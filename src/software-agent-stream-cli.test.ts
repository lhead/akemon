import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { SoftwareAgentStreamCliRenderer } from "./software-agent-stream-cli.js";

describe("software-agent stream CLI renderer", () => {
  it("prints clearer start, raw chunks, end summary, and exit code", () => {
    const capture = createCapture();
    const renderer = new SoftwareAgentStreamCliRenderer(capture.writers);

    assert.equal(renderer.handleLine(JSON.stringify({
      type: "start",
      taskId: "sw_1",
      commandLine: "codex exec -",
    })), false);
    assert.equal(renderer.handleLine(JSON.stringify({
      type: "stdout",
      taskId: "sw_1",
      chunk: "hello ",
    })), false);
    assert.equal(renderer.handleLine(JSON.stringify({
      type: "stderr",
      taskId: "sw_1",
      chunk: "note",
    })), false);
    assert.equal(renderer.handleLine(JSON.stringify({
      type: "end",
      taskId: "sw_1",
      exitCode: 0,
      durationMs: 7,
      result: {
        success: true,
        taskId: "sw_1",
        output: "hello world",
        exitCode: 0,
        durationMs: 7,
      },
    })), false);

    assert.equal(capture.stdout, "hello ");
    assert.match(capture.stderr, /\[software-agent\] task sw_1 started/);
    assert.match(capture.stderr, /\[software-agent\] command: codex exec -/);
    assert.match(capture.stderr, /note\n\[software-agent\] task sw_1 finished exit=0 duration=7ms/);
    assert.match(capture.stderr, /\[software-agent\] summary: hello world/);
  });

  it("marks failed end events as process failures and prints the error", () => {
    const capture = createCapture();
    const renderer = new SoftwareAgentStreamCliRenderer(capture.writers);

    const failed = renderer.handleLine(JSON.stringify({
      type: "end",
      taskId: "sw_fail",
      result: {
        success: false,
        taskId: "sw_fail",
        error: "tests failed",
        exitCode: 1,
      },
    }));

    assert.equal(failed, true);
    assert.match(capture.stderr, /\[software-agent\] task sw_fail failed exit=1/);
    assert.match(capture.stderr, /\[software-agent\] error: tests failed/);
  });

  it("keeps non-json stream lines non-fatal", () => {
    const capture = createCapture();
    const renderer = new SoftwareAgentStreamCliRenderer(capture.writers);

    assert.equal(renderer.handleLine("server warning"), false);
    assert.match(capture.stderr, /\[software-agent\] non-json: server warning/);
  });
});

function createCapture(): {
  stdout: string;
  stderr: string;
  writers: {
    stdout(chunk: string): void;
    stderr(chunk: string): void;
  };
} {
  const capture = {
    stdout: "",
    stderr: "",
    writers: {
      stdout(chunk: string) {
        capture.stdout += chunk;
      },
      stderr(chunk: string) {
        capture.stderr += chunk;
      },
    },
  };
  return capture;
}
