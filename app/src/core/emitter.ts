export interface Unsubscribe {
  (): void;
}

/** Minimal typed event emitter. Listener errors are isolated and reported. */
export class Emitter<Events extends Record<string, unknown>> {
  private listeners: { [K in keyof Events]?: Set<(payload: Events[K]) => void> } = {};

  constructor(private readonly onListenerError: (err: unknown) => void = defaultReport) {}

  on<K extends keyof Events>(event: K, fn: (payload: Events[K]) => void): Unsubscribe {
    const set = (this.listeners[event] ??= new Set());
    set.add(fn);
    return () => {
      set.delete(fn);
    };
  }

  emit<K extends keyof Events>(event: K, payload: Events[K]): void {
    const set = this.listeners[event];
    if (!set) return;
    for (const fn of [...set]) {
      try {
        fn(payload);
      } catch (err) {
        this.onListenerError(err);
      }
    }
  }

  listenerCount<K extends keyof Events>(event: K): number {
    return this.listeners[event]?.size ?? 0;
  }
}

function defaultReport(err: unknown): void {
  console.error('[Emitter] listener threw', err);
}
