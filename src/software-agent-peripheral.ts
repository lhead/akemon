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
export type SoftwareAgentEnvPolicy = "inherit" | "allowlist";

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
  /** User-owned work memory directory that external software agents may read/update as task context. */
  workMemoryDir?: string;
  /** Akemon-managed context session for cross-run continuity. Distinct from Codex transport session id. */
  contextSessionId?: string;
  /** Path to the Akemon-generated context packet for this task. */
  contextPacketPath?: string;
  /** Concise summary from the previous task in the same Akemon context session. */
  previousTaskSummary?: string;
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

export interface SoftwareAgentEnvironmentAudit {
  policy: SoftwareAgentEnvPolicy;
  allowedKeys?: string[];
}

export interface SoftwareAgentContextSessionAudit {
  sessionId: string;
  packetPath: string;
  statePath: string;
}

export interface SoftwareAgentContextSessionRecord {
  sessionId: string;
  packetPath: string;
  statePath: string;
  hasContextPacket: boolean;
  updatedAt?: string;
  lastTaskId?: string;
  lastGoal?: string;
  lastResult?: {
    success: boolean;
    exitCode: number | null;
    durationMs: number;
    outputSummary?: TextSummary;
    errorSummary?: TextSummary;
  };
  contextPacket?: string;
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
  environment?: SoftwareAgentEnvironmentAudit;
  contextSession?: SoftwareAgentContextSessionAudit;
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
  contextSessionId?: string;
  contextPacketPath?: string;
  workMemoryDir?: string;
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
  contextSessionId?: string;
  contextPacketPath?: string;
  workMemoryDir?: string;
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
  contextSessionDir?: string;
  workMemoryDir?: string;
  gitStatusImpl?: (workdir: string) => GitWorktreeStatus;
  envPolicy?: SoftwareAgentEnvPolicy;
  envAllowlist?: string[];
  sourceEnv?: NodeJS.ProcessEnv;
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
const CONTEXT_PACKET_FILENAME = "TASK_CONTEXT.md";
const CONTEXT_SESSION_STATE_FILENAME = "SESSION.json";
const MAX_CONTEXT_SESSION_ID_LENGTH = 120;
const MAX_CONTEXT_SESSION_SUMMARY_CHARS = 4_000;
const DEFAULT_SOFTWARE_AGENT_ENV_POLICY: SoftwareAgentEnvPolicy = "inherit";
const DEFAULT_SOFTWARE_AGENT_ENV_ALLOWLIST = [
  "PATH",
  "HOME",
  "SHELL",
  "USER",
  "LOGNAME",
  "TMPDIR",
  "TEMP",
  "TMP",
  "LANG",
  "LC_ALL",
  "LC_CTYPE",
  "TERM",
  "COLORTERM",
  "NO_COLOR",
  "FORCE_COLOR",
  "OPENAI_API_KEY",
  "OPENAI_BASE_URL",
  "OPENAI_ORG_ID",
  "OPENAI_ORGANIZATION",
  "OPENAI_PROJECT",
  "OPENAI_MODEL",
  "CODEX_HOME",
  "CODEX_MODEL",
  "CODEX_PROFILE",
] as const;

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
    this.config = {
      ...config,
      envPolicy: normalizeSoftwareAgentEnvPolicy(config.envPolicy),
      envAllowlist: normalizeSoftwareAgentEnvAllowlist(config.envAllowlist),
    };
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
      contextSessionDir: this.config.contextSessionDir,
      workMemoryDir: this.config.workMemoryDir,
      environment: buildSoftwareAgentChildEnvironment({
        policy: this.config.envPolicy,
        allowlist: this.config.envAllowlist,
        sourceEnv: this.config.sourceEnv,
      }).audit,
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
    const contextSessionId = normalizeContextSessionId(envelope.contextSessionId) || taskId;
    const workdirSafety = resolveWorkdirSafety(
      this.config.workdir,
      envelope.workdir || this.config.workdir,
      envelope.workdirSafety?.allowOutsideWorkdir || false,
    );
    const workdir = workdirSafety.effectiveWorkdir;
    let effectiveEnvelope: TaskEnvelope = {
      ...envelope,
      taskId,
      contextSessionId,
      workdir,
      workdirSafety,
      workMemoryDir: envelope.workMemoryDir || this.config.workMemoryDir,
    };
    const contextSession = this.config.contextSessionDir
      ? writeSoftwareAgentContextPacket(this.config.contextSessionDir, effectiveEnvelope)
      : undefined;
    if (contextSession) effectiveEnvelope = contextSession.envelope;
    const prompt = contextSession
      ? buildContextPacketLaunchPrompt(effectiveEnvelope, contextSession.audit.packetPath)
      : buildTaskEnvelopePrompt(effectiveEnvelope);
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
    const taskMetadata = {
      contextSessionId: effectiveEnvelope.contextSessionId,
      contextPacketPath: effectiveEnvelope.contextPacketPath,
      workMemoryDir: effectiveEnvelope.workMemoryDir,
    };
    const childEnvironment = buildSoftwareAgentChildEnvironment({
      policy: this.config.envPolicy,
      allowlist: this.config.envAllowlist,
      sourceEnv: this.config.sourceEnv,
    });

