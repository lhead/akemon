import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { PassThrough } from "node:stream";
import type { ChildProcess } from "node:child_process";
import {
  CodexSoftwareAgentPeripheral,
  buildTaskEnvelopePrompt,
  createOwnerTaskEnvelope,
  listSoftwareAgentTaskRecords,
  resolveWorkdirSafety,
  summarizeText,
  type GitWorktreeStatus,
  type TaskEnvelope,
} from "./software-agent-peripheral.js";
import { SimpleEventBus } from "./event-bus.js";
import { SIG } from "./types.js";

type StreamEvent =
  | { type: "start"; taskId: string; origin?: string; cmd: string }
  | { type: "stream"; taskId: string; stream: "stdout" | "stderr"; chunk: string }
  | { type: "end"; taskId: string; exitCode: number | null; durationMs: number };

function createFakeChild(): ChildProcess {
  const child = new EventEmitter() as EventEmitter & ChildProcess;
  child.stdin = new PassThrough();
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  Object.defineProperty(child, "pid", { value: 23456, configurable: true });
  child.unref = () => child;
  return child;
}

function baseEnvelope(overrides: Partial<TaskEnvelope> = {}): TaskEnvelope {
  return {
    taskId: "sw-test-1",
    sourceModule: "task",
    purpose: "dogfood coding task",
    goal: "Inspect the repo and summarize the event bus implementation.",
    workdir: "/tmp/akemon",
    roleScope: "owner",
    memoryScope: "owner",
    riskLevel: "medium",
    allowedActions: ["read repository files", "run tests"],
    forbiddenActions: ["read owner private notes outside this envelope"],
    memorySummary: "Visible context only.",
    deliverable: "Concise engineering report.",
    ...overrides,
  };
}

describe("buildTaskEnvelopePrompt", () => {
  it("renders envelope fields, visible memory, boundaries, and deliverable", () => {
    const prompt = buildTaskEnvelopePrompt(baseEnvelope({
      workdirSafety: {
        baseWorkdir: "/tmp",
        requestedWorkdir: "/tmp/akemon",
        effectiveWorkdir: "/tmp/akemon",
        allowOutsideWorkdir: false,
        outsideBaseWorkdir: false,
      },
      workMemoryDir: "/tmp/akemon/.akemon/agents/momo/work",
      workMemoryContext: "# Akemon Work Memory Context\n\nKeep Codex focused on work memory.",
    }));

    assert.match(prompt, /Task ID: sw-test-1/);
    assert.match(prompt, /Source module: task/);
    assert.match(prompt, /Role scope: owner/);
    assert.match(prompt, /Memory scope: owner/);
    assert.match(prompt, /Risk level: medium/);
    assert.match(prompt, /Workdir: \/tmp\/akemon/);
    assert.match(prompt, /Work memory directory: \/tmp\/akemon\/\.akemon\/agents\/momo\/work/);
    assert.match(prompt, /Base workdir: \/tmp/);
    assert.match(prompt, /Outside base workdir: no/);
    assert.match(prompt, /Visible context only\./);
    assert.match(prompt, /Included work-memory context:/);
    assert.match(prompt, /Keep Codex focused on work memory/);
    assert.match(prompt, /- read repository files/);
    assert.match(prompt, /- read owner private notes outside this envelope/);
    assert.match(prompt, /Concise engineering report\./);
    assert.match(prompt, /Do not attempt to read Akemon private memory outside the visible context/);
    assert.match(prompt, /Do not read or edit Akemon self memory/);
    assert.match(prompt, /akemon work-note/);
  });
});

