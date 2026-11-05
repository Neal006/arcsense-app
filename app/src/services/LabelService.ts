/**
 * Ground-truth annotation during a trial (functionalities F30-F34).
 *
 * Every press is written to the Label Marker characteristic of both ankles AND
 * recorded here with phone time. The phone log is authoritative ground truth
 * (FINDINGS F-07: the firmware's use of the BIN label channel is unconfirmed);
 * labels are mapped onto the device timelines through the sync tokens.
 *
 * Rules:
 *  - a start/end pair forms an episode; a start cannot be pressed while its
 *    episode is open, an end only while it is open
 *  - trial episodes (Normal / Shuffling / Limping) are mutually exclusive;
 *    FoG episodes may overlap a trial
 *  - a label written to an SD card cannot be removed, so "void" writes the VOID
 *    id and flags the most recent label as voided; the training pipeline drops
 *    voided labels (ml/arcsense_ml/labels.py)
 *  - stopping a session auto-closes open episodes and marks them as such
 * Open-episode state is always recomputed from the record log, so it cannot
 * drift from what was recorded.
 */
import type { Clock } from '@/core/clock';
import { Emitter, type Unsubscribe } from '@/core/emitter';
import { LABELS, VOID_LABEL_ID } from '@/shared/generated/labels';

import { deliveredToBoth, writeBoth, type BilateralWrite } from './bilateralWrite';
import type { DeviceManager } from './DeviceManager';

export type LabelDef = (typeof LABELS)[number];

export interface LabelRecord {
  seq: number;
  labelId: number;
  key: string;
  name: string;
  kind: LabelDef['kind'];
  group: LabelDef['group'];
  t: number;
  wall: number;
  sides: BilateralWrite;
  delivered: boolean;
  voided: boolean;
  /** For VOID records: the seq of the label they void. */
  voidsSeq: number | null;
  /** End label written automatically when the session stopped. */
  autoClosed: boolean;
}

export interface NoteRecord {
  seq: number;
  t: number;
  wall: number;
  text: string;
}

export class LabelError extends Error {
  override name = 'LabelError';
}

const BY_ID = new Map<number, LabelDef>(LABELS.map((l) => [l.id, l]));

export function labelDef(id: number): LabelDef {
  const def = BY_ID.get(id);
  if (!def) throw new LabelError(`unknown label id ${id}`);
  return def;
}

/** Start records of episodes that are open after replaying `records`. */
export function openEpisodes(records: readonly LabelRecord[]): LabelRecord[] {
  const open = new Map<number, LabelRecord>();
  for (const r of records) {
    if (r.voided || r.kind === 'void') continue;
    if (r.kind === 'start') open.set(r.labelId, r);
    else if (r.kind === 'end') {
      const pair = labelDef(r.labelId).pairId;
      if (pair !== null) open.delete(pair);
    }
  }
  return [...open.values()];
}

interface LabelEvents extends Record<string, unknown> {
  label: LabelRecord;
  voided: LabelRecord;
  note: NoteRecord;
  changed: readonly LabelRecord[];
}

export class LabelService {
  private readonly emitter = new Emitter<LabelEvents>();
  private readonly records: LabelRecord[] = [];
  private readonly notes: NoteRecord[] = [];
  private chain: Promise<unknown> = Promise.resolve();

  constructor(
    private readonly dm: DeviceManager,
    private readonly clock: Clock,
  ) {}

  on<K extends keyof LabelEvents>(event: K, fn: (p: LabelEvents[K]) => void): Unsubscribe {
    return this.emitter.on(event, fn);
  }

  /** Buttons to show: everything except the VOID control. */
  catalog(): LabelDef[] {
    return LABELS.filter((l) => l.kind !== 'void');
  }

  getRecords(): readonly LabelRecord[] {
    return this.records;
  }

  getNotes(): readonly NoteRecord[] {
    return this.notes;
  }

  open(): LabelRecord[] {
    return openEpisodes(this.records);
  }

  isOpen(startId: number): boolean {
    return this.open().some((r) => r.labelId === startId);
  }

