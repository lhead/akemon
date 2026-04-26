/**
 * SoftwareAgentPeripheral — wraps full agent software as an Akemon peripheral.
 *
 * This is distinct from EnginePeripheral. Engines are pure compute: modules
 * prepare context and the engine returns text. Software agent peripherals are
 * external software bodies such as Codex CLI or Claude Code: they may manage
 * their own repo context, tools, skills, and multi-step execution loop.
 *
 * Batch 5 starts with a conservative Codex `exec` baseline. It gives Akemon a
 * stable task envelope, streaming, reset, and event shape before switching the
 * transport to app-server or a true persistent interactive session.
 */

import { randomUUID } from "crypto";
import { spawn, spawnSync, type ChildProcess } from "child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, unlinkSync, writeFileSync } from "fs";
import { isAbsolute, join, relative, resolve as resolvePath } from "path";
import { StringDecoder } from "string_decoder";
import type { EventBus, Peripheral, Signal } from "./types.js";
import { SIG, sig } from "./types.js";
import { sendTaskEnd, sendTaskStart, sendTaskStream } from "./relay-client.js";
import { redactSecrets, StreamingRedactor } from "./redaction.js";

export type MemoryScope = "none" | "public" | "task" | "owner";
export type RoleScope = "owner" | "public" | "order" | "agent" | "system";
export type RiskLevel = "low" | "medium" | "high";

export interface TaskEnvelope {
  /** Stable task id for event log and Live Tasks stream */
  taskId?: string;
  /** Module or subsystem requesting the software agent */
  sourceModule: string;
  /** Why this software peripheral is being called */
  purpose: string;
  /** Concrete task goal */
  goal: string;
  /** Working directory the software agent is allowed to treat as primary root */
  workdir: string;
  /** Server-side workdir boundary decision for auditing and prompt clarity */
  workdirSafety?: WorkdirSafety;
  /** Relationship/privacy scope that selected the visible context */
  roleScope: RoleScope;
  /** Memory selection level after Akemon-side filtering */
  memoryScope: MemoryScope;
  /** Operational risk classification for future permission gating */
  riskLevel: RiskLevel;
  /** Actions the software agent may take */
  allowedActions?: string[];
  /** Actions or content explicitly forbidden */
  forbiddenActions?: string[];
  /** Pre-filtered memory/context text. Must already respect roleScope. */
  memorySummary?: string;
  /** Expected output shape */
  deliverable?: string;
  /** Optional hard timeout for this run */
  timeoutMs?: number;
}

export interface WorkdirSafety {
  baseWorkdir: string;
  requestedWorkdir: string;
  effectiveWorkdir: string;
  allowOutsideWorkdir: boolean;
  outsideBaseWorkdir: boolean;
}

export interface SoftwareAgentResult {
  success: boolean;
  taskId: string;
  output: string;
  error?: string;
  exitCode: number | null;
  durationMs: number;
}

export type SoftwareAgentTaskStatus = "running" | "completed" | "failed";

export interface TextSummary {
  chars: number;
  bytes: number;
  lines: number;
  text: string;
  truncated: boolean;
  omittedChars?: number;
}

export interface GitWorktreeStatus {
  workdir: string;
  isRepo: boolean;
  dirty: boolean;
  changedFiles: string[];
  root?: string;
  error?: string;
}

export interface SoftwareAgentTaskRecord {
  schemaVersion: 1;
  taskId: string;
  status: SoftwareAgentTaskStatus;
  agentId: string;
  sessionId: string;
  transport: "codex-exec";
  commandLine: string;
  envelope: TaskEnvelope;
  startedAt: string;
  workdirStatus?: GitWorktreeStatus;
  updatedAt: string;
  completedAt?: string;
  durationMs?: number;
  result?: SoftwareAgentResult;
  stdoutSummary?: TextSummary;
  stderrSummary?: TextSummary;
}

export interface SoftwareAgentPeripheral extends Peripheral {
  startSession(): Promise<void>;
  sendTask(envelope: TaskEnvelope, options?: AbortSignal | SoftwareAgentTaskOptions): Promise<SoftwareAgentResult>;
  resetSession(): Promise<void>;
  getState(): Record<string, unknown>;
}

