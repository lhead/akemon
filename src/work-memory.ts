import { randomUUID } from "crypto";
import type { Dirent } from "fs";
import { appendFile, mkdir, readdir, readFile } from "fs/promises";
import { basename, dirname, join } from "path";
import { localNow } from "./self.js";
import { redactSecrets, redactText } from "./redaction.js";

export interface WorkMemoryContextOptions {
  workdir: string;
  agentName: string;
  purpose?: string;
  budget?: number;
}

export interface WorkMemoryContextSection {
  title: string;
  path?: string;
  relativePath?: string;
  chars: number;
  truncated: boolean;
  content: string;
}

export interface WorkMemoryContextPacket {
  agentName: string;
  workdir: string;
  workMemoryDir: string;
  generatedAt: string;
  purpose: string;
  budget: number;
  sections: WorkMemoryContextSection[];
  text: string;
}

export interface WorkMemoryNoteInput {
  workdir: string;
  agentName: string;
  text: string;
  source?: string;
  sessionId?: string;
  kind?: string;
  target?: string;
}

export interface WorkMemoryNoteRecord {
  id: string;
  ts: string;
  agentName: string;
  source: string;
  sessionId?: string;
  kind: string;
  text: string;
  target?: string;
}

const DEFAULT_CONTEXT_BUDGET = 12_000;
const MIN_CONTEXT_BUDGET = 1_000;
const MAX_CONTEXT_BUDGET = 80_000;
const MAX_SECTION_CHARS = 4_000;
const MAX_INDEX_FILES = 200;
const MAX_INDEX_DEPTH = 4;
const WORK_DIR = "work";
const WORK_INBOX_FILE = "inbox.md";

const DEFAULT_CONTEXT_FILES = [
  "README.md",
  "current.md",
  "handoff.md",
  "decisions.md",
  "commands.md",
  "notes.md",
  WORK_INBOX_FILE,
];

const INDEX_FILE_EXTENSIONS = new Set([
  ".md",
  ".txt",
  ".json",
  ".jsonl",
  ".yaml",
  ".yml",
]);

export function workMemoryDir(workdir: string, agentName: string): string {
  return join(workdir, ".akemon", "agents", cleanAgentName(agentName), WORK_DIR);
}

export function workMemoryInboxPath(workdir: string, agentName: string): string {
  return join(workMemoryDir(workdir, agentName), WORK_INBOX_FILE);
}

export async function buildWorkMemoryContext(
  opts: WorkMemoryContextOptions,
): Promise<WorkMemoryContextPacket> {
  const budget = normalizeBudget(opts.budget);
  const agentName = cleanAgentName(opts.agentName);
  const root = workMemoryDir(opts.workdir, agentName);
  const generatedAt = localNow();
  const purpose = cleanSingleLine(opts.purpose || "external software-agent work context", 180);
  const sections = await collectWorkContextSections(root);
  const text = renderWorkMemoryContext({
    agentName,
    workdir: opts.workdir,
    workMemoryDir: root,
    generatedAt,
    purpose,
    budget,
    sections,
  });

  return {
    agentName,
    workdir: opts.workdir,
    workMemoryDir: root,
    generatedAt,
    purpose,
    budget,
    sections,
    text: fitText(text, budget),
  };
}

export async function appendWorkMemoryNote(
  input: WorkMemoryNoteInput,
): Promise<{ note: WorkMemoryNoteRecord; path: string }> {
  const text = cleanMultiline(input.text, 8_000);
  if (!text) throw new Error("Missing required work memory note text");

  const note: WorkMemoryNoteRecord = {
    id: `work_${Date.now()}_${randomUUID().slice(0, 8)}`,
    ts: localNow(),
    agentName: cleanAgentName(input.agentName),
    source: cleanToken(input.source || "user", "source", 80),
    kind: cleanToken(input.kind || "note", "kind", 80),
    text,
  };

  const sessionId = cleanOptionalToken(input.sessionId, "sessionId", 120);
  if (sessionId) note.sessionId = sessionId;
  const target = cleanOptionalPathHint(input.target);
  if (target) note.target = target;

  const redacted = redactSecrets(note);
  const path = target
    ? join(workMemoryDir(input.workdir, note.agentName), target)
    : workMemoryInboxPath(input.workdir, note.agentName);
  await mkdir(dirname(path), { recursive: true });
  await appendFile(path, renderWorkMemoryNote(redacted), "utf-8");
  return { note: redacted, path };
}

