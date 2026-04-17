import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { EngineQueue } from "./engine-queue.js";

// Helpers
const tick = () => new Promise<void>((r) => setImmediate(r));
async function sleep(ms: number) {
  return new Promise<void>((r) => setTimeout(r, ms));
}

describe("EngineQueue", () => {
  it("free slot: acquire resolves immediately and isBusy becomes true", async () => {
    const q = new EngineQueue();
    assert.equal(q.isBusy(), false);
    await q.acquire("high", 1000);
    assert.equal(q.isBusy(), true);
    q.release();
    assert.equal(q.isBusy(), false);
  });

  it("tryAcquire: succeeds when free, returns false when busy", () => {
    const q = new EngineQueue();
    assert.equal(q.tryAcquire(), true);
    assert.equal(q.isBusy(), true);
    assert.equal(q.tryAcquire(), false);
    q.release();
  });

  it("priority ordering: high waiter beats normal when slot is released", async () => {
    const q = new EngineQueue();
    await q.acquire("high", 1000); // take the slot

    const order: string[] = [];
    const p1 = q.acquire("normal", 2000).then(() => { order.push("normal"); q.release(); });
    await tick();
    const p2 = q.acquire("high", 2000).then(() => { order.push("high"); q.release(); });
    await tick();

    assert.equal(q.queueDepth(), 2);
    q.release(); // hand off to highest-priority waiter
    await Promise.all([p1, p2]);
    assert.deepEqual(order, ["high", "normal"]);
  });

  it("FIFO within same priority: earlier enqueuer wins", async () => {
    const q = new EngineQueue();
    await q.acquire("high", 1000);

    const order: string[] = [];
    const p1 = q.acquire("normal", 2000).then(() => { order.push("first"); q.release(); });
    await sleep(5); // ensure different enqueuedAt timestamps
    const p2 = q.acquire("normal", 2000).then(() => { order.push("second"); q.release(); });
    await tick();

    q.release();
    await Promise.all([p1, p2]);
    assert.deepEqual(order, ["first", "second"]);
  });

  it("deadline timeout: waiter is removed and rejects with busy-timeout error", async () => {
    const q = new EngineQueue();
    await q.acquire("high", 1000); // hold the slot

    let caught: Error | null = null;
    const p = q.acquire("low", 30).catch((e) => { caught = e; });
    await sleep(60); // let the 30ms deadline fire
    assert.equal(q.queueDepth(), 0, "waiter must be removed after timeout");
    await p;
    assert.ok(caught !== null && typeof caught === "object", "should have rejected with an Error");
    const msg = (caught as Error).message;
    assert.ok(msg.includes("Engine busy timeout"), msg);
    q.release();
  });

  it("release with no waiters makes slot free", () => {
    const q = new EngineQueue();
    assert.equal(q.tryAcquire(), true);
    q.release();
    assert.equal(q.isBusy(), false);
    assert.equal(q.heldMs(), 0);
  });

  it("queueDepth tracks waiters correctly", async () => {
    const q = new EngineQueue();
    await q.acquire("high", 1000);
    assert.equal(q.queueDepth(), 0);

    const p1 = q.acquire("normal", 2000);
    await tick();
    assert.equal(q.queueDepth(), 1);

    const p2 = q.acquire("low", 2000);
    await tick();
    assert.equal(q.queueDepth(), 2);

    q.release(); // hand to normal (higher priority)
    await tick();
    assert.equal(q.queueDepth(), 1);

    const holder = await p1; // p1 resolved — release it
    void holder; // suppress unused warning
    q.release();
    await p2;
    q.release();
    assert.equal(q.queueDepth(), 0);
  });

  it("heldMs: returns 0 when free, positive when busy", async () => {
    const q = new EngineQueue();
    assert.equal(q.heldMs(), 0);
    await q.acquire("high", 1000);
    await sleep(10);
    assert.ok(q.heldMs() >= 10, `heldMs should be >= 10, got ${q.heldMs()}`);
    q.release();
    assert.equal(q.heldMs(), 0);
  });
});