export interface SoftwareAgentTaskOptions {
  signal?: AbortSignal;
  observer?: SoftwareAgentTaskObserver;
}

export interface SoftwareAgentTaskObserver {
  onStart?(event: SoftwareAgentTaskStartEvent): void;
  onStream?(event: SoftwareAgentTaskStreamChunkEvent): void;
  onEnd?(event: SoftwareAgentTaskEndEvent): void;
}

export interface SoftwareAgentTaskStartEvent {
  taskId: string;
  origin: string | undefined;
  commandLine: string;
}

export interface SoftwareAgentTaskStreamChunkEvent {
  taskId: string;
  stream: "stdout" | "stderr";
  chunk: string;
}

export interface SoftwareAgentTaskEndEvent {
  taskId: string;
  exitCode: number | null;
  durationMs: number;
  result: SoftwareAgentResult;
}

export interface SoftwareTaskRelay {
  sendTaskStart(taskId: string, origin: string | undefined, cmd: string): void;
  sendTaskStream(taskId: string, stream: "stdout" | "stderr", chunk: string): void;
  sendTaskEnd(taskId: string, exitCode: number | null, durationMs: number): void;
}

export interface CodexSoftwareAgentConfig {
  id?: string;
  name?: string;
  workdir: string;
  model?: string;
  sandbox?: "read-only" | "workspace-write" | "danger-full-access";
  command?: string;
  spawnImpl?: typeof spawn;
  taskRelay?: SoftwareTaskRelay;
  defaultTimeoutMs?: number;
  taskLedgerDir?: string;
  taskLedgerMaxRecords?: number;
  gitStatusImpl?: (workdir: string) => GitWorktreeStatus;
}

const defaultTaskRelay: SoftwareTaskRelay = {
  sendTaskStart,
  sendTaskStream,
  sendTaskEnd,
};

const DEFAULT_TIMEOUT_MS = 10 * 60 * 1000;
const MAX_OWNER_TIMEOUT_MS = 60 * 60 * 1000;
const DEFAULT_OWNER_ALLOWED_ACTIONS = ["read repository files", "edit files in workdir", "run project tests"];
const DEFAULT_OWNER_FORBIDDEN_ACTIONS = [
  "read Akemon private memory outside this envelope",
  "access files outside the stated workdir unless explicitly needed and reported",
];
const ROLE_SCOPES: RoleScope[] = ["owner", "public", "order", "agent", "system"];
const MEMORY_SCOPES: MemoryScope[] = ["none", "public", "task", "owner"];
const RISK_LEVELS: RiskLevel[] = ["low", "medium", "high"];
const MAX_STREAM_SUMMARY_CHARS = 12_000;
const STREAM_SUMMARY_HEAD_CHARS = 4_000;
const DEFAULT_TASK_LEDGER_MAX_RECORDS = 200;

export class CodexSoftwareAgentPeripheral implements SoftwareAgentPeripheral {
  id: string;
  name: string;
  capabilities = ["code-agent", "repo-inspect", "repo-edit", "tool-use", "skill-use", "streaming"];
  tags = ["software-agent", "codex"];

  private config: CodexSoftwareAgentConfig;
  private bus: EventBus | null = null;
  private activeChild: ChildProcess | null = null;
  private activeTaskId: string | null = null;
  private activeWorkdir: string | null = null;
  private sessionId = randomUUID();

  constructor(config: CodexSoftwareAgentConfig) {
    this.config = config;
    this.id = config.id || "software-agent:codex";
    this.name = config.name || "Codex CLI Software Agent";
  }

  async start(bus: EventBus): Promise<void> {
    this.bus = bus;
  }

  async stop(): Promise<void> {
    await this.resetSession();
    this.bus = null;
  }

  async startSession(): Promise<void> {
    // Codex `exec` baseline is oneshot per task. Keep a session id so callers
    // can observe resets and future transports can preserve this interface.
    if (!this.sessionId) this.sessionId = randomUUID();
  }