async function collectWorkContextSections(root: string): Promise<WorkMemoryContextSection[]> {
  const sections: WorkMemoryContextSection[] = [];

  for (const file of DEFAULT_CONTEXT_FILES) {
    const section = await readWorkContextFile(root, file);
    if (section) sections.push(section);
  }

  const index = await buildWorkFileIndex(root);
  if (index) sections.push(index);

  return sections;
}

async function readWorkContextFile(root: string, relativePath: string): Promise<WorkMemoryContextSection | null> {
  const path = join(root, relativePath);
  let raw: string;
  try {
    raw = await readFile(path, "utf-8");
  } catch {
    return null;
  }

  const redacted = redactText(selectUsefulFileContent(relativePath, raw));
  const trimmed = redacted.trim();
  const content = fitText(trimmed, MAX_SECTION_CHARS);
  return {
    title: relativePath,
    path,
    relativePath,
    chars: trimmed.length,
    truncated: content.length < trimmed.length,
    content,
  };
}

async function buildWorkFileIndex(root: string): Promise<WorkMemoryContextSection | null> {
  const files = await listWorkMemoryFiles(root);
  if (!files.length) return null;
  const content = files.map((file) => `- ${file}`).join("\n");
  return {
    title: "work memory file index",
    path: root,
    relativePath: ".",
    chars: content.length,
    truncated: files.length >= MAX_INDEX_FILES,
    content,
  };
}

async function listWorkMemoryFiles(root: string): Promise<string[]> {
  const files: string[] = [];
  await walk(root, "", 0, files);
  return files.sort((a, b) => a.localeCompare(b)).slice(0, MAX_INDEX_FILES);
}

async function walk(root: string, relativeDir: string, depth: number, files: string[]): Promise<void> {
  if (depth > MAX_INDEX_DEPTH || files.length >= MAX_INDEX_FILES) return;
  const dir = relativeDir ? join(root, relativeDir) : root;
  let entries: Dirent[];
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return;
  }

  for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    if (files.length >= MAX_INDEX_FILES) return;
    if (entry.name.startsWith(".")) continue;
    const relativePath = relativeDir ? `${relativeDir}/${entry.name}` : entry.name;
    if (entry.isDirectory()) {
      await walk(root, relativePath, depth + 1, files);
      continue;
    }
    if (!entry.isFile()) continue;
    if (!INDEX_FILE_EXTENSIONS.has(extensionOf(entry.name))) continue;
    files.push(relativePath);
  }
}

function renderWorkMemoryContext(packet: Omit<WorkMemoryContextPacket, "text">): string {
  const lines: string[] = [
    "# Akemon Work Memory Context",
    "",
    `Generated at: ${packet.generatedAt}`,
    `Agent: ${packet.agentName}`,
    `Purpose: ${packet.purpose}`,
    `Workdir: ${packet.workdir}`,
    `Work memory directory: ${packet.workMemoryDir}`,
    "",
    "## Boundary",
    "",
    "- This is user-owned work memory for engineering and task continuity.",
    "- External tools such as Codex or Claude Code may read this work directory as task context.",
    "- External tools may update this work directory when the user or task asks them to maintain work memory.",
    "- Do not read or edit Akemon self memory through this work-memory interface.",
    "- Use grep, direct file reading, semantic review, or your own tool workflow as appropriate for the task.",
    "",
    "## Suggested Update Command",
    "",
    "```bash",
    `akemon work-note \"<durable work memory>\" --source codex --kind decision`,
    "```",
  ];

  if (!packet.sections.length) {
    lines.push("", "## Included Work Memory", "", "No work memory files were found yet.");
    lines.push("", "Create files under the work memory directory or use `akemon work-note` to append a quick note.");
    return lines.join("\n");
  }

  lines.push("", "## Included Work Memory");
  for (const section of packet.sections) {
    lines.push("");
    lines.push(`### ${section.title}`);
    if (section.relativePath) lines.push(`Path: ${section.relativePath}`);
    if (section.truncated) lines.push(`Truncated from ${section.chars} chars.`);
    lines.push("");
    lines.push("```");
    lines.push(section.content || "(empty)");
    lines.push("```");
  }

  return lines.join("\n");
}

