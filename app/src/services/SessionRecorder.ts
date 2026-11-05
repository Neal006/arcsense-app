/**
 * Session lifecycle (functionalities F21, F27-F29): metadata, start, stop,
 * crash recovery, and persistence of everything recorded during a session.
 *
 * Persistence is write-through: every token, label, void, note and connection
 * event is stored the moment it happens, so an app kill loses nothing that was
 * already acknowledged on screen.
 */
import type { Side } from '@/ble/gatt';
import type { Clock } from '@/core/clock';
import { Emitter, type Unsubscribe } from '@/core/emitter';
import type { SessionRepository, SessionRow } from '@/db/SessionRepository';
import { FEATURE_SPEC_HASH } from '@/shared/generated/features';
import { GATT_SPEC_VERSION } from '@/shared/generated/gatt';
import { LABEL_CATALOG_VERSION } from '@/shared/generated/labels';

import type { DeviceManager } from './DeviceManager';
import { LabelService } from './LabelService';
import { DEFAULT_SYNC_INTERVAL_MS, nextToken, SyncService } from './SyncService';

export interface SessionMetaInput {
  subjectCode: string;
  condition: string;
  operator: string;
  notes: string;
  plannedSides: 'LR' | 'L' | 'R';
  /** Affected side for asymmetric conditions (e.g. post-stroke limping). */
  affectedSide: Side | null;
}

/** Pseudonymous codes only: letters, digits, '-' and '_', 2-32 characters. */
export const SUBJECT_CODE_PATTERN = /^[A-Za-z0-9_-]{2,32}$/;

export function validateMeta(m: SessionMetaInput): string[] {
  const errors: string[] = [];
  if (!SUBJECT_CODE_PATTERN.test(m.subjectCode.trim())) {
    errors.push('Subject code is required: 2-32 letters, digits, "-" or "_" (no names).');
  }
  if (!m.condition.trim()) errors.push('Condition / trial type is required.');
  if (!m.operator.trim()) errors.push('Operator is required.');
  return errors;
}

export function plannedSideList(p: SessionMetaInput['plannedSides']): Side[] {
  return p === 'LR' ? ['L', 'R'] : [p];
}

export type RecorderState = 'idle' | 'starting' | 'running' | 'stopping';

export interface SessionSummary {
  sessionId: string;
  durationMs: number;
  tokens: number;
  partialTokens: number;
  labels: number;
  voidedLabels: number;
  autoClosedEpisodes: number;
  notes: number;
  connectionEvents: number;
  linkLosses: number;
}

export class SessionError extends Error {
  override name = 'SessionError';
}

interface RecorderEvents extends Record<string, unknown> {
  state: RecorderState;
  session: SessionRow | null;
}

export interface RecorderDeps {
  dm: DeviceManager;
  repo: SessionRepository;
  clock: Clock;
  appVersion: string;
  syncIntervalMs?: number;
  newId?: (subjectCode: string, wall: number) => string;
}

export function defaultSessionId(subjectCode: string, wall: number): string {
  const d = new Date(wall);
  const p = (n: number) => String(n).padStart(2, '0');
  const stamp = `${d.getUTCFullYear()}${p(d.getUTCMonth() + 1)}${p(d.getUTCDate())}-${p(d.getUTCHours())}${p(d.getUTCMinutes())}${p(d.getUTCSeconds())}`;
  const rand = Math.floor(Math.random() * 0xffff)
    .toString(16)
    .padStart(4, '0');
  return `${subjectCode}_${stamp}Z_${rand}`;
}

export class SessionRecorder {
  private readonly emitter = new Emitter<RecorderEvents>();
  private st: RecorderState = 'idle';
  private session: SessionRow | null = null;
  private run = 0;
  private runMono = 0;
  private runWall = 0;
  private syncSvc: SyncService | null = null;
  private labelSvc: LabelService | null = null;
  private offs: Unsubscribe[] = [];
  private eventIdx = 0;

  constructor(private readonly deps: RecorderDeps) {}

  on<K extends keyof RecorderEvents>(event: K, fn: (p: RecorderEvents[K]) => void): Unsubscribe {
    return this.emitter.on(event, fn);
  }

