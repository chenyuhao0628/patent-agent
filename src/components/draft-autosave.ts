/** Debounced manuscript autosave: many keystrokes coalesce; flush on blur/unmount. */
export const DRAFT_AUTOSAVE_MS = 500;

export type DraftAutosave = {
  /** Queue text for debounced persist; does not save immediately. */
  onChange(text: string): void;
  /** Persist pending text now (blur / unmount / explicit flush). */
  flush(): Promise<void>;
  /** Drop pending timer without saving (e.g. before an explicit save). */
  cancel(): void;
  /** True when a debounce is waiting and has not been flushed or fired. */
  hasPending(): boolean;
};

export type DraftAutosaveOptions = {
  save: (text: string) => void | Promise<void>;
  delayMs?: number;
  setTimeout?: typeof globalThis.setTimeout;
  clearTimeout?: typeof globalThis.clearTimeout;
};

export function createDraftAutosave(opts: DraftAutosaveOptions): DraftAutosave {
  const delayMs = opts.delayMs ?? DRAFT_AUTOSAVE_MS;
  const schedule = opts.setTimeout ?? setTimeout;
  const clear = opts.clearTimeout ?? clearTimeout;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let pending: string | null = null;

  function clearTimer() {
    if (timer == null) return;
    clear(timer);
    timer = null;
  }

  async function persist(text: string) {
    await opts.save(text);
  }

  return {
    onChange(text: string) {
      pending = text;
      clearTimer();
      timer = schedule(() => {
        timer = null;
        const next = pending;
        pending = null;
        if (next !== null) void persist(next);
      }, delayMs) as ReturnType<typeof setTimeout>;
    },
    async flush() {
      clearTimer();
      if (pending === null) return;
      const next = pending;
      pending = null;
      await persist(next);
    },
    cancel() {
      clearTimer();
      pending = null;
    },
    hasPending() {
      return pending !== null;
    },
  };
}
