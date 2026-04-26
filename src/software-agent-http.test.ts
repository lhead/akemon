import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import type { IncomingMessage, ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable, Writable } from "node:stream";
import { describe, it } from "node:test";
import {
  handleSoftwareAgentResetHttp,
  handleSoftwareAgentRunHttp,
  handleSoftwareAgentRunStreamHttp,
  handleSoftwareAgentStatusHttp,
  handleSoftwareAgentTasksHttp,
} from "./server.js";
import type {
  SoftwareAgentResult,
  SoftwareAgentTaskOptions,
  SoftwareAgentTaskRecord,
  TaskEnvelope,
} from "./software-agent-peripheral.js";

class TestResponse extends Writable {
  statusCode = 200;
  headers: Record<string, string> = {};
  body = "";

  writeHead(statusCode: number, headers?: Record<string, string>): this {
    this.statusCode = statusCode;
    this.headers = headers || {};
    return this;
  }

  override end(chunk?: any, encoding?: BufferEncoding | (() => void), callback?: () => void): this {
    if (chunk) this.body += Buffer.isBuffer(chunk) ? chunk.toString("utf-8") : String(chunk);
    return super.end(callback || (typeof encoding === "function" ? encoding : undefined)) as this;
  }

  override _write(chunk: Buffer, _encoding: BufferEncoding, callback: (error?: Error | null) => void): void {
    this.body += chunk.toString("utf-8");
    callback();
  }
}

async function callSoftwareAgentEndpoint(
  softwareAgent: { sendTask(envelope: TaskEnvelope): Promise<SoftwareAgentResult> } | null,
  body: unknown,
  token?: string,
): Promise<{ statusCode: number; body: any }> {
  const req = createRequest("POST", "/self/software-agent/run", body, token);
  const res = new TestResponse();
  await handleSoftwareAgentRunHttp(req, res as unknown as ServerResponse, {
    options: { secretKey: "owner-secret", key: "legacy-owner-key" },
    workdir: "/repo",
    agentName: "test-agent",
    softwareAgent,
  });

  return {
    statusCode: res.statusCode,
    body: res.body ? JSON.parse(res.body) : {},
  };
}

async function callSoftwareAgentStatusEndpoint(
  softwareAgent: { getState(): Record<string, unknown> } | null,
  token?: string,
): Promise<{ statusCode: number; body: any }> {
  const req = createRequest("GET", "/self/software-agent/status", undefined, token);
  const res = new TestResponse();
  await handleSoftwareAgentStatusHttp(req, res as unknown as ServerResponse, {
    options: { secretKey: "owner-secret", key: "legacy-owner-key" },
    softwareAgent,
  });
  return {
    statusCode: res.statusCode,
    body: res.body ? JSON.parse(res.body) : {},
  };
}

async function callSoftwareAgentStreamEndpoint(
  softwareAgent: {
    sendTask(envelope: TaskEnvelope, options?: SoftwareAgentTaskOptions): Promise<SoftwareAgentResult>;
  } | null,
  body: unknown,
  token?: string,
): Promise<{ statusCode: number; headers: Record<string, string>; events: any[]; body: string }> {
  const req = createRequest("POST", "/self/software-agent/run-stream", body, token);
  const res = new TestResponse();
  await handleSoftwareAgentRunStreamHttp(req, res as unknown as ServerResponse, {
    options: { secretKey: "owner-secret", key: "legacy-owner-key" },
    workdir: "/repo",
    agentName: "test-agent",
    softwareAgent,
  });
  return {
    statusCode: res.statusCode,
    headers: res.headers,
    events: String(res.headers["Content-Type"] || "").includes("application/x-ndjson")
      ? parseNdjson(res.body)
      : [],
    body: res.body,
  };
}

async function callSoftwareAgentTasksEndpoint(
  workdir: string,
  path: string,
  token?: string,
): Promise<{ statusCode: number; body: any }> {
  const req = createRequest("GET", path, undefined, token);
  const res = new TestResponse();
  await handleSoftwareAgentTasksHttp(req, res as unknown as ServerResponse, {
    options: { secretKey: "owner-secret", key: "legacy-owner-key" },
    workdir,
    agentName: "test-agent",
  });
  return {
    statusCode: res.statusCode,
    body: res.body ? JSON.parse(res.body) : {},
  };
}