  async resetSession(): Promise<void> {
    const activePid = this.activeChild?.pid;
    if (activePid) {
      const processGroupId = -activePid;
      try { process.kill(processGroupId, "SIGTERM"); } catch {}
      setTimeout(() => {
        try { process.kill(processGroupId, "SIGKILL"); } catch {}
      }, 3000).unref();
    }
    this.activeChild = null;
    this.activeTaskId = null;
    this.activeWorkdir = null;
    this.sessionId = randomUUID();
  }

  getState(): Record<string, unknown> {
    const currentWorkdir = this.activeWorkdir || resolvePath(this.config.workdir);
    return {
      id: this.id,
      sessionId: this.sessionId,
      activeTaskId: this.activeTaskId,
      activeWorkdir: this.activeWorkdir,
      busy: !!this.activeChild,
      transport: "codex-exec",
      baseWorkdir: resolvePath(this.config.workdir),
      workdirStatus: this.collectWorkdirStatus(currentWorkdir),
      taskLedgerDir: this.config.taskLedgerDir,
    };
  }

  async send(signal: Signal): Promise<Signal | null> {
    if (signal.type !== SIG.SOFTWARE_AGENT_TASK) return null;
    const envelope = signal.data.envelope as TaskEnvelope | undefined;
    if (!envelope) {
      return sig(SIG.SOFTWARE_AGENT_RESPONSE, {
        success: false,
        error: "Missing task envelope",
      }, this.id);
    }
    const result = await this.sendTask(envelope);
    return sig(SIG.SOFTWARE_AGENT_RESPONSE, { ...result }, this.id);
  }

