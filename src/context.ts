/**
 * Context helpers — local conversation storage and product context.
 *
 * Conversations are stored as per-user markdown files in
 * .akemon/agents/{name}/conversations/{id}.md
 *
 * File format:
 *   ## Summary
 *   (compressed older rounds, initially empty)
 *
 *   ## Recent
 *   [2026-04-15 10:30] User: message
 *   [2026-04-15 10:30] Agent: reply
 */

import { readFile, writeFile, mkdir, appendFile, readdir, stat, unlink } from "fs/promises";
import { join } from "path";
import { localNow } from "./self.js";
import type { RelayPeripheral } from "./relay-peripheral.js";
import type { EnginePeripheral } from "./engine-peripheral.js";
import type { BioStateModule } from "./bio-module.js";
import type { MemoryModule } from "./memory-module.js";

// ---------------------------------------------------------------------------
// ServeOptions
// ---------------------------------------------------------------------------

export interface ServeOptions {
  port: number;
  workdir?: string;
  agentName: string;
  model?: string;
  mock?: boolean;
  key?: string;
  approve?: boolean;
  engine?: string;
  allowAll?: boolean;
  relayHttp?: string;
  secretKey?: string;
  mcpServer?: string;
  cycleInterval?: number; // minutes
  notifyUrl?: string; // ntfy.sh topic URL (CLI --notify, overrides config)
  /** V2: Relay peripheral instance (injected by serve()) */
  relay?: RelayPeripheral;
  /** V2: Engine peripheral instance (injected by serve()) */
  enginePeripheral?: EnginePeripheral;
  /** V2: Bio-state module instance (injected by serve()) */
  bioModule?: BioStateModule;
  /** V2: Memory module instance (injected by serve()) */
  memoryModule?: MemoryModule;
  /** V2: Which modules to enable (default: all) */
  enabledModules?: string[];
  /** Script name for ScriptModule (default: daily-life) */
  scriptName?: string;
}

// ---------------------------------------------------------------------------
// Local Conversation Storage
// ---------------------------------------------------------------------------

export interface ConversationRound {
  ts: string;
  role: "user" | "agent";
  content: string;
}

export interface Conversation {
  summary: string;
  rounds: ConversationRound[];
}

function conversationsDir(workdir: string, agentName: string): string {
  return join(workdir, ".akemon", "agents", agentName, "conversations");
}

function conversationPath(workdir: string, agentName: string, id: string): string {
  return join(conversationsDir(workdir, agentName), `${id}.md`);
}

/** Determine conversation ID from publisherId / sessionId. */
export function resolveConvId(publisherId: string, sessionId: string): string {
  if (publisherId) return `pub_${publisherId}`;
  if (sessionId) return `ses_${sessionId}`;
  return "ses_anonymous";
}

