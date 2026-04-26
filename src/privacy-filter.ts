import { spawn, type ChildProcess } from "node:child_process";
import { redactText } from "./redaction.js";

export type PrivacyFilterMode = "fast" | "pii" | "strict";
export type PrivacyFilterBackend = "fast" | "opf";

export interface PrivacyFilterOptions {
  mode?: PrivacyFilterMode;
  backend?: PrivacyFilterBackend;
  command?: string;
  device?: string;
  checkpoint?: string;
  timeoutMs?: number;
  maxBufferBytes?: number;
  maxInputChars?: number;
  spawnImpl?: typeof spawn;
  env?: NodeJS.ProcessEnv;
}

export interface PrivacyFilterResult {
  text: string;
  mode: PrivacyFilterMode;
  backend: PrivacyFilterBackend;
  opfApplied: boolean;
  warnings: string[];
}

export class PrivacyFilterUnavailableError extends Error {
  constructor(message: string, options: { cause?: unknown } = {}) {
    super(message);
    this.name = "PrivacyFilterUnavailableError";
    if (options.cause !== undefined) {
      (this as Error & { cause?: unknown }).cause = options.cause;
    }
  }
}

const DEFAULT_OPF_COMMAND = "opf";
const DEFAULT_TIMEOUT_MS = 30_000;
const DEFAULT_MAX_BUFFER_BYTES = 2 * 1024 * 1024;
const DEFAULT_MAX_INPUT_CHARS = 32_000;

export async function sanitizeText(text: string, options: PrivacyFilterOptions = {}): Promise<PrivacyFilterResult> {
  const mode = normalizeMode(options.mode);
  const env = { ...process.env, ...(options.env || {}) };
  const backend = resolveBackend(mode, options.backend, env);
  const fastText = redactText(text || "");

  if (backend === "fast") {
    return {
      text: fastText,
      mode,
      backend,
      opfApplied: false,
      warnings: [],
    };
  }

  try {
    const filteredText = await runOpfCli(fastText, options, env);
    return {
      text: filteredText,
      mode,
      backend,
      opfApplied: true,
      warnings: [],
    };
  } catch (error) {
    if (mode === "strict") {
      throw toPrivacyFilterUnavailableError(error);
    }
    return {
      text: fastText,
      mode,
      backend,
      opfApplied: false,
      warnings: [`OPF unavailable, used built-in redaction: ${redactText(errorMessage(error))}`],
    };
  }
}

function normalizeMode(mode: PrivacyFilterMode | undefined): PrivacyFilterMode {
  if (mode === undefined) return "fast";
  if (mode === "fast" || mode === "pii" || mode === "strict") return mode;
  throw new TypeError(`Invalid privacy filter mode: ${String(mode)}`);
}

function resolveBackend(
  mode: PrivacyFilterMode,
  backend: PrivacyFilterBackend | undefined,
  env: NodeJS.ProcessEnv,
): PrivacyFilterBackend {
  if (backend !== undefined) return normalizeBackend(backend);

  const envBackend = env.AKEMON_PRIVACY_FILTER?.trim().toLowerCase();
  if (envBackend) return normalizeBackend(envBackend);

  return mode === "strict" ? "opf" : "fast";
}

function normalizeBackend(backend: string): PrivacyFilterBackend {
  if (backend === "fast" || backend === "opf") return backend;
  throw new TypeError(`Invalid privacy filter backend: ${backend}`);
}

