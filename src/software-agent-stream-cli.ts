export interface SoftwareAgentStreamCliWriters {
  stdout(chunk: string): void;
  stderr(chunk: string): void;
}

export class SoftwareAgentStreamCliRenderer {
  private taskId: string | undefined;
  private stderrEndsWithNewline = true;

  constructor(
    private readonly writers: SoftwareAgentStreamCliWriters = {
      stdout: (chunk) => process.stdout.write(chunk),
      stderr: (chunk) => process.stderr.write(chunk),
    },
  ) {}

  handleLine(line: string): boolean {
    const trimmed = line.trim();
    if (!trimmed) return false;

    let event: any;
    try {
      event = JSON.parse(trimmed);
    } catch {
      this.stderrLine(`[software-agent] non-json: ${trimmed}`);
      return false;
    }

    return this.handleEvent(event);
  }

  private handleEvent(event: any): boolean {
    const type = typeof event?.type === "string" ? event.type : "";

    if (type === "start") {
      const taskId = readString(event.taskId) || "unknown";
      this.taskId = taskId;
      this.stderrLine(`[software-agent] task ${taskId} started`);
      const commandLine = readString(event.commandLine);
      if (commandLine) this.stderrLine(`[software-agent] command: ${truncateOneLine(commandLine, 160)}`);
      this.printMetadata(event);
      return false;
    }

    if (type === "stdout" && typeof event.chunk === "string") {
      this.writers.stdout(event.chunk);
      return false;
    }

    if (type === "stderr" && typeof event.chunk === "string") {
      this.writers.stderr(event.chunk);
      this.stderrEndsWithNewline = event.chunk.endsWith("\n") || event.chunk.endsWith("\r");
      return false;
    }

    if (type === "end") {
      return this.handleEnd(event);
    }

    if (type === "error") {
      this.stderrLine(`[software-agent] stream error: ${readString(event.error) || "unknown error"}`);
      return true;
    }

    this.stderrLine(`[software-agent] ignored stream event: ${type || "unknown"}`);
    return false;
  }

  private handleEnd(event: any): boolean {
    const result = isObject(event.result) ? event.result : {};
    const taskId = readString(event.taskId) || readString(result.taskId) || this.taskId || "unknown";
    const success = result.success === false ? false : true;
    const exitCode = readExitCode(event.exitCode) ?? readExitCode(result.exitCode);
    const durationMs = readDurationMs(event.durationMs) ?? readDurationMs(result.durationMs);

    const parts = [`[software-agent] task ${taskId} ${success ? "finished" : "failed"}`];
    if (exitCode !== undefined) parts.push(`exit=${exitCode}`);
    if (durationMs !== undefined) parts.push(`duration=${durationMs}ms`);
    this.stderrLine(parts.join(" "));

    const error = readString(result.error);
    if (!success && error) {
      this.stderrLine(`[software-agent] error: ${truncateOneLine(error, 240)}`);
    }

    const output = readString(result.output);
    if (output) {
      this.stderrLine(`[software-agent] summary: ${truncateOneLine(output, 240)}`);
    }

    this.printNextSteps(event, taskId);

    return !success;
  }

  private printMetadata(event: any): void {
    const contextSessionId = readString(event.contextSessionId);
    const contextPacketPath = readString(event.contextPacketPath);
    const workMemoryDir = readString(event.workMemoryDir);
    if (contextSessionId) this.stderrLine(`[software-agent] session: ${truncateOneLine(contextSessionId, 120)}`);
    if (contextPacketPath) this.stderrLine(`[software-agent] context: ${truncateOneLine(contextPacketPath, 240)}`);
    if (workMemoryDir) this.stderrLine(`[software-agent] work memory: ${truncateOneLine(workMemoryDir, 240)}`);
  }

  private printNextSteps(event: any, taskId: string): void {
    const contextSessionId = readString(event.contextSessionId);
    const workMemoryDir = readString(event.workMemoryDir);
    const hints: string[] = [`akemon software-agent-tasks ${taskId}`];
    if (contextSessionId) hints.push(`akemon software-agent-sessions ${contextSessionId} --context`);
    if (workMemoryDir) hints.push("akemon work-note \"<durable work memory>\" --source codex");
    this.stderrLine(`[software-agent] next: ${hints.join(" | ")}`);
  }

  private stderrLine(line: string): void {
    if (!this.stderrEndsWithNewline) this.writers.stderr("\n");
    this.writers.stderr(`${line}\n`);
    this.stderrEndsWithNewline = true;
  }
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
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
