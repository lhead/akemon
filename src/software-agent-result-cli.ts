export interface SoftwareAgentResultCliWriters {
  stdout(chunk: string): void;
  stderr(chunk: string): void;
}

export function renderSoftwareAgentRunResult(
  result: any,
  writers: SoftwareAgentResultCliWriters = {
    stdout: (chunk) => process.stdout.write(chunk),
    stderr: (chunk) => process.stderr.write(chunk),
  },
): boolean {
  const output = readString(result?.output);
  if (output) {
    writers.stdout(output);
    if (!output.endsWith("\n")) writers.stdout("\n");
  } else {
    writers.stdout(`${JSON.stringify(result, null, 2)}\n`);
  }

  const taskId = readString(result?.taskId) || "unknown";
  const success = result?.success === false ? false : true;
  const exitCode = readExitCode(result?.exitCode);
  const durationMs = readDurationMs(result?.durationMs);
  const parts = [`[software-agent] task ${taskId} ${success ? "finished" : "failed"}`];
  if (exitCode !== undefined) parts.push(`exit=${exitCode}`);
  if (durationMs !== undefined) parts.push(`duration=${durationMs}ms`);
  stderrLine(writers, parts.join(" "));

  const error = readString(result?.error);
  if (!success && error) stderrLine(writers, `[software-agent] error: ${truncateOneLine(error, 240)}`);

  printMetadata(result, writers);
  printNextSteps(result, taskId, writers);

  return !success;
}

function printMetadata(result: any, writers: SoftwareAgentResultCliWriters): void {
  const contextSessionId = readString(result?.contextSessionId);
  const contextPacketPath = readString(result?.contextPacketPath);
  const workMemoryDir = readString(result?.workMemoryDir);
  if (contextSessionId) stderrLine(writers, `[software-agent] session: ${truncateOneLine(contextSessionId, 120)}`);
  if (contextPacketPath) stderrLine(writers, `[software-agent] context: ${truncateOneLine(contextPacketPath, 240)}`);
  if (workMemoryDir) stderrLine(writers, `[software-agent] work memory: ${truncateOneLine(workMemoryDir, 240)}`);
}

function printNextSteps(result: any, taskId: string, writers: SoftwareAgentResultCliWriters): void {
  const contextSessionId = readString(result?.contextSessionId);
  const workMemoryDir = readString(result?.workMemoryDir);
  const hints: string[] = [`akemon software-agent-tasks ${taskId}`];
  if (contextSessionId) hints.push(`akemon software-agent-sessions ${contextSessionId} --context`);
  if (workMemoryDir) hints.push("akemon work-note \"<durable work memory>\" --source codex");
  stderrLine(writers, `[software-agent] next: ${hints.join(" | ")}`);
}

function stderrLine(writers: SoftwareAgentResultCliWriters, line: string): void {
  writers.stderr(`${line}\n`);
}

function readString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value : undefined;
}

function readExitCode(value: unknown): number | undefined {
  return typeof value === "number" && Number.isInteger(value) ? value : undefined;
}

function readDurationMs(value: unknown): number | undefined {
  return typeof value === "number" && Number.isInteger(value) && value >= 0 ? value : undefined;
}

function truncateOneLine(value: string, max: number): string {
  const oneLine = value.replace(/\s+/g, " ").trim();
  if (oneLine.length <= max) return oneLine;
  return `${oneLine.slice(0, Math.max(0, max - 3))}...`;
}
