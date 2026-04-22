import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { sortByQuadrant, dedupeWorkItems, computeRetryDelay, RETRY_INTERVALS } from "./task-helpers.js";

describe("sortByQuadrant", () => {
  it("empty array returns empty array", () => {
    assert.deepStrictEqual(sortByQuadrant([]), []);
  });

  it("does not modify the input array", () => {
    const items = [
      { quadrant: 3, id: "a" },
      { quadrant: 1, id: "b" },
    ];
    const original = [...items];
    sortByQuadrant(items);
    assert.deepStrictEqual(items, original, "input array must not be mutated");
  });

  it("sorts ascending by quadrant", () => {
    const items = [
      { quadrant: 4, id: "d" },
      { quadrant: 2, id: "b" },
      { quadrant: 3, id: "c" },
      { quadrant: 1, id: "a" },
    ];
    const result = sortByQuadrant(items);
    assert.deepStrictEqual(
      result.map(i => i.quadrant),
      [1, 2, 3, 4],
    );
  });

  it("is stable: equal-quadrant items preserve original order", () => {
    const items = [
      { quadrant: 2, id: "first" },
      { quadrant: 1, id: "solo" },
      { quadrant: 2, id: "second" },
    ];
    const result = sortByQuadrant(items);
    assert.strictEqual(result[0].id, "solo");
    assert.strictEqual(result[1].id, "first", "first Q2 item should come before second Q2 item");
    assert.strictEqual(result[2].id, "second");
  });
});

describe("dedupeWorkItems", () => {
  it("different type, same id are kept (not considered duplicates)", () => {
    const items = [
      { type: "order", id: "abc" },
      { type: "user_task", id: "abc" },
    ];
    const result = dedupeWorkItems(items);
    assert.strictEqual(result.length, 2, "order:abc and user_task:abc must both survive");
  });

  it("same type+id: only first occurrence is kept", () => {
    const items = [
      { type: "order", id: "x", extra: 1 },
      { type: "order", id: "x", extra: 2 },
    ];
    const result = dedupeWorkItems(items);
    assert.strictEqual(result.length, 1);
    assert.strictEqual((result[0] as typeof items[0]).extra, 1, "first occurrence must be preserved");
  });

  it("returns empty array for empty input", () => {
    assert.deepStrictEqual(dedupeWorkItems([]), []);
  });
});

describe("computeRetryDelay", () => {
  it("count=0 returns 0 (immediate first retry)", () => {
    assert.strictEqual(computeRetryDelay(0), 0);
  });

  it("count=1 returns 30_000", () => {
    assert.strictEqual(computeRetryDelay(1), 30_000);
  });

  it("count=4 returns 7_200_000 (2h)", () => {
    assert.strictEqual(computeRetryDelay(4), 2 * 3600_000);
  });

  it("count=5 returns null (exhausted)", () => {
    assert.strictEqual(computeRetryDelay(5), null);
  });

  it("count=-1 returns null (negative treated as exhausted)", () => {
    assert.strictEqual(computeRetryDelay(-1), null);
  });

  it("uses RETRY_INTERVALS as default intervals", () => {
    for (let i = 0; i < RETRY_INTERVALS.length; i++) {
      assert.strictEqual(computeRetryDelay(i), RETRY_INTERVALS[i]);
    }
  });

  it("accepts a custom intervals array", () => {
    const custom = [100, 200, 300] as const;
    assert.strictEqual(computeRetryDelay(0, custom), 100);
    assert.strictEqual(computeRetryDelay(2, custom), 300);
    assert.strictEqual(computeRetryDelay(3, custom), null);
  });
});
