import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { renderSoftwareAgentRunResult } from "./software-agent-result-cli.js";

describe("software-agent final result CLI renderer", () => {
  it("prints output plus handoff metadata for successful non-stream runs", () => {
    const capture = createCapture();
    const failed = renderSoftwareAgentRunResult({
      success: true,
      taskId: "sw_1",
      output: "done",
      exitCode: 0,
      durationMs: 9,
      contextSessionId: "project-alpha",
      contextPacketPath: "/repo/.akemon/agents/my-agent/software-agent/sessions/project-alpha/TASK_CONTEXT.md",
      workMemoryDir: "/repo/.akemon/agents/my-agent/work",
    }, capture.writers);

    assert.equal(failed, false);
    assert.equal(capture.stdout, "done\n");
    assert.match(capture.stderr, /\[software-agent\] task sw_1 finished exit=0 duration=9ms/);
    assert.match(capture.stderr, /\[software-agent\] session: project-alpha/);
    assert.match(capture.stderr, /\[software-agent\] context: \/repo\/\.akemon\/agents\/my-agent\/software-agent\/sessions\/project-alpha\/TASK_CONTEXT\.md/);
    assert.match(capture.stderr, /\[software-agent\] work memory: \/repo\/\.akemon\/agents\/my-agent\/work/);
    assert.match(capture.stderr, /\[software-agent\] next: akemon software-agent-tasks sw_1 \| akemon software-agent-sessions project-alpha --context \| akemon work-note/);
  });

  it("prints failure details and asks caller to exit nonzero", () => {
    const capture = createCapture();
    const failed = renderSoftwareAgentRunResult({
      success: false,
      taskId: "sw_fail",
      output: "",
      error: "tests failed",
      exitCode: 1,
      durationMs: 12,
    }, capture.writers);

    assert.equal(failed, true);
    assert.match(capture.stdout, /"success": false/);
    assert.match(capture.stderr, /\[software-agent\] task sw_fail failed exit=1 duration=12ms/);
    assert.match(capture.stderr, /\[software-agent\] error: tests failed/);
    assert.match(capture.stderr, /\[software-agent\] next: akemon software-agent-tasks sw_fail/);
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