  state(): RecorderState {
    return this.st;
  }

  current(): SessionRow | null {
    return this.session;
  }

  sync(): SyncService {
    if (!this.syncSvc) throw new SessionError('no active session');
    return this.syncSvc;
  }

  labels(): LabelService {
    if (!this.labelSvc) throw new SessionError('no active session');
    return this.labelSvc;
  }

  /** Session time: monotonic within this run, bridged by wall time across runs. */
  elapsedMs(): number {
    if (!this.session?.startedWall) return 0;
    return this.clock.now() - this.runMono + (this.runWall - this.session.startedWall);
  }

  /** Planned sides that are not connected and ready. */
  missingSides(planned: SessionMetaInput['plannedSides']): Side[] {
    return plannedSideList(planned).filter((s) => !this.deps.dm.isReady(s));
  }

  async start(meta: SessionMetaInput): Promise<SessionRow> {
    if (this.st !== 'idle') throw new SessionError(`cannot start while ${this.st}`);
    const errors = validateMeta(meta);
    if (errors.length) throw new SessionError(errors.join(' '));
    const missing = this.missingSides(meta.plannedSides);
    if (missing.length) throw new SessionError(`Connect ${missing.join(' and ')} before starting.`);

    this.setState('starting');
    try {
      const { dm, repo, clock } = this.deps;
      const wall = clock.wallNow();
      const links = dm.getLinks();
      const subjectCode = meta.subjectCode.trim();
      const id = (this.deps.newId ?? defaultSessionId)(subjectCode, wall);
      this.session = repo.createSession({
        id,
        subjectCode,
        condition: meta.condition.trim(),
        operator: meta.operator.trim(),
        notes: meta.notes.trim(),
        plannedSides: meta.plannedSides,
        affectedSide: meta.affectedSide,
        status: 'running',
        createdWall: wall,
        startedWall: wall,
        appVersion: this.deps.appVersion,
        gattSpecVersion: GATT_SPEC_VERSION,
        labelCatalogVersion: LABEL_CATALOG_VERSION,
        featureSpecHash: FEATURE_SPEC_HASH,
        deviceL: links.L.deviceId,
        deviceR: links.R.deviceId,
        modeL: links.L.mode,
        modeR: links.R.mode,
      });
      this.beginRun();
      this.attachServices(0);
      await this.syncSvc!.start();
      const ss = this.syncSvc!.getSessionStart();
      this.session = repo.updateSession(id, { sessionStartValue: ss?.value ?? null });
      this.setState('running');
      this.emitter.emit('session', this.session);
      return this.session;
    } catch (e) {
      this.teardown();
      if (this.session) {
        this.deps.repo.updateSession(this.session.id, {
          status: 'aborted',
          stoppedWall: this.clock.wallNow(),
        });
      }
      this.session = null;
      this.setState('idle');
      throw e;
    }
  }

  async stop(): Promise<SessionSummary> {
    if (this.st !== 'running' || !this.session)
      throw new SessionError(`cannot stop while ${this.st}`);
    this.setState('stopping');
    const id = this.session.id;
    let failure: unknown = null;
    try {
      await this.labelSvc!.closeAll();
      await this.syncSvc!.stop();
    } catch (e) {
      failure = e;
    }
    // The session is closed even if the final writes failed; the error is re-raised.
    this.deps.repo.updateSession(id, { status: 'stopped', stoppedWall: this.clock.wallNow() });
    const summary = this.summarize(id);
    this.teardown();
    this.session = null;
    this.setState('idle');
    this.emitter.emit('session', null);
    if (failure) throw failure;
    return summary;
  }

  /** A session the app did not stop (killed mid-trial), if any. */
  findUnfinished(): SessionRow | undefined {
    return this.deps.repo.findUnfinished();
  }

