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
import { spawn, type ChildProcess } from "child_process";
import { StringDecoder } from "string_decoder";
import type { EventBus, Peripheral, Signal } from "./types.js";
import { SIG, sig } from "./types.js";
import { sendTaskEnd, sendTaskStart, sendTaskStream } from "./relay-client.js";

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

export interface SoftwareAgentResult {
  success: boolean;
  taskId: string;
  output: string;
  error?: string;
  exitCode: number | null;
  durationMs: number;
}

export interface SoftwareAgentPeripheral extends Peripheral {
  startSession(): Promise<void>;
  sendTask(envelope: TaskEnvelope, signal?: AbortSignal): Promise<SoftwareAgentResult>;
  resetSession(): Promise<void>;
  getState(): Record<string, unknown>;
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

export class CodexSoftwareAgentPeripheral implements SoftwareAgentPeripheral {
  id: string;
  name: string;
  capabilities = ["code-agent", "repo-inspect", "repo-edit", "tool-use", "skill-use", "streaming"];
  tags = ["software-agent", "codex"];

  private config: CodexSoftwareAgentConfig;
  private bus: EventBus | null = null;
  private activeChild: ChildProcess | null = null;
  private activeTaskId: string | null = null;
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
    if (this.activeChild?.pid) {
      try { process.kill(-this.activeChild.pid, "SIGTERM"); } catch {}
      setTimeout(() => {
        try { process.kill(-this.activeChild!.pid!, "SIGKILL"); } catch {}
      }, 3000).unref();
    }
    this.activeChild = null;
    this.activeTaskId = null;
    this.sessionId = randomUUID();
  }

  getState(): Record<string, unknown> {
    return {
      id: this.id,
      sessionId: this.sessionId,
      activeTaskId: this.activeTaskId,
      busy: !!this.activeChild,
      transport: "codex-exec",
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

  async sendTask(envelope: TaskEnvelope, signal?: AbortSignal): Promise<SoftwareAgentResult> {
    if (this.activeChild) {
      throw new Error(`Software agent busy (task=${this.activeTaskId})`);
    }

    const taskId = envelope.taskId || `sw_${Date.now()}_${randomUUID().slice(0, 8)}`;
    const workdir = envelope.workdir || this.config.workdir;
    const prompt = buildTaskEnvelopePrompt({ ...envelope, taskId, workdir });
    const { cmd, args } = buildCodexExecCommand({
      command: this.config.command || "codex",
      workdir,
      model: this.config.model,
      sandbox: this.config.sandbox || "workspace-write",
    });

    const startedAt = Date.now();
    const relay = this.config.taskRelay || defaultTaskRelay;
    const commandLine = [cmd, ...args].join(" ");
    const spawnImpl = this.config.spawnImpl || spawn;
    const timeoutMs = envelope.timeoutMs || this.config.defaultTimeoutMs || DEFAULT_TIMEOUT_MS;

    return new Promise<SoftwareAgentResult>((resolve) => {
      this.activeTaskId = taskId;
      relay.sendTaskStart(taskId, "software_agent", commandLine);
      this.bus?.emit(SIG.TASK_STARTED, sig(SIG.TASK_STARTED, {
        taskId,
        taskType: "software_agent",
        description: envelope.goal,
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
        const durationMs = Date.now() - startedAt;
        relay.sendTaskEnd(taskId, null, durationMs);
        const result = {
          success: false,
          taskId,
          output: "",
          error: err.message || String(err),
          exitCode: null,
          durationMs,
        };
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

      const finish = (exitCode: number | null, error?: string) => {
        if (finished) return;
        finished = true;
        signal?.removeEventListener("abort", onAbort);
        clearTimeout(timer);
        const tailOut = outDecoder.end();
        const tailErr = errDecoder.end();
        if (tailOut) {
          stdout += tailOut;
          relay.sendTaskStream(taskId, "stdout", tailOut);
        }
        if (tailErr) {
          stderr += tailErr;
          relay.sendTaskStream(taskId, "stderr", tailErr);
        }
        const durationMs = Date.now() - startedAt;
        relay.sendTaskEnd(taskId, exitCode, durationMs);
        this.activeChild = null;
        this.activeTaskId = null;

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
        relay.sendTaskStream(taskId, "stdout", text);
      });

      child.stderr?.on("data", (chunk: Buffer) => {
        const text = errDecoder.write(chunk);
        if (!text) return;
        stderr += text;
        relay.sendTaskStream(taskId, "stderr", text);
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
    "",
    "Goal:",
    envelope.goal,
    "",
  ];

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
  const callerForbiddenActions = readOptionalStringArray(body.forbiddenActions, "forbiddenActions");

  return {
    taskId: readOptionalString(body.taskId, "taskId"),
    sourceModule: "owner-http",
    purpose: readOptionalString(body.purpose, "purpose") || "owner software-agent task",
    goal,
    workdir: readOptionalString(body.workdir, "workdir") || defaultWorkdir,
    roleScope: readEnum(body.roleScope, "roleScope", ROLE_SCOPES, "owner"),
    memoryScope: readEnum(body.memoryScope, "memoryScope", MEMORY_SCOPES, "owner"),
    riskLevel: readEnum(body.riskLevel, "riskLevel", RISK_LEVELS, "medium"),
    allowedActions: body.allowedActions !== undefined
      ? readOptionalStringArray(body.allowedActions, "allowedActions")
      : [...DEFAULT_OWNER_ALLOWED_ACTIONS],
    forbiddenActions: [...new Set([...DEFAULT_OWNER_FORBIDDEN_ACTIONS, ...callerForbiddenActions])],
    memorySummary: typeof body.memorySummary === "string" ? body.memorySummary : "",
    deliverable: typeof body.deliverable === "string"
      ? body.deliverable
      : "Return a concise engineering summary with changes, verification, and remaining risks.",
    timeoutMs: readTimeoutMs(body.timeoutMs),
  };
}

function readOptionalString(value: unknown, field: string): string | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "string") throw new Error(`Invalid ${field}: expected string`);
  const trimmed = value.trim();
  return trimmed || undefined;
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
