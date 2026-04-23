import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { describe, it } from "node:test";
import { PassThrough } from "node:stream";
import type { ChildProcess } from "node:child_process";
import { EnginePeripheral } from "./engine-peripheral.js";

type StreamEvent =
  | { type: "start"; taskId: string; origin?: string; cmd: string }
  | { type: "stream"; taskId: string; stream: "stdout" | "stderr"; chunk: string }
  | { type: "end"; taskId: string; exitCode: number | null; durationMs: number };

function createFakeChild(): ChildProcess {
  const child = new EventEmitter() as EventEmitter & ChildProcess;
  child.stdin = new PassThrough();
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  Object.defineProperty(child, "pid", { value: 12345, configurable: true });
  child.unref = () => child;
  return child;
}

describe("Engine stream publish", () => {
  it("publishes task lifecycle and stdout/stderr chunks", async () => {
    const events: StreamEvent[] = [];
    let spawnedChild: ChildProcess | null = null;

    const engine = new EnginePeripheral({
      engine: "claude",
      workdir: "/tmp",
      spawnImpl: ((cmd, args) => {
        assert.equal(cmd, "claude");
        assert.deepEqual(args, ["--print"]);

        const child = createFakeChild();
        spawnedChild = child;

        queueMicrotask(() => {
          child.stdout?.emit("data", Buffer.from("hello "));
          child.stderr?.emit("data", Buffer.from("warn"));
          child.stdout?.emit("data", Buffer.from("world"));
          child.emit("close", 0, null);
        });

        return child;
      }) as typeof import("node:child_process").spawn,
      taskRelay: {
        sendTaskStart(taskId, origin, cmd) {
          events.push({ type: "start", taskId, origin, cmd });
        },
        sendTaskStream(taskId, stream, chunk) {
          events.push({ type: "stream", taskId, stream, chunk });
        },
        sendTaskEnd(taskId, exitCode, durationMs) {
          events.push({ type: "end", taskId, exitCode, durationMs });
        },
      },
    });

    const result = await engine.runEngine("say hello", false, undefined, undefined, "user_manual", undefined, "order-123");

    assert.equal(result, "hello world");
    assert.ok(spawnedChild, "spawn should be called");

    assert.deepEqual(events.slice(0, 4), [
      { type: "start", taskId: "order-123", origin: "user_manual", cmd: "claude --print" },
      { type: "stream", taskId: "order-123", stream: "stdout", chunk: "hello " },
      { type: "stream", taskId: "order-123", stream: "stderr", chunk: "warn" },
      { type: "stream", taskId: "order-123", stream: "stdout", chunk: "world" },
    ]);

    const end = events[4];
    assert.equal(end?.type, "end");
    if (end?.type === "end") {
      assert.equal(end.taskId, "order-123");
      assert.equal(end.exitCode, 0);
      assert.ok(end.durationMs >= 0);
    }
  });

  it("generates a task id when caller does not provide one", async () => {
    const events: StreamEvent[] = [];

    const engine = new EnginePeripheral({
      engine: "opencode",
      workdir: "/tmp",
      spawnImpl: (() => {
        const child = createFakeChild();
        queueMicrotask(() => {
          child.stdout?.emit("data", Buffer.from("done"));
          child.emit("close", 0, null);
        });
        return child;
      }) as typeof import("node:child_process").spawn,
      taskRelay: {
        sendTaskStart(taskId, origin, cmd) {
          events.push({ type: "start", taskId, origin, cmd });
        },
        sendTaskStream(taskId, stream, chunk) {
          events.push({ type: "stream", taskId, stream, chunk });
        },
        sendTaskEnd(taskId, exitCode, durationMs) {
          events.push({ type: "end", taskId, exitCode, durationMs });
        },
      },
    });

    const result = await engine.runEngine("say hello", false, undefined, undefined, "platform");

    assert.equal(result, "done");
    assert.equal(events[0]?.type, "start");
    if (events[0]?.type === "start") {
      assert.match(events[0].taskId, /^task_/);
      assert.equal(events[0].origin, "platform");
      assert.equal(events[0].cmd, "opencode run say hello");
    }
    assert.equal(events[2]?.type, "end");
    if (events[2]?.type === "end" && events[0]?.type === "start") {
      assert.equal(events[2].taskId, events[0].taskId);
      assert.equal(events[2].exitCode, 0);
    }
  });
});