async function callSoftwareAgentResetEndpoint(
  softwareAgent: { getState(): Record<string, unknown>; resetSession(): Promise<void> } | null,
  token?: string,
): Promise<{ statusCode: number; body: any }> {
  const req = createRequest("POST", "/self/software-agent/reset", undefined, token);
  const res = new TestResponse();
  await handleSoftwareAgentResetHttp(req, res as unknown as ServerResponse, {
    options: { secretKey: "owner-secret", key: "legacy-owner-key" },
    softwareAgent,
  });
  return {
    statusCode: res.statusCode,
    body: res.body ? JSON.parse(res.body) : {},
  };
}

function createRequest(method: string, url: string, body: unknown, token?: string): IncomingMessage {
  const rawBody = body === undefined ? "" : JSON.stringify(body);
  const req = Readable.from(rawBody ? [Buffer.from(rawBody)] : []) as IncomingMessage;
  Object.assign(req, {
    method,
    url,
    headers: {
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      ...(body === undefined ? {} : { "content-type": "application/json" }),
    },
  });
  return req;
}

function parseNdjson(body: string): any[] {
  return body
    .split(/\r?\n/)
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}

describe("software-agent HTTP endpoint", () => {
  it("requires an owner token", async () => {
    let calls = 0;
    const res = await callSoftwareAgentEndpoint({
      async sendTask(envelope) {
        calls++;
        return successResult(envelope);
      },
    }, { goal: "inspect repo" });

    assert.equal(res.statusCode, 401);
    assert.match(res.body.error, /Owner token required/);
    assert.equal(calls, 0);
  });

  it("forwards a validated owner envelope to the software agent", async () => {
    let received: TaskEnvelope | null = null;
    const res = await callSoftwareAgentEndpoint({
      async sendTask(envelope) {
        received = envelope;
        return successResult(envelope);
      },
    }, {
      goal: "  inspect repo  ",
      roleScope: "owner",
      memoryScope: "owner",
      riskLevel: "low",
      forbiddenActions: ["make network requests"],
      timeoutMs: 5000,
    }, "owner-secret");

    assert.equal(res.statusCode, 200);
    assert.equal((res.body as SoftwareAgentResult).success, true);
    assert.ok(received);
    const envelope = received as TaskEnvelope;
    assert.equal(envelope.goal, "inspect repo");
    assert.equal(envelope.riskLevel, "low");
    assert.equal(envelope.timeoutMs, 5000);
    assert.match(envelope.memorySummary || "", /Akemon memory boundary/);
    assert.deepEqual(envelope.forbiddenActions, [
      "read Akemon private memory outside this envelope",
      "access files outside the stated workdir unless explicitly needed and reported",
      "make network requests",
    ]);
  });

  it("rejects software-agent workdirs outside the serve workdir by default", async () => {
    let calls = 0;
    const res = await callSoftwareAgentEndpoint({
      async sendTask(envelope) {
        calls++;
        return successResult(envelope);
      },
    }, { goal: "inspect repo", workdir: "/outside" }, "owner-secret");

    assert.equal(res.statusCode, 400);
    assert.match(res.body.error, /outside base workdir/);
    assert.equal(calls, 0);
  });

  it("allows outside software-agent workdirs only with an explicit owner override", async () => {
    let received: TaskEnvelope | null = null;
    const res = await callSoftwareAgentEndpoint({
      async sendTask(envelope) {
        received = envelope;
        return successResult(envelope);
      },
    }, {
      goal: "inspect repo",
      workdir: "/outside",
      allowOutsideWorkdir: true,
    }, "owner-secret");

    assert.equal(res.statusCode, 200);
    assert.ok(received);
    const envelope = received as TaskEnvelope;
    assert.equal(envelope.workdir, "/outside");
    assert.equal(envelope.workdirSafety?.baseWorkdir, "/repo");
    assert.equal(envelope.workdirSafety?.requestedWorkdir, "/outside");
    assert.equal(envelope.workdirSafety?.effectiveWorkdir, "/outside");
    assert.equal(envelope.workdirSafety?.outsideBaseWorkdir, true);
    assert.equal(envelope.workdirSafety?.allowOutsideWorkdir, true);
  });

  it("rejects invalid envelope fields before calling the software agent", async () => {
    let calls = 0;
    const res = await callSoftwareAgentEndpoint({
      async sendTask(envelope) {
        calls++;
        return successResult(envelope);
      },
    }, { goal: "inspect repo", roleScope: "friend" }, "owner-secret");

    assert.equal(res.statusCode, 400);
    assert.match(res.body.error, /Invalid roleScope/);
    assert.equal(calls, 0);
  });

  it("replaces caller memorySummary with server-built memory boundary", async () => {
    let received: TaskEnvelope | null = null;
    const res = await callSoftwareAgentEndpoint({
      async sendTask(envelope) {
        received = envelope;
        return successResult(envelope);
      },
    }, {
      goal: "inspect repo",
      roleScope: "order",
      memoryScope: "task",
      memorySummary: "owner secret context",
    }, "owner-secret");

    assert.equal(res.statusCode, 200);
    assert.ok(received);
    const envelope = received as TaskEnvelope;
    const summary = envelope.memorySummary || "";
    assert.match(summary, /Akemon memory boundary/);
    assert.match(summary, /Excluded owner memory/);
    assert.doesNotMatch(summary, /owner secret context/);
  });

  it("redacts secrets from software-agent JSON responses", async () => {
    const apiKey = "sk-123456789012345678901234";
    const res = await callSoftwareAgentEndpoint({
      async sendTask(envelope) {
        return {
          ...successResult(envelope),
          output: `done OPENAI_API_KEY=${apiKey}`,
          error: `Authorization: Bearer ${apiKey}`,
        };
      },
    }, { goal: "inspect repo" }, "owner-secret");

    const text = JSON.stringify(res.body);
    assert.equal(res.statusCode, 200);
    assert.doesNotMatch(text, new RegExp(apiKey));
    assert.match(text, /\[REDACTED\]/);
  });

  it("streams owner-only software-agent task events as ndjson", async () => {
    let received: TaskEnvelope | null = null;
    const res = await callSoftwareAgentStreamEndpoint({
      async sendTask(envelope, options) {
        received = envelope;
        const taskId = envelope.taskId || "stream-task";
        options?.observer?.onStart?.({
          taskId,
          origin: "software_agent",
          commandLine: "codex exec -",
        });
        options?.observer?.onStream?.({ taskId, stream: "stdout", chunk: "hello " });
        options?.observer?.onStream?.({ taskId, stream: "stderr", chunk: "note" });
        const result: SoftwareAgentResult = {
          success: true,
          taskId,
          output: "hello world",
          exitCode: 0,
          durationMs: 7,
        };
        options?.observer?.onStream?.({ taskId, stream: "stdout", chunk: "world" });
        options?.observer?.onEnd?.({ taskId, exitCode: 0, durationMs: 7, result });
        return result;
      },
    }, { goal: "inspect repo" }, "owner-secret");

    assert.equal(res.statusCode, 200);
    assert.match(res.headers["Content-Type"], /application\/x-ndjson/);
    assert.ok(received);
    const envelope = received as TaskEnvelope;
    assert.equal(envelope.goal, "inspect repo");
    assert.match(envelope.memorySummary || "", /Akemon memory boundary/);
    assert.deepEqual(res.events, [
      { type: "start", taskId: "stream-task", commandLine: "codex exec -" },
      { type: "stdout", taskId: "stream-task", chunk: "hello " },
      { type: "stderr", taskId: "stream-task", chunk: "note" },
      { type: "stdout", taskId: "stream-task", chunk: "world" },
      {
        type: "end",
        taskId: "stream-task",
        result: {
          success: true,
          taskId: "stream-task",
          output: "hello world",
          exitCode: 0,
          durationMs: 7,
        },
      },
    ]);
  });

  it("redacts secrets from software-agent stream events", async () => {
    const apiKey = "sk-123456789012345678901234";
    const res = await callSoftwareAgentStreamEndpoint({
      async sendTask(envelope, options) {
        const taskId = envelope.taskId || "stream-redaction-task";
        const result: SoftwareAgentResult = {
          success: true,
          taskId,
          output: `finished OPENAI_API_KEY=${apiKey}`,
          exitCode: 0,
          durationMs: 7,
        };
        options?.observer?.onStart?.({ taskId, origin: "software_agent", commandLine: "codex exec -" });
        options?.observer?.onStream?.({ taskId, stream: "stdout", chunk: `OPENAI_API_KEY=${apiKey}` });
        options?.observer?.onEnd?.({ taskId, exitCode: 0, durationMs: 7, result });
        return result;
      },
    }, { goal: "inspect repo" }, "owner-secret");

    const text = JSON.stringify(res.events);
    assert.equal(res.statusCode, 200);
    assert.doesNotMatch(text, new RegExp(apiKey));
    assert.match(text, /\[REDACTED\]/);
  });

  it("rejects run-stream before streaming when the software agent is busy", async () => {
    let calls = 0;
    const res = await callSoftwareAgentStreamEndpoint({
      async sendTask() {
        calls++;
        throw new Error("Software agent busy (task=existing)");
      },
    }, { goal: "inspect repo" }, "owner-secret");

    assert.equal(res.statusCode, 409);
    assert.match(JSON.parse(res.body).error, /busy/);
    assert.equal(res.events.length, 0);
    assert.equal(calls, 1);
  });

  it("returns owner-only software-agent status", async () => {
    const unauth = await callSoftwareAgentStatusEndpoint({
      getState: () => ({ id: "software-agent:codex", busy: false }),
    });

    assert.equal(unauth.statusCode, 401);

    const res = await callSoftwareAgentStatusEndpoint({
      getState: () => ({
        id: "software-agent:codex",
        busy: false,
        transport: "codex-exec",
      }),
    }, "owner-secret");

    assert.equal(res.statusCode, 200);
    assert.equal(res.body.id, "software-agent:codex");
    assert.equal(res.body.busy, false);
    assert.equal(res.body.transport, "codex-exec");
  });

  it("returns owner-only software-agent task ledger records", async () => {
    const workdir = await mkdtemp(join(tmpdir(), "akemon-software-agent-http-"));
    try {
      const ledgerDir = join(workdir, ".akemon", "agents", "test-agent", "software-agent", "tasks");
      await mkdir(ledgerDir, { recursive: true });
      await writeSoftwareAgentTaskRecord(ledgerDir, taskRecord({
        taskId: "older",
        updatedAt: "2026-04-25T01:00:00.000Z",
        goal: "older task",
      }));
      await writeSoftwareAgentTaskRecord(ledgerDir, taskRecord({
        taskId: "newer",
        updatedAt: "2026-04-25T02:00:00.000Z",
        goal: "newer task",
      }));

      const unauth = await callSoftwareAgentTasksEndpoint(workdir, "/self/software-agent/tasks");
      assert.equal(unauth.statusCode, 401);

      const list = await callSoftwareAgentTasksEndpoint(workdir, "/self/software-agent/tasks?limit=1", "owner-secret");
      assert.equal(list.statusCode, 200);
      assert.equal(list.body.tasks.length, 1);
      assert.equal(list.body.tasks[0].taskId, "newer");
      assert.equal(list.body.tasks[0].envelope.goal, "newer task");

      const detail = await callSoftwareAgentTasksEndpoint(workdir, "/self/software-agent/tasks/older", "owner-secret");
      assert.equal(detail.statusCode, 200);
      assert.equal(detail.body.task.taskId, "older");
      assert.equal(detail.body.task.envelope.goal, "older task");

      const missing = await callSoftwareAgentTasksEndpoint(workdir, "/self/software-agent/tasks/missing", "owner-secret");
      assert.equal(missing.statusCode, 404);
    } finally {
      await rm(workdir, { recursive: true, force: true });
    }
  });

  it("resets the owner-only software-agent session", async () => {
    let resets = 0;
    const res = await callSoftwareAgentResetEndpoint({
      async resetSession() {
        resets++;
      },
      getState: () => ({ id: "software-agent:codex", busy: false, sessionId: "after-reset" }),
    }, "owner-secret");

    assert.equal(res.statusCode, 200);
    assert.equal(res.body.ok, true);
    assert.equal(res.body.state.sessionId, "after-reset");
    assert.equal(resets, 1);
  });
});