  async sendTask(
    envelope: TaskEnvelope,
    taskOptions?: AbortSignal | SoftwareAgentTaskOptions,
  ): Promise<SoftwareAgentResult> {
    if (this.activeChild) {
      throw new Error(`Software agent busy (task=${this.activeTaskId})`);
    }
    const { signal, observer } = normalizeSoftwareAgentTaskOptions(taskOptions);

    const taskId = envelope.taskId || `sw_${Date.now()}_${randomUUID().slice(0, 8)}`;
    const workdirSafety = resolveWorkdirSafety(
      this.config.workdir,
      envelope.workdir || this.config.workdir,
      envelope.workdirSafety?.allowOutsideWorkdir || false,
    );
    const workdir = workdirSafety.effectiveWorkdir;
    const effectiveEnvelope = { ...envelope, taskId, workdir, workdirSafety };
    const prompt = buildTaskEnvelopePrompt(effectiveEnvelope);
    const { cmd, args } = buildCodexExecCommand({
      command: this.config.command || "codex",
      workdir,
      model: this.config.model,
      sandbox: this.config.sandbox || "workspace-write",
    });

    const startedAt = Date.now();
    const startedAtIso = new Date(startedAt).toISOString();
    const relay = this.config.taskRelay || defaultTaskRelay;
    const commandLine = [cmd, ...args].join(" ");
    const spawnImpl = this.config.spawnImpl || spawn;
    const timeoutMs = envelope.timeoutMs || this.config.defaultTimeoutMs || DEFAULT_TIMEOUT_MS;
    const workdirStatus = this.collectWorkdirStatus(workdir);

    const baseTaskRecord = (): Omit<SoftwareAgentTaskRecord, "status" | "updatedAt"> => ({
      schemaVersion: 1,
      taskId,
      agentId: this.id,
      sessionId: this.sessionId,
      transport: "codex-exec",
      commandLine,
      envelope: effectiveEnvelope,
      startedAt: startedAtIso,
      workdirStatus,
    });

    return new Promise<SoftwareAgentResult>((resolve) => {
      this.activeTaskId = taskId;
      this.activeWorkdir = workdir;
      this.writeTaskRecord({
        ...baseTaskRecord(),
        status: "running",
        updatedAt: startedAtIso,
      });
      const origin = "software_agent";
      relay.sendTaskStart(taskId, origin, commandLine);
      observer?.onStart?.({ taskId, origin, commandLine });
      this.bus?.emit(SIG.TASK_STARTED, sig(SIG.TASK_STARTED, {
        taskId,
        taskType: "software_agent",
        description: effectiveEnvelope.goal,
        peripheral: this.id,
        sessionId: this.sessionId,
      }, this.id));

      let child: ChildProcess;
      try {
        child = spawnImpl(cmd, args, {
          cwd: workdir,
          env: process.env,
          stdio: ["pipe", "pipe", "pipe"],
          detached: true,
        });
      } catch (err: any) {
        this.activeChild = null;
        this.activeTaskId = null;
        this.activeWorkdir = null;
        const durationMs = Date.now() - startedAt;
        const result = {
          success: false,
          taskId,
          output: "",
          error: err.message || String(err),
          exitCode: null,
          durationMs,
        };
        relay.sendTaskEnd(taskId, null, durationMs);
        observer?.onEnd?.({ taskId, exitCode: null, durationMs, result: redactSecrets(result) });
        const completedAt = new Date().toISOString();
        this.writeTaskRecord({
          ...baseTaskRecord(),
          status: "failed",
          updatedAt: completedAt,
          completedAt,
          durationMs,
          result,
          stdoutSummary: summarizeText(""),
          stderrSummary: summarizeText(result.error || ""),
        });
        this.bus?.emit(SIG.TASK_FAILED, sig(SIG.TASK_FAILED, result, this.id));
        resolve(result);
        return;
      }

      this.activeChild = child;

      let stdout = "";
      let stderr = "";
      let finished = false;
      let aborted = false;
      const outDecoder = new StringDecoder("utf8");
      const errDecoder = new StringDecoder("utf8");
      const outRedactor = new StreamingRedactor();
      const errRedactor = new StreamingRedactor();
      const emitSafeStream = (stream: "stdout" | "stderr", text: string) => {
        if (!text) return;
        relay.sendTaskStream(taskId, stream, text);
        observer?.onStream?.({ taskId, stream, chunk: text });
      };

      const finish = (exitCode: number | null, error?: string) => {
        if (finished) return;
        finished = true;
        signal?.removeEventListener("abort", onAbort);
        clearTimeout(timer);
        const tailOut = outDecoder.end();
        const tailErr = errDecoder.end();
        if (tailOut) {
          stdout += tailOut;
          emitSafeStream("stdout", outRedactor.push(tailOut));
        }
        if (tailErr) {
          stderr += tailErr;
          emitSafeStream("stderr", errRedactor.push(tailErr));
        }
        emitSafeStream("stdout", outRedactor.flush());
        emitSafeStream("stderr", errRedactor.flush());
        const durationMs = Date.now() - startedAt;
        this.activeChild = null;
        this.activeTaskId = null;
        this.activeWorkdir = null;

        const output = stdout.trim() || stderr.trim();
        const success = !error && !aborted && exitCode === 0;
        const result: SoftwareAgentResult = {
          success,
          taskId,
          output,
          error: success ? undefined : error || stderr.trim() || `codex exited with code ${exitCode}`,
          exitCode,
          durationMs,
        };
        relay.sendTaskEnd(taskId, exitCode, durationMs);
        observer?.onEnd?.({ taskId, exitCode, durationMs, result: redactSecrets(result) });
        const completedAt = new Date().toISOString();
        this.writeTaskRecord({
          ...baseTaskRecord(),
          status: success ? "completed" : "failed",
          updatedAt: completedAt,
          completedAt,
          durationMs,
          result,
          stdoutSummary: summarizeText(stdout),
          stderrSummary: summarizeText(stderr),
        });

        this.bus?.emit(success ? SIG.TASK_COMPLETED : SIG.TASK_FAILED, sig(success ? SIG.TASK_COMPLETED : SIG.TASK_FAILED, {
          ...result,
          taskLabel: `software_agent:${this.id}`,
        }, this.id));
        resolve(result);
      };

      const onAbort = () => {
        if (aborted || !child.pid) return;
        aborted = true;
        try { process.kill(-child.pid, "SIGTERM"); } catch {}
        setTimeout(() => {
          try { process.kill(-child.pid!, "SIGKILL"); } catch {}
        }, 3000).unref();
      };

      const timer = setTimeout(() => {
        if (!child.pid) return;
        aborted = true;
        try { process.kill(-child.pid, "SIGTERM"); } catch {}
        setTimeout(() => {
          try { process.kill(-child.pid!, "SIGKILL"); } catch {}
        }, 3000).unref();
      }, timeoutMs);

      if (signal) {
        if (signal.aborted) onAbort();
        else signal.addEventListener("abort", onAbort, { once: true });
      }

      child.stdin?.on("error", () => {});
      child.stdin?.write(prompt);
      child.stdin?.end();

      child.stdout?.on("data", (chunk: Buffer) => {
        const text = outDecoder.write(chunk);
        if (!text) return;
        stdout += text;
        emitSafeStream("stdout", outRedactor.push(text));
      });

      child.stderr?.on("data", (chunk: Buffer) => {
        const text = errDecoder.write(chunk);
        if (!text) return;
        stderr += text;
        emitSafeStream("stderr", errRedactor.push(text));
      });

      child.on("close", (code) => {
        child.unref();
        finish(code);
      });

      child.on("error", (err) => {
        child.unref();
        finish(null, err.message);
      });
    });
  }