/** Parse a conversation markdown file into structured data. */
function parseConversation(content: string): Conversation {
  let summary = "";
  const rounds: ConversationRound[] = [];

  const summaryMatch = content.match(/## Summary\n([\s\S]*?)(?=\n## Recent|$)/);
  if (summaryMatch) {
    summary = summaryMatch[1].trim();
  }

  const recentMatch = content.match(/## Recent\n([\s\S]*)$/);
  if (recentMatch) {
    const lines = recentMatch[1].split("\n");
    for (const line of lines) {
      const m = line.match(/^\[(.+?)\] (User|Agent): (.*)$/);
      if (m) {
        rounds.push({
          ts: m[1],
          role: m[2].toLowerCase() as "user" | "agent",
          content: m[3],
        });
      }
    }
  }

  return { summary, rounds };
}

/** Load and parse a conversation. Returns empty conversation if file doesn't exist. */
export async function loadConversation(workdir: string, agentName: string, convId: string): Promise<Conversation> {
  try {
    const content = await readFile(conversationPath(workdir, agentName, convId), "utf-8");
    return parseConversation(content);
  } catch {
    return { summary: "", rounds: [] };
  }
}

/** Append a user+agent round to a conversation file. Creates file if needed. */
export async function appendRound(
  workdir: string, agentName: string, convId: string,
  userMsg: string, agentMsg: string,
): Promise<void> {
  const dir = conversationsDir(workdir, agentName);
  await mkdir(dir, { recursive: true });
  const p = conversationPath(workdir, agentName, convId);

  let content = "";
  try { content = await readFile(p, "utf-8"); } catch {}

  if (!content) {
    content = "## Summary\n\n\n## Recent\n";
  }

  const ts = localNow();
  const entry = `[${ts}] User: ${userMsg}\n[${ts}] Agent: ${agentMsg}\n`;
  content = content.trimEnd() + "\n" + entry;

  await writeFile(p, content);
}

/**
 * Build LLM context string from a conversation, respecting a character budget.
 * Takes recent rounds from the end, prepends summary if space remains.
 */
export function buildLLMContext(conv: Conversation, budget: number): { text: string; recentStartIndex: number } {
  if (!conv.rounds.length && !conv.summary) {
    return { text: "", recentStartIndex: 0 };
  }

  // Build recent rounds text from end, fitting within budget
  const recentLines: string[] = [];
  let recentSize = 0;
  let recentStartIndex = conv.rounds.length; // all rounds are "old" by default

  for (let i = conv.rounds.length - 1; i >= 0; i--) {
    const r = conv.rounds[i];
    const line = `[${r.ts}] ${r.role === "user" ? "User" : "Agent"}: ${r.content}`;
    if (recentSize + line.length + 1 > budget) break;
    recentLines.unshift(line);
    recentSize += line.length + 1;
    recentStartIndex = i;
  }

  const recentText = recentLines.join("\n");

  // Fill remaining budget with summary
  const remaining = budget - recentSize;
  let summaryText = "";
  if (conv.summary && remaining > 50) {
    summaryText = conv.summary.length <= remaining
      ? conv.summary
      : conv.summary.slice(0, remaining - 3) + "...";
  }

  const parts: string[] = [];
  if (summaryText) parts.push(`[Conversation summary]\n${summaryText}`);
  if (recentText) parts.push(`[Recent conversation]\n${recentText}`);

  return { text: parts.join("\n\n"), recentStartIndex };
}

/** List all conversations for an agent. */
export async function listConversations(workdir: string, agentName: string): Promise<{ id: string; lastActive: string; roundCount: number }[]> {
  const dir = conversationsDir(workdir, agentName);
  try {
    const files = await readdir(dir);
    const results: { id: string; lastActive: string; roundCount: number }[] = [];
    for (const f of files) {
      if (!f.endsWith(".md")) continue;
      const id = f.replace(/\.md$/, "");
      try {
        const st = await stat(join(dir, f));
        const content = await readFile(join(dir, f), "utf-8");
        const conv = parseConversation(content);
        results.push({
          id,
          lastActive: st.mtime.toISOString(),
          roundCount: conv.rounds.length,
        });
      } catch { continue; }
    }
    results.sort((a, b) => b.lastActive.localeCompare(a.lastActive));
    return results;
  } catch {
    return [];
  }
}

/** Delete session-only conversations older than maxAgeDays. */
export async function cleanStaleSessions(workdir: string, agentName: string, maxAgeDays = 7): Promise<number> {
  const dir = conversationsDir(workdir, agentName);
  const cutoff = Date.now() - maxAgeDays * 86400_000;
  let cleaned = 0;
  try {
    const files = await readdir(dir);
    for (const f of files) {
      if (!f.startsWith("ses_") || !f.endsWith(".md")) continue;
      try {
        const st = await stat(join(dir, f));
        if (st.mtimeMs < cutoff) {
          await unlink(join(dir, f));
          cleaned++;
        }
      } catch { continue; }
    }
  } catch {}
  if (cleaned) console.log(`[context] Cleaned ${cleaned} stale session conversations`);
  return cleaned;
}

// ---------------------------------------------------------------------------
// Product Context
// ---------------------------------------------------------------------------

function sanitizeProductDir(name: string): string {
  return name.replace(/[^a-zA-Z0-9\u4e00-\u9fff_\- ]/g, "_").slice(0, 80);
}

export async function loadProductContext(workdir: string, productName: string): Promise<string> {
  try {
    const dir = join(workdir, ".akemon", "products", sanitizeProductDir(productName));
    const notesPath = join(dir, "notes.md");
    return await readFile(notesPath, "utf-8");
  } catch {
    return "";
  }
}

export async function appendProductLog(workdir: string, productName: string, task: string, response: string): Promise<void> {
  try {
    const dir = join(workdir, ".akemon", "products", sanitizeProductDir(productName));
    await mkdir(dir, { recursive: true });

    // Append to interaction log
    const logPath = join(dir, "history.log");
    const timestamp = localNow();
    const entry = `\n--- ${timestamp} ---\nRequest: ${task.slice(0, 500)}\nResponse: ${response.slice(0, 500)}\n`;
    await appendFile(logPath, entry);

    // Create notes.md if it doesn't exist
    const notesPath = join(dir, "notes.md");
    try {
      await readFile(notesPath, "utf-8");
    } catch {
      await writeFile(notesPath, `# ${productName}\n\nProduct context and accumulated knowledge.\nThis file is auto-created. The agent can update it to improve service quality.\n\n## Customer Patterns\n\n(Will be populated as customers interact)\n`);
    }
  } catch (err) {
    console.log(`[product] Failed to save log: ${err}`);
  }
}