  /**
   * Continue an unfinished session after an app restart (F28): new run, labels
   * and notes restored, token sequence continued, an immediate token sent.
   */
  async resume(sessionId: string): Promise<SessionRow> {
    if (this.st !== 'idle') throw new SessionError(`cannot resume while ${this.st}`);
    const row = this.deps.repo.getSession(sessionId);
    if (!row || row.status !== 'running')
      throw new SessionError(`session ${sessionId} is not resumable`);
    this.setState('starting');
    try {
      this.session = row;
      this.beginRun();
      const tokens = this.deps.repo.getTokens(sessionId);
      const lastToken = row.lastToken ?? tokens.at(-1)?.token ?? null;
      this.attachServices(this.deps.repo.nextConnectionEventIdx(sessionId));
      this.labelSvc!.restore(
        this.deps.repo.getLabels(sessionId),
        this.deps.repo.getNotes(sessionId),
      );
      await this.syncSvc!.start(
        lastToken === null ? undefined : nextToken(lastToken),
        tokens.length,
      );
      this.setState('running');
      this.emitter.emit('session', this.session);
      return this.session;
    } catch (e) {
      this.teardown();
      this.session = null;
      this.setState('idle');
      throw e;
    }
  }

  /** Close an unfinished session without devices (user chose not to resume). */
  abandon(sessionId: string): void {
    const row = this.deps.repo.getSession(sessionId);
    if (!row || row.status !== 'running')
      throw new SessionError(`session ${sessionId} is not unfinished`);
    if (this.session?.id === sessionId) throw new SessionError('session is active in this app run');
    this.deps.repo.updateSession(sessionId, {
      status: 'aborted',
      stoppedWall: this.clock.wallNow(),
    });
  }

  summarize(sessionId: string): SessionSummary {
    const { repo } = this.deps;
    const row = repo.getSession(sessionId);
    if (!row) throw new SessionError(`session ${sessionId} not found`);
    const tokens = repo.getTokens(sessionId);
    const labels = repo.getLabels(sessionId);
    const events = repo.getConnectionEvents(sessionId);
    const end = row.stoppedWall ?? this.clock.wallNow();
    return {
      sessionId,
      durationMs: row.startedWall ? end - row.startedWall : 0,
      tokens: tokens.length,
      partialTokens: tokens.filter((t) => t.partial).length,
      labels: labels.filter((l) => l.kind !== 'void').length,
      voidedLabels: labels.filter((l) => l.voided).length,
      autoClosedEpisodes: labels.filter((l) => l.autoClosed).length,
      notes: repo.getNotes(sessionId).length,
      connectionEvents: events.length,
      linkLosses: events.filter((e) => e.type === 'link_lost').length,
    };
  }

  // ---- internals ------------------------------------------------------------

  private get clock(): Clock {
    return this.deps.clock;
  }

  private beginRun(): void {
    this.runMono = this.clock.now();
    this.runWall = this.clock.wallNow();
    this.run = this.deps.repo.addRun(this.session!.id, this.runMono, this.runWall);
  }

  private attachServices(firstEventIdx: number): void {
    const { dm, repo, clock } = this.deps;
    const id = this.session!.id;
    const run = this.run;
    this.syncSvc = new SyncService(dm, clock, this.deps.syncIntervalMs ?? DEFAULT_SYNC_INTERVAL_MS);
    this.labelSvc = new LabelService(dm, clock);
    this.eventIdx = firstEventIdx;
    this.offs = [
      this.syncSvc.on('token', (t) => {
        repo.addToken(id, run, t);
        repo.updateSession(id, { lastToken: t.token });
      }),
      this.labelSvc.on('label', (l) => repo.addLabel(id, run, l)),
      this.labelSvc.on('voided', (l) => repo.markLabelVoided(id, l.seq)),
      this.labelSvc.on('note', (n) => repo.addNote(id, run, n)),
      dm.on('event', (e) => repo.addConnectionEvent(id, run, this.eventIdx++, e)),
      dm.on('ready', ({ side, deviceId, mode }) => {
        // keep device ids / modes current if a side is (re)connected mid-session
        const patch =
          side === 'L' ? { deviceL: deviceId, modeL: mode } : { deviceR: deviceId, modeR: mode };
        this.session = repo.updateSession(id, patch);
      }),
    ];
  }

  private teardown(): void {
    for (const off of this.offs) off();
    this.offs = [];
    this.syncSvc?.dispose();
    this.syncSvc = null;
    this.labelSvc = null;
  }

  private setState(s: RecorderState): void {
    this.st = s;
    this.emitter.emit('state', s);
  }
}