  private writeTaskRecord(record: SoftwareAgentTaskRecord): void {
    const dir = this.config.taskLedgerDir;
    if (!dir) return;
    try {
      mkdirSync(dir, { recursive: true });
      const safeTaskId = safeTaskFilename(record.taskId);
      writeFileSync(join(dir, `${safeTaskId}.json`), `${JSON.stringify(redactSecrets(record), null, 2)}\n`);
      pruneSoftwareAgentTaskRecords(dir, this.config.taskLedgerMaxRecords, record.taskId);
    } catch (err: any) {
      console.error(`[software-agent] Failed to write task ledger: ${err.message || String(err)}`);
    }
  }

  private collectWorkdirStatus(workdir: string): GitWorktreeStatus {
    const impl = this.config.gitStatusImpl || readGitWorktreeStatus;
    return impl(workdir);
  }
}

export function summarizeText(text: string, maxChars = MAX_STREAM_SUMMARY_CHARS): TextSummary {
  const normalized = text || "";
  const chars = normalized.length;
  const bytes = Buffer.byteLength(normalized, "utf8");
  const lines = normalized ? normalized.split(/\r\n|\r|\n/).length : 0;
  if (chars <= maxChars) {
    return { chars, bytes, lines, text: normalized, truncated: false };
  }

  const headChars = Math.min(STREAM_SUMMARY_HEAD_CHARS, maxChars);
  const tailChars = Math.max(0, maxChars - headChars);
  const omittedChars = chars - headChars - tailChars;
  const tailText = tailChars > 0 ? normalized.slice(-tailChars) : "";
  return {
    chars,
    bytes,
    lines,
    text: [
      normalized.slice(0, headChars),
      `[truncated ${omittedChars} chars]`,
      tailText,
    ].join("\n"),
    truncated: true,
    omittedChars,
  };
}

export function buildTaskEnvelopePrompt(envelope: TaskEnvelope): string {
  const lines: string[] = [
    "[Akemon Software Peripheral Task Envelope]",
    "",
    `Task ID: ${envelope.taskId || "(unspecified)"}`,
    `Source module: ${envelope.sourceModule}`,
    `Purpose: ${envelope.purpose}`,
    `Role scope: ${envelope.roleScope}`,
    `Memory scope: ${envelope.memoryScope}`,
    `Risk level: ${envelope.riskLevel}`,
    `Workdir: ${envelope.workdir}`,
  ];

  if (envelope.workdirSafety) {
    lines.push(`Base workdir: ${envelope.workdirSafety.baseWorkdir}`);
    lines.push(`Requested workdir: ${envelope.workdirSafety.requestedWorkdir}`);
    lines.push(`Effective workdir: ${envelope.workdirSafety.effectiveWorkdir}`);
    lines.push(`Outside base workdir: ${envelope.workdirSafety.outsideBaseWorkdir ? "yes" : "no"}`);
    lines.push(`Outside workdir explicitly allowed: ${envelope.workdirSafety.allowOutsideWorkdir ? "yes" : "no"}`);
  }

  lines.push("", "Goal:", envelope.goal, "");

  if (envelope.memorySummary?.trim()) {
    lines.push("Visible Akemon memory/context:");
    lines.push(envelope.memorySummary.trim());
    lines.push("");
  }

  if (envelope.allowedActions?.length) {
    lines.push("Allowed actions:");
    for (const item of envelope.allowedActions) lines.push(`- ${item}`);
    lines.push("");
  }

  if (envelope.forbiddenActions?.length) {
    lines.push("Forbidden actions:");
    for (const item of envelope.forbiddenActions) lines.push(`- ${item}`);
    lines.push("");
  }

  if (envelope.deliverable?.trim()) {
    lines.push("Expected deliverable:");
    lines.push(envelope.deliverable.trim());
    lines.push("");
  }

  lines.push("Instructions:");
  lines.push("- Treat this envelope as the complete Akemon-provided context for this task.");
  lines.push("- Do not attempt to read Akemon private memory outside the visible context above.");
  lines.push("- Work only in the stated workdir unless the envelope explicitly allows otherwise.");
  lines.push("- Report what changed, what you verified, and any remaining risk.");

  return lines.join("\n");
}

