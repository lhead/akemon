const REDACTION = "[REDACTED]";

const PRIVATE_KEY_BLOCK_RE = /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g;
const AUTH_HEADER_RE = /\b((?:Authorization\s*:\s*)?(?:Bearer|Basic)\s+)[A-Za-z0-9._~+/=-]{12,}/gi;
const URL_CREDENTIAL_RE = /\b([a-z][a-z0-9+.-]*:\/\/)([^/\s:@]+):([^/\s@]+)@/gi;
const SECRET_ASSIGNMENT_RE = /((?:^|[\s{,])["']?[A-Za-z0-9_.-]*(?:secret|token|password|passwd|pwd|api[_-]?key|access[_-]?key|private[_-]?key|credential)s?["']?\s*[:=]\s*["']?)([^"',\s})]+)/gi;

const KNOWN_TOKEN_PATTERNS: RegExp[] = [
  /\bsk-ant-[A-Za-z0-9_-]{20,}\b/g,
  /\bsk-[A-Za-z0-9_-]{20,}\b/g,
  /\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9_]{20,}\b/g,
  /\bgithub_pat_[A-Za-z0-9_]{20,}\b/g,
  /\bnpm_[A-Za-z0-9]{20,}\b/g,
  /\bxox[baprs]-[A-Za-z0-9-]{20,}\b/g,
  /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g,
  /\b[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{20,}\b/g,
];

const SENSITIVE_KEY_NAMES = new Set([
  "auth",
  "authorization",
  "bearer",
  "credential",
  "credentials",
  "password",
  "passwd",
  "pwd",
  "secret",
  "secretkey",
  "token",
  "accesstoken",
  "accesskey",
  "apikey",
  "rawapikey",
  "privatekey",
]);

export interface StreamingRedactorOptions {
  maxBufferedChars?: number;
}

const DEFAULT_MAX_BUFFERED_CHARS = 8192;
const SECRET_TERMINATOR_RE = /[\s"',}\])>]$/;
const POTENTIAL_SECRET_TAIL_PATTERNS: RegExp[] = [
  /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*$/i,
  /(?:^|[\s{,])["']?[A-Za-z0-9_.-]*(?:secret|token|password|passwd|pwd|api[_-]?key|access[_-]?key|private[_-]?key|credential)s?["']?\s*[:=]\s*["']?[^"',\s})]*$/i,
  /\b(?:Authorization\s*:\s*)?(?:Bearer|Basic)\s+[A-Za-z0-9._~+/=-]*$/i,
  /\b(?:sk-ant-|sk-|ghp_|gho_|ghu_|ghs_|ghr_|github_pat_|npm_|xox[baprs]-)[A-Za-z0-9._~+/=-]*$/i,
  /\b(?:AKIA|ASIA)[0-9A-Z]*$/i,
  /\b[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]*$/i,
  /\b[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]*$/i,
  /\b[a-z][a-z0-9+.-]*:\/\/[^/\s:@]+:[^/\s@]*$/i,
];

export class StreamingRedactor {
  private pending = "";
  private readonly maxBufferedChars: number;

  constructor(options: StreamingRedactorOptions = {}) {
    this.maxBufferedChars = normalizePositiveInt(options.maxBufferedChars, DEFAULT_MAX_BUFFERED_CHARS);
  }

  push(chunk: string): string {
    if (!chunk) return "";
    this.pending += chunk;

    const redacted = redactText(this.pending);
    if (redacted !== this.pending) {
      if (SECRET_TERMINATOR_RE.test(this.pending) || this.pending.length > this.maxBufferedChars) {
        this.pending = "";
        return redacted;
      }
      return "";
    }

    const holdStart = findPotentialSecretTailStart(this.pending);
    if (holdStart >= 0) {
      const output = this.pending.slice(0, holdStart);
      const held = this.pending.slice(holdStart);
      if (held.length > this.maxBufferedChars) {
        this.pending = "";
        return `${redactText(output)}${REDACTION}`;
      }
      this.pending = held;
      return redactText(output);
    }

    const output = this.pending;
    this.pending = "";
    return output;
  }

  flush(): string {
    if (!this.pending) return "";
    const output = redactText(this.pending);
    this.pending = "";
    return output;
  }
}

export function redactText(text: string): string {
  let redacted = text;
  redacted = redacted.replace(PRIVATE_KEY_BLOCK_RE, REDACTION);
  redacted = redacted.replace(URL_CREDENTIAL_RE, `$1${REDACTION}@`);
  redacted = redacted.replace(AUTH_HEADER_RE, `$1${REDACTION}`);
  redacted = redacted.replace(SECRET_ASSIGNMENT_RE, `$1${REDACTION}`);
  for (const pattern of KNOWN_TOKEN_PATTERNS) {
    redacted = redacted.replace(pattern, REDACTION);
  }
  return redacted;
}

export function redactSecrets<T>(value: T): T {
  return redactValue(value, new WeakMap<object, unknown>(), "") as T;
}

export function isSensitiveKey(key: string): boolean {
  const normalized = key.replace(/[^a-z0-9]/gi, "").toLowerCase();
  return SENSITIVE_KEY_NAMES.has(normalized)
    || normalized.endsWith("secret")
    || normalized.endsWith("token")
    || normalized.endsWith("password")
    || normalized.endsWith("apikey")
    || normalized.endsWith("accesskey")
    || normalized.endsWith("privatekey")
    || normalized.includes("credential");
}

function redactValue(value: unknown, seen: WeakMap<object, unknown>, key: string): unknown {
  if (isSensitiveKey(key) && value !== undefined && value !== null) {
    return REDACTION;
  }
  if (typeof value === "string") {
    return redactText(value);
  }
  if (!value || typeof value !== "object") {
    return value;
  }
  if (seen.has(value)) {
    return seen.get(value);
  }
  if (Array.isArray(value)) {
    const copy: unknown[] = [];
    seen.set(value, copy);
    for (const item of value) copy.push(redactValue(item, seen, ""));
    return copy;
  }
  if (!isPlainObject(value)) {
    return value;
  }

  const copy: Record<string, unknown> = {};
  seen.set(value, copy);
  for (const [childKey, childValue] of Object.entries(value)) {
    copy[childKey] = redactValue(childValue, seen, childKey);
  }
  return copy;
}

function isPlainObject(value: object): value is Record<string, unknown> {
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

function findPotentialSecretTailStart(text: string): number {
  let start = -1;
  for (const pattern of POTENTIAL_SECRET_TAIL_PATTERNS) {
    pattern.lastIndex = 0;
    const match = pattern.exec(text);
    if (match?.index !== undefined && (start < 0 || match.index < start)) {
      start = match.index;
    }
  }
  return start;
}

function normalizePositiveInt(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isInteger(value) && value > 0 ? value : fallback;
}
