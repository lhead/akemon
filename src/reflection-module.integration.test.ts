import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ReflectionModule } from "./reflection-module.js";
import { loadDiscoveries } from "./self.js";
import type {
  EventBus,
  EventHandler,
  ModuleContext,
  Signal,
  ComputeResult,
  Peripheral,
} from "./types.js";
import { SIG } from "./types.js";

// ---------------------------------------------------------------------------
// Fake helpers
// ---------------------------------------------------------------------------

class FakeBus implements EventBus {
  private handlers = new Map<string, Array<EventHandler>>();
  emitted: Signal[] = [];

  on(event: string, fn: EventHandler): void {
    const arr = this.handlers.get(event) ?? [];
    arr.push(fn);
    this.handlers.set(event, arr);
  }

  off(event: string, fn: EventHandler): void {
    const arr = this.handlers.get(event) ?? [];
    this.handlers.set(event, arr.filter(h => h !== fn));
  }

  emit(event: string, s: Signal): void {
    this.emitted.push(s);
    (this.handlers.get(event) ?? []).forEach(fn => fn(s));
  }
}

function makeCtx(
  workdir: string,
  agentName: string,
  bus: FakeBus,
  computeResponses: ComputeResult[],
): { ctx: ModuleContext; computeCalls: Array<{ context: string; question: string; priority: string }> } {
  let callIdx = 0;
  const computeCalls: Array<{ context: string; question: string; priority: string }> = [];
  const ctx: ModuleContext = {
    workdir,
    agentName,
    bus,
    requestCompute: async (req) => {
      computeCalls.push({ context: req.context, question: req.question, priority: req.priority });
      return (computeResponses[callIdx++] ?? { success: false }) as ComputeResult;
    },
    getPeripherals: (_capability: string): Peripheral[] => [],
    sendTo: async (_capability: string, _signal: Signal): Promise<Signal | null> => null,
    getPromptContributions: (): string[] => [],
  };
  return { ctx, computeCalls };
}

/** Drain pending microtasks + I/O by waiting n setImmediate ticks. */
async function flush(n = 8): Promise<void> {
  for (let i = 0; i < n; i++) {
    await new Promise<void>(r => setImmediate(r));
  }
}

