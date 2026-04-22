/**
 * EngineQueue — priority-aware single-slot scheduler for the local engine.
 *
 * Only one engine subprocess may run at a time. All modules (orders, digestion,
 * reflection, script activities, MCP ad-hoc calls, …) go through this queue so
 * that higher-priority work does not starve behind background busywork.
 *
 * Ordering:
 *   - When the slot is free, acquire() returns immediately.
 *   - Otherwise callers wait; when the running job releases the slot, the
 *     highest-priority waiter wins (FIFO within the same priority).
 *   - If the caller's deadline elapses first, acquire() rejects with
 *     "Engine busy timeout" and the caller is removed from the queue.
 *
 * Priority semantics (keep in sync with types.ts ComputeRequest.priority):
 *   - high   — user-waiting work (orders, user tasks, direct MCP calls)
 *   - normal — periodic self-maintenance that must not starve (digestion,
 *              reflection)
 *   - low    — background enrichment (platform tasks, script activities,
 *              long-term, identity compression)
 */

import { updateMetrics } from "./metrics.js";

export type Priority = "high" | "normal" | "low";

const PRIORITY_RANK: Record<Priority, number> = { high: 3, normal: 2, low: 1 };

interface Waiter {
  priority: Priority;
  enqueuedAt: number;
  resolve: () => void;
  reject: (err: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

/** Max simultaneous user_manual tasks allowed to hold or wait for a slot.
 *  Prevents more than this many claude CLI processes from queuing up. */
const DEFAULT_MAX_USER_MANUAL = 2;

interface UserManualWaiter {
  resolve: () => void;
  reject: (err: Error) => void;
}

export class EngineQueue {
  private busy = false;
  private busySince = 0;
  private waiters: Waiter[] = [];

  // User-manual concurrency gate
  private maxUserManualSlots: number;
  private userManualActive = 0;
  private userManualQueue: UserManualWaiter[] = [];

  constructor(maxUserManualSlots = DEFAULT_MAX_USER_MANUAL) {
    this.maxUserManualSlots = maxUserManualSlots;
  }

  /** Acquire a user_manual slot before joining the engine queue.
   *  Callers MUST call releaseUserManualSlot() in a finally block. */
  acquireUserManualSlot(deadlineMs: number): Promise<void> {
    if (this.userManualActive < this.maxUserManualSlots) {
      this.userManualActive++;
      return Promise.resolve();
    }
    return new Promise<void>((resolve, reject) => {
      let timerRef: ReturnType<typeof setTimeout>;
      const entry: UserManualWaiter = {
        resolve: () => { clearTimeout(timerRef); resolve(); },
        reject: (err: Error) => { clearTimeout(timerRef); reject(err); },
      };
      timerRef = setTimeout(() => {
        const idx = this.userManualQueue.indexOf(entry);
        if (idx >= 0) this.userManualQueue.splice(idx, 1);
        entry.reject(new Error("User manual slot timeout"));
      }, deadlineMs);
      this.userManualQueue.push(entry);
    });
  }

  /** Release a user_manual slot and wake the next waiter. */
  releaseUserManualSlot(): void {
    const next = this.userManualQueue.shift();
    if (next) {
      // Transfer slot to the next waiter (active count unchanged)
      next.resolve();
    } else {
      this.userManualActive = Math.max(0, this.userManualActive - 1);
    }
  }

  /** Wait up to `deadlineMs` for the slot, then take it. */
  acquire(priority: Priority, deadlineMs: number): Promise<void> {
    if (!this.busy) {
      this.busy = true;
      this.busySince = Date.now();
      return Promise.resolve();
    }
    return new Promise<void>((resolve, reject) => {
      const waiter: Waiter = {
        priority,
        enqueuedAt: Date.now(),
        resolve,
        reject,
        timer: setTimeout(() => {
          const idx = this.waiters.indexOf(waiter);
          if (idx >= 0) {
            this.waiters.splice(idx, 1);
            updateMetrics({ engine_queue_depth: this.waiters.length });
          }
          reject(new Error(`Engine busy timeout (${Math.round(deadlineMs / 60000)} min)`));
        }, deadlineMs),
      };
      this.waiters.push(waiter);
      updateMetrics({ engine_queue_depth: this.waiters.length });
    });
  }

  /** Release the slot and hand it to the best waiter, if any. */
  release(): void {
    const next = this.pickNext();
    if (!next) {
      this.busy = false;
      this.busySince = 0;
      return;
    }
    this.waiters.splice(this.waiters.indexOf(next), 1);
    clearTimeout(next.timer);
    this.busySince = Date.now();
    updateMetrics({ engine_queue_depth: this.waiters.length });
    next.resolve();
  }

  /** Take the slot synchronously (used by MCP fast-path when !isBusy). */
  tryAcquire(): boolean {
    if (this.busy) return false;
    this.busy = true;
    this.busySince = Date.now();
    return true;
  }

  isBusy(): boolean {
    return this.busy;
  }

  queueDepth(): number {
    return this.waiters.length;
  }

  /** How long has the current holder held the slot, in ms. 0 if free. */
  heldMs(): number {
    return this.busy && this.busySince ? Date.now() - this.busySince : 0;
  }

  private pickNext(): Waiter | null {
    if (this.waiters.length === 0) return null;
    let best = this.waiters[0];
    for (let i = 1; i < this.waiters.length; i++) {
      const w = this.waiters[i];
      const wr = PRIORITY_RANK[w.priority];
      const br = PRIORITY_RANK[best.priority];
      if (wr > br || (wr === br && w.enqueuedAt < best.enqueuedAt)) {
        best = w;
      }
    }
    return best;
  }
}
