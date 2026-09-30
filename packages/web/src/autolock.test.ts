import assert from "node:assert/strict";
import test from "node:test";
import { AutoLock, type LockReason } from "./autolock.ts";

function clock() {
  let now = 0;
  const timers: Array<{ at: number; fn: () => void; id: number }> = [];
  let next = 1;
  return {
    now: () => now,
    schedule: (fn: () => void, ms: number) => {
      const id = next++;
      timers.push({ at: now + ms, fn, id });
      return id;
    },
    cancel: (id: unknown) => {
      const index = timers.findIndex((timer) => timer.id === id);
      if (index >= 0) timers.splice(index, 1);
    },
    /** Moves time forward, firing timers that come due (as a foreground tab would). */
    advance(ms: number) {
      const end = now + ms;
      for (;;) {
        timers.sort((a, b) => a.at - b.at);
        const due = timers[0];
        if (!due || due.at > end) break;
        timers.shift();
        now = due.at;
        due.fn();
      }
      now = end;
    },
    /** Moves time forward without firing anything (a throttled background tab). */
    sleep(ms: number) {
      now += ms;
    },
    pending: () => timers.length,
  };
}

const MIN = 60_000;

test("locks after the idle timeout, and activity pushes it back", () => {
  const c = clock();
  const locks: LockReason[] = [];
  const lock = new AutoLock({ idleMs: 15 * MIN, maxMs: 720 * MIN, onLock: (reason) => locks.push(reason), ...c });
  lock.start();
  c.advance(10 * MIN);
  lock.touch();
  c.advance(10 * MIN);
  assert.deepEqual(locks, [], "20 minutes in, but only 10 idle");
  c.advance(5 * MIN);
  assert.deepEqual(locks, ["idle"]);
  assert.equal(lock.running, false);
  assert.equal(c.pending(), 0, "no timer left behind");
});

test("a background tab woken past the deadline locks instead of extending", () => {
  const c = clock();
  const locks: LockReason[] = [];
  const lock = new AutoLock({ idleMs: 15 * MIN, maxMs: 720 * MIN, onLock: (reason) => locks.push(reason), ...c });
  lock.start();
  c.sleep(60 * MIN);
  lock.touch();
  assert.deepEqual(locks, ["idle"]);
});

test("the hard cap locks even with constant activity", () => {
  const c = clock();
  const locks: LockReason[] = [];
  const lock = new AutoLock({ idleMs: 15 * MIN, maxMs: 60 * MIN, onLock: (reason) => locks.push(reason), ...c });
  lock.start();
  for (let i = 0; i < 7; i += 1) {
    c.advance(9 * MIN);
    lock.touch();
  }
  assert.deepEqual(locks, ["max"]);
});

test("manual lock fires once; a shorter idle setting applies at once", () => {
  const c = clock();
  const locks: LockReason[] = [];
  const lock = new AutoLock({ idleMs: 60 * MIN, maxMs: 720 * MIN, onLock: (reason) => locks.push(reason), ...c });
  lock.start();
  c.advance(10 * MIN);
  lock.setIdle(5 * MIN);
  assert.deepEqual(locks, ["idle"], "already idle longer than the new setting");
  lock.start();
  lock.lock("manual");
  lock.lock("manual");
  assert.deepEqual(locks, ["idle", "manual"]);
});
