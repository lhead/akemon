import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { parseProcessList } from "./orphan-scan.js";

describe("parseProcessList", () => {
  it("empty string returns empty array", () => {
    assert.deepStrictEqual(parseProcessList(""), []);
  });

  it("whitespace-only string returns empty array", () => {
    assert.deepStrictEqual(parseProcessList("\n\n  \n"), []);
  });

  it("header line (PID PPID COMMAND) is silently skipped", () => {
    const output = "  PID  PPID COMMAND\n  123     1 opencode run --flag\n";
    const result = parseProcessList(output);
    assert.strictEqual(result.length, 1);
    assert.strictEqual(result[0].pid, 123);
  });

  it("ppid=1 + command matches 'opencode run' → hit", () => {
    const output = "  123     1 opencode run --headless\n";
    const result = parseProcessList(output);
    assert.strictEqual(result.length, 1);
    assert.strictEqual(result[0].pid, 123);
    assert.strictEqual(result[0].ppid, 1);
    assert.ok(result[0].command.includes("opencode run"));
  });

  it("ppid=1 + command is 'opencode install' → not hit (install is not agent mode)", () => {
    const output = "  456     1 opencode install some-plugin\n";
    const result = parseProcessList(output);
    assert.strictEqual(result.length, 0);
  });

  it("ppid=1 + command is 'opencode update' → not hit", () => {
    const output = "  789     1 opencode update\n";
    const result = parseProcessList(output);
    assert.strictEqual(result.length, 0);
  });

  it("ppid != 1 but command matches → not hit (never kill non-orphans)", () => {
    const output = "  999  5678 opencode run --headless\n";
    const result = parseProcessList(output);
    assert.strictEqual(result.length, 0);
  });

  it("ppid=1 + 'claude -p' → hit", () => {
    const output = "  100     1 claude -p some prompt text\n";
    const result = parseProcessList(output);
    assert.strictEqual(result.length, 1);
    assert.strictEqual(result[0].pid, 100);
  });

  it("ppid=1 + 'codex exec' → hit", () => {
    const output = "  200     1 codex exec --flag\n";
    const result = parseProcessList(output);
    assert.strictEqual(result.length, 1);
  });

  it("ppid=1 + 'gemini -p' → hit", () => {
    const output = "  300     1 gemini -p --output-format json\n";
    const result = parseProcessList(output);
    assert.strictEqual(result.length, 1);
  });

  it("command with full path still matches", () => {
    const output = "  400     1 /usr/local/bin/opencode run --headless task\n";
    const result = parseProcessList(output);
    assert.strictEqual(result.length, 1);
    assert.strictEqual(result[0].pid, 400);
  });

  it("multiple orphans parsed correctly, non-orphan interleaved is skipped", () => {
    const output = [
      "  PID  PPID COMMAND",
      "  111     1 opencode run",
      "  222  3456 opencode run",   // ppid != 1, not orphan
      "  333     1 claude -p task",
      "  444     1 bash",           // not a known pattern
    ].join("\n");
    const result = parseProcessList(output);
    assert.strictEqual(result.length, 2);
    assert.strictEqual(result[0].pid, 111);
    assert.strictEqual(result[1].pid, 333);
  });

  it("large PID and PPID values parse correctly", () => {
    const output = "  99999     1 opencode run\n";
    const result = parseProcessList(output);
    assert.strictEqual(result.length, 1);
    assert.strictEqual(result[0].pid, 99999);
  });
});
