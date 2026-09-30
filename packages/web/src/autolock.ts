export type LockReason = "idle" | "max" | "manual" | "signed-out";

export interface AutoLockOptions {
  idleMs: number;
  /** Hard cap from unlock, whatever the activity. */
  maxMs: number;
  onLock: (reason: LockReason) => void;
  now?: () => number;
  schedule?: (fn: () => void, ms: number) => unknown;
  cancel?: (handle: unknown) => void;
}

/**
 * Locks after `idleMs` without activity or `maxMs` after unlock. Background
 * tabs throttle timers, so every touch and visibility change re-checks the
 * clock first: a tab woken after the deadline locks instead of extending.
 */
export class AutoLock {
  private startedAt = 0;
  private lastActivity = 0;
  private handle: unknown = null;
  private active = false;
  private readonly now: () => number;
  private readonly schedule: (fn: () => void, ms: number) => unknown;
  private readonly cancel: (handle: unknown) => void;

  constructor(private options: AutoLockOptions) {
    this.now = options.now ?? (() => Date.now());
    this.schedule = options.schedule ?? ((fn, ms) => setTimeout(fn, ms));
    this.cancel = options.cancel ?? ((handle) => clearTimeout(handle as ReturnType<typeof setTimeout>));
  }

  get running(): boolean {
    return this.active;
  }

  start(): void {
    this.active = true;
    this.startedAt = this.lastActivity = this.now();
    this.arm();
  }

  setIdle(idleMs: number): void {
    this.options = { ...this.options, idleMs };
    if (this.active && !this.check()) this.arm();
  }

  touch(): void {
    if (!this.active || this.check()) return;
    this.lastActivity = this.now();
  }

  /** Locks and returns true if a deadline has passed. */
  check(): boolean {
    if (!this.active) return false;
    const now = this.now();
    if (now - this.startedAt >= this.options.maxMs) return this.fire("max");
    if (now - this.lastActivity >= this.options.idleMs) return this.fire("idle");
    return false;
  }

  lock(reason: LockReason): void {
    if (this.active) this.fire(reason);
  }

  stop(): void {
    this.active = false;
    if (this.handle !== null) this.cancel(this.handle);
    this.handle = null;
  }

  private fire(reason: LockReason): true {
    this.stop();
    this.options.onLock(reason);
    return true;
  }

  private arm(): void {
    if (this.handle !== null) this.cancel(this.handle);
    const due = Math.min(this.lastActivity + this.options.idleMs, this.startedAt + this.options.maxMs) - this.now();
    this.handle = this.schedule(() => {
      this.handle = null;
      if (!this.check()) this.arm();
    }, Math.max(due, 0));
  }
}