describe("createOwnerTaskEnvelope", () => {
  it("builds conservative owner defaults from a minimal body", () => {
    const envelope = createOwnerTaskEnvelope({ goal: "  inspect repo  " }, "/repo");

    assert.equal(envelope.sourceModule, "owner-http");
    assert.equal(envelope.goal, "inspect repo");
    assert.equal(envelope.workdir, "/repo");
    assert.deepEqual(envelope.workdirSafety, {
      baseWorkdir: "/repo",
      requestedWorkdir: "/repo",
      effectiveWorkdir: "/repo",
      allowOutsideWorkdir: false,
      outsideBaseWorkdir: false,
    });
    assert.equal(envelope.roleScope, "owner");
    assert.equal(envelope.memoryScope, "owner");
    assert.equal(envelope.riskLevel, "medium");
    assert.equal(envelope.contextSessionId, undefined);
    assert.deepEqual(envelope.allowedActions, ["read repository files", "edit files in workdir", "run project tests"]);
    assert.ok(envelope.forbiddenActions?.some((item) => item.includes("private memory")));
  });

  it("keeps software-agent workdirs inside the default workdir unless explicitly allowed", () => {
    assert.equal(resolveWorkdirSafety("/repo", "src").effectiveWorkdir, "/repo/src");

    const inside = createOwnerTaskEnvelope({ goal: "inspect repo", workdir: "packages/app" }, "/repo");
    assert.equal(inside.workdir, "/repo/packages/app");
    assert.equal(inside.workdirSafety?.baseWorkdir, "/repo");
    assert.equal(inside.workdirSafety?.requestedWorkdir, "packages/app");
    assert.equal(inside.workdirSafety?.outsideBaseWorkdir, false);

    assert.throws(
      () => createOwnerTaskEnvelope({ goal: "inspect repo", workdir: "/outside" }, "/repo"),
      /outside base workdir/,
    );

    const outside = createOwnerTaskEnvelope({
      goal: "inspect repo",
      workdir: "/outside",
      allowOutsideWorkdir: true,
    }, "/repo");
    assert.equal(outside.workdir, "/outside");
    assert.equal(outside.workdirSafety?.outsideBaseWorkdir, true);
    assert.equal(outside.workdirSafety?.allowOutsideWorkdir, true);

    assert.throws(
      () => createOwnerTaskEnvelope({ goal: "inspect repo", allowOutsideWorkdir: "yes" }, "/repo"),
      /Invalid allowOutsideWorkdir/,
    );
  });

  it("keeps baseline forbidden boundaries when caller adds restrictions", () => {
    const envelope = createOwnerTaskEnvelope({
      goal: "inspect repo",
      forbiddenActions: ["make network requests", "read Akemon private memory outside this envelope"],
    }, "/repo");

    assert.deepEqual(envelope.forbiddenActions, [
      "read Akemon private memory outside this envelope",
      "access files outside the stated workdir unless explicitly needed and reported",
      "make network requests",
    ]);
  });

  it("rejects empty goals", () => {
    assert.throws(() => createOwnerTaskEnvelope({ goal: "   " }, "/repo"), /Missing required string field: goal/);
  });

  it("rejects invalid scope, action, and timeout fields", () => {
    assert.throws(
      () => createOwnerTaskEnvelope({ goal: "inspect repo", roleScope: "friend" }, "/repo"),
      /Invalid roleScope/,
    );
    assert.throws(
      () => createOwnerTaskEnvelope({ goal: "inspect repo", memoryScope: "private" }, "/repo"),
      /Invalid memoryScope/,
    );
    assert.throws(
      () => createOwnerTaskEnvelope({ goal: "inspect repo", riskLevel: "critical" }, "/repo"),
      /Invalid riskLevel/,
    );
    assert.throws(
      () => createOwnerTaskEnvelope({ goal: "inspect repo", allowedActions: ["read", ""] }, "/repo"),
      /Invalid allowedActions\[1\]/,
    );
    assert.throws(
      () => createOwnerTaskEnvelope({ goal: "inspect repo", contextSessionId: "../bad" }, "/repo"),
      /Invalid contextSessionId/,
    );
    assert.throws(
      () => createOwnerTaskEnvelope({ goal: "inspect repo", timeoutMs: 0 }, "/repo"),
      /Invalid timeoutMs/,
    );
  });
});