export function createOwnerTaskEnvelope(body: any, defaultWorkdir: string): TaskEnvelope {
  const goal = typeof body?.goal === "string" ? body.goal.trim() : "";
  if (!goal) throw new Error("Missing required string field: goal");
  const callerForbiddenActions = readOptionalStringArray(body?.forbiddenActions, "forbiddenActions");
  const requestedWorkdir = readOptionalString(body?.workdir, "workdir") || defaultWorkdir;
  const workdirSafety = resolveWorkdirSafety(
    defaultWorkdir,
    requestedWorkdir,
    readOptionalBoolean(body?.allowOutsideWorkdir, "allowOutsideWorkdir") || false,
  );

  return {
    taskId: readOptionalString(body?.taskId, "taskId"),
    sourceModule: "owner-http",
    purpose: readOptionalString(body?.purpose, "purpose") || "owner software-agent task",
    goal,
    workdir: workdirSafety.effectiveWorkdir,
    workdirSafety,
    roleScope: readEnum(body?.roleScope, "roleScope", ROLE_SCOPES, "owner"),
    memoryScope: readEnum(body?.memoryScope, "memoryScope", MEMORY_SCOPES, "owner"),
    riskLevel: readEnum(body?.riskLevel, "riskLevel", RISK_LEVELS, "medium"),
    allowedActions: body?.allowedActions !== undefined
      ? readOptionalStringArray(body?.allowedActions, "allowedActions")
      : [...DEFAULT_OWNER_ALLOWED_ACTIONS],
    forbiddenActions: [...new Set([...DEFAULT_OWNER_FORBIDDEN_ACTIONS, ...callerForbiddenActions])],
    memorySummary: typeof body?.memorySummary === "string" ? body.memorySummary : "",
    deliverable: typeof body?.deliverable === "string"
      ? body.deliverable
      : "Return a concise engineering summary with changes, verification, and remaining risks.",
    timeoutMs: readTimeoutMs(body?.timeoutMs),
  };
}

export function resolveWorkdirSafety(
  baseWorkdir: string,
  requestedWorkdir: string,
  allowOutsideWorkdir = false,
): WorkdirSafety {
  const base = resolvePath(baseWorkdir);
  const requested = isAbsolute(requestedWorkdir)
    ? resolvePath(requestedWorkdir)
    : resolvePath(base, requestedWorkdir);
  const rel = relative(base, requested);
  const outsideBaseWorkdir = !!rel && (rel.startsWith("..") || isAbsolute(rel));

  if (outsideBaseWorkdir && !allowOutsideWorkdir) {
    throw new Error(`Invalid workdir: ${requested} is outside base workdir ${base}`);
  }

  return {
    baseWorkdir: base,
    requestedWorkdir,
    effectiveWorkdir: requested,
    allowOutsideWorkdir,
    outsideBaseWorkdir,
  };
}