  /** Whether `id` can be pressed now, and why not. Pure check; used by the UI. */
  availability(id: number): { enabled: boolean; reason: string | null } {
    const def = labelDef(id);
    const open = this.open();
    if (def.kind === 'start') {
      if (open.some((r) => r.labelId === def.id)) {
        return { enabled: false, reason: `${def.name} is already running` };
      }
      if (def.group === 'trial') {
        const other = open.find((r) => r.group === 'trial');
        if (other) return { enabled: false, reason: `End "${other.name}" first` };
      }
    } else if (def.kind === 'end') {
      if (!open.some((r) => r.labelId === def.pairId)) {
        return { enabled: false, reason: `${def.name} is not running` };
      }
    } else if (def.kind === 'void') {
      if (!this.lastVoidable()) return { enabled: false, reason: 'Nothing to void' };
    }
    return { enabled: true, reason: null };
  }

  /** Record and write a label. Rejects with LabelError if the rules forbid it now. */
  press(id: number): Promise<LabelRecord> {
    if (id === VOID_LABEL_ID) {
      return this.voidLast().then((r) => {
        if (!r) throw new LabelError('Nothing to void');
        return r;
      });
    }
    const at = this.stamp(); // ground truth is the moment of the tap, not of the write
    return this.serial(async () => {
      const def = labelDef(id);
      const a = this.availability(id);
      if (!a.enabled) throw new LabelError(a.reason ?? 'not allowed');
      return this.write(def, { voidsSeq: null, autoClosed: false }, at);
    });
  }

  /** Press the start or the end of an episode depending on whether it is open. */
  toggleEpisode(startId: number): Promise<LabelRecord> {
    const def = labelDef(startId);
    if (def.kind !== 'start' || def.pairId === null) {
      return Promise.reject(new LabelError(`${def.key} is not an episode start`));
    }
    return this.press(this.isOpen(startId) ? def.pairId : startId);
  }

  /** Void the most recent label that is not already voided. */
  voidLast(): Promise<LabelRecord | null> {
    const at = this.stamp();
    return this.serial(async () => {
      const target = this.lastVoidable();
      if (!target) return null;
      target.voided = true;
      this.emitter.emit('voided', target);
      return this.write(labelDef(VOID_LABEL_ID), { voidsSeq: target.seq, autoClosed: false }, at);
    });
  }

  /** Close every open episode (session stop). */
  closeAll(): Promise<LabelRecord[]> {
    const at = this.stamp();
    return this.serial(async () => {
      const out: LabelRecord[] = [];
      // close FoG-type episodes before the trial that contains them
      const open = this.open().sort((a, b) => b.seq - a.seq);
      for (const start of open) {
        const end = labelDef(labelDef(start.labelId).pairId!);
        out.push(await this.write(end, { voidsSeq: null, autoClosed: true }, at));
      }
      return out;
    });
  }

  addNote(text: string): NoteRecord {
    const trimmed = text.trim();
    if (!trimmed) throw new LabelError('note is empty');
    const note: NoteRecord = {
      seq: this.notes.length,
      t: this.clock.now(),
      wall: this.clock.wallNow(),
      text: trimmed,
    };
    this.notes.push(note);
    this.emitter.emit('note', note);
    return note;
  }

  /** Rebuild state from persisted records (crash recovery, F28). */
  restore(records: readonly LabelRecord[], notes: readonly NoteRecord[]): void {
    if (this.records.length || this.notes.length)
      throw new LabelError('restore into a used service');
    this.records.push(...records.map((r) => ({ ...r })));
    this.notes.push(...notes.map((n) => ({ ...n })));
    this.emitter.emit('changed', this.records);
  }

  private lastVoidable(): LabelRecord | undefined {
    for (let i = this.records.length - 1; i >= 0; i--) {
      const r = this.records[i]!;
      if (r.kind !== 'void' && !r.voided) return r;
    }
    return undefined;
  }

  private stamp(): { t: number; wall: number } {
    return { t: this.clock.now(), wall: this.clock.wallNow() };
  }

  private async write(
    def: LabelDef,
    extra: { voidsSeq: number | null; autoClosed: boolean },
    { t, wall }: { t: number; wall: number },
  ): Promise<LabelRecord> {
    const sides = await writeBoth(this.dm, this.clock, 'labelMarker', def.id, true);
    const rec: LabelRecord = {
      seq: this.records.length,
      labelId: def.id,
      key: def.key,
      name: def.name,
      kind: def.kind,
      group: def.group,
      t,
      wall,
      sides,
      delivered: deliveredToBoth(sides),
      voided: false,
      ...extra,
    };
    this.records.push(rec);
    this.emitter.emit('label', rec);
    this.emitter.emit('changed', this.records);
    return rec;
  }

  private serial<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.chain.then(fn);
    this.chain = run.catch(() => undefined);
    return run;
  }
}