function renderWorkMemoryNote(note: WorkMemoryNoteRecord): string {
  const lines = [
    "",
    `## ${note.ts} ${note.kind}`,
    "",
    `Source: ${note.source}`,
  ];
  if (note.sessionId) lines.push(`Session: ${note.sessionId}`);
  if (note.target) lines.push(`Target: ${note.target}`);
  lines.push("", note.text.trim(), "");
  return lines.join("\n");
}

function selectUsefulFileContent(relativePath: string, raw: string): string {
  if (!relativePath.endsWith(".jsonl")) return raw;
  const lines = raw.trim().split(/\r?\n/).filter(Boolean);
  return lines.slice(-20).join("\n");
}

function normalizeBudget(value: number | undefined): number {
  if (value === undefined || value === null) return DEFAULT_CONTEXT_BUDGET;
  if (!Number.isInteger(value) || value <= 0) throw new Error("Context budget must be a positive integer");
  return Math.max(MIN_CONTEXT_BUDGET, Math.min(MAX_CONTEXT_BUDGET, value));
}

function cleanToken(value: string, field: string, maxChars: number): string {
  const cleaned = cleanSingleLine(value, maxChars);
  if (!cleaned) throw new Error(`Missing required ${field}`);
  if (!/^[A-Za-z0-9_.:@-]+$/.test(cleaned)) {
    throw new Error(`Invalid ${field}: expected letters, numbers, dot, underscore, colon, at, or hyphen`);
  }
  return cleaned;
}

function cleanAgentName(value: string): string {
  const cleaned = cleanSingleLine(value, 120);
  if (!cleaned) throw new Error("Missing required agentName");
  if (cleaned === "." || cleaned === ".." || cleaned.includes("/") || cleaned.includes("\\") || cleaned.includes("\0")) {
    throw new Error("Invalid agentName: path separators and NUL bytes are not allowed");
  }
  return cleaned;
}

function cleanOptionalToken(value: string | undefined, field: string, maxChars: number): string | undefined {
  if (value === undefined || value === null || value.trim() === "") return undefined;
  return cleanToken(value, field, maxChars);
}

function cleanOptionalPathHint(value: string | undefined): string | undefined {
  if (value === undefined || value === null || value.trim() === "") return undefined;
  const cleaned = cleanSingleLine(value, 240);
  if (cleaned.includes("\0") || cleaned.startsWith("/") || cleaned.includes("\\") || cleaned.split("/").includes("..")) {
    throw new Error("Invalid target path");
  }
  const base = basename(cleaned);
  if (base === "." || base === "..") throw new Error("Invalid target path");
  return cleaned;
}

function cleanSingleLine(value: string, maxChars: number): string {
  return fitText(String(value || "").replace(/\s+/g, " ").trim(), maxChars);
}

function cleanMultiline(value: string, maxChars: number): string {
  return fitText(String(value || "").replace(/\0/g, "").trim(), maxChars);
}

function fitText(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text;
  if (maxChars <= 20) return text.slice(0, maxChars);
  const omitted = text.length - maxChars;
  const head = Math.floor(maxChars * 0.65);
  const tail = Math.max(0, maxChars - head - 40);
  return `${text.slice(0, head)}\n[truncated ${omitted} chars]\n${text.slice(-tail)}`;
}

function extensionOf(file: string): string {
  const index = file.lastIndexOf(".");
  return index >= 0 ? file.slice(index).toLowerCase() : "";
}
