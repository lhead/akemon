/**
 * Context helpers — session context and product context for conversations.
 * Extracted from server.ts (Phase 1 code organization).
 */

import { readFile, writeFile, mkdir, appendFile } from "fs/promises";
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
// Session Context API
// ---------------------------------------------------------------------------

const MAX_CONTEXT_BYTES = 8192;

export async function fetchContext(relayHttp: string, agentName: string, secretKey: string, publisherId: string): Promise<string> {
  try {
    const url = `${relayHttp}/v1/agent/${agentName}/sessions/${publisherId}/context`;
    const res = await fetch(url, {
      headers: { Authorization: `Bearer ${secretKey}` },
    });
    if (!res.ok) return "";
    return await res.text();
  } catch (err) {
    console.log(`[context] GET failed: ${err}`);
    return "";
  }
}

export async function storeContext(relayHttp: string, agentName: string, secretKey: string, publisherId: string, context: string): Promise<void> {
  try {
    const url = `${relayHttp}/v1/agent/${agentName}/sessions/${publisherId}/context`;
    await fetch(url, {
      method: "PUT",
      headers: { Authorization: `Bearer ${secretKey}`, "Content-Type": "text/plain" },
      body: context,
    });
  } catch (err) {
    console.log(`[context] PUT failed: ${err}`);
  }
}

export function buildContextPayload(prevContext: string, task: string, response: string): string {
  // Append the new round
  let newRound = `\n\n[Round]\nUser: ${task}\nAssistant: ${response}`;
  let context = prevContext + newRound;

  // Trim oldest rounds if over limit
  while (Buffer.byteLength(context, "utf-8") > MAX_CONTEXT_BYTES) {
    const firstRound = context.indexOf("\n\n[Round]\n", 1);
    if (firstRound === -1) {
      // Single round too large — truncate response
      context = context.slice(context.length - MAX_CONTEXT_BYTES);
      break;
    }
    context = context.slice(firstRound);
  }

  return context;
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