function successResult(envelope: TaskEnvelope): SoftwareAgentResult {
  return {
    success: true,
    taskId: envelope.taskId || "task-from-test",
    output: "ok",
    exitCode: 0,
    durationMs: 1,
  };
}

function taskRecord(overrides: {
  taskId: string;
  updatedAt: string;
  goal: string;
}): SoftwareAgentTaskRecord {
  return {
    schemaVersion: 1,
    taskId: overrides.taskId,
    status: "completed",
    agentId: "software-agent:codex",
    sessionId: "session-test",
    transport: "codex-exec",
    commandLine: "codex exec -",
    envelope: {
      taskId: overrides.taskId,
      sourceModule: "owner-http",
      purpose: "test task",
      goal: overrides.goal,
      workdir: "/repo",
      roleScope: "owner",
      memoryScope: "owner",
      riskLevel: "medium",
    },
    startedAt: "2026-04-25T00:00:00.000Z",
    updatedAt: overrides.updatedAt,
    completedAt: overrides.updatedAt,
    durationMs: 12,
    result: {
      success: true,
      taskId: overrides.taskId,
      output: "ok",
      exitCode: 0,
      durationMs: 12,
    },
  };
}

async function writeSoftwareAgentTaskRecord(dir: string, record: SoftwareAgentTaskRecord): Promise<void> {
  await writeFile(join(dir, `${record.taskId}.json`), `${JSON.stringify(record, null, 2)}\n`);
}
