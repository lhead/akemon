import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { describe, it } from "node:test";
import { PassThrough } from "node:stream";
import type { ChildProcess, spawn } from "node:child_process";
import { PrivacyFilterUnavailableError, sanitizeText } from "./privacy-filter.js";

const OPENAI_KEY = "sk-123456789012345678901234";

interface SpawnCapture {
  command?: string;
  args?: string[];
  stdin?: string;
  calls: number;
}

function createFakeChild(): ChildProcess {
  const child = new EventEmitter() as EventEmitter & ChildProcess;
  child.stdin = new PassThrough();
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.kill = () => true;
  return child;
}

function fakeSpawn(
  stdout: string,
  stderr = "",
  code = 0,
  capture: SpawnCapture = { calls: 0 },
): typeof spawn {
  return ((command: string, args?: readonly string[]) => {
    capture.calls += 1;
    capture.command = command;
    capture.args = [...(args || [])];

    const child = createFakeChild();
    child.stdin?.on("data", (chunk: Buffer | string) => {
      capture.stdin = `${capture.stdin || ""}${Buffer.isBuffer(chunk) ? chunk.toString("utf8") : chunk}`;
    });
    queueMicrotask(() => {
      child.stdout?.emit("data", Buffer.from(stdout));
      if (stderr) child.stderr?.emit("data", Buffer.from(stderr));
      child.emit("close", code);
    });
    return child;
  }) as typeof spawn;
}

describe("sanitizeText", () => {
  it("uses built-in redaction by default without spawning OPF", async () => {
    const capture: SpawnCapture = { calls: 0 };
    const result = await sanitizeText(`OPENAI_API_KEY=${OPENAI_KEY} hello`, {
      spawnImpl: fakeSpawn("{}", "", 0, capture),
    });

    assert.equal(capture.calls, 0);
    assert.equal(result.backend, "fast");
    assert.equal(result.opfApplied, false);
    assert.match(result.text, /OPENAI_API_KEY=\[REDACTED\]/);
    assert.doesNotMatch(result.text, new RegExp(OPENAI_KEY));
  });

  it("can call OPF explicitly after fast redaction", async () => {
    const capture: SpawnCapture = { calls: 0 };
    const result = await sanitizeText(`Alice has OPENAI_API_KEY=${OPENAI_KEY}`, {
      mode: "pii",
      backend: "opf",
      device: "cpu",
      checkpoint: "/tmp/opf-checkpoint",
      spawnImpl: fakeSpawn(JSON.stringify({ redacted_text: "<redacted> has OPENAI_API_KEY=[REDACTED]" }), "", 0, capture),
    });

    assert.equal(result.backend, "opf");
    assert.equal(result.opfApplied, true);
    assert.equal(result.text, "<redacted> has OPENAI_API_KEY=[REDACTED]");
    assert.equal(capture.command, "opf");
    assert.deepEqual(capture.args?.slice(0, 8), [
      "redact",
      "--format",
      "json",
      "--output-mode",
      "redacted",
      "--json-indent",
      "0",
      "--no-print-color-coded-text",
    ]);
    assert.ok(capture.args?.includes("--device"));
    assert.ok(capture.args?.includes("cpu"));
    assert.ok(capture.args?.includes("--checkpoint"));
    assert.ok(capture.args?.includes("/tmp/opf-checkpoint"));
    assert.equal(capture.args?.some((arg) => arg.includes("Alice")), false);
    assert.equal(capture.args?.some((arg) => arg.includes("[REDACTED]")), false);
    assert.doesNotMatch(capture.stdin || "", new RegExp(OPENAI_KEY));
    assert.match(capture.stdin || "", /Alice has OPENAI_API_KEY=\[REDACTED\]\n/);
  });

  it("reconstructs multi-line OPF stdin output from concatenated JSON records", async () => {
    const capture: SpawnCapture = { calls: 0 };
    const stdout = [
      JSON.stringify({ redacted_text: "[NAME] first line" }),
      JSON.stringify({ redacted_text: "[NAME] second line" }),
    ].join("\n");

    const result = await sanitizeText("Alice first line\n\nBob second line", {
      mode: "pii",
      backend: "opf",
      spawnImpl: fakeSpawn(stdout, "", 0, capture),
    });

    assert.equal(result.opfApplied, true);
    assert.equal(result.text, "[NAME] first line\n\n[NAME] second line");
    assert.equal(capture.stdin, "Alice first line\n\nBob second line\n");
  });

  it("falls back to built-in redaction when OPF fails in pii mode", async () => {
    const result = await sanitizeText(`OPENAI_API_KEY=${OPENAI_KEY} Alice`, {
      mode: "pii",
      backend: "opf",
      spawnImpl: fakeSpawn("", "opf missing", 127),
    });

    assert.equal(result.backend, "opf");
    assert.equal(result.opfApplied, false);
    assert.match(result.text, /OPENAI_API_KEY=\[REDACTED\]/);
    assert.doesNotMatch(result.text, new RegExp(OPENAI_KEY));
    assert.match(result.warnings[0] || "", /OPF unavailable/);
  });

  it("throws when OPF fails in strict mode", async () => {
    await assert.rejects(
      () => sanitizeText("Alice", {
        mode: "strict",
        backend: "opf",
        spawnImpl: fakeSpawn("", "opf missing", 127),
      }),
      PrivacyFilterUnavailableError,
    );
  });

  it("does not spawn OPF when input exceeds the configured max", async () => {
    const capture: SpawnCapture = { calls: 0 };
    await assert.rejects(
      () => sanitizeText("too long", {
        mode: "strict",
        backend: "opf",
        maxInputChars: 3,
        spawnImpl: fakeSpawn("{}", "", 0, capture),
      }),
      /exceeds max 3 chars/,
    );
    assert.equal(capture.calls, 0);
  });
});
