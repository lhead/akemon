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

  it("redacts secrets before persisting event log lines", async () => {
    const path = join(tmpDir, "events.jsonl");
    const bus = new PersistentEventBus(new FileEventLog(path));
    const apiKey = "sk-123456789012345678901234";

    bus.emit("custom:event", sig("custom:event", {
      secretKey: "ak_secret_should_not_persist",
      message: `OPENAI_API_KEY=${apiKey}`,
      tokenLimit: 1000,
    }, "test"));

    const logged = JSON.parse((await readFile(path, "utf-8")).trim());
    assert.equal(logged.s.data.secretKey, "[REDACTED]");
    assert.equal(logged.s.data.tokenLimit, 1000);
    assert.doesNotMatch(JSON.stringify(logged), new RegExp(apiKey));
    assert.doesNotMatch(JSON.stringify(logged), /ak_secret_should_not_persist/);
  });

  it("rotates event logs when the size cap is reached", async () => {
    const path = join(tmpDir, "events.jsonl");
    const bus = new PersistentEventBus(new FileEventLog(path, { maxBytes: 80, maxFiles: 2 }));

    bus.emit("custom:event", sig("custom:event", { n: 1, text: "x".repeat(80) }, "test"));
    bus.emit("custom:event", sig("custom:event", { n: 2, text: "x".repeat(80) }, "test"));
    bus.emit("custom:event", sig("custom:event", { n: 3, text: "x".repeat(80) }, "test"));

    const current = JSON.parse((await readFile(path, "utf-8")).trim());
    const previous = JSON.parse((await readFile(join(tmpDir, "events.1.jsonl"), "utf-8")).trim());
    const older = JSON.parse((await readFile(join(tmpDir, "events.2.jsonl"), "utf-8")).trim());

    assert.equal(current.s.data.n, 3);
    assert.equal(previous.s.data.n, 2);
    assert.equal(older.s.data.n, 1);
  });

  it("replays rotated event logs from oldest to newest", async () => {
    const path = join(tmpDir, "events.jsonl");
    const bus = new PersistentEventBus(new FileEventLog(path, { maxBytes: 80, maxFiles: 1 }));

    bus.emit("custom:event", sig("custom:event", { n: 1, text: "x".repeat(80) }, "test"));
    bus.emit("custom:event", sig("custom:event", { n: 2, text: "x".repeat(80) }, "test"));
    bus.emit("custom:event", sig("custom:event", { n: 3, text: "x".repeat(80) }, "test"));

    const recovered = new PersistentEventBus(new FileEventLog(path, { maxBytes: 80, maxFiles: 1 }));
    const seen: number[] = [];
    recovered.on("custom:event", (signal) => {
      seen.push(Number(signal.data.n));
    });

    const count = await recovered.recover();

    assert.equal(count, 2);
    assert.deepEqual(seen, [2, 3]);
  });
});
