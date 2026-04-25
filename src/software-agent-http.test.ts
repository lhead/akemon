import assert from "node:assert/strict";
import type { IncomingMessage, ServerResponse } from "node:http";
import { Readable, Writable } from "node:stream";
import { describe, it } from "node:test";
import { handleSoftwareAgentRunHttp } from "./server.js";
import type { SoftwareAgentResult, TaskEnvelope } from "./software-agent-peripheral.js";

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
  const rawBody = JSON.stringify(body);
  const req = Readable.from([Buffer.from(rawBody)]) as IncomingMessage;
  Object.assign(req, {
    method: "POST",
    url: "/self/software-agent/run",
    headers: {
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      "content-type": "application/json",
    },
  });

  const res = new TestResponse();
  await handleSoftwareAgentRunHttp(req, res as unknown as ServerResponse, {
    options: { secretKey: "owner-secret", key: "legacy-owner-key" },
    workdir: "/repo",
    softwareAgent,
  });

  return {
    statusCode: res.statusCode,
    body: res.body ? JSON.parse(res.body) : {},
  };
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
    assert.deepEqual(envelope.forbiddenActions, [
      "read Akemon private memory outside this envelope",
      "access files outside the stated workdir unless explicitly needed and reported",
      "make network requests",
    ]);
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