/** Wait ms milliseconds — for fire-and-forget chains with multiple sequential I/O steps. */
function wait(ms: number): Promise<void> {
  return new Promise<void>(r => setTimeout(r, ms));
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("ReflectionModule reflect integration", () => {

  it("self_cycle=false → start does not schedule reflect, stop does not throw", async () => {
    const tmpDir = await mkdtemp(join(tmpdir(), "akemon-refl-"));
    try {
      const agentName = "test-agent";
      const agentDir = join(tmpDir, ".akemon", "agents", agentName);
      await mkdir(agentDir, { recursive: true });
      await writeFile(join(agentDir, "config.json"), JSON.stringify({ self_cycle: false }));

      const bus = new FakeBus();
      const { ctx, computeCalls } = makeCtx(tmpDir, agentName, bus, []);
      const mod = new ReflectionModule();

      await mod.start(ctx);
      await flush();

      assert.strictEqual(computeCalls.length, 0, "no compute calls expected when self_cycle=false");
      await assert.doesNotReject(() => mod.stop());
    } finally {
      await rm(tmpDir, { recursive: true, force: true });
    }
  });

  it("single TASK_FAILED does not trigger reflect (below threshold of 2)", async () => {
    const tmpDir = await mkdtemp(join(tmpdir(), "akemon-refl-"));
    try {
      const agentName = "test-agent";
      const bus = new FakeBus();
      const { ctx, computeCalls } = makeCtx(tmpDir, agentName, bus, []);
      const mod = new ReflectionModule();

      await mod.start(ctx);

      bus.emit(SIG.TASK_FAILED, { type: SIG.TASK_FAILED, data: { taskLabel: "a", error: "oops" } });
      await flush();

      assert.strictEqual(computeCalls.length, 0, "one failure must not trigger reflect");
      await mod.stop();
    } finally {
      await rm(tmpDir, { recursive: true, force: true });
    }
  });

  it("two TASK_FAILED events trigger reflect and save discoveries to disk", async () => {
    const tmpDir = await mkdtemp(join(tmpdir(), "akemon-refl-"));
    try {
      const agentName = "test-agent";
      // Self dir must exist for saveDiscoveries to write successfully
      await mkdir(join(tmpDir, ".akemon", "agents", agentName, "self"), { recursive: true });

      const bus = new FakeBus();
      const response = JSON.stringify({
        discoveries: [{ capability: "X", confidence: 0.7, evidence: "Y" }],
      });
      const { ctx, computeCalls } = makeCtx(tmpDir, agentName, bus, [
        { success: true, response },
      ]);
      const mod = new ReflectionModule();

      await mod.start(ctx);

      bus.emit(SIG.TASK_FAILED, { type: SIG.TASK_FAILED, data: { taskLabel: "task1", error: "err1" } });
      bus.emit(SIG.TASK_FAILED, { type: SIG.TASK_FAILED, data: { taskLabel: "task2", error: "err2" } });
      await flush();

      assert.strictEqual(computeCalls.length, 1, "reflect should call requestCompute exactly once");

      const discoveries = await loadDiscoveries(tmpDir, agentName);
      assert.ok(discoveries.length > 0, "at least one discovery should be saved");
      assert.ok(
        discoveries.some(d => d.capability === "X"),
        "saved discovery should have capability='X'",
      );

      await mod.stop();
    } finally {
      await rm(tmpDir, { recursive: true, force: true });
    }
  });

  it("unparseable compute response → no crash, recentFailures cleared, no discoveries saved", async () => {
    const tmpDir = await mkdtemp(join(tmpdir(), "akemon-refl-"));
    try {
      const agentName = "test-agent";
      const bus = new FakeBus();
      const { ctx, computeCalls } = makeCtx(tmpDir, agentName, bus, [
        { success: true, response: "this is not json at all" },
      ]);
      const mod = new ReflectionModule();

      await mod.start(ctx);

      bus.emit(SIG.TASK_FAILED, { type: SIG.TASK_FAILED, data: { taskLabel: "x1", error: "e1" } });
      bus.emit(SIG.TASK_FAILED, { type: SIG.TASK_FAILED, data: { taskLabel: "x2", error: "e2" } });
      await flush();

      assert.strictEqual(computeCalls.length, 1, "reflect should still have run");

      const state = mod.getState();
      assert.strictEqual(
        state["recentFailures"],
        0,
        "recentFailures should be cleared even when response is unparseable",
      );

      const discoveries = await loadDiscoveries(tmpDir, agentName);
      assert.strictEqual(discoveries.length, 0, "no discoveries should be saved for bad response");

      await mod.stop();
    } finally {
      await rm(tmpDir, { recursive: true, force: true });
    }
  });

  it("TASK_COMPLETED with success=true and productName appends experience to playbook", async () => {
    const tmpDir = await mkdtemp(join(tmpdir(), "akemon-refl-"));
    try {
      const agentName = "test-agent";
      const selfBase = join(tmpDir, ".akemon", "agents", agentName, "self");
      const pbDir = join(selfBase, "playbooks");
      const prodDir = join(selfBase, "products");
      await mkdir(pbDir, { recursive: true });
      await mkdir(prodDir, { recursive: true });

      await writeFile(
        join(prodDir, "widget.md"),
        "# Widget\n\n## playbook\nwidget-pb\n\n## products\n- p_w1\n",
      );
      await writeFile(
        join(pbDir, "widget-pb.md"),
        "# Widget Playbook\n\n## 经验\n",
      );

      const bus = new FakeBus();
      const { ctx } = makeCtx(tmpDir, agentName, bus, []);
      const mod = new ReflectionModule();

      await mod.start(ctx);

      bus.emit(SIG.TASK_COMPLETED, {
        type: SIG.TASK_COMPLETED,
        data: { success: true, productName: "widget", taskLabel: "deliver-logo", creditsEarned: 3 },
      });
      // Fire-and-forget handler — appendPlaybookExperience chains several sequential I/O ops
      // (readdir + readFile per directory in loadMdFiles). Use a time-based wait to be safe.
      await wait(100);

      const content = await readFile(join(pbDir, "widget-pb.md"), "utf-8");
      assert.ok(content.includes("widget"), "playbook should contain productName");
      assert.ok(content.includes("deliver-logo"), "playbook should contain taskLabel");
      assert.ok(content.includes("earned 3¢"), "playbook should contain credits");

      await mod.stop();
    } finally {
      await rm(tmpDir, { recursive: true, force: true });
    }
  });
});
