import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, readFile, appendFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FileEventLog, PersistentEventBus } from "./event-bus.js";
import { SIG, sig } from "./types.js";

describe("PersistentEventBus", () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), "akemon-event-bus-"));
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  it("appends emitted events and still dispatches handlers", async () => {
    const path = join(tmpDir, "events.jsonl");
    const bus = new PersistentEventBus(new FileEventLog(path));

    const seen: string[] = [];
    bus.on(SIG.AGENT_START, (signal) => {
      seen.push(String(signal.data.agentName));
    });

    bus.emit(SIG.AGENT_START, sig(SIG.AGENT_START, { agentName: "momo" }, "test"));

    assert.deepEqual(seen, ["momo"]);

    const lines = (await readFile(path, "utf-8")).trim().split("\n");
    assert.equal(lines.length, 1);
    const logged = JSON.parse(lines[0]);
    assert.equal(logged.e, SIG.AGENT_START);
    assert.equal(logged.s.type, SIG.AGENT_START);
    assert.equal(logged.s.data.agentName, "momo");
    assert.equal(logged.s.source, "test");
  });

  it("recovers valid logged events without appending duplicates", async () => {
    const path = join(tmpDir, "events.jsonl");
    await appendFile(path, JSON.stringify({
      e: "custom:event",
      s: { type: "custom:event", data: { n: 1 }, source: "fixture" },
    }) + "\n");
    await appendFile(path, "not-json\n");

    const bus = new PersistentEventBus(new FileEventLog(path));
    const seen: number[] = [];
    bus.on("custom:event", (signal) => {
      seen.push(Number(signal.data.n));
    });

    const count = await bus.recover();

    assert.equal(count, 1);
    assert.deepEqual(seen, [1]);

    const lines = (await readFile(path, "utf-8")).trim().split("\n");
    assert.equal(lines.length, 2);
  });
});