export function readGitWorktreeStatus(workdir: string): GitWorktreeStatus {
  const resolvedWorkdir = resolvePath(workdir);

  try {
    const rootResult = spawnSync("git", ["-C", resolvedWorkdir, "rev-parse", "--show-toplevel"], {
      encoding: "utf8",
      timeout: 5000,
    });

    if (rootResult.status !== 0) {
      return {
        workdir: resolvedWorkdir,
        isRepo: false,
        dirty: false,
        changedFiles: [],
        error: summarizeGitError(rootResult.stderr, rootResult.error),
      };
    }

    const root = String(rootResult.stdout || "").trim();
    const statusResult = spawnSync("git", ["-C", resolvedWorkdir, "status", "--short"], {
      encoding: "utf8",
      timeout: 5000,
    });

    if (statusResult.status !== 0) {
      return {
        workdir: resolvedWorkdir,
        isRepo: true,
        dirty: false,
        changedFiles: [],
        root,
        error: summarizeGitError(statusResult.stderr, statusResult.error),
      };
    }

    const changedFiles = String(statusResult.stdout || "")
      .split(/\r?\n/)
      .map((line) => line.trimEnd())
      .filter(Boolean)
      .map((line) => line.slice(3).trim())
      .filter(Boolean);

    return {
      workdir: resolvedWorkdir,
      isRepo: true,
      dirty: changedFiles.length > 0,
      changedFiles,
      root,
    };
  } catch (err: any) {
    return {
      workdir: resolvedWorkdir,
      isRepo: false,
      dirty: false,
      changedFiles: [],
      error: err.message || String(err),
    };
  }
}

export function listSoftwareAgentTaskRecords(taskLedgerDir: string, limit = 20): SoftwareAgentTaskRecord[] {
  const safeLimit = normalizeTaskRecordLimit(limit);
  try {
    if (!existsSync(taskLedgerDir)) return [];
    return readdirSync(taskLedgerDir, { withFileTypes: true })
      .filter((entry) => entry.isFile() && entry.name.endsWith(".json"))
      .map((entry) => readSoftwareAgentTaskRecordFile(join(taskLedgerDir, entry.name)))
      .filter((record): record is SoftwareAgentTaskRecord => !!record)
      .sort(compareSoftwareAgentTaskRecords)
      .slice(0, safeLimit);
  } catch {
    return [];
  }
}

export function readSoftwareAgentTaskRecord(
  taskLedgerDir: string,
  taskId: string,
): SoftwareAgentTaskRecord | null {
  const file = join(taskLedgerDir, `${safeTaskFilename(taskId)}.json`);
  return readSoftwareAgentTaskRecordFile(file);
}

export function pruneSoftwareAgentTaskRecords(
  taskLedgerDir: string,
  maxRecords = DEFAULT_TASK_LEDGER_MAX_RECORDS,
  preserveTaskId?: string,
): number {
  const safeMaxRecords = normalizeTaskLedgerMaxRecords(maxRecords);
  try {
    if (!existsSync(taskLedgerDir)) return 0;
    const records = readdirSync(taskLedgerDir, { withFileTypes: true })
      .filter((entry) => entry.isFile() && entry.name.endsWith(".json"))
      .map((entry) => {
        const file = join(taskLedgerDir, entry.name);
        const record = readSoftwareAgentTaskRecordFile(file);
        return record ? { file, record } : null;
      })
      .filter((entry): entry is { file: string; record: SoftwareAgentTaskRecord } => !!entry)
      .sort((a, b) => compareSoftwareAgentTaskRecords(a.record, b.record));

    const keepTaskIds = new Set(records.slice(0, safeMaxRecords).map((entry) => entry.record.taskId));
    if (preserveTaskId) keepTaskIds.add(preserveTaskId);

    let deleted = 0;
    for (const entry of records) {
      if (keepTaskIds.has(entry.record.taskId)) continue;
      try {
        unlinkSync(entry.file);
        deleted++;
      } catch {
        // Best effort: retention should not break task completion.
      }
    }
    return deleted;
  } catch {
    return 0;
  }
}

function readOptionalString(value: unknown, field: string): string | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "string") throw new Error(`Invalid ${field}: expected string`);
  const trimmed = value.trim();
  return trimmed || undefined;
}