    const baseTaskRecord = (): Omit<SoftwareAgentTaskRecord, "status" | "updatedAt"> => ({
      schemaVersion: 1,
      taskId,
      agentId: this.id,
      sessionId: this.sessionId,
      transport: "codex-exec",
      commandLine,
      envelope: effectiveEnvelope,
      startedAt: startedAtIso,
      environment: childEnvironment.audit,
      contextSession: contextSession?.audit,
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
      observer?.onStart?.({ taskId, origin, commandLine, ...taskMetadata });
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
          env: childEnvironment.env,
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
        observer?.onEnd?.({
          taskId,
          exitCode: null,
          durationMs,
          result: redactSecrets(result),
          ...taskMetadata,
        });
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
        if (contextSession) {
          writeSoftwareAgentContextSessionState(contextSession.audit.statePath, effectiveEnvelope, result, completedAt);
        }
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
        observer?.onEnd?.({
          taskId,
          exitCode,
          durationMs,
          result: redactSecrets(result),
          ...taskMetadata,
        });
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
        if (contextSession) {
          writeSoftwareAgentContextSessionState(contextSession.audit.statePath, effectiveEnvelope, result, completedAt);
        }

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
    `Akemon context session: ${envelope.contextSessionId || "(one-shot)"}`,
    `Source module: ${envelope.sourceModule}`,
    `Purpose: ${envelope.purpose}`,
    `Role scope: ${envelope.roleScope}`,
    `Memory scope: ${envelope.memoryScope}`,
    `Risk level: ${envelope.riskLevel}`,
    `Workdir: ${envelope.workdir}`,
  ];

  if (envelope.workMemoryDir) {
    lines.push(`Work memory directory: ${envelope.workMemoryDir}`);
  }

  if (envelope.contextPacketPath) {
    lines.push(`Context packet path: ${envelope.contextPacketPath}`);
  }

  if (envelope.workdirSafety) {
    lines.push(`Base workdir: ${envelope.workdirSafety.baseWorkdir}`);
    lines.push(`Requested workdir: ${envelope.workdirSafety.requestedWorkdir}`);
    lines.push(`Effective workdir: ${envelope.workdirSafety.effectiveWorkdir}`);
    lines.push(`Outside base workdir: ${envelope.workdirSafety.outsideBaseWorkdir ? "yes" : "no"}`);
    lines.push(`Outside workdir explicitly allowed: ${envelope.workdirSafety.allowOutsideWorkdir ? "yes" : "no"}`);
  }

  lines.push("", "Goal:", envelope.goal, "");

  if (envelope.previousTaskSummary?.trim()) {
    lines.push("Previous task summary for this Akemon context session:");
    lines.push(envelope.previousTaskSummary.trim());
    lines.push("");
  }

  if (envelope.memorySummary?.trim()) {
    lines.push("Visible Akemon memory/context:");
    lines.push(envelope.memorySummary.trim());
    lines.push("");
  }

  if (envelope.workMemoryDir) {
    lines.push("Work memory:");
    lines.push("- This is user-owned working context for engineering/task continuity.");
    lines.push("- You may read it with grep, direct file browsing, or semantic review as appropriate.");
    lines.push("- You may update files under this directory when the task or user asks you to maintain work memory.");
    lines.push("- Do not read or edit Akemon self memory as part of this software-agent task.");
    lines.push("- For a quick append, use `akemon work-note \"<durable work memory>\" --source codex --kind note`.");
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
  lines.push("- Do not read or edit Akemon self memory unless the user explicitly names a normal file to inspect.");
  lines.push("- Work only in the stated workdir unless the envelope explicitly allows otherwise.");
  lines.push("- If you learn durable work memory, update the work memory directory or use `akemon work-note`.");
  lines.push("- Report what changed, what you verified, and any remaining risk.");

  return lines.join("\n");
}

export function buildContextPacketLaunchPrompt(envelope: TaskEnvelope, contextPacketPath: string): string {
  return [
    "[Akemon Software Peripheral Task]",
    "",
    `Task ID: ${envelope.taskId || "(unspecified)"}`,
    `Akemon context session: ${envelope.contextSessionId || "(one-shot)"}`,
    `Context packet: ${contextPacketPath}`,
    `Workdir: ${envelope.workdir}`,
    `Work memory directory: ${envelope.workMemoryDir || "(not configured)"}`,
    "",
    "Goal:",
    envelope.goal,
    "",
    "Instructions:",
    "- Read the context packet first before doing repository work.",
    "- Treat that file as the complete Akemon-provided context for this task.",
    "- Do not read Akemon private memory outside the context packet.",
    "- Do not read or edit Akemon self memory unless the user explicitly names a normal file to inspect.",
    "- Work only in the stated workdir unless the packet explicitly allows otherwise.",
    "- If you learn durable work memory, update the work memory directory or use `akemon work-note`.",
    "- Report what changed, what you verified, and any remaining risk.",
  ].join("\n");
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
    contextSessionId: readOptionalContextSessionId(body?.contextSessionId ?? body?.sessionId, "contextSessionId"),
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

export function listSoftwareAgentTaskRecords(
  taskLedgerDir: string,
  limit = 20,
  opts: { contextSessionId?: string } = {},
): SoftwareAgentTaskRecord[] {
  const safeLimit = normalizeTaskRecordLimit(limit);
  const contextSessionId = opts.contextSessionId?.trim();
  try {
    if (!existsSync(taskLedgerDir)) return [];
    return readdirSync(taskLedgerDir, { withFileTypes: true })
      .filter((entry) => entry.isFile() && entry.name.endsWith(".json"))
      .map((entry) => readSoftwareAgentTaskRecordFile(join(taskLedgerDir, entry.name)))
      .filter((record): record is SoftwareAgentTaskRecord => !!record)
      .filter((record) => !contextSessionId || record.contextSession?.sessionId === contextSessionId || record.envelope.contextSessionId === contextSessionId)
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

export function listSoftwareAgentContextSessions(
  contextSessionDir: string,
  limit = 20,
): SoftwareAgentContextSessionRecord[] {
  const safeLimit = normalizeTaskRecordLimit(limit);
  try {
    if (!existsSync(contextSessionDir)) return [];
    return readdirSync(contextSessionDir, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => {
        try {
          return readSoftwareAgentContextSession(contextSessionDir, entry.name);
        } catch {
          return null;
        }
      })
      .filter((record): record is SoftwareAgentContextSessionRecord => !!record)
      .sort(compareSoftwareAgentContextSessions)
      .slice(0, safeLimit);
  } catch {
    return [];
  }
}

export function readSoftwareAgentContextSession(
  contextSessionDir: string,
  sessionId: string,
  opts: { includeContextPacket?: boolean } = {},
): SoftwareAgentContextSessionRecord | null {
  const safeSessionId = normalizeContextSessionId(sessionId, "sessionId");
  if (!safeSessionId) return null;
  const sessionDir = join(contextSessionDir, safeSessionId);
  if (!existsSync(sessionDir)) return null;

  const packetPath = join(sessionDir, CONTEXT_PACKET_FILENAME);
  const statePath = join(sessionDir, CONTEXT_SESSION_STATE_FILENAME);
  const state = readSoftwareAgentContextSessionState(statePath);
  const record: SoftwareAgentContextSessionRecord = {
    sessionId: safeSessionId,
    packetPath,
    statePath,
    hasContextPacket: existsSync(packetPath),
  };

  if (state) {
    record.updatedAt = state.updatedAt;
    record.lastTaskId = state.lastTaskId;
    record.lastGoal = state.lastGoal;
    record.lastResult = state.lastResult;
  }

  if (opts.includeContextPacket && record.hasContextPacket) {
    try {
      record.contextPacket = readFileSync(packetPath, "utf8");
    } catch {
      record.contextPacket = "";
    }
  }

  return record;
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

export function buildSoftwareAgentChildEnvironment(opts: {
  policy?: SoftwareAgentEnvPolicy;
  allowlist?: string[];
  sourceEnv?: NodeJS.ProcessEnv;
} = {}): { env: NodeJS.ProcessEnv; audit: SoftwareAgentEnvironmentAudit } {
  const policy = normalizeSoftwareAgentEnvPolicy(opts.policy);
  const sourceEnv = opts.sourceEnv || process.env;

  if (policy === "inherit") {
    return {
      env: sourceEnv,
      audit: { policy },
    };
  }

  const allowlist = normalizeSoftwareAgentEnvAllowlist([
    ...DEFAULT_SOFTWARE_AGENT_ENV_ALLOWLIST,
    ...(opts.allowlist || []),
  ]);
  const env: NodeJS.ProcessEnv = {};
  for (const key of allowlist) {
    if (isForbiddenSoftwareAgentEnvKey(key)) continue;
    const value = sourceEnv[key];
    if (value !== undefined) env[key] = value;
  }

  return {
    env,
    audit: {
      policy,
      allowedKeys: Object.keys(env).sort(),
    },
  };
}

function writeSoftwareAgentContextPacket(
  contextSessionDir: string,
  envelope: TaskEnvelope,
): { envelope: TaskEnvelope; audit: SoftwareAgentContextSessionAudit } {
  const sessionId = normalizeContextSessionId(envelope.contextSessionId) || envelope.taskId || randomUUID();
  const sessionDir = join(contextSessionDir, sessionId);
  const packetPath = join(sessionDir, CONTEXT_PACKET_FILENAME);
  const statePath = join(sessionDir, CONTEXT_SESSION_STATE_FILENAME);
  const previousTaskSummary = readSoftwareAgentContextSessionSummary(statePath);
  const packetEnvelope: TaskEnvelope = {
    ...envelope,
    contextSessionId: sessionId,
    contextPacketPath: packetPath,
    previousTaskSummary,
  };

  mkdirSync(sessionDir, { recursive: true });
  const content = buildTaskEnvelopePrompt(packetEnvelope);
  writeFileSync(packetPath, `${redactSecrets(content)}\n`);

  return {
    envelope: packetEnvelope,
    audit: { sessionId, packetPath, statePath },
  };
}

function writeSoftwareAgentContextSessionState(
  statePath: string,
  envelope: TaskEnvelope,
  result: SoftwareAgentResult,
  updatedAt: string,
): void {
  try {
    const state = {
      schemaVersion: 1,
      sessionId: envelope.contextSessionId,
      updatedAt,
      lastTaskId: result.taskId,
      lastGoal: envelope.goal,
      lastResult: {
        success: result.success,
        exitCode: result.exitCode,
        durationMs: result.durationMs,
        outputSummary: summarizeText(result.output || "", MAX_CONTEXT_SESSION_SUMMARY_CHARS),
        errorSummary: result.error ? summarizeText(result.error, MAX_CONTEXT_SESSION_SUMMARY_CHARS) : undefined,
      },
    };
    writeFileSync(statePath, `${JSON.stringify(redactSecrets(state), null, 2)}\n`);
  } catch (err: any) {
    console.error(`[software-agent] Failed to write context session state: ${err.message || String(err)}`);
  }
}

function readSoftwareAgentContextSessionSummary(statePath: string): string | undefined {
  try {
    const parsed = readSoftwareAgentContextSessionState(statePath);
    if (!parsed?.lastTaskId || !parsed.lastResult) return undefined;
    const result = parsed.lastResult;
    const status = result.success === true ? "completed" : "failed";
    const lines = [
      `Previous task: ${parsed.lastTaskId}`,
      parsed.lastGoal ? `Previous goal: ${parsed.lastGoal}` : "",
      `Status: ${status}`,
      Number.isInteger(result.exitCode) ? `Exit code: ${result.exitCode}` : "Exit code: null",
      Number.isInteger(result.durationMs) ? `Duration: ${result.durationMs}ms` : "",
      result.outputSummary?.text ? "Previous output summary:" : "",
      result.outputSummary?.text || "",
      result.errorSummary?.text ? "Previous error summary:" : "",
      result.errorSummary?.text || "",
    ].filter(Boolean);
    const summary = lines.join("\n").trim();
    return summary ? summarizeText(summary, MAX_CONTEXT_SESSION_SUMMARY_CHARS).text : undefined;
  } catch {
    return undefined;
  }
}

function readSoftwareAgentContextSessionState(statePath: string): SoftwareAgentContextSessionState | null {
  try {
    if (!existsSync(statePath)) return null;
    const parsed = JSON.parse(readFileSync(statePath, "utf8"));
    if (!isSoftwareAgentContextSessionState(parsed)) return null;
    return parsed;
  } catch {
    return null;
  }
}

interface SoftwareAgentContextSessionState {
  schemaVersion: 1;
  sessionId: string;
  updatedAt: string;
  lastTaskId: string;
  lastGoal?: string;
  lastResult: {
    success: boolean;
    exitCode: number | null;
    durationMs: number;
    outputSummary?: TextSummary;
    errorSummary?: TextSummary;
  };
}

function isSoftwareAgentContextSessionState(value: any): value is SoftwareAgentContextSessionState {
  return value
    && value.schemaVersion === 1
    && typeof value.sessionId === "string"
    && typeof value.updatedAt === "string"
    && typeof value.lastTaskId === "string"
    && value.lastResult
    && typeof value.lastResult.success === "boolean"
    && (typeof value.lastResult.exitCode === "number" || value.lastResult.exitCode === null)
    && typeof value.lastResult.durationMs === "number";
}

function readOptionalString(value: unknown, field: string): string | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "string") throw new Error(`Invalid ${field}: expected string`);
  const trimmed = value.trim();
  return trimmed || undefined;
}

function readOptionalContextSessionId(value: unknown, field: string): string | undefined {
  if (value === undefined || value === null || value === "") return undefined;
  if (typeof value !== "string") throw new Error(`Invalid ${field}: expected string`);
  return normalizeContextSessionId(value, field);
}

function normalizeContextSessionId(value: string | undefined, field = "contextSessionId"): string | undefined {
  if (!value) return undefined;
  const trimmed = value.trim();
  if (!trimmed) return undefined;
  if (trimmed.length > MAX_CONTEXT_SESSION_ID_LENGTH) {
    throw new Error(`Invalid ${field}: expected at most ${MAX_CONTEXT_SESSION_ID_LENGTH} characters`);
  }
  if (!/^[A-Za-z0-9][A-Za-z0-9_.-]*$/.test(trimmed)) {
    throw new Error(`Invalid ${field}: expected letters, numbers, dot, underscore, or hyphen`);
  }
  return trimmed;
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

function normalizeSoftwareAgentEnvPolicy(value: unknown): SoftwareAgentEnvPolicy {
  if (value === undefined || value === null || value === "") return DEFAULT_SOFTWARE_AGENT_ENV_POLICY;
  if (value === "inherit" || value === "allowlist") return value;
  throw new Error("Invalid software-agent env policy: expected inherit or allowlist");
}

function normalizeSoftwareAgentEnvAllowlist(values: readonly string[] | undefined): string[] {
  if (!values) return [];
  const seen = new Set<string>();
  for (const value of values) {
    if (typeof value !== "string") {
      throw new Error("Invalid software-agent env allowlist entry: expected string");
    }
    const key = value.trim();
    if (!key) continue;
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) {
      throw new Error(`Invalid software-agent env allowlist entry: ${key}`);
    }
    seen.add(key);
  }
  return [...seen];
}

function isForbiddenSoftwareAgentEnvKey(key: string): boolean {
  const upper = key.toUpperCase();
  if (upper.startsWith("AKEMON_")) return true;
  const looksLikeCredential = /(?:SECRET|TOKEN|ACCESS|KEY|CREDENTIAL)/.test(upper);
  return looksLikeCredential && (upper.includes("RELAY") || upper.includes("OWNER"));
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

function compareSoftwareAgentContextSessions(
  a: SoftwareAgentContextSessionRecord,
  b: SoftwareAgentContextSessionRecord,
): number {
  const bTime = Date.parse(b.updatedAt || "") || 0;
  const aTime = Date.parse(a.updatedAt || "") || 0;
  if (bTime !== aTime) return bTime - aTime;
  return b.sessionId.localeCompare(a.sessionId);
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