describe("CodexSoftwareAgentPeripheral", () => {
  it("runs codex exec with an envelope over stdin and streams lifecycle events", async () => {
    const streamEvents: StreamEvent[] = [];
    const observerEvents: string[] = [];
    const busEvents: string[] = [];
    let writtenPrompt = "";
    let spawnedChild: ChildProcess | null = null;

    const bus = new SimpleEventBus();
    bus.on(SIG.TASK_STARTED, (signal) => {
      busEvents.push(`${signal.type}:${signal.data.taskId}`);
    });
    bus.on(SIG.TASK_COMPLETED, (signal) => {
      busEvents.push(`${signal.type}:${signal.data.taskId}`);
    });

    const peripheral = new CodexSoftwareAgentPeripheral({
      workdir: "/tmp/akemon",
      command: "codex",
      workMemoryDir: "/tmp/akemon/.akemon/agents/momo/work",
      spawnImpl: ((cmd, args, opts) => {
        assert.equal(cmd, "codex");
        assert.deepEqual(args, [
          "exec",
          "--skip-git-repo-check",
          "--color", "never",
          "-s", "workspace-write",
          "-C", "/tmp/akemon",
          "-",
        ]);
        assert.equal(opts?.cwd, "/tmp/akemon");
        assert.equal(opts?.env, process.env);

        const child = createFakeChild();
        spawnedChild = child;
        child.stdin?.on("data", (chunk: Buffer) => {
          writtenPrompt += chunk.toString("utf8");
        });

        queueMicrotask(() => {
          child.stdout?.emit("data", Buffer.from("result "));
          child.stderr?.emit("data", Buffer.from("note"));
          child.stdout?.emit("data", Buffer.from("ok"));
          child.emit("close", 0);
        });

        return child;
      }) as typeof import("node:child_process").spawn,
      taskRelay: {
        sendTaskStart(taskId, origin, cmd) {
          streamEvents.push({ type: "start", taskId, origin, cmd });
        },
        sendTaskStream(taskId, stream, chunk) {
          streamEvents.push({ type: "stream", taskId, stream, chunk });
        },
        sendTaskEnd(taskId, exitCode, durationMs) {
          streamEvents.push({ type: "end", taskId, exitCode, durationMs });
        },
      },
    });
    await peripheral.start(bus);

    const result = await peripheral.sendTask(baseEnvelope(), {
      observer: {
        onStart(event) {
          observerEvents.push(`start:${event.taskId}:${event.commandLine}:${event.contextSessionId}:${event.workMemoryDir}`);
        },
        onStream(event) {
          observerEvents.push(`${event.stream}:${event.chunk}`);
        },
        onEnd(event) {
          observerEvents.push(`end:${event.taskId}:${event.result.success}:${event.contextSessionId}:${event.workMemoryDir}`);
        },
      },
    });

    assert.ok(spawnedChild, "spawn should be called");
    assert.equal(result.success, true);
    assert.equal(result.taskId, "sw-test-1");
    assert.equal(result.output, "result ok");
    assert.equal(result.exitCode, 0);

    assert.match(writtenPrompt, /Akemon Software Peripheral Task Envelope/);
    assert.match(writtenPrompt, /Goal:\nInspect the repo/);
    assert.match(writtenPrompt, /Visible context only\./);
    assert.match(writtenPrompt, /Work memory directory: \/tmp\/akemon\/\.akemon\/agents\/momo\/work/);

    assert.deepEqual(streamEvents.slice(0, 4), [
      {
        type: "start",
        taskId: "sw-test-1",
        origin: "software_agent",
        cmd: "codex exec --skip-git-repo-check --color never -s workspace-write -C /tmp/akemon -",
      },
      { type: "stream", taskId: "sw-test-1", stream: "stdout", chunk: "result " },
      { type: "stream", taskId: "sw-test-1", stream: "stderr", chunk: "note" },
      { type: "stream", taskId: "sw-test-1", stream: "stdout", chunk: "ok" },
    ]);
    const end = streamEvents[4];
    assert.equal(end?.type, "end");
    if (end?.type === "end") {
      assert.equal(end.taskId, "sw-test-1");
      assert.equal(end.exitCode, 0);
      assert.ok(end.durationMs >= 0);
    }
    assert.deepEqual(observerEvents, [
      "start:sw-test-1:codex exec --skip-git-repo-check --color never -s workspace-write -C /tmp/akemon -:sw-test-1:/tmp/akemon/.akemon/agents/momo/work",
      "stdout:result ",
      "stderr:note",
      "stdout:ok",
      "end:sw-test-1:true:sw-test-1:/tmp/akemon/.akemon/agents/momo/work",
    ]);

    assert.deepEqual(busEvents, [
      "task:started:sw-test-1",
      "task:completed:sw-test-1",
    ]);
  });

  it("rejects concurrent tasks while a codex run is active", async () => {
    const peripheral = new CodexSoftwareAgentPeripheral({
      workdir: "/tmp/akemon",
      spawnImpl: (() => {
        const child = createFakeChild();
        setTimeout(() => child.emit("close", 0), 10);
        return child;
      }) as typeof import("node:child_process").spawn,
      taskRelay: {
        sendTaskStart() {},
        sendTaskStream() {},
        sendTaskEnd() {},
      },
    });

    const first = peripheral.sendTask(baseEnvelope({ taskId: "first" }));
    await assert.rejects(
      () => peripheral.sendTask(baseEnvelope({ taskId: "second" })),
      /Software agent busy/,
    );

    await first;
  });

  it("reports git workdir status in peripheral state", () => {
    const status: GitWorktreeStatus = {
      workdir: "/tmp/akemon",
      isRepo: true,
      dirty: true,
      changedFiles: ["src/software-agent-peripheral.ts"],
      root: "/tmp/akemon",
    };
    const peripheral = new CodexSoftwareAgentPeripheral({
      workdir: "/tmp/akemon",
      gitStatusImpl: () => status,
    });

    const state = peripheral.getState();

    assert.equal(state.baseWorkdir, "/tmp/akemon");
    assert.equal(state.activeWorkdir, null);
    assert.equal(state.busy, false);
    assert.deepEqual(state.workdirStatus, status);
    assert.deepEqual(state.environment, { policy: "inherit" });
  });

  it("records task ledger state from running to completed", async () => {
    const tmpDir = await mkdtemp(join(tmpdir(), "akemon-software-agent-ledger-"));
    try {
      const spawnedChild = createFakeChild();
      const ledgerDir = join(tmpDir, "tasks");
      const workdirStatus: GitWorktreeStatus = {
        workdir: "/tmp/akemon",
        isRepo: true,
        dirty: true,
        changedFiles: ["src/software-agent-peripheral.ts"],
        root: "/tmp/akemon",
      };
      const peripheral = new CodexSoftwareAgentPeripheral({
        workdir: "/tmp/akemon",
        spawnImpl: (() => {
          return spawnedChild;
        }) as typeof import("node:child_process").spawn,
        taskRelay: {
          sendTaskStart() {},
          sendTaskStream() {},
          sendTaskEnd() {},
        },
        taskLedgerDir: ledgerDir,
        gitStatusImpl: () => workdirStatus,
      });

      const run = peripheral.sendTask(baseEnvelope({ taskId: "ledger-running" }));
      const path = join(ledgerDir, "ledger-running.json");
      const running = JSON.parse(await readFile(path, "utf-8"));

      assert.equal(running.schemaVersion, 1);
      assert.equal(running.status, "running");
      assert.equal(running.taskId, "ledger-running");
      assert.equal(running.envelope.goal, "Inspect the repo and summarize the event bus implementation.");
      assert.equal(running.transport, "codex-exec");
      assert.deepEqual(running.environment, { policy: "inherit" });
      assert.deepEqual(running.workdirStatus, workdirStatus);

      spawnedChild.stdout?.emit("data", Buffer.from("ledger result"));
      spawnedChild.stderr?.emit("data", Buffer.from("ledger note"));
      spawnedChild.emit("close", 0);

      const result = await run;
      const completed = JSON.parse(await readFile(path, "utf-8"));

      assert.equal(result.success, true);
      assert.equal(completed.status, "completed");
      assert.equal(completed.result.success, true);
      assert.equal(completed.result.exitCode, 0);
      assert.equal(completed.stdoutSummary.text, "ledger result");
      assert.equal(completed.stderrSummary.text, "ledger note");
      assert.equal(completed.stdoutSummary.truncated, false);
      assert.deepEqual(completed.workdirStatus, workdirStatus);
      assert.ok(completed.completedAt);
      assert.ok(completed.durationMs >= 0);
    } finally {
      await rm(tmpDir, { recursive: true, force: true });
    }
  });

  it("writes a context packet and carries previous summary across explicit Akemon sessions", async () => {
    const tmpDir = await mkdtemp(join(tmpdir(), "akemon-software-agent-context-"));
    try {
      const contextSessionDir = join(tmpDir, "sessions");
      const ledgerDir = join(tmpDir, "tasks");
      const children: ChildProcess[] = [];
      const prompts: string[] = [];
      const peripheral = new CodexSoftwareAgentPeripheral({
        workdir: "/tmp/akemon",
        contextSessionDir,
        taskLedgerDir: ledgerDir,
        workMemoryDir: "/tmp/akemon/.akemon/agents/momo/work",
        spawnImpl: (() => {
          const index = prompts.length;
          prompts.push("");
          const child = createFakeChild();
          child.stdin?.on("data", (chunk: Buffer) => {
            prompts[index] += chunk.toString("utf8");
          });
          children.push(child);
          return child;
        }) as typeof import("node:child_process").spawn,
        taskRelay: {
          sendTaskStart() {},
          sendTaskStream() {},
          sendTaskEnd() {},
        },
      });

      const first = peripheral.sendTask(baseEnvelope({
        taskId: "ctx-1",
        contextSessionId: "project-alpha",
        memorySummary: "Visible context only.",
      }));
      children[0].stdout?.emit("data", Buffer.from("first result"));
      children[0].emit("close", 0);
      await first;

      const packetPath = join(contextSessionDir, "project-alpha", "TASK_CONTEXT.md");
      const statePath = join(contextSessionDir, "project-alpha", "SESSION.json");
      const firstPacket = await readFile(packetPath, "utf-8");
      const firstState = JSON.parse(await readFile(statePath, "utf-8"));

      assert.match(prompts[0], /Read the context packet first/);
      assert.match(prompts[0], new RegExp(packetPath.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
      assert.doesNotMatch(prompts[0], /Visible context only/);
      assert.match(firstPacket, /Akemon context session: project-alpha/);
      assert.match(firstPacket, /Work memory directory: \/tmp\/akemon\/\.akemon\/agents\/momo\/work/);
      assert.match(firstPacket, /Visible context only\./);
      assert.equal(firstState.sessionId, "project-alpha");
      assert.equal(firstState.workMemoryDir, "/tmp/akemon/.akemon/agents/momo/work");
      assert.equal(firstState.lastTaskId, "ctx-1");
      assert.equal(firstState.lastResult.outputSummary.text, "first result");

      const second = peripheral.sendTask(baseEnvelope({
        taskId: "ctx-2",
        contextSessionId: "project-alpha",
        goal: "Continue the same investigation.",
        memorySummary: "Second visible context.",
      }));
      children[1].stdout?.emit("data", Buffer.from("second result"));
      children[1].emit("close", 0);
      await second;

      const secondPacket = await readFile(packetPath, "utf-8");
      const secondRecord = JSON.parse(await readFile(join(ledgerDir, "ctx-2.json"), "utf-8"));

      assert.match(secondPacket, /Previous task summary for this Akemon context session/);
      assert.match(secondPacket, /Previous task: ctx-1/);
      assert.match(secondPacket, /first result/);
      assert.equal(secondRecord.contextSession.sessionId, "project-alpha");
      assert.equal(secondRecord.contextSession.packetPath, packetPath);
      assert.equal(secondRecord.envelope.contextPacketPath, packetPath);
      assert.match(prompts[1], /Continue the same investigation/);
      assert.doesNotMatch(prompts[1], /first result/);
    } finally {
      await rm(tmpDir, { recursive: true, force: true });
    }
  });

  it("can run codex with an allowlisted child environment and records no env values", async () => {
    const tmpDir = await mkdtemp(join(tmpdir(), "akemon-software-agent-env-"));
    try {
      const spawnedChild = createFakeChild();
      const ledgerDir = join(tmpDir, "tasks");
      const openAiKey = "sk-123456789012345678901234";
      const sourceEnv: NodeJS.ProcessEnv = {
        PATH: "/usr/bin",
        HOME: "/Users/tester",
        SHELL: "/bin/zsh",
        USER: "tester",
        TMPDIR: "/tmp",
        CODEX_HOME: "/Users/tester/.codex",
        OPENAI_API_KEY: openAiKey,
        UNLISTED_ALLOWED: "custom-value",
        AKEMON_KEY: "owner-secret",
        AKEMON_RAW_KEY: "raw-secret",
        RELAY_OWNER_TOKEN: "relay-secret",
        NOT_ALLOWED: "hidden-value",
      };
      let childEnv: NodeJS.ProcessEnv | undefined;

      const peripheral = new CodexSoftwareAgentPeripheral({
        workdir: "/tmp/akemon",
        envPolicy: "allowlist",
        envAllowlist: ["UNLISTED_ALLOWED", "AKEMON_KEY", "RELAY_OWNER_TOKEN"],
        sourceEnv,
        spawnImpl: ((_cmd, _args, opts) => {
          childEnv = opts?.env as NodeJS.ProcessEnv;
          return spawnedChild;
        }) as typeof import("node:child_process").spawn,
        taskRelay: {
          sendTaskStart() {},
          sendTaskStream() {},
          sendTaskEnd() {},
        },
        taskLedgerDir: ledgerDir,
      });

      const run = peripheral.sendTask(baseEnvelope({ taskId: "env-allowlist" }));
      spawnedChild.stdout?.emit("data", Buffer.from("ok"));
      spawnedChild.emit("close", 0);
      await run;

      assert.equal(childEnv?.PATH, "/usr/bin");
      assert.equal(childEnv?.HOME, "/Users/tester");
      assert.equal(childEnv?.SHELL, "/bin/zsh");
      assert.equal(childEnv?.USER, "tester");
      assert.equal(childEnv?.TMPDIR, "/tmp");
      assert.equal(childEnv?.CODEX_HOME, "/Users/tester/.codex");
      assert.equal(childEnv?.OPENAI_API_KEY, openAiKey);
      assert.equal(childEnv?.UNLISTED_ALLOWED, "custom-value");
      assert.equal(childEnv?.AKEMON_KEY, undefined);
      assert.equal(childEnv?.AKEMON_RAW_KEY, undefined);
      assert.equal(childEnv?.RELAY_OWNER_TOKEN, undefined);
      assert.equal(childEnv?.NOT_ALLOWED, undefined);

      const recordText = await readFile(join(ledgerDir, "env-allowlist.json"), "utf-8");
      const record = JSON.parse(recordText);
      assert.equal(record.environment.policy, "allowlist");
      assert.deepEqual(record.environment.allowedKeys.sort(), [
        "CODEX_HOME",
        "HOME",
        "OPENAI_API_KEY",
        "PATH",
        "SHELL",
        "TMPDIR",
        "UNLISTED_ALLOWED",
        "USER",
      ]);
      assert.doesNotMatch(recordText, new RegExp(openAiKey));
      assert.doesNotMatch(recordText, /owner-secret|raw-secret|relay-secret|custom-value|hidden-value/);
    } finally {
      await rm(tmpDir, { recursive: true, force: true });
    }
  });

  it("redacts secrets split across streamed chunks and task ledger records", async () => {
    const tmpDir = await mkdtemp(join(tmpdir(), "akemon-software-agent-redaction-"));
    try {
      const spawnedChild = createFakeChild();
      const ledgerDir = join(tmpDir, "tasks");
      const apiKey = "sk-123456789012345678901234";
      const relayChunks: string[] = [];
      const observerChunks: string[] = [];
      const peripheral = new CodexSoftwareAgentPeripheral({
        workdir: "/tmp/akemon",
        spawnImpl: (() => spawnedChild) as typeof import("node:child_process").spawn,
        taskRelay: {
          sendTaskStart() {},
          sendTaskStream(_taskId, _stream, chunk) {
            relayChunks.push(chunk);
          },
          sendTaskEnd() {},
        },
        taskLedgerDir: ledgerDir,
      });

      const run = peripheral.sendTask(baseEnvelope({
        taskId: "redaction-task",
        memorySummary: `Visible context with OPENAI_API_KEY=${apiKey}`,
      }), {
        observer: {
          onStream(event) {
            observerChunks.push(event.chunk);
          },
        },
      });

      spawnedChild.stdout?.emit("data", Buffer.from("result OPENAI_API_KEY=sk-123456789012"));
      spawnedChild.stdout?.emit("data", Buffer.from("345678901234"));
      spawnedChild.stderr?.emit("data", Buffer.from("Authorization: Bearer sk-123456789012"));
      spawnedChild.stderr?.emit("data", Buffer.from("345678901234"));
      spawnedChild.emit("close", 0);

      await run;
      const recordText = await readFile(join(ledgerDir, "redaction-task.json"), "utf-8");

      assert.doesNotMatch(relayChunks.join(""), new RegExp(apiKey));
      assert.doesNotMatch(observerChunks.join(""), new RegExp(apiKey));
      assert.doesNotMatch(recordText, new RegExp(apiKey));
      assert.match(recordText, /\[REDACTED\]/);
      assert.match(relayChunks.join(""), /\[REDACTED\]/);
    } finally {
      await rm(tmpDir, { recursive: true, force: true });
    }
  });

  it("prunes old task ledger records after writing a new task", async () => {
    const tmpDir = await mkdtemp(join(tmpdir(), "akemon-software-agent-ledger-retention-"));
    try {
      const spawnedChild = createFakeChild();
      const ledgerDir = join(tmpDir, "tasks");
      await mkdir(ledgerDir, { recursive: true });
      const peripheral = new CodexSoftwareAgentPeripheral({
        workdir: "/tmp/akemon",
        spawnImpl: (() => spawnedChild) as typeof import("node:child_process").spawn,
        taskRelay: {
          sendTaskStart() {},
          sendTaskStream() {},
          sendTaskEnd() {},
        },
        taskLedgerDir: ledgerDir,
        taskLedgerMaxRecords: 2,
      });

      await writeFile(join(ledgerDir, "older-1.json"), JSON.stringify(taskRecord("older-1", "2026-04-25T01:00:00.000Z")));
      await writeFile(join(ledgerDir, "older-2.json"), JSON.stringify(taskRecord("older-2", "2026-04-25T02:00:00.000Z")));
      await writeFile(join(ledgerDir, "older-3.json"), JSON.stringify(taskRecord("older-3", "2026-04-25T03:00:00.000Z")));

      const run = peripheral.sendTask(baseEnvelope({ taskId: "retention-current" }));
      spawnedChild.stdout?.emit("data", Buffer.from("ok"));
      spawnedChild.emit("close", 0);
      await run;

      const records = listSoftwareAgentTaskRecords(ledgerDir, 10);
      assert.deepEqual(records.map((record) => record.taskId), ["retention-current", "older-3"]);
    } finally {
      await rm(tmpDir, { recursive: true, force: true });
    }
  });
});

describe("listSoftwareAgentTaskRecords", () => {
  it("ignores malformed JSON and returns recent records sorted and limited", async () => {
    const ledgerDir = await mkdtemp(join(tmpdir(), "akemon-software-agent-ledger-list-"));
    try {
      await writeFile(join(ledgerDir, "bad.json"), "{not json\n");
      await writeFile(join(ledgerDir, "older.json"), JSON.stringify(taskRecord("older", "2026-04-25T01:00:00.000Z")));
      await writeFile(join(ledgerDir, "middle.json"), JSON.stringify(taskRecord("middle", "2026-04-25T02:00:00.000Z")));
      await writeFile(join(ledgerDir, "newer.json"), JSON.stringify(taskRecord("newer", "2026-04-25T03:00:00.000Z")));

      const allRecords = listSoftwareAgentTaskRecords(ledgerDir, 10);
      assert.deepEqual(allRecords.map((record) => record.taskId), ["newer", "middle", "older"]);

      const limitedRecords = listSoftwareAgentTaskRecords(ledgerDir, 2);
      assert.deepEqual(limitedRecords.map((record) => record.taskId), ["newer", "middle"]);
    } finally {
      await rm(ledgerDir, { recursive: true, force: true });
    }
  });
});

describe("summarizeText", () => {
  it("keeps short text and truncates long text with size metadata", () => {
    const short = summarizeText("hello\nworld", 20);
    assert.equal(short.text, "hello\nworld");
    assert.equal(short.truncated, false);
    assert.equal(short.lines, 2);

    const long = summarizeText("x".repeat(30), 10);
    assert.equal(long.truncated, true);
    assert.equal(long.chars, 30);
    assert.equal(long.bytes, 30);
    assert.match(long.text, /\[truncated /);
    assert.equal(long.text, `${"x".repeat(10)}\n[truncated 20 chars]\n`);
  });
});

function taskRecord(taskId: string, updatedAt: string) {
  return {
    schemaVersion: 1,
    taskId,
    status: "completed",
    startedAt: "2026-04-25T00:00:00.000Z",
    updatedAt,
    envelope: {
      goal: `${taskId} task`,
    },
  };
}