function normalizeSoftwareAgentTaskOptions(
  options: AbortSignal | SoftwareAgentTaskOptions | undefined,
): SoftwareAgentTaskOptions {
  if (!options) return {};
  if (isAbortSignal(options)) {
    return { signal: options };
  }
  return options;
}

function isAbortSignal(value: unknown): value is AbortSignal {
  return !!value
    && typeof (value as AbortSignal).aborted === "boolean"
    && typeof (value as AbortSignal).addEventListener === "function";
}

function readOptionalStringArray(value: unknown, field: string): string[] {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value)) throw new Error(`Invalid ${field}: expected array of strings`);
  return value.map((item, index) => {
    if (typeof item !== "string" || !item.trim()) {
      throw new Error(`Invalid ${field}[${index}]: expected non-empty string`);
    }
    return item.trim();
  });
}

function readOptionalBoolean(value: unknown, field: string): boolean | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "boolean") throw new Error(`Invalid ${field}: expected boolean`);
  return value;
}

function readEnum<T extends string>(value: unknown, field: string, allowed: readonly T[], fallback: T): T {
  if (value === undefined || value === null || value === "") return fallback;
  if (typeof value !== "string" || !allowed.includes(value as T)) {
    throw new Error(`Invalid ${field}: expected one of ${allowed.join(", ")}`);
  }
  return value as T;
}

function readTimeoutMs(value: unknown): number | undefined {
  if (value === undefined || value === null) return undefined;
  if (
    typeof value !== "number"
    || !Number.isInteger(value)
    || value <= 0
    || value > MAX_OWNER_TIMEOUT_MS
  ) {
    throw new Error(`Invalid timeoutMs: expected integer between 1 and ${MAX_OWNER_TIMEOUT_MS}`);
  }
  return value;
}

function safeTaskFilename(taskId: string): string {
  const safe = taskId.replace(/[^A-Za-z0-9_.-]/g, "_").slice(0, 200);
  return safe || "task";
}

function summarizeGitError(stderr: unknown, error?: Error): string | undefined {
  if (error) return error.message;
  const text = typeof stderr === "string" ? stderr.trim() : "";
  return text || undefined;
}

function normalizeTaskRecordLimit(limit: number): number {
  if (!Number.isInteger(limit) || limit <= 0) return 20;
  return Math.min(limit, 100);
}

function normalizeTaskLedgerMaxRecords(limit: number): number {
  if (!Number.isInteger(limit) || limit <= 0) return DEFAULT_TASK_LEDGER_MAX_RECORDS;
  return Math.min(limit, 10_000);
}

function readSoftwareAgentTaskRecordFile(file: string): SoftwareAgentTaskRecord | null {
  try {
    if (!existsSync(file)) return null;
    const parsed = JSON.parse(readFileSync(file, "utf8"));
    if (!isSoftwareAgentTaskRecord(parsed)) return null;
    return parsed;
  } catch {
    return null;
  }
}

function isSoftwareAgentTaskRecord(value: any): value is SoftwareAgentTaskRecord {
  return value
    && value.schemaVersion === 1
    && typeof value.taskId === "string"
    && (value.status === "running" || value.status === "completed" || value.status === "failed")
    && typeof value.startedAt === "string"
    && typeof value.updatedAt === "string"
    && value.envelope
    && typeof value.envelope.goal === "string";
}

function compareSoftwareAgentTaskRecords(a: SoftwareAgentTaskRecord, b: SoftwareAgentTaskRecord): number {
  const bTime = Date.parse(b.updatedAt || b.startedAt) || 0;
  const aTime = Date.parse(a.updatedAt || a.startedAt) || 0;
  if (bTime !== aTime) return bTime - aTime;
  return b.taskId.localeCompare(a.taskId);
}

function buildCodexExecCommand(opts: {
  command: string;
  workdir: string;
  model?: string;
  sandbox: "read-only" | "workspace-write" | "danger-full-access";
}): { cmd: string; args: string[] } {
  const args = [
    "exec",
    "--skip-git-repo-check",
    "--color", "never",
    "-s", opts.sandbox,
    "-C", opts.workdir,
  ];
  if (opts.model) args.push("-m", opts.model);
  args.push("-");
  return { cmd: opts.command, args };
}