async function runOpfCli(text: string, options: PrivacyFilterOptions, env: NodeJS.ProcessEnv): Promise<string> {
  const maxInputChars = readPositiveInt(
    options.maxInputChars,
    env.AKEMON_OPF_MAX_INPUT_CHARS,
    DEFAULT_MAX_INPUT_CHARS,
  );
  if (text.length > maxInputChars) {
    throw new PrivacyFilterUnavailableError(`OPF input length ${text.length} exceeds max ${maxInputChars} chars`);
  }

  const command = options.command || env.AKEMON_OPF_COMMAND || DEFAULT_OPF_COMMAND;
  const timeoutMs = readPositiveInt(options.timeoutMs, env.AKEMON_OPF_TIMEOUT_MS, DEFAULT_TIMEOUT_MS);
  const maxBufferBytes = readPositiveInt(
    options.maxBufferBytes,
    env.AKEMON_OPF_MAX_BUFFER_BYTES,
    DEFAULT_MAX_BUFFER_BYTES,
  );
  const device = options.device || env.AKEMON_OPF_DEVICE;
  const checkpoint = options.checkpoint || env.AKEMON_OPF_CHECKPOINT;
  const args = buildOpfArgs(text, { device, checkpoint });
  const spawnImpl = options.spawnImpl || spawn;

  const stdout = await collectChildOutput(
    spawnImpl(command, args, {
      env,
      stdio: ["ignore", "pipe", "pipe"],
    }),
    timeoutMs,
    maxBufferBytes,
  );

  return parseOpfRedactedText(stdout);
}

function buildOpfArgs(text: string, options: { device?: string; checkpoint?: string }): string[] {
  const args = [
    "redact",
    "--format",
    "json",
    "--output-mode",
    "redacted",
    "--json-indent",
    "0",
    "--no-print-color-coded-text",
  ];

  if (options.device) args.push("--device", options.device);
  if (options.checkpoint) args.push("--checkpoint", options.checkpoint);
  args.push(text);
  return args;
}

function collectChildOutput(child: ChildProcess, timeoutMs: number, maxBufferBytes: number): Promise<string> {
  return new Promise((resolve, reject) => {
    let stdout = "";
    let stderr = "";
    let stdoutBytes = 0;
    let stderrBytes = 0;
    let settled = false;

    const timer = setTimeout(() => {
      fail(new PrivacyFilterUnavailableError(`OPF timed out after ${timeoutMs}ms`));
      child.kill("SIGTERM");
    }, timeoutMs);

    const fail = (error: unknown) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(toPrivacyFilterUnavailableError(error));
    };

    child.stdout?.on("data", (chunk: Buffer | string) => {
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      stdoutBytes += buffer.byteLength;
      if (stdoutBytes > maxBufferBytes) {
        fail(new PrivacyFilterUnavailableError(`OPF stdout exceeded ${maxBufferBytes} bytes`));
        child.kill("SIGTERM");
        return;
      }
      stdout += buffer.toString("utf8");
    });

    child.stderr?.on("data", (chunk: Buffer | string) => {
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      stderrBytes += buffer.byteLength;
      if (stderrBytes > maxBufferBytes) {
        fail(new PrivacyFilterUnavailableError(`OPF stderr exceeded ${maxBufferBytes} bytes`));
        child.kill("SIGTERM");
        return;
      }
      stderr += buffer.toString("utf8");
    });

    child.on("error", fail);
    child.on("close", (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (code !== 0) {
        reject(new PrivacyFilterUnavailableError(`OPF exited with code ${code}: ${stderr.trim() || "no stderr"}`));
        return;
      }
      resolve(stdout);
    });
  });
}

function parseOpfRedactedText(stdout: string): string {
  let parsed: unknown;
  try {
    parsed = JSON.parse(stdout);
  } catch (error) {
    throw new PrivacyFilterUnavailableError("OPF did not return valid JSON", { cause: error });
  }

  if (!parsed || typeof parsed !== "object") {
    throw new PrivacyFilterUnavailableError("OPF JSON output was not an object");
  }

  const redacted = (parsed as { redacted_text?: unknown; redactedText?: unknown }).redacted_text
    ?? (parsed as { redactedText?: unknown }).redactedText;
  if (typeof redacted !== "string") {
    throw new PrivacyFilterUnavailableError("OPF JSON output did not include redacted_text");
  }
  return redacted;
}

function readPositiveInt(value: unknown, envValue: string | undefined, fallback: number): number {
  const raw = value !== undefined ? value : envValue;
  const parsed = typeof raw === "number" ? raw : Number(raw);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

function toPrivacyFilterUnavailableError(error: unknown): PrivacyFilterUnavailableError {
  if (error instanceof PrivacyFilterUnavailableError) return error;
  return new PrivacyFilterUnavailableError(errorMessage(error), { cause: error });
}

function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}
