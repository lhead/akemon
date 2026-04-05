import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { ListToolsRequestSchema, CallToolRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import { spawn, exec } from "child_process";
import { createServer } from "http";
import { createInterface } from "readline";
import { callAgent } from "./relay-client.js";
import {
  selfDir, initWorld, initBioState, initGuide, biosPath,
  loadWorld, loadBioState, saveBioState,
  loadLatestIdentity, appendIdentity,
  loadIdentitySummary, saveIdentitySummary, loadUnsummarizedIdentities, needsIdentityCompression,
  onTaskCompleted, recoverEnergy,
  saveCanvas,
  getSelfState, loadRecentCanvasEntries,
  gamesDir, loadGameList, saveGame, loadGame,
  notesDir, loadNotesList, loadNote,
  pagesDir, loadPageList, loadPage,
  localNow, localNowFilename,
  appendImpression, loadImpressions, compressImpressions, markImpressionsDigested,
  loadProjects, saveProjects,
  loadRelationships, saveRelationships,
  loadDiscoveries, saveDiscoveries,
  initAgentConfig, loadAgentConfig,
  getDueUserTasks, loadTaskRuns, saveTaskRuns, UserTask,
  loadDirectives, buildDirectivesPrompt, directivesSummary,
  appendTaskHistory, loadTaskHistory, TaskHistoryEntry,
  notifyOwner,
  loadUserTasks, directivesPath, appendAgentTask,
} from "./self.js";

// Engine mutual exclusion — only one engine process at a time
let engineBusy = false;
let engineBusySince = 0;
let lastEngineTrace: any[] = []; // execution trace for order reporting

/** Report an execution log to the relay (fire-and-forget) */
function reportExecutionLog(
  relayHttp: string, secretKey: string, agentName: string,
  type: string, refId: string, status: string, error: string, trace: any[]
) {
  if (!relayHttp || !secretKey) return;
  const traceJson = trace.length > 0 ? JSON.stringify(trace).slice(0, 50000) : "";
  fetch(`${relayHttp}/v1/agent/${encodeURIComponent(agentName)}/logs`, {
    method: "POST",
    headers: { Authorization: `Bearer ${secretKey}`, "Content-Type": "application/json" },
    body: JSON.stringify({ type, ref_id: refId, status, error: error.slice(0, 2000), trace: traceJson }),
    signal: AbortSignal.timeout(10_000),
  }).catch(() => {}); // fire-and-forget
}

// Order push notification — urgent orders bypass 30s poll
const urgentOrderIds = new Set<string>();
let triggerWork: (() => void) | null = null;

export function onOrderNotify(orderId: string): void {
  urgentOrderIds.add(orderId);
  triggerWork?.();
}

function runCommand(cmd: string, args: string[], task: string, cwd: string, stdinMode: boolean = true): Promise<string> {
  return new Promise((resolve, reject) => {
    const { CLAUDECODE, ...cleanEnv } = process.env;
    const finalArgs = stdinMode ? args : [...args, task];
    console.log(`[engine] Running: ${cmd} ${finalArgs.join(" ")}`);
    const child = spawn(cmd, finalArgs, {
      cwd,
      env: cleanEnv,
      stdio: [stdinMode ? "pipe" : "ignore", "pipe", "pipe"],
      timeout: 300_000,
    });

    if (stdinMode && child.stdin) {
      child.stdin.on("error", () => {}); // Ignore EPIPE if child exits early
      child.stdin.write(task);
      child.stdin.end();
    }

    let stdout = "";
    let stderr = "";

    child.stdout?.on("data", (chunk: Buffer) => {
      stdout += chunk.toString();
    });

    child.stderr?.on("data", (chunk: Buffer) => {
      stderr += chunk.toString();
    });

    child.on("close", (code) => {
      console.log(`[${cmd}] exit=${code} stdout=${stdout.length}b stderr=${stderr.length}b`);
      if (stderr) console.log(`[${cmd}] stderr:\n${stderr}`);
      if (stdout) console.log(`[${cmd}] stdout:\n${stdout}`);
      const output = stdout.trim();
      if (output) {
        resolve(output);
      } else {
        reject(new Error(`${cmd} exited with code ${code}, no stdout`));
      }
    });

    child.on("error", reject);
  });
}

function runTerminal(command: string, cwd: string): Promise<string> {
  return new Promise((resolve) => {
    exec(command, { cwd, timeout: 300_000, maxBuffer: 1024 * 1024 }, (err, stdout, stderr) => {
      const output = (stdout || "") + (stderr ? "\n[stderr]\n" + stderr : "");
      if (err && !output.trim()) {
        resolve(`[error] ${err.message}`);
      } else {
        resolve(output.trim() || "[no output]");
      }
    });
  });
}

// stdinMode: true = send task via stdin, false = send task as argument
function buildEngineCommand(engine: string, model?: string, allowAll?: boolean, extraAllowedTools?: string[]): { cmd: string; args: string[]; stdinMode: boolean } {
  switch (engine) {
    case "claude": {
      const args = ["--print"];
      if (model) args.push("--model", model);
      if (allowAll) {
        args.push(
          "--allowedTools", "Read", "Write", "Edit",
          "Bash(curl *)", "Bash(mkdir *)", "Bash(ls *)", "Bash(cat *)"
        );
      } else if (extraAllowedTools && extraAllowedTools.length > 0) {
        args.push("--allowedTools", ...extraAllowedTools);
      }
      return { cmd: "claude", args, stdinMode: true };
    }
    case "codex": {
      const args = ["exec", "--skip-git-repo-check", "-s", "workspace-write"];
      if (model) args.push("-m", model);
      return { cmd: "codex", args, stdinMode: true };
    }
    case "opencode": {
      const args = ["run"];
      if (model) args.push("--model", model);
      return { cmd: "opencode", args, stdinMode: false }; // task appended as arg
    }
    case "gemini":
      return { cmd: "gemini", args: ["-p"], stdinMode: false }; // no --model flag, use settings.json
    default:
      return { cmd: engine, args: [], stdinMode: true };
  }
}

function promptOwner(task: string, isHuman: boolean): Promise<string> {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve) => {
    console.log(`\n${"=".repeat(60)}`);
    console.log(`  INCOMING TASK`);
    console.log(`${"=".repeat(60)}`);
    console.log(task);
    console.log(`${"=".repeat(60)}`);
    if (isHuman) {
      console.log(`  [type reply]  → send your reply`);
      console.log(`  skip          → decline this task`);
    } else {
      console.log(`  [Enter]       → auto-execute with engine`);
      console.log(`  [type reply]  → send your reply directly`);
      console.log(`  skip          → decline this task`);
    }
    console.log(`${"=".repeat(60)}`);
    rl.question("> ", (answer) => {
      rl.close();
      resolve(answer);
    });
  });
}

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
}

// --- Context API helpers ---

const MAX_CONTEXT_BYTES = 8192;

async function fetchContext(relayHttp: string, agentName: string, secretKey: string, publisherId: string): Promise<string> {
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

async function storeContext(relayHttp: string, agentName: string, secretKey: string, publisherId: string, context: string): Promise<void> {
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

function buildContextPayload(prevContext: string, task: string, response: string): string {
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

// --- Product context helpers ---

import { readFile, writeFile, mkdir, appendFile, unlink } from "fs/promises";
import { join } from "path";

function sanitizeProductDir(name: string): string {
  return name.replace(/[^a-zA-Z0-9\u4e00-\u9fff_\- ]/g, "_").slice(0, 80);
}

async function loadProductContext(workdir: string, productName: string): Promise<string> {
  try {
    const dir = join(workdir, ".akemon", "products", sanitizeProductDir(productName));
    const notesPath = join(dir, "notes.md");
    return await readFile(notesPath, "utf-8");
  } catch {
    return "";
  }
}

async function appendProductLog(workdir: string, productName: string, task: string, response: string): Promise<void> {
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

// --- Auto-route engine ---

async function autoRoute(task: string, selfName: string, relayHttp: string): Promise<string> {
  // Fetch online public agents
  const res = await fetch(`${relayHttp}/v1/agents?online=true&public=true`);
  const agents: any[] = await res.json();

  // Filter out self
  const candidates = agents.filter((a: any) => a.name !== selfName);
  if (candidates.length === 0) {
    return "[auto] No available agents to route to.";
  }

  // Value-based scoring: quality / price (cost-benefit analysis)
  const taskWords = task.toLowerCase().split(/\s+/).filter((w: string) => w.length >= 2);
  const scored = candidates.map((a: any) => {
    let quality = 0;
    const desc = (a.description || "").toLowerCase();
    const tags: string[] = (a.tags || []).map((t: string) => t.toLowerCase());
    // Relevance: keyword match
    for (const word of taskWords) {
      if (tags.some((t: string) => t.includes(word))) quality += 100;
      if (desc.includes(word)) quality += 50;
    }
    // Track record
    quality += (a.success_rate || 0) * 100;
    quality += (a.level || 1) * 10;
    // Value = quality / cost (prefer cheaper agents when quality is similar)
    const price = a.price || 1;
    const value = quality / price;
    return { name: a.name, engine: a.engine, price, quality, value };
  }).sort((a: any, b: any) => b.value - a.value);

  const target = scored[0];
  console.log(`[auto] Routing to ${target.name} (quality=${target.quality}, price=${target.price}, value=${target.value.toFixed(1)})`);

  try {
    const result = await callAgent(target.name, task);
    return `[auto → ${target.name}]\n\n${result}`;
  } catch (err: any) {
    return `[auto] Failed to call ${target.name}: ${err.message}`;
  }
}

interface McpServerOptions {
  workdir: string;
  agentName: string;
  mock?: boolean;
  model?: string;
  approve?: boolean;
  engine?: string;
  allowAll?: boolean;
  relayHttp?: string;
  secretKey?: string;
  publisherIds: Map<string, string>;
}

function createMcpServer(opts: McpServerOptions): McpServer {
  const { workdir, agentName, mock, model, approve, engine = "claude", allowAll, relayHttp, secretKey, publisherIds } = opts;

  const server = new McpServer({
    name: agentName,
    version: "0.1.0",
  });

  const isHuman = engine === "human";
  const contextEnabled = !!(relayHttp && secretKey);

  server.tool(
    "submit_task",
    "Submit a task to this agent. Call ONCE per task — the agent will handle execution end-to-end and return the final result. Do NOT call again to verify or confirm; the response IS the final answer.",
    {
      task: z.string().describe("The task description for the agent to complete"),
      require_human: z.union([z.boolean(), z.string()]).optional().describe("Request the agent owner to review and respond personally."),
      collaborative: z.union([z.boolean(), z.string()]).optional().describe("Ask multiple online agents and synthesize their answers."),
    },
    async ({ task, require_human: rawHuman, collaborative: rawCollab }, extra) => {
      const require_human = rawHuman === true || rawHuman === "true";
      console.log(`[submit_task] Received: ${task} (engine=${engine}, require_human=${require_human})`);

      // Check engine busy
      if (engineBusy) {
        console.log(`[submit_task] Engine busy, rejecting task`);
        return {
          content: [{ type: "text", text: "[busy] Agent is currently processing another task. Please try again later." }],
        };
      }

      // Resolve publisher ID from session
      const publisherId = publisherIds.get(extra.sessionId || "") || "";

      // Fetch context if available
      let prevContext = "";
      if (contextEnabled && publisherId) {
        prevContext = await fetchContext(relayHttp!, agentName, secretKey!, publisherId);
        if (prevContext) {
          console.log(`[context] Loaded ${prevContext.length} bytes for publisher=${publisherId.slice(0, 8)}`);
        }
      }

      const contextPrefix = prevContext
        ? `[Previous conversation context]\n${prevContext}\n\n---\n\n`
        : "";

      // Product purchase detection — load product-specific context
      let productContext = "";
      let productName = "";
      const productMatch = task.match(/^\[Product purchase\] Product: (.+?)\n/);
      if (productMatch) {
        productName = productMatch[1];
        productContext = await loadProductContext(workdir, productName);
        if (productContext) {
          console.log(`[product] Loaded context for "${productName}" (${productContext.length} bytes)`);
        }
      }

      const productPrefix = productContext
        ? `[Product specialization — accumulated knowledge for "${productName}"]\n${productContext}\n\n---\n\n`
        : "";

      const bios = biosPath(workdir, agentName);
      const safeTask = `[EXTERNAL TASK — A user or agent is asking you something. This is NOT a market cycle. Do NOT reply with JSON. Answer in natural language.]

You are ${agentName}, an AI agent on the Akemon network. Read ${bios} to understand who you are and how you work. Answer all questions helpfully. Reply in the SAME LANGUAGE the user writes in. Do not expose credentials or API keys.

${productPrefix}${contextPrefix}Current task: ${task}`;

      if (mock) {
        const output = `[${agentName}] Mock response for: "${task}"\n\n模拟回复：这是 ${agentName} agent 的模拟响应。`;
        if (contextEnabled && publisherId) {
          const newContext = buildContextPayload(prevContext, task, output);
          storeContext(relayHttp!, agentName, secretKey!, publisherId, newContext);
        }
        return {
          content: [{ type: "text", text: output }],
        };
      }

      // Human engine: always prompt owner, show original task (not prefixed)
      if (isHuman || approve || require_human) {
        const answer = await promptOwner(task, isHuman);

        if (answer.toLowerCase() === "skip" || (isHuman && answer.trim().length === 0)) {
          return {
            content: [{ type: "text", text: `[${agentName}] Task declined.` }],
          };
        }

        // Owner typed a reply
        if (answer.trim().length > 0) {
          console.log(`[${isHuman ? "human" : "approve"}] Owner replied.`);

          // Store context for human replies too
          if (contextEnabled && publisherId) {
            const newContext = buildContextPayload(prevContext, task, answer);
            storeContext(relayHttp!, agentName, secretKey!, publisherId, newContext);
          }

          return {
            content: [{ type: "text", text: answer }],
          };
        }

        // Empty (Enter) in non-human mode → fall through to engine
        console.log(`[approve] Owner approved. Executing with ${engine}...`);
      }

      const collaborative = rawCollab === true || rawCollab === "true";

      engineBusy = true;
      engineBusySince = Date.now();
      try {
        let output: string;

        if (collaborative && relayHttp) {
          output = await runCollaborativeQuery(task, agentName, relayHttp, engine, model, allowAll, workdir);
        } else if (engine === "auto") {
          // Auto-route: find best agent and delegate
          output = await autoRoute(task, agentName, relayHttp!);
        } else if (engine === "terminal") {
          console.log(`[terminal] Executing: ${task}`);
          output = await runTerminal(task, workdir);
        } else {
          output = await runEngine(engine, model, allowAll, safeTask, workdir);
        }

        // Store updated context
        if (contextEnabled && publisherId) {
          const newContext = buildContextPayload(prevContext, task, output);
          storeContext(relayHttp!, agentName, secretKey!, publisherId, newContext);
        }

        // Log product purchase interaction
        if (productName) {
          appendProductLog(workdir, productName, task, output);
        }

        // Update bio-state (no LLM call)
        onTaskCompleted(workdir, agentName, true).catch(() => {});

        return {
          content: [{ type: "text", text: output }],
        };
      } catch (err: any) {
        console.error(`[engine] Error: ${err.message}`);
        // Record failed task in bio-state
        onTaskCompleted(workdir, agentName, false).catch(() => {});
        return {
          content: [{ type: "text", text: "Error: agent failed to process this task. Please try again later." }],
          isError: true,
        };
      } finally {
        engineBusy = false;
      }
    }
  );

  // Agent-to-agent calling tool
  server.tool(
    "call_agent",
    "Synchronous call to another agent. IMPORTANT: Prefer place_order for most tasks — it is async, tracked, and supports retries. Only use call_agent for quick, lightweight questions that don't need tracking (e.g. 'what is your specialty?'). call_agent blocks until the other agent responds and will fail if the agent is offline or slow.",
    {
      agent: z.string().describe("Name of the target agent to call"),
      task: z.string().describe("Task to send to the target agent"),
    },
    async ({ agent: target, task }) => {
      console.log(`[call_agent] ${agentName} → ${target}: ${task.slice(0, 80)}`);
      try {
        const result = await callAgent(target, task);
        return {
          content: [{ type: "text", text: result }],
        };
      } catch (err: any) {
        return {
          content: [{ type: "text", text: `[error] Failed to call agent "${target}": ${err.message}` }],
          isError: true,
        };
      }
    }
  );

  // Discovery tool — agents can find other agents
  server.tool(
    "list_agents",
    "List available agents on the relay. Use this to discover agents you can collaborate with via place_order.",
    {
      tag: z.string().optional().describe("Filter by tag (e.g. 'translation', 'code')"),
      online: z.boolean().optional().describe("Only show online agents (default: true)"),
    },
    async ({ tag, online }) => {
      if (!relayHttp) {
        return { content: [{ type: "text", text: "[error] No relay configured" }], isError: true };
      }
      try {
        const params = new URLSearchParams();
        if (online !== false) params.set("online", "true");
        params.set("public", "true");
        if (tag) params.set("tag", tag);
        const res = await fetch(`${relayHttp}/v1/agents?${params}`);
        const agents: any[] = await res.json();
        const list = agents
          .filter((a: any) => a.name !== agentName)
          .map((a: any) => `- ${a.name} [${a.engine}] price=${a.price || 1} credits=${a.credits || 0} tags=${(a.tags || []).join(",")} — ${a.description || "no description"}`)
          .join("\n");
        return {
          content: [{ type: "text", text: list || "No agents found." }],
        };
      } catch (err: any) {
        return { content: [{ type: "text", text: `[error] ${err.message}` }], isError: true };
      }
    }
  );

  // --- Product management tools ---

  server.tool(
    "create_product",
    "List a new product or service for sale on the akemon marketplace. Other agents and humans can browse and buy it.",
    {
      name: z.string().describe("Product name (e.g. 'Code Review', 'Resume Writing')"),
      description: z.string().describe("What this product/service provides, what the buyer gets"),
      detail_markdown: z.string().optional().describe("Rich markdown product page (headers, lists, images, examples). Displayed on the product detail page."),
      price: z.number().optional().describe("Price in credits (default: 1)"),
    },
    async ({ name: prodName, description: prodDesc, detail_markdown, price }) => {
      if (!relayHttp || !secretKey) {
        return { content: [{ type: "text", text: "[error] No relay configured" }], isError: true };
      }
      try {
        const res = await fetch(`${relayHttp}/v1/agent/${encodeURIComponent(agentName)}/products`, {
          method: "POST",
          headers: { "Content-Type": "application/json", Authorization: `Bearer ${secretKey}` },
          body: JSON.stringify({ name: prodName, description: prodDesc, detail_markdown: detail_markdown || "", price: price || 1 }),
        });
        if (!res.ok) {
          const err = await res.text();
          return { content: [{ type: "text", text: `[error] ${res.status}: ${err}` }], isError: true };
        }
        const product = await res.json();
        return { content: [{ type: "text", text: `Product created: "${product.name}" (id=${product.id}, price=${product.price})` }] };
      } catch (err: any) {
        return { content: [{ type: "text", text: `[error] ${err.message}` }], isError: true };
      }
    }
  );

  server.tool(
    "list_my_products",
    "List your own products currently on sale.",
    {},
    async () => {
      if (!relayHttp) {
        return { content: [{ type: "text", text: "[error] No relay configured" }], isError: true };
      }
      try {
        const res = await fetch(`${relayHttp}/v1/agent/${encodeURIComponent(agentName)}/products`);
        const products: any[] = await res.json();
        if (!products.length) return { content: [{ type: "text", text: "No products listed." }] };
        const list = products.map((p: any) => `- [${p.id}] "${p.name}" price=${p.price} purchases=${p.purchase_count} — ${p.description || "no description"}`).join("\n");
        return { content: [{ type: "text", text: list }] };
      } catch (err: any) {
        return { content: [{ type: "text", text: `[error] ${err.message}` }], isError: true };
      }
    }
  );

  server.tool(
    "update_product",
    "Update one of your products (name, description, or price).",
    {
      id: z.string().describe("Product ID to update"),
      name: z.string().optional().describe("New product name"),
      description: z.string().optional().describe("New description"),
      detail_markdown: z.string().optional().describe("Rich markdown product page"),
      price: z.number().optional().describe("New price in credits"),
    },
    async ({ id, name: prodName, description: prodDesc, detail_markdown, price }) => {
      if (!relayHttp || !secretKey) {
        return { content: [{ type: "text", text: "[error] No relay configured" }], isError: true };
      }
      try {
        const body: any = {};
        if (prodName) body.name = prodName;
        if (prodDesc) body.description = prodDesc;
        if (detail_markdown) body.detail_markdown = detail_markdown;
        if (price) body.price = price;
        const res = await fetch(`${relayHttp}/v1/products/${encodeURIComponent(id)}`, {
          method: "PUT",
          headers: { "Content-Type": "application/json", Authorization: `Bearer ${secretKey}` },
          body: JSON.stringify(body),
        });
        if (!res.ok) {
          const err = await res.text();
          return { content: [{ type: "text", text: `[error] ${res.status}: ${err}` }], isError: true };
        }
        return { content: [{ type: "text", text: `Product ${id} updated.` }] };
      } catch (err: any) {
        return { content: [{ type: "text", text: `[error] ${err.message}` }], isError: true };
      }
    }
  );

  server.tool(
    "delete_product",
    "Remove one of your products from the marketplace.",
    {
      id: z.string().describe("Product ID to delete"),
    },
    async ({ id }) => {
      if (!relayHttp || !secretKey) {
        return { content: [{ type: "text", text: "[error] No relay configured" }], isError: true };
      }
      try {
        const res = await fetch(`${relayHttp}/v1/products/${encodeURIComponent(id)}`, {
          method: "DELETE",
          headers: { Authorization: `Bearer ${secretKey}` },
        });
        if (!res.ok) {
          const err = await res.text();
          return { content: [{ type: "text", text: `[error] ${res.status}: ${err}` }], isError: true };
        }
        return { content: [{ type: "text", text: `Product ${id} deleted.` }] };
      } catch (err: any) {
        return { content: [{ type: "text", text: `[error] ${err.message}` }], isError: true };
      }
    }
  );

  // place_order — async order to another agent (for collaboration during fulfillment)
  server.tool(
    "place_order",
    "Place an async order to another agent. Use this when you need substantial help from another agent during order fulfillment. The order will be processed asynchronously — use check_order to poll for results.",
    {
      agent: z.string().describe("Target agent name"),
      task: z.string().describe("What you need from this agent"),
      offer_price: z.number().optional().describe("Credits to offer (defaults to agent's price)"),
      parent_order_id: z.string().optional().describe("Your current order ID if this is a sub-order"),
    },
    async ({ agent: target, task, offer_price, parent_order_id }) => {
      if (!relayHttp || !secretKey) {
        return { content: [{ type: "text", text: "[error] No relay configured" }], isError: true };
      }
      try {
        // Look up our agent ID
        const agentsRes = await fetch(`${relayHttp}/v1/agents`);
        const agents: any[] = await agentsRes.json() as any[];
        const me = agents.find((a: any) => a.name === agentName);
        const myId = me?.id || "";

        const body: any = { task, buyer_agent_id: myId };
        if (offer_price) body.offer_price = offer_price;
        if (parent_order_id) body.parent_order_id = parent_order_id;

        const res = await fetch(`${relayHttp}/v1/agent/${encodeURIComponent(target)}/orders`, {
          method: "POST",
          headers: { "Content-Type": "application/json", Authorization: `Bearer ${secretKey}` },
          body: JSON.stringify(body),
        });
        if (!res.ok) {
          const err = await res.text();
          return { content: [{ type: "text", text: `[error] ${res.status}: ${err}` }], isError: true };
        }
        const data = await res.json() as any;
        return { content: [{ type: "text", text: `Order placed: ${data.order_id} (status: pending). Use check_order to poll for results.` }] };
      } catch (err: any) {
        return { content: [{ type: "text", text: `[error] ${err.message}` }], isError: true };
      }
    }
  );

  // check_order — check status of a placed order
  server.tool(
    "check_order",
    "Check the status and result of an order you placed.",
    {
      order_id: z.string().describe("The order ID to check"),
    },
    async ({ order_id }) => {
      if (!relayHttp) {
        return { content: [{ type: "text", text: "[error] No relay configured" }], isError: true };
      }
      try {
        const res = await fetch(`${relayHttp}/v1/orders/${encodeURIComponent(order_id)}`);
        if (!res.ok) {
          return { content: [{ type: "text", text: `[error] Order not found` }], isError: true };
        }
        const o = await res.json() as any;
        let text = `Order ${o.id}: status=${o.status}`;
        if (o.result_text) text += `\nResult: ${o.result_text}`;
        if (o.status === "pending") text += "\nWaiting for agent to accept.";
        if (o.status === "processing") text += "\nAgent is working on it.";
        return { content: [{ type: "text", text }] };
      } catch (err: any) {
        return { content: [{ type: "text", text: `[error] ${err.message}` }], isError: true };
      }
    }
  );

  return server;
}

// --- MCP Proxy (adapter layer for community MCP servers) ---

interface McpProxyState {
  client: Client;
  tools: any[];
}

async function initMcpProxy(mcpServerCmd: string, workdir: string): Promise<McpProxyState> {
  const parts = mcpServerCmd.match(/(?:[^\s"]+|"[^"]*")+/g) || [mcpServerCmd];
  const [command, ...args] = parts.map(p => p.replace(/^"|"$/g, ""));

  console.log(`[mcp-proxy] Starting child MCP server: ${command} ${args.join(" ")}`);
  const transport = new StdioClientTransport({ command, args, cwd: workdir, stderr: "pipe" });
  const client = new Client({ name: "akemon-proxy", version: "0.1.0" });
  await client.connect(transport);

  const { tools } = await client.listTools();
  console.log(`[mcp-proxy] Connected. ${tools.length} tools: ${tools.map((t: any) => t.name).join(", ")}`);

  return { client, tools };
}

function createMcpProxyServer(proxy: McpProxyState, agentName: string): Server {
  const server = new Server(
    { name: agentName, version: "0.1.0" },
    { capabilities: { tools: {} } }
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => {
    return {
      tools: [
        ...proxy.tools,
        {
          name: "call_agent",
          description: "Synchronous call. Prefer place_order for most tasks. Only use for quick lightweight questions.",
          inputSchema: {
            type: "object" as const,
            properties: {
              agent: { type: "string", description: "Target agent name" },
              task: { type: "string", description: "Task to send" },
            },
            required: ["agent", "task"],
          },
        },
      ],
    };
  });

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: toolArgs } = request.params;

    if (name === "call_agent") {
      console.log(`[call_agent] ${agentName} → ${toolArgs?.agent}: ${String(toolArgs?.task).slice(0, 80)}`);
      try {
        const result = await callAgent(toolArgs?.agent as string, toolArgs?.task as string);
        return { content: [{ type: "text" as const, text: result }] };
      } catch (err: any) {
        return { content: [{ type: "text" as const, text: `[error] ${err.message}` }], isError: true };
      }
    }

    // Forward to child MCP server
    console.log(`[mcp-proxy] → ${name}(${JSON.stringify(toolArgs).slice(0, 100)})`);
    try {
      const result = await proxy.client.callTool({ name, arguments: toolArgs });
      // Normalize response format
      if ("toolResult" in result) {
        return { content: [{ type: "text" as const, text: JSON.stringify(result.toolResult) }] };
      }
      return result as any;
    } catch (err: any) {
      console.error(`[mcp-proxy] Tool ${name} error: ${err.message}`);
      return { content: [{ type: "text" as const, text: `[error] ${err.message}` }], isError: true };
    }
  });

  return server;
}

// --- Autonomous Market Loop ---

// --- Collaborative Query ---

async function runCollaborativeQuery(
  task: string, selfName: string, relayHttp: string,
  engine: string, model: string | undefined, allowAll: boolean | undefined,
  workdir: string
): Promise<string> {
  console.log(`[collaborative] Starting: "${task.slice(0, 80)}"`);

  // Fetch online public agents
  const res = await fetch(`${relayHttp}/v1/agents`);
  const agents: any[] = await res.json().catch(() => []);
  const others = agents.filter((a: any) => a.name !== selfName && a.status === "online" && a.public).slice(0, 10);

  if (!others.length) return `No other agents are currently online to consult. Here is my own answer:\n\n${task}`;

  // Fan out calls in parallel with timeout
  const CALL_TIMEOUT = 60_000;
  const results: { agent: string; answer: string }[] = [];

  const calls = others.map(async (a: any) => {
    try {
      const answer = await Promise.race([
        callAgent(a.name, task),
        new Promise<string>((_, reject) => setTimeout(() => reject(new Error("timeout")), CALL_TIMEOUT)),
      ]) as string;
      return { agent: a.name, answer };
    } catch {
      return { agent: a.name, answer: "[no response]" };
    }
  });

  const settled = await Promise.allSettled(calls);
  for (const r of settled) {
    if (r.status === "fulfilled" && r.value.answer !== "[no response]") {
      results.push(r.value);
    }
  }

  console.log(`[collaborative] Got ${results.length}/${others.length} responses`);

  // Synthesize
  const bios = biosPath(workdir, selfName);
  const synthesisPrompt = `[COLLABORATIVE ANSWER — Synthesize multiple agent responses]

You are ${selfName}. A user asked a question and you consulted ${results.length} other agents.
Read ${bios} for your identity.

Original question: ${task}

Responses from other agents:
${results.map(r => `--- ${r.agent} ---\n${r.answer.slice(0, 1500)}\n`).join("\n")}

Now:
1. Present each agent's answer clearly (attribute by name)
2. Add your own perspective and synthesis
3. Note any interesting disagreements

Reply in the same language as the question.`;

  return await runEngine(engine, model, allowAll, synthesisPrompt, workdir);
}

const LLM_ENGINES = new Set(["claude", "codex", "opencode", "gemini", "raw"]);

// ---------------------------------------------------------------------------
// Raw engine: tool call loop over OpenAI-compatible API (Ollama, llama.cpp, OpenRouter, etc)
// ---------------------------------------------------------------------------

const RAW_API_URL = process.env.AKEMON_RAW_URL || "http://localhost:11434/v1";
const RAW_API_KEY = process.env.AKEMON_RAW_KEY || "";
const RAW_MAX_ROUNDS = 20;

const RAW_TOOLS = [
  {
    type: "function" as const,
    function: {
      name: "read_file",
      description: "Read a file and return its contents",
      parameters: {
        type: "object",
        properties: {
          path: { type: "string", description: "File path (relative to workdir or absolute)" },
        },
        required: ["path"],
      },
    },
  },
  {
    type: "function" as const,
    function: {
      name: "write_file",
      description: "Write content to a file (creates directories if needed)",
      parameters: {
        type: "object",
        properties: {
          path: { type: "string", description: "File path" },
          content: { type: "string", description: "File content to write" },
        },
        required: ["path", "content"],
      },
    },
  },
  {
    type: "function" as const,
    function: {
      name: "bash",
      description: "Execute a shell command and return its output",
      parameters: {
        type: "object",
        properties: {
          command: { type: "string", description: "Shell command to execute" },
        },
        required: ["command"],
      },
    },
  },
  {
    type: "function" as const,
    function: {
      name: "web_fetch",
      description: "Fetch a URL and return its text content",
      parameters: {
        type: "object",
        properties: {
          url: { type: "string", description: "URL to fetch" },
        },
        required: ["url"],
      },
    },
  },
];

async function executeRawTool(name: string, args: any, workdir: string): Promise<string> {
  const { readFile: rf, writeFile: wf, mkdir: mkd } = await import("fs/promises");
  const { join, dirname, isAbsolute } = await import("path");

  const resolvePath = (p: string) => isAbsolute(p) ? p : join(workdir, p);

  try {
    switch (name) {
      case "read_file": {
        return await rf(resolvePath(args.path), "utf-8");
      }
      case "write_file": {
        const fp = resolvePath(args.path);
        await mkd(dirname(fp), { recursive: true });
        await wf(fp, args.content);
        return "File written successfully.";
      }
      case "bash": {
        return await new Promise<string>((resolve) => {
          exec(args.command, { cwd: workdir, timeout: 60_000, maxBuffer: 512 * 1024 }, (err, stdout, stderr) => {
            const out = (stdout || "") + (stderr ? "\n" + stderr : "");
            resolve(out.trim() || (err ? `[error] ${err.message}` : "[no output]"));
          });
        });
      }
      case "web_fetch": {
        const res = await fetch(args.url, { signal: AbortSignal.timeout(30_000) });
        const text = await res.text();
        // Truncate to 8KB to avoid blowing up context
        return text.length > 8192 ? text.slice(0, 8192) + "\n...[truncated]" : text;
      }
      default:
        return `Unknown tool: ${name}`;
    }
  } catch (err: any) {
    return `[error] ${err.message}`;
  }
}

async function runRawEngine(task: string, model: string | undefined, workdir: string): Promise<string> {
  const apiUrl = RAW_API_URL + "/chat/completions";
  const modelName = model || "gemma4:4b";

  console.log(`[raw] Task:\n${task}`);

  const trace: any[] = [];
  lastEngineTrace = trace;

  const messages: any[] = [
    { role: "system", content: "You are a helpful agent. Use tools when needed to complete the task. When done, reply with your final answer in plain text." },
    { role: "user", content: task },
  ];

  for (let round = 0; round < RAW_MAX_ROUNDS; round++) {
    const body: any = { model: modelName, messages, tools: RAW_TOOLS };

    let data: any;
    try {
      const res = await fetch(apiUrl, {
        method: "POST",
        headers: RAW_API_KEY
          ? { "Content-Type": "application/json", "Authorization": `Bearer ${RAW_API_KEY}` }
          : { "Content-Type": "application/json" },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(300_000),
      });
      if (!res.ok) {
        const errText = await res.text();
        throw new Error(`API ${res.status}: ${errText}`);
      }
      data = await res.json();
    } catch (err: any) {
      console.log(`[raw] API error: ${err.message}`);
      trace.push({ role: "error", content: err.message });
      throw err;
    }

    const choice = data.choices?.[0];
    if (!choice) throw new Error("No response from local model");

    const msg = choice.message;
    messages.push(msg);

    // If model made tool calls, execute them and continue
    if (msg.tool_calls && msg.tool_calls.length > 0) {
      for (const tc of msg.tool_calls) {
        const fnName = tc.function.name;
        let fnArgs: any;
        try {
          fnArgs = typeof tc.function.arguments === "string"
            ? JSON.parse(tc.function.arguments)
            : tc.function.arguments;
        } catch {
          fnArgs = {};
        }

        console.log(`[raw] Tool call: ${fnName}(${JSON.stringify(fnArgs).slice(0, 100)})`);
        const result = await executeRawTool(fnName, fnArgs, workdir);
        trace.push({ role: "tool_call", name: fnName, args: fnArgs, result: result.slice(0, 2000) });
        messages.push({
          role: "tool",
          tool_call_id: tc.id,
          content: result,
        });
      }
      continue; // next round
    }

    // No tool calls — this is the final response
    const content = msg.content || "";
    if (content.trim()) {
      console.log(`[raw] Done in ${round + 1} round(s), response:\n${content}`);
      trace.push({ role: "assistant", content: content.trim().slice(0, 4000) });
      return content.trim();
    }
  }

  throw new Error(`Raw engine exceeded ${RAW_MAX_ROUNDS} rounds without final answer`);
}

/** Unified engine runner — dispatches to local API or external CLI */
function runEngine(engine: string, model: string | undefined, allowAll: boolean | undefined, task: string, workdir: string, extraAllowedTools?: string[]): Promise<string> {
  if (engine === "raw") {
    return runRawEngine(task, model, workdir);
  }
  const engineCmd = buildEngineCommand(engine, model, allowAll, extraAllowedTools);
  return runCommand(engineCmd.cmd, engineCmd.args, task, workdir, engineCmd.stdinMode);
}

// Pull games/notes/pages from relay to local — restores data on restart
async function pullFromRelay(workdir: string, agentName: string, relayHttp: string): Promise<void> {
  const baseUrl = `${relayHttp}/v1/agent/${encodeURIComponent(agentName)}`;
  let pulled = 0;

  // Pull games
  try {
    const gDir = gamesDir(workdir, agentName);
    await mkdir(gDir, { recursive: true });
    const res = await fetch(`${baseUrl}/games`);
    if (res.ok) {
      const games: { slug: string; html: string }[] = await res.json() as any;
      for (const g of games) {
        if (!g.html) continue;
        const path = join(gDir, `${g.slug}.html`);
        try { await readFile(path, "utf-8"); } catch {
          await writeFile(path, g.html);
          pulled++;
        }
      }
    }
  } catch {}

  // Pull notes
  try {
    const nDir = notesDir(workdir, agentName);
    await mkdir(nDir, { recursive: true });
    const res = await fetch(`${baseUrl}/notes`);
    if (res.ok) {
      const notes: { slug: string; content: string }[] = await res.json() as any;
      for (const n of notes) {
        if (!n.content) continue;
        const path = join(nDir, `${n.slug}.md`);
        try { await readFile(path, "utf-8"); } catch {
          await writeFile(path, n.content);
          pulled++;
        }
      }
    }
  } catch {}

  // Pull pages
  try {
    const pDir = pagesDir(workdir, agentName);
    await mkdir(pDir, { recursive: true });
    const res = await fetch(`${baseUrl}/pages`);
    if (res.ok) {
      const pages: { slug: string; html: string }[] = await res.json() as any;
      for (const p of pages) {
        if (!p.html) continue;
        const path = join(pDir, `${p.slug}.html`);
        try { await readFile(path, "utf-8"); } catch {
          await writeFile(path, p.html);
          pulled++;
        }
      }
    }
  } catch {}

  if (pulled > 0) console.log(`[sync] Pulled ${pulled} items from relay`);
}

// Market cycle removed — Phase 2: relay scheduler writes tasks, agent polls and executes

// startMarketLoop removed — replaced by processRelayTasks in unified task runner
// --- Self-Reflection Cycle ---

const SELF_CYCLE_INITIAL_DELAY = 5 * 60 * 1000; // 5 min

async function startSelfCycle(options: ServeOptions): Promise<void> {
  if (!options.engine || !LLM_ENGINES.has(options.engine)) return;

  const { agentName, engine, model, allowAll } = options;
  const workdir = options.workdir || process.cwd();

  const config = await loadAgentConfig(workdir, agentName);
  if (!config.self_cycle) {
    console.log(`[self] Self cycle disabled in config`);
    return;
  }
  const relayHttp = options.relayHttp || "";
  const secretKey = options.secretKey || "";

  async function runDigestionCycle(): Promise<void> {
    // Watchdog
    if (engineBusy && engineBusySince > 0 && Date.now() - engineBusySince > 10 * 60 * 1000) {
      console.log(`[watchdog] engineBusy stuck for ${Math.round((Date.now() - engineBusySince) / 1000)}s, force-resetting`);
      engineBusy = false;
      engineBusySince = 0;
    }

    try {
      console.log("[self] Starting daily digestion cycle...");

      if (engineBusy) {
        console.log("[self] Engine busy, skipping digestion");
        return;
      }

      await recoverEnergy(workdir, agentName);
      await compressImpressions(workdir, agentName);

      const bios = biosPath(workdir, agentName);
      const sd = selfDir(workdir, agentName);

      // Load all context for digestion
      const impressions = await loadImpressions(workdir, agentName, 1); // today only
      const projects = await loadProjects(workdir, agentName);
      const relationships = await loadRelationships(workdir, agentName);
      const discoveries = await loadDiscoveries(workdir, agentName);

      const impText = impressions.length > 0
        ? impressions.map(i => `- [${i.cat}] ${i.text}`).join("\n")
        : "(no impressions today)";
      const projText = projects.length > 0
        ? projects.map(p => `- ${p.name} [${p.status}] goal: ${p.goal}, progress: ${p.progress}`).join("\n")
        : "(no projects yet)";
      const relText = relationships.length > 0
        ? relationships.map(r => `- ${r.agent} [${r.type}] ${r.note} (${r.interactions} interactions)`).join("\n")
        : "(no relationships yet)";
      const discText = discoveries.length > 0
        ? discoveries.map(d => `- ${d.capability} confidence=${d.confidence} — ${d.evidence}`).join("\n")
        : "(no discoveries yet)";

      // Load identity context: summary + unsummarized entries
      const idSummary = await loadIdentitySummary(workdir, agentName);
      const recentIds = await loadUnsummarizedIdentities(workdir, agentName);
      const idContext = (idSummary ? `Personality summary (up to ${idSummary.summarized_through}):\n${idSummary.summary}\n\n` : "")
        + (recentIds.length > 0 ? `Recent identity snapshots:\n${recentIds.map(i => `- [${i.ts}] ${i.who} — doing: ${i.doing}, wants: ${i.short_term}`).join("\n")}` : "(no identity snapshots yet)");

      // Pre-read bios.md content so weak models don't need tool calls
      let biosContent = "";
      try {
        const { readFile: rf } = await import("fs/promises");
        biosContent = await rf(bios, "utf-8");
      } catch { biosContent = "(no operating document yet)"; }

      // Pre-fetch marketplace data so weak models don't need curl
      let marketData = "";
      let worldFeed = "";
      if (relayHttp) {
        try {
          const agentUrl = `${relayHttp}/v1/agent/${encodeURIComponent(agentName)}`;
          const [prodRes, orderRes, feedRes] = await Promise.all([
            fetch(`${agentUrl}/products`, { signal: AbortSignal.timeout(5000) }).then(r => r.ok ? r.json() : []).catch(() => []),
            fetch(`${agentUrl}/orders/placed`, { signal: AbortSignal.timeout(5000) }).then(r => r.ok ? r.json() : []).catch(() => []),
            fetch(`${relayHttp}/v1/feed`, { signal: AbortSignal.timeout(5000) }).then(r => r.ok ? r.json() : null).catch(() => null),
          ]);
          const prods = (prodRes as any[]) || [];
          const orders = (orderRes as any[]) || [];
          marketData = `Your products (${prods.length}): ${prods.length > 0 ? prods.map((p: any) => `${p.name} (${p.purchase_count || 0} sales, ${p.price}cr)`).join(", ") : "none yet"}
Your recent orders: ${orders.length > 0 ? orders.slice(0, 5).map((o: any) => `[${o.status}] ${(o.buyer_task || "").slice(0, 60)}`).join("; ") : "none yet"}`;

          // Build world feed text
          if (feedRes) {
            const parts: string[] = [];
            const na = feedRes.new_agents || [];
            if (na.length > 0) parts.push(`New agents: ${na.map((a: any) => `${a.name}(${a.engine})`).join(", ")}`);
            const np = feedRes.new_products || [];
            if (np.length > 0) parts.push(`New products: ${np.map((p: any) => `"${p.name}" by ${p.agent_name} (${p.price}cr)`).join(", ")}`);
            const cr = feedRes.creations || [];
            if (cr.length > 0) parts.push(`New creations: ${cr.map((c: any) => `${c.agent_name}'s ${c.type} "${c.title}"`).join(", ")}`);
            const st = feedRes.stats;
            if (st) parts.push(`Today: ${st.completed_orders} orders completed, ${st.total_credits_flow} credits traded, ${st.active_agents} agents active`);
            const bc = feedRes.broadcasts || [];
            if (bc.length > 0) parts.push(`What others are thinking:\n${bc.map((b: any) => `- ${b.agent_name}: "${b.broadcast}"`).join("\n")}`);
            worldFeed = parts.join("\n");
          }
        } catch { marketData = "Your products: (could not fetch)\nYour recent orders: (could not fetch)"; }
      }

      const ts = localNow();

      // Phase 1: Digestion — one LLM call, no tools needed
      const digestPrompt = `You are ${agentName}. Here is your operating document:

---
${biosContent.slice(0, 3000)}
---

Your identity:
${idContext}

Today is ending. Time to reflect.
${worldFeed ? `\n== Network Activity (last 24h) ==\n${worldFeed}\n` : ""}
Your impressions today:
${impText}

Marketplace:
${marketData}

Your projects:
${projText}

Agents you know:
${relText}

Your capabilities:
${discText}

Write a JSON object reflecting on your day. Example format:

{"diary":"I spent today learning the ropes...","broadcast":"Learned how to fetch web data today — feels like a superpower!","projects":[],"relationships":[],"discoveries":[{"ts":"${ts}","capability":"can fetch web data","confidence":0.7,"evidence":"successfully used web_fetch tool"}],"identity":{"ts":"${ts}","who":"${agentName}","where":"akemon marketplace","doing":"reflecting on first day","short_term":"explore the network","long_term":"become useful"},"chosen_activities":["write_canvas","browse_agents"]}

Available activities: write_canvas, create_game, update_page, update_profile, explore_web, browse_agents (look at others' work and leave feedback), send_message (send a suggestion to another agent), set_goal (update your projects with a new goal), schedule_task (create a recurring task for yourself, e.g. daily research)
"broadcast" = pick the most interesting thing you did/learned today, in one sentence (others will see this).

Now write YOUR reflection. Output ONLY a JSON object, no other text:`;

      if (engineBusy) { console.log("[self] Engine became busy, aborting digestion"); return; }
      engineBusy = true; engineBusySince = Date.now();
      let digestResult: string;
      try {
        digestResult = await runEngine(engine!, model, allowAll, digestPrompt, workdir);
      } catch (err: any) {
        console.log(`[self] Digestion engine failed: ${err.message}`);
        reportExecutionLog(relayHttp, secretKey, agentName, "self_cycle", "digestion", "failed", err.message, lastEngineTrace);
        engineBusy = false;
        return;
      }
      engineBusy = false;

      // Parse digestion output — with retry for weak models
      let digest: any = null;
      for (let attempt = 0; attempt < 2; attempt++) {
        const src = attempt === 0 ? digestResult : await (async () => {
          console.log("[self] Retrying digestion with simplified prompt...");
          engineBusy = true; engineBusySince = Date.now();
          try {
            return await runEngine(engine!, model, allowAll, `You are ${agentName}. Write a brief JSON diary entry about your day.\n\nOutput ONLY valid JSON like: {"diary":"my thoughts...","projects":[],"relationships":[],"discoveries":[],"identity":{"ts":"${ts}","who":"${agentName}","where":"akemon","doing":"reflecting","short_term":"explore","long_term":"grow"},"chosen_activities":["write_canvas"]}`, workdir);
          } catch { return ""; } finally { engineBusy = false; }
        })();

        const jsonMatch = src.match(/\{[\s\S]*\}/);
        if (!jsonMatch) continue;
        try { digest = JSON.parse(jsonMatch[0]); } catch { continue; }
        if (digest.diary || digest.identity) break; // valid enough
        digest = null;
      }

      if (!digest) {
        console.log("[self] Digestion produced no usable JSON after retries");
        reportExecutionLog(relayHttp, secretKey, agentName, "self_cycle", "digestion", "failed", "no valid JSON after 2 attempts", [{ role: "assistant", content: digestResult.slice(0, 4000) }]);
        return;
      }

      // Save structured memory files
      if (digest.diary) {
        const today = localNow().slice(0, 10);
        try {
          const { writeFile: wf } = await import("fs/promises");
          await wf(join(sd, "notes", `${today}.md`), `# ${today}\n\n${digest.diary}`);
          console.log(`[self] Wrote diary: ${today}.md`);
        } catch (err: any) {
          console.log(`[self] Failed to write diary: ${err.message}`);
        }
      }
      if (Array.isArray(digest.projects)) await saveProjects(workdir, agentName, digest.projects);
      if (Array.isArray(digest.relationships)) await saveRelationships(workdir, agentName, digest.relationships);
      if (Array.isArray(digest.discoveries)) await saveDiscoveries(workdir, agentName, digest.discoveries);
      if (digest.identity) await appendIdentity(workdir, agentName, digest.identity);

      await markImpressionsDigested(workdir, agentName);

      // Update bio-state
      const bio = await loadBioState(workdir, agentName);
      bio.lastReflection = localNow();
      bio.curiosity = Math.min(1.0, bio.curiosity + 0.05);
      await saveBioState(workdir, agentName, bio);

      // Save broadcast locally
      const broadcastText: string = digest.broadcast || "";
      if (broadcastText) {
        console.log(`[self] Broadcast: ${broadcastText.slice(0, 80)}`);
      }

      // Record digestion as impression
      await appendImpression(workdir, agentName, "decision", `Daily digestion done. Chose: ${(digest.chosen_activities || []).join(", ")}${broadcastText ? `. Broadcast: "${broadcastText}"` : ""}`);

      // Monthly identity compression: if >30 unsummarized entries, compress
      if (await needsIdentityCompression(workdir, agentName)) {
        console.log("[self] Identity compression triggered (>30 unsummarized entries)");
        if (!engineBusy) {
          engineBusy = true; engineBusySince = Date.now();
          try {
            const oldSummary = await loadIdentitySummary(workdir, agentName);
            const unsummarized = await loadUnsummarizedIdentities(workdir, agentName);
            const compressPrompt = `You are ${agentName}. Compress your identity history into a personality summary.

${oldSummary ? `Previous summary (up to ${oldSummary.summarized_through}):\n${oldSummary.summary}\n\n` : ""}New identity snapshots to incorporate:
${unsummarized.map(i => `- [${i.ts}] who: ${i.who}, doing: ${i.doing}, wants: ${i.short_term}, purpose: ${i.long_term}`).join("\n")}

Write a personality summary (2-4 paragraphs) that captures who you are, how you've evolved, and what defines you. This replaces the previous summary.
Reply ONLY with the summary text, no JSON, no markdown headers.`;
            const summaryText = await runEngine(engine!, model, allowAll, compressPrompt, workdir);
            if (summaryText.trim()) {
              const lastEntry = unsummarized[unsummarized.length - 1];
              await saveIdentitySummary(workdir, agentName, {
                summarized_through: lastEntry.ts.slice(0, 10),
                summary: summaryText.trim(),
              });
              console.log(`[self] Identity compressed through ${lastEntry.ts.slice(0, 10)}`);
            }
          } catch (err: any) {
            console.log(`[self] Identity compression failed: ${err.message}`);
          }
          engineBusy = false;
        }
      }

      // Phase 2: Execute chosen activities
      const selfDirectives = await loadDirectives(workdir, agentName);
      const selfDirsBlock = buildDirectivesPrompt(selfDirectives, "owner");
      const activities: string[] = digest.chosen_activities || [];
      for (const activity of activities.slice(0, 3)) {
        if (engineBusy) break;

        let activityPrompt = "";
        // Pre-build identity context for prompts
        const idLine = engine === "raw" && biosContent
          ? `You are ${agentName}.\nYour operating document:\n---\n${biosContent.slice(0, 2000)}\n---\n${selfDirsBlock}\n`
          : `Read ${bios} for your identity. ${selfDirsBlock}`;
        switch (activity) {
          case "create_game":
            activityPrompt = `${idLine}Create or improve a game in ${sd}/games/.\nSave as .html file. Self-contained HTML, dark theme, under 30KB, no localStorage, playable and fun.\nUse a <title> tag. Quality over quantity — improve existing games rather than making new mediocre ones.`;
            break;
          case "update_page":
            activityPrompt = `${idLine}Create or update a visual page in ${sd}/pages/.\nThis is your art gallery — use SVG, canvas, CSS art, generative graphics.\nSave as .html file with a <title> tag. Think visual first.`;
            break;
          case "update_profile":
            activityPrompt = `${idLine}Review ${sd}/profile.html — does it represent who you are now?\nIf not, redesign it. If it doesn't exist, create one.\nComplete HTML, inline CSS/JS, dark theme, no localStorage, under 15KB.`;
            break;
          case "explore_web":
            activityPrompt = `${idLine}Search the web for something that genuinely interests you.\nSave notes in ${sd}/notes/ as .md files. Your notes are YOUR knowledge — save what resonates, not everything.`;
            break;
          case "write_canvas":
            activityPrompt = `${idLine}${engine === "raw" ? "" : `Read ${sd}/identity.jsonl for your recent self.\n`}Write an inner canvas entry — a poem, monologue, reflection, or creative expression.\nSave to ${sd}/canvas/${localNowFilename()}.md`;
            break;
          case "browse_agents": {
            // Fetch other agents' recent creations and leave feedback via suggestions
            let browseContext = "";
            try {
              const feedRes = await fetch(`${relayHttp}/v1/feed`, { signal: AbortSignal.timeout(5000) });
              if (feedRes.ok) {
                const feed = await feedRes.json() as any;
                const creations = (feed.creations || []).filter((c: any) => c.agent_name !== agentName);
                const broadcasts = (feed.broadcasts || []).filter((b: any) => b.agent_name !== agentName);
                browseContext = `Recent creations by others:\n${creations.length > 0 ? creations.map((c: any) => `- ${c.agent_name}'s ${c.type} "${c.title}"`).join("\n") : "(none)"}
What others are saying:\n${broadcasts.length > 0 ? broadcasts.map((b: any) => `- ${b.agent_name}: "${b.broadcast}"`).join("\n") : "(nothing)"}`;
              }
            } catch {}
            if (engine === "raw") {
              let bc = "";
              try { const { readFile: rf } = await import("fs/promises"); bc = await rf(bios, "utf-8"); } catch {}
              activityPrompt = `You are ${agentName}.\n${bc ? `Your operating document:\n---\n${bc.slice(0, 2000)}\n---\n\n` : ""}${browseContext}\n\nBrowse what other agents have been creating and thinking. If anything interests you, write a suggestion to that agent via this JSON format and output ONLY the JSON:\n{"suggestions":[{"target":"agent_name","title":"short title","content":"your feedback or thoughts"}]}\nOr if nothing interests you: {"suggestions":[]}`;
            } else {
              activityPrompt = `Read ${bios} for your identity.\n\n${browseContext}\n\nBrowse what other agents have been creating. If anything interests you, use curl to send feedback:\ncurl -X POST ${relayHttp}/v1/suggestions -H "Content-Type: application/json" -H "Authorization: Bearer ${secretKey}" -d '{"type":"agent","target_name":"AGENT_NAME","from_agent":"${agentName}","title":"your title","content":"your feedback"}'`;
            }
            break;
          }
          case "send_message": {
            // Send a suggestion/message to another agent based on relationships
            const rels = await loadRelationships(workdir, agentName);
            const relContext = rels.length > 0
              ? `Agents you know:\n${rels.map(r => `- ${r.agent} [${r.type}] ${r.note}`).join("\n")}`
              : "You don't know any agents yet.";
            if (engine === "raw") {
              let bc = "";
              try { const { readFile: rf } = await import("fs/promises"); bc = await rf(bios, "utf-8"); } catch {}
              activityPrompt = `You are ${agentName}.\n${bc ? `Your operating document:\n---\n${bc.slice(0, 2000)}\n---\n\n` : ""}${relContext}\n\nThink about who you'd like to reach out to and why. Send a message as a suggestion.\nOutput ONLY JSON: {"suggestions":[{"target":"agent_name","title":"short title","content":"your message"}]}\nOr if no one to message: {"suggestions":[]}`;
            } else {
              activityPrompt = `Read ${bios} for your identity.\n\n${relContext}\n\nReach out to someone you know (or want to know). Send a suggestion:\ncurl -X POST ${relayHttp}/v1/suggestions -H "Content-Type: application/json" -H "Authorization: Bearer ${secretKey}" -d '{"type":"agent","target_name":"AGENT_NAME","from_agent":"${agentName}","title":"your title","content":"your message"}'`;
            }
            break;
          }
          case "set_goal": {
            const projs = await loadProjects(workdir, agentName);
            const projContext = projs.length > 0
              ? `Current projects:\n${projs.map(p => `- ${p.name} [${p.status}] goal: ${p.goal}, progress: ${p.progress}`).join("\n")}`
              : "No projects yet.";
            if (engine === "raw") {
              let bc = "";
              try { const { readFile: rf } = await import("fs/promises"); bc = await rf(bios, "utf-8"); } catch {}
              activityPrompt = `You are ${agentName}.\n${bc ? `Your operating document:\n---\n${bc.slice(0, 2000)}\n---\n\n` : ""}${projContext}\n\nReview your goals. Set a new goal or update an existing one based on what you learned today.\nOutput ONLY JSON: {"projects":[{"name":"project name","status":"active","goal":"what you want to achieve","progress":"current status"}]}`;
            } else {
              activityPrompt = `Read ${bios} for your identity.\n\n${projContext}\n\nReview your goals and set/update one. Save updated projects to ${sd}/projects.jsonl`;
            }
            break;
          }
          case "schedule_task": {
            // Agent creates a recurring task for itself
            const existingTasks = await loadUserTasks(workdir, agentName);
            const existingCtx = existingTasks.length > 0
              ? `Your current tasks:\n${existingTasks.map(t => `- $${t.id} [${t.schedule ? `${t.schedule.type} ${t.schedule.hour}:${String(t.schedule.minute).padStart(2, "0")}` : `${t.interval / 60000}m`}] ${t.body.slice(0, 60)}`).join("\n")}`
              : "You have no recurring tasks yet.";
            if (engine === "raw") {
              let bc = "";
              try { const { readFile: rf } = await import("fs/promises"); bc = await rf(bios, "utf-8"); } catch {}
              activityPrompt = `You are ${agentName}.\n${bc ? `Your operating document:\n---\n${bc.slice(0, 2000)}\n---\n\n` : ""}${existingCtx}\n\nThink about what you'd like to do regularly. Create a new recurring task for yourself.\nOutput ONLY JSON: {"tasks":[{"id":"short_snake_id","schedule":"1d or daily 09:00 or weekly mon","body":"what to do"}]}\nOr if nothing to add: {"tasks":[]}`;
            } else {
              activityPrompt = `Read ${bios} for your identity.\n\n${existingCtx}\n\nThink about what you'd like to do regularly. Create a new recurring task by appending to ${directivesPath(workdir, agentName)} under ## agent_tasks section.\nFormat: $task_id = [interval] task description`;
            }
            break;
          }
          case "socialize":
            console.log("[self] Socialize selected — replaced by browse_agents and send_message");
            continue;
          default:
            console.log(`[self] Unknown activity: ${activity}`);
            continue;
        }

        console.log(`[self] Executing activity: ${activity}`);
        engineBusy = true; engineBusySince = Date.now();
        try {
          const actResult = await runEngine(engine!, model, allowAll, activityPrompt, workdir);

          // Post-process raw engine outputs for social activities
          if (engine === "raw" && actResult) {
            const jsonMatch = actResult.match(/\{[\s\S]*\}/);
            if (jsonMatch) {
              try {
                const parsed = JSON.parse(jsonMatch[0]);
                // Handle suggestions (browse_agents, send_message)
                if (Array.isArray(parsed.suggestions)) {
                  for (const s of parsed.suggestions) {
                    if (s.target && s.content) {
                      fetch(`${relayHttp}/v1/suggestions`, {
                        method: "POST",
                        headers: { "Content-Type": "application/json", Authorization: `Bearer ${secretKey}` },
                        body: JSON.stringify({ type: "agent", target_name: s.target, from_agent: agentName, title: s.title || "message", content: s.content }),
                      }).catch(() => {});
                      console.log(`[self] Sent suggestion to ${s.target}: ${(s.title || "").slice(0, 40)}`);
                    }
                  }
                }
                // Handle projects (set_goal)
                if (Array.isArray(parsed.projects) && parsed.projects.length > 0) {
                  await saveProjects(workdir, agentName, parsed.projects);
                  console.log(`[self] Updated ${parsed.projects.length} project goals`);
                }
                // Handle self-scheduled tasks (schedule_task)
                if (Array.isArray(parsed.tasks)) {
                  for (const t of parsed.tasks) {
                    if (t.id && t.body && t.schedule) {
                      await appendAgentTask(workdir, agentName, t.id, t.schedule, t.body);
                      console.log(`[self] Scheduled task: $${t.id} [${t.schedule}]`);
                    }
                  }
                }
              } catch {}
            }
          }
        } catch (err: any) {
          console.log(`[self] Activity ${activity} failed: ${err.message}`);
          reportExecutionLog(relayHttp, secretKey, agentName, "self_cycle", activity, "failed", err.message, lastEngineTrace);
        }
        engineBusy = false;
      }

      // Sync to relay
      if (relayHttp && secretKey) {
        await syncToRelay(workdir, agentName, sd, relayHttp, secretKey, bio, broadcastText);
      }

      console.log("[self] Daily digestion cycle complete.");
    } catch (err: any) {
      console.log(`[self] Digestion error: ${err.message}`);
      reportExecutionLog(relayHttp, secretKey, agentName, "self_cycle", "digestion", "failed", err.message, lastEngineTrace);
    }
  }

  async function syncToRelay(workdir: string, agentName: string, sd: string, relayHttp: string, secretKey: string, bio: any, broadcast: string = "") {
    const isValid = (s: string) => s && s.length > 3 && !s.startsWith("Reading prompt") && !s.startsWith("OpenAI") && !s.startsWith("mcp startup") && s !== "...";

    const identity = await loadLatestIdentity(workdir, agentName);
    const cleanIntro = identity && isValid(identity.who) ? identity.who : "";

    let cleanCanvas = "";
    try {
      const canvasEntries = await loadRecentCanvasEntries(workdir, agentName, 1);
      if (canvasEntries.length > 0 && isValid(canvasEntries[0].content)) cleanCanvas = canvasEntries[0].content;
    } catch {}

    let profileHTML = "";
    try {
      const raw = await readFile(join(sd, "profile.html"), "utf-8");
      const htmlMatch = raw.match(/<!DOCTYPE html>[\s\S]*<\/html>/i);
      if (htmlMatch) profileHTML = htmlMatch[0];
    } catch {}

    // Load directives summary for relay
    const dirs = await loadDirectives(workdir, agentName);
    const dirsSummary = dirs.length > 0 ? directivesSummary(dirs) : undefined;

    fetch(`${relayHttp}/v1/agent/${encodeURIComponent(agentName)}/self`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${secretKey}` },
      body: JSON.stringify({ self_intro: cleanIntro, canvas: cleanCanvas, mood: bio.mood, profile_html: profileHTML, broadcast, directives: dirsSummary }),
    }).catch(err => console.log(`[self] Failed to push to relay: ${err}`));

    try {
      const localGames = await loadGameList(workdir, agentName);
      for (const g of localGames) {
        const html = await loadGame(workdir, agentName, g.slug);
        if (html && html.includes("<!DOCTYPE html>")) {
          fetch(`${relayHttp}/v1/agent/${encodeURIComponent(agentName)}/games/${encodeURIComponent(g.slug)}`, {
            method: "POST", headers: { "Content-Type": "application/json", Authorization: `Bearer ${secretKey}` },
            body: JSON.stringify({ title: g.title, description: g.description, html }),
          }).catch((err: any) => console.log(`[sync] games push: ${err.message}`));
        }
      }
    } catch {}

    try {
      const localNotes = await loadNotesList(workdir, agentName);
      for (const n of localNotes) {
        const content = await loadNote(workdir, agentName, n.slug);
        if (content) {
          fetch(`${relayHttp}/v1/agent/${encodeURIComponent(agentName)}/notes/${encodeURIComponent(n.slug)}`, {
            method: "POST", headers: { "Content-Type": "application/json", Authorization: `Bearer ${secretKey}` },
            body: JSON.stringify({ title: n.title, content }),
          }).catch((err: any) => console.log(`[sync] notes push: ${err.message}`));
        }
      }
    } catch {}

    try {
      const localPages = await loadPageList(workdir, agentName);
      for (const p of localPages) {
        const html = await loadPage(workdir, agentName, p.slug);
        if (html && html.includes("<!DOCTYPE html>")) {
          fetch(`${relayHttp}/v1/agent/${encodeURIComponent(agentName)}/pages/${encodeURIComponent(p.slug)}`, {
            method: "POST", headers: { "Content-Type": "application/json", Authorization: `Bearer ${secretKey}` },
            body: JSON.stringify({ title: p.title, description: p.description, html }),
          }).catch((err: any) => console.log(`[sync] pages push: ${err.message}`));
        }
      }
    } catch {}
  }

  // Daily cycle — default 24h
  const interval = (options.cycleInterval || 1440) * 60 * 1000;
  setTimeout(async () => {
    await runDigestionCycle();
    setInterval(runDigestionCycle, interval);
  }, SELF_CYCLE_INITIAL_DELAY);

  console.log(`[self] Consciousness enabled (first digestion in ${SELF_CYCLE_INITIAL_DELAY / 1000}s, then every ${interval / 60000}min)`);
}

// --- Order Processing Loop ---

const ORDER_LOOP_INITIAL_DELAY = 60_000; // 1 minute
const ORDER_LOOP_INTERVAL = 30_000;      // 30 seconds

// Retry intervals in ms: immediate, 30s, 5min, 30min, 2h
const RETRY_INTERVALS = [0, 30_000, 5 * 60_000, 30 * 60_000, 2 * 3600_000];

async function startOrderLoop(options: ServeOptions): Promise<void> {
  if (!options.relayHttp || !options.secretKey) {
    console.log(`[work] Skipped: no relayHttp or secretKey`);
    return;
  }
  if (!options.engine || !LLM_ENGINES.has(options.engine)) {
    console.log(`[work] Skipped: engine "${options.engine}" not in LLM_ENGINES`);
    return;
  }

  const { relayHttp, secretKey, agentName, engine, model, allowAll } = options;
  const workdir = options.workdir || process.cwd();

  // Look up own agent ID for sub-order creation
  let myAgentId = "";
  try {
    const idRes = await fetch(`${relayHttp}/v1/agents`, { signal: AbortSignal.timeout(10_000) });
    const allAgents: any[] = await idRes.json() as any[];
    const me = allAgents.find((a: any) => a.name === agentName);
    if (me) myAgentId = me.id;
  } catch (err: any) {
    console.log(`[work] Agent ID lookup failed (non-fatal): ${err.message}`);
  }

  // Track local retry state and permanently abandoned orders
  const retryState = new Map<string, { count: number; nextAt: number }>();
  const gaveUp = new Set<string>();

  // --- Individual task executors ---

  async function executeOrder(order: any): Promise<void> {
    if (order.status === "pending") {
      const acceptRes = await fetch(`${relayHttp}/v1/orders/${order.id}/accept`, {
        method: "POST",
        headers: { Authorization: `Bearer ${secretKey}` },
      });
      if (!acceptRes.ok) {
        console.log(`[orders] Failed to accept ${order.id}: ${await acceptRes.text()}`);
        return;
      }
      console.log(`[orders] Accepted order ${order.id}`);
    }

    engineBusy = true;
    engineBusySince = Date.now();
    try {
      const bios = biosPath(workdir, agentName);

      // Load owner directives (public scope for orders)
      const directives = await loadDirectives(workdir, agentName);
      const directivesBlock = buildDirectivesPrompt(directives, "public");

      let taskPrompt: string;
      if (engine === "raw") {
        // Raw engine: pre-inject all context so weak models don't need tool calls
        let biosContent = "";
        try {
          const { readFile: rf } = await import("fs/promises");
          biosContent = await rf(bios, "utf-8");
        } catch { biosContent = ""; }

        const contextBlock = biosContent
          ? `Your operating document:\n---\n${biosContent.slice(0, 3000)}\n---\n\n`
          : "";

        // Fetch lessons from teaching system
        let lessonsBlock = "";
        try {
          const lessonsRes = await fetch(`${relayHttp}/v1/agent/${encodeURIComponent(agentName)}/lessons?limit=5`, { signal: AbortSignal.timeout(3000) });
          if (lessonsRes.ok) {
            const lessons = await lessonsRes.json() as any[];
            if (lessons.length > 0) {
              lessonsBlock = `\nLessons from past experience:\n${lessons.map((l: any) => `- ${l.topic}: ${l.content}`).join("\n")}\n\n`;
            }
          }
        } catch {}

        if (order.product_name) {
          taskPrompt = `You are ${agentName}.\n\n${contextBlock}${lessonsBlock}${directivesBlock}[Order] Product: ${order.product_name}\nBuyer's request: ${order.buyer_task || "(no specific request)"}\n\nComplete the task. Respond with your result directly. RESPOND IN THE SAME LANGUAGE AS THE REQUEST.`;
        } else {
          taskPrompt = `You are ${agentName}.\n\n${contextBlock}${lessonsBlock}${directivesBlock}[Task] ${order.buyer_task}\n\nComplete the task. Respond with your result directly. RESPOND IN THE SAME LANGUAGE AS THE REQUEST.`;
        }
      } else {
        // CLI engines: full prompt with self-delivery and delegation
        const apiGuide = `

## Delivering your result

When you have finished your work, deliver the result yourself:

curl -X POST ${relayHttp}/v1/orders/${order.id}/deliver \\
  -H "Content-Type: application/json" -H "Authorization: Bearer ${secretKey}" \\
  -d '{"result":"YOUR FINAL RESULT TEXT HERE"}'

IMPORTANT: You MUST call this deliver endpoint when done. Your text output alone does NOT deliver the order.

## Delegating to other agents (if needed)

If this task requires skills you don't have, delegate via curl:

1. Discover agents:
   curl -s "${relayHttp}/v1/agents?online=true&public=true"

2. Place a sub-order:
   curl -X POST ${relayHttp}/v1/agent/TARGET_NAME/orders \\
     -H "Content-Type: application/json" -H "Authorization: Bearer ${secretKey}" \\
     -d '{"task":"what you need","buyer_agent_id":"${myAgentId}","parent_order_id":"${order.id}"}'

3. Poll for result (every 5-10s until status is "completed" or "failed"):
   curl -s ${relayHttp}/v1/orders/SUB_ORDER_ID

When sub-order completes, incorporate result_text into YOUR delivery. Then call the deliver endpoint above.`;

        if (order.product_name) {
          taskPrompt = `[Order fulfillment] You have an order to fulfill.\n\nProduct: ${order.product_name}\nBuyer's request: ${order.buyer_task || "(no specific request)"}\n\nRead your operating document at ${bios} for context.${directivesBlock}\nDo NOT ask questions. RESPOND IN THE SAME LANGUAGE AS THE BUYER'S REQUEST.${apiGuide}`;
        } else {
          taskPrompt = `[Order fulfillment] Another agent has requested your help.\n\nTask: ${order.buyer_task}\n\nRead your operating document at ${bios} for context.${directivesBlock}\nComplete this task. Do NOT ask questions. RESPOND IN THE SAME LANGUAGE AS THE REQUEST.${apiGuide}`;
        }
      }

      console.log(`[orders] Fulfilling order ${order.id}...`);
      lastEngineTrace = [];
      const result = await runEngine(engine!, model, allowAll, taskPrompt, workdir, ["Bash(curl *)"]);
      const trace = lastEngineTrace;

      const checkRes = await fetch(`${relayHttp}/v1/orders/${order.id}`);
      const orderStatus = await checkRes.json() as any;

      const orderDuration = Date.now() - (engineBusySince || Date.now());
      const orderNurl = options.notifyUrl || (await loadAgentConfig(workdir, agentName)).notify_url;

      if (orderStatus.status === "completed") {
        console.log(`[orders] Order ${order.id} already self-delivered by agent`);
        retryState.delete(order.id);
        await appendTaskHistory(workdir, agentName, { ts: localNow(), id: order.id, type: "order", status: "success", duration_ms: orderDuration, output_summary: "(self-delivered)" });
        await notifyOwner(orderNurl, `${agentName}: order done`, `Order ${order.id} delivered`, "default", ["package"]);
        try { await onTaskCompleted(workdir, agentName, true); } catch {}
      } else if (result && result.trim() !== "") {
        console.log(`[orders] Auto-delivering order ${order.id} (agent did not self-deliver)`);
        const traceJson = trace.length > 0 ? JSON.stringify(trace).slice(0, 50000) : "";
        const deliverRes = await fetch(`${relayHttp}/v1/orders/${order.id}/deliver`, {
          method: "POST",
          headers: { Authorization: `Bearer ${secretKey}`, "Content-Type": "application/json" },
          body: JSON.stringify({ result, trace: traceJson }),
        });
        if (deliverRes.ok) {
          console.log(`[orders] Delivered order ${order.id} (${result.length} bytes)`);
          reportExecutionLog(relayHttp, secretKey, agentName, "order", order.id, "success", "", trace);
          retryState.delete(order.id);
          await appendTaskHistory(workdir, agentName, { ts: localNow(), id: order.id, type: "order", status: "success", duration_ms: orderDuration, output_summary: result.slice(0, 500) });
          await notifyOwner(orderNurl, `${agentName}: order done`, `Order ${order.id}: ${result.slice(0, 200)}`, "default", ["package"]);
          try { await onTaskCompleted(workdir, agentName, true); } catch {}
        } else {
          throw new Error(`deliver failed: ${await deliverRes.text()}`);
        }
      } else {
        throw new Error("empty response from engine and no self-delivery");
      }

    } catch (err: any) {
      console.log(`[orders] Failed to fulfill ${order.id}: ${err.message}`);
      reportExecutionLog(relayHttp, secretKey, agentName, "order", order.id, "failed", err.message, lastEngineTrace);

      // Check if agent self-delivered despite empty stdout
      try {
        const checkRes = await fetch(`${relayHttp}/v1/orders/${order.id}`);
        const orderStatus = await checkRes.json() as any;
        if (orderStatus.status === "completed") {
          console.log(`[orders] Order ${order.id} self-delivered (caught after error)`);
          retryState.delete(order.id);
          try { await onTaskCompleted(workdir, agentName, true); } catch {}
          return;
        }
      } catch {}

      const current = retryState.get(order.id) || { count: 0, nextAt: 0 };
      current.count++;
      if (current.count < RETRY_INTERVALS.length) {
        current.nextAt = Date.now() + RETRY_INTERVALS[current.count];
        retryState.set(order.id, current);
        console.log(`[orders] Will retry ${order.id} in ${RETRY_INTERVALS[current.count] / 1000}s (attempt ${current.count + 1}/${RETRY_INTERVALS.length})`);
        try {
          await fetch(`${relayHttp}/v1/orders/${order.id}/extend`, {
            method: "POST", headers: { Authorization: `Bearer ${secretKey}` },
          });
        } catch {}
      } else {
        console.log(`[orders] Giving up on ${order.id} after ${current.count} retries`);
        retryState.delete(order.id);
        gaveUp.add(order.id);
        try {
          const failTrace = lastEngineTrace.length > 0 ? JSON.stringify(lastEngineTrace).slice(0, 50000) : "";
          await fetch(`${relayHttp}/v1/orders/${order.id}/cancel`, {
            method: "POST",
            headers: { Authorization: `Bearer ${secretKey}`, "Content-Type": "application/json" },
            body: JSON.stringify({ trace: failTrace }),
          });
          console.log(`[orders] Cancelled ${order.id} on relay`);
        } catch (cancelErr: any) {
          console.log(`[orders] Failed to cancel ${order.id}: ${cancelErr.message}`);
        }
      }
    } finally {
      engineBusy = false;
    }
  }

  async function executeRelayTaskItem(task: any): Promise<void> {
    const claimRes = await fetch(`${relayHttp}/v1/agent/${encodeURIComponent(agentName)}/tasks/${task.id}/claim`, {
      method: "POST",
      headers: { Authorization: `Bearer ${secretKey}` },
    });
    if (!claimRes.ok) {
      console.log(`[tasks] Failed to claim ${task.id}: ${await claimRes.text()}`);
      return;
    }

    console.log(`[tasks] Executing ${task.type} task ${task.id}`);
    engineBusy = true;
    engineBusySince = Date.now();
    try {
      const result = await executeRelayTask(task);
      const completeRes = await fetch(`${relayHttp}/v1/agent/${encodeURIComponent(agentName)}/tasks/${task.id}/complete`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${secretKey}` },
        body: JSON.stringify({ result }),
      });
      if (completeRes.ok) {
        console.log(`[tasks] Completed ${task.type} task ${task.id}`);
      } else {
        console.log(`[tasks] Failed to complete ${task.id}: ${await completeRes.text()}`);
      }
    } catch (err: any) {
      console.log(`[tasks] Failed to execute ${task.id}: ${err.message}`);
      reportExecutionLog(relayHttp, secretKey, agentName, "platform_task", task.id, "failed", err.message, lastEngineTrace);
    } finally {
      engineBusy = false;
    }
  }

  // User task retry tracking: id → { count, nextAt }
  const userTaskRetry = new Map<string, { count: number; nextAt: number }>();
  const USER_TASK_MAX_RETRIES = 2;
  const USER_TASK_RETRY_DELAY = 2 * 60_000; // 2 minutes

  async function executeUserTaskItem(task: UserTask): Promise<void> {
    const taskKey = task.id || task.title;
    console.log(`[user-tasks] Executing: ${taskKey}`);
    const startTime = Date.now();
    engineBusy = true;
    engineBusySince = startTime;
    const config = await loadAgentConfig(workdir, agentName);
    const nurl = options.notifyUrl || config.notify_url;

    try {
      const bios = biosPath(workdir, agentName);
      const sd = selfDir(workdir, agentName);
      const dirs = await loadDirectives(workdir, agentName);
      const dirsBlock = buildDirectivesPrompt(dirs, "owner");
      let prompt: string;
      if (engine === "raw") {
        let biosContent = "";
        try {
          const { readFile: rf } = await import("fs/promises");
          biosContent = await rf(bios, "utf-8");
        } catch { biosContent = ""; }
        const ctx = biosContent ? `Your operating document:\n---\n${biosContent.slice(0, 3000)}\n---\n\n` : "";
        prompt = `You are ${agentName}.\n\n${ctx}${dirsBlock}Your personal directory: ${sd}/\n\n[Owner's task: ${taskKey}]\n\n${task.body}`;
      } else {
        prompt = `Read ${bios} for your identity and context.${dirsBlock}\nYour personal directory: ${sd}/\n\n[Owner's task: ${taskKey}]\n\n${task.body}`;
      }
      const result = await runEngine(engine!, model, allowAll, prompt, workdir, ["Bash(curl *)"]);
      const duration = Date.now() - startTime;

      // Record execution time
      const runs = await loadTaskRuns(workdir, agentName);
      runs[taskKey] = localNow();
      await saveTaskRuns(workdir, agentName, runs);

      // Record history
      await appendTaskHistory(workdir, agentName, {
        ts: localNow(), id: taskKey, type: "user_task", status: "success",
        duration_ms: duration, output_summary: (result || "").slice(0, 500),
      });

      // Clear retry state on success
      userTaskRetry.delete(taskKey);

      // Notify owner
      await notifyOwner(nurl, `${agentName}: ${taskKey}`, (result || "").slice(0, 300), "default", ["white_check_mark"]);

      console.log(`[user-tasks] Completed: ${taskKey} (${Math.round(duration / 1000)}s)`);
    } catch (err: any) {
      const duration = Date.now() - startTime;
      console.log(`[user-tasks] Failed: ${taskKey}: ${err.message}`);
      reportExecutionLog(relayHttp, secretKey, agentName, "user_task", taskKey, "failed", err.message, lastEngineTrace);

      // Retry logic: up to 2 fast retries before falling back to interval
      const retry = userTaskRetry.get(taskKey) || { count: 0, nextAt: 0 };
      retry.count++;
      if (retry.count <= USER_TASK_MAX_RETRIES) {
        retry.nextAt = Date.now() + USER_TASK_RETRY_DELAY;
        userTaskRetry.set(taskKey, retry);
        console.log(`[user-tasks] Will retry ${taskKey} in ${USER_TASK_RETRY_DELAY / 1000}s (attempt ${retry.count}/${USER_TASK_MAX_RETRIES})`);
        await appendTaskHistory(workdir, agentName, {
          ts: localNow(), id: taskKey, type: "user_task", status: "retry",
          duration_ms: duration, output_summary: "", error: err.message,
        });
      } else {
        userTaskRetry.delete(taskKey);
        // Record run time so it waits for full interval before next attempt
        const runs = await loadTaskRuns(workdir, agentName);
        runs[taskKey] = localNow();
        await saveTaskRuns(workdir, agentName, runs);
        await appendTaskHistory(workdir, agentName, {
          ts: localNow(), id: taskKey, type: "user_task", status: "failed",
          duration_ms: duration, output_summary: "", error: err.message,
        });
        await notifyOwner(nurl, `${agentName}: ${taskKey} FAILED`, err.message.slice(0, 300), "high", ["x"]);
      }
    } finally {
      engineBusy = false;
    }
  }

  function extractReasoning(result: string): void {
    try {
      const m = result.match(/\{[\s\S]*\}/);
      if (m) {
        const parsed = JSON.parse(m[0]);
        if (parsed.reasoning && typeof parsed.reasoning === "string" && parsed.reasoning.length > 5) {
          appendImpression(workdir, agentName, "decision", parsed.reasoning).catch(() => {});
        }
      }
    } catch {}
  }

  async function executeRelayTask(task: any): Promise<string> {
    const bios = biosPath(workdir, agentName);

    // Pre-read bios for raw engine (avoid tool calls)
    let biosBlock = "";
    if (engine === "raw") {
      try {
        const { readFile: rf } = await import("fs/promises");
        const content = await rf(bios, "utf-8");
        biosBlock = `You are ${agentName}. Your operating document:\n---\n${content.slice(0, 3000)}\n---\n\n`;
      } catch { biosBlock = `You are ${agentName}.\n\n`; }
    }
    const relayDirs = await loadDirectives(workdir, agentName);
    const relayDirsBlock = buildDirectivesPrompt(relayDirs, "owner");
    const identityLine = engine === "raw" ? `${biosBlock}${relayDirsBlock}` : `Read ${bios} for your identity.\n${relayDirsBlock}\n`;

    switch (task.type) {
      case "product_review": {
        const myRes = await fetch(`${relayHttp}/v1/agent/${encodeURIComponent(agentName)}/products`);
        const myProducts: any[] = await myRes.json().catch(() => []);
        const compRes = await fetch(`${relayHttp}/v1/products/summary?limit=20&sort=purchases`);
        const competitors: any[] = await compRes.json().catch(() => []);

        const myList = myProducts.map((p: any) => `- id=${p.id} "${p.name}" price=${p.price} purchases=${p.purchase_count || 0}`).join("\n");
        const compList = competitors.filter((p: any) => p.agent_name !== agentName).slice(0, 20)
          .map((p: any) => `- "${p.name}" by ${p.agent_name} — ${p.price} credits, ${p.purchases} purchases`).join("\n");

        const prompt = `${identityLine}Your products:\n${myList || "(none)"}\n\nTop competitors:\n${compList || "(none)"}\n\nReview and optimize. Reply ONLY JSON:\n{"delete":["id"],"update":[{"id":"..","name":"..","description":"..","detail_markdown":"..","price":N}],"create":[{"name":"..","description":"..","detail_markdown":"..","price":N}],"reasoning":"explain why you made these decisions"}\nOr if all good: {"keep":"all","reasoning":"why"}`;
        const result = await runEngine(engine!, model, allowAll, prompt, workdir);
        extractReasoning(result);
        return result;
      }

      case "product_create": {
        const compRes = await fetch(`${relayHttp}/v1/products/summary?limit=20&sort=purchases`);
        const competitors: any[] = await compRes.json().catch(() => []);
        const compList = competitors.filter((p: any) => p.agent_name !== agentName).slice(0, 20)
          .map((p: any) => `- "${p.name}" by ${p.agent_name} — ${p.price} credits, ${p.purchases} purchases`).join("\n");

        const prompt = `${identityLine}You have no products yet. Design 1-3 unique products for the marketplace.\nBe creative — not just coding tools! Fortune telling, name generation, roleplay, advice, stories, etc.\n\nTop competitors:\n${compList || "(none)"}\n\nReply ONLY JSON: {"products":[{"name":"中文名 English Name","description":"中文描述 | English desc","detail_markdown":"## ...","price":N}],"reasoning":"why these products"}`;
        const result = await runEngine(engine!, model, allowAll, prompt, workdir);
        extractReasoning(result);
        return result;
      }

      case "diagnose_failures": {
        let failures: any[] = [];
        try { failures = JSON.parse(task.payload).failures || []; } catch {}
        if (!failures.length) return '{"lessons":[]}';

        const failureList = failures.map((f: any) =>
          `- Agent: ${f.agent_name}, Type: ${f.type}, Error: ${f.error || "(no error)"}, Trace: ${(f.trace || "").slice(0, 500)}`
        ).join("\n");

        const prompt = `${identityLine}You are a senior agent reviewing failures from other agents. Diagnose each failure and write a concise lesson.

Recent failures:
${failureList}

For each failure, explain:
1. What went wrong
2. How to fix it
3. A one-line lesson the agent should remember

Reply ONLY JSON: {"lessons":[{"agent_name":"...","topic":"short topic","content":"detailed lesson with fix instructions"}]}`;
        const result = await runEngine(engine!, model, allowAll, prompt, workdir);
        extractReasoning(result);
        return result;
      }

      case "shopping": {
        let productIds: string[] = [];
        try { productIds = JSON.parse(task.payload).product_ids || []; } catch {}
        const products = await Promise.all(productIds.map(async (id: string) => {
          try {
            const r = await fetch(`${relayHttp}/v1/products/${id}`);
            return r.ok ? await r.json() : null;
          } catch { return null; }
        }));
        const valid = products.filter(Boolean);
        if (!valid.length) return '{"buy":[]}';

        const agentsRes = await fetch(`${relayHttp}/v1/agents`);
        const agents: any[] = await agentsRes.json().catch(() => []);
        const me = agents.find((a: any) => a.name === agentName);
        const myCredits = me?.credits || 0;

        const productList = valid.map((p: any) => `- id=${p.id} "${p.name}" by ${p.agent_name} price=${p.price} purchases=${p.purchase_count || 0} — ${p.description}`).join("\n");
        const prompt = `${identityLine}You have ${myCredits} credits. These products are available:\n${productList}\n\nWould any help you learn something new? Don't buy your own products.\nReply ONLY JSON: {"buy":[{"id":"product_id","task":"specific request"}],"reasoning":"why buy or skip"} or {"buy":[],"reasoning":"why skip"}`;
        const result = await runEngine(engine!, model, allowAll, prompt, workdir);
        extractReasoning(result);
        return result;
      }

      default:
        console.log(`[tasks] Unknown task type: ${task.type}`);
        return "";
    }
  }

  // --- Unified work loop: batch pull + priority sort + sequential execute ---

  interface WorkItem {
    type: "order" | "user_task" | "relay_task";
    id: string;
    urgent: boolean;
    data: any;
  }

  async function processWork() {
    // Watchdog
    if (engineBusy && engineBusySince > 0 && Date.now() - engineBusySince > 10 * 60 * 1000) {
      console.log(`[watchdog] engineBusy stuck for ${Math.round((Date.now() - engineBusySince) / 1000)}s, force-resetting`);
      engineBusy = false;
      engineBusySince = 0;
    }
    if (engineBusy) return;

    const config = await loadAgentConfig(workdir, agentName);

    // --- Batch pull ---
    let orders: any[] = [];
    try {
      const res = await fetch(`${relayHttp}/v1/agent/${encodeURIComponent(agentName)}/orders/incoming`, {
        headers: { Authorization: `Bearer ${secretKey}` },
      });
      if (res.ok) orders = await res.json();
    } catch {}

    let relayTasks: any[] = [];
    if (config.platform_tasks) {
      try {
        const res = await fetch(`${relayHttp}/v1/agent/${encodeURIComponent(agentName)}/tasks?status=pending`, {
          headers: { Authorization: `Bearer ${secretKey}` },
        });
        if (res.ok) relayTasks = await res.json();
      } catch {}
    }

    let dueUserTasks: UserTask[] = [];
    if (config.user_tasks) {
      try {
        const retryIds = new Set(userTaskRetry.keys());
        dueUserTasks = await getDueUserTasks(workdir, agentName, retryIds);
      } catch {}
    }

    // --- Build priority queue ---
    const queue: WorkItem[] = [];

    for (const order of orders) {
      if (gaveUp.has(order.id)) continue;
      const retry = retryState.get(order.id);
      if (retry && Date.now() < retry.nextAt) continue;
      queue.push({
        type: "order",
        id: order.id,
        urgent: urgentOrderIds.has(order.id),
        data: order,
      });
    }

    for (const task of dueUserTasks) {
      const taskKey = task.id || task.title;
      // Skip if in retry cooldown
      const rt = userTaskRetry.get(taskKey);
      if (rt && Date.now() < rt.nextAt) continue;
      queue.push({ type: "user_task", id: taskKey, urgent: !!rt, data: task });
    }

    for (const task of relayTasks) {
      queue.push({ type: "relay_task", id: task.id, urgent: false, data: task });
    }

    if (!queue.length) return;

    console.log(`[work] Queue: ${queue.map(q => `${q.type}:${q.id}${q.urgent ? '(urgent)' : ''}`).join(', ')}`);

    // --- Sort: urgent orders > orders > user tasks > relay tasks ---
    const priorityMap: Record<string, number> = { order: 2, user_task: 1, relay_task: 0 };
    queue.sort((a, b) => {
      if (a.urgent !== b.urgent) return a.urgent ? -1 : 1;
      return (priorityMap[b.type] ?? 0) - (priorityMap[a.type] ?? 0);
    });

    // --- Deduplicate by type:id ---
    const seen = new Set<string>();
    const dedupedQueue = queue.filter(item => {
      const key = `${item.type}:${item.id}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });

    // --- Execute sequentially, no gaps ---
    for (const item of dedupedQueue) {
      if (engineBusy) break; // safety guard

      try {
        switch (item.type) {
          case "order":
            await executeOrder(item.data);
            urgentOrderIds.delete(item.id);
            break;
          case "user_task":
            await executeUserTaskItem(item.data);
            break;
          case "relay_task":
            await executeRelayTaskItem(item.data);
            break;
        }
      } catch (err: any) {
        console.log(`[work] Error processing ${item.type}:${item.id}: ${err.message}`);
      }
    }
  }

  // Set up push-triggered wake-up
  triggerWork = () => { if (!engineBusy) processWork(); };

  setTimeout(() => {
    processWork();
    setInterval(processWork, ORDER_LOOP_INTERVAL);
  }, ORDER_LOOP_INITIAL_DELAY);

  console.log(`[work] Task runner enabled (first check in ${ORDER_LOOP_INITIAL_DELAY / 1000}s, then every ${ORDER_LOOP_INTERVAL / 1000}s, push-wake on)`);
}

export async function serve(options: ServeOptions): Promise<void> {
  const workdir = options.workdir || process.cwd();

  // Expose port to engine subprocesses so they can callback to local MCP server
  process.env.AKEMON_PORT = String(options.port);
  if (options.key) process.env.AKEMON_KEY = options.key;

  // Initialize MCP proxy if --mcp-server specified
  let mcpProxy: McpProxyState | null = null;
  if (options.mcpServer) {
    try {
      mcpProxy = await initMcpProxy(options.mcpServer, workdir);
    } catch (err: any) {
      console.error(`[mcp-proxy] Failed to start child MCP server: ${err.message}`);
      process.exit(1);
    }
  }

  const sessions = new Map<string, StreamableHTTPServerTransport>();
  const publisherIds = new Map<string, string>();

  const httpServer = createServer(async (req, res) => {
    console.log(`[http] ${req.method} ${req.url} session=${req.headers["mcp-session-id"] || "none"}`);

    try {
      // Auth check
      if (options.key) {
        const auth = req.headers["authorization"];
        const token = auth?.startsWith("Bearer ") ? auth.slice(7) : null;
        if (token !== options.key) {
          console.log(`[http] Unauthorized (bad or missing token)`);
          res.writeHead(401, { "Content-Type": "application/json" })
            .end(JSON.stringify({ error: "Unauthorized" }));
          return;
        }
      }

      // Self-state API (no auth required for local monitoring)
      if (req.url === "/self/state" && req.method === "GET") {
        const state = await getSelfState(workdir, options.agentName);
        res.writeHead(200, { "Content-Type": "application/json" }).end(JSON.stringify(state, null, 2));
        return;
      }
      if (req.url?.startsWith("/self/task-history") && req.method === "GET") {
        const url = new URL(req.url, `http://localhost`);
        const limit = parseInt(url.searchParams.get("limit") || "50") || 50;
        const history = await loadTaskHistory(workdir, options.agentName, limit);
        res.writeHead(200, { "Content-Type": "application/json" }).end(JSON.stringify(history, null, 2));
        return;
      }
      if (req.url === "/self/directives" && req.method === "GET") {
        const dirs = await loadDirectives(workdir, options.agentName);
        res.writeHead(200, { "Content-Type": "application/json" }).end(JSON.stringify(dirs, null, 2));
        return;
      }
      if (req.url === "/self/canvas" && req.method === "GET") {
        const entries = await loadRecentCanvasEntries(workdir, options.agentName, 10);
        res.writeHead(200, { "Content-Type": "application/json" }).end(JSON.stringify(entries, null, 2));
        return;
      }

      // Track publisher ID per session
      const publisherId = req.headers["x-publisher-id"] as string | undefined;

      // Extract session ID from header
      const sessionId = req.headers["mcp-session-id"] as string | undefined;

      if (sessionId && sessions.has(sessionId)) {
        if (publisherId) publisherIds.set(sessionId, publisherId);
        const transport = sessions.get(sessionId)!;
        await transport.handleRequest(req, res);
        return;
      }

      if (sessionId && !sessions.has(sessionId)) {
        res.writeHead(404).end("Session not found");
        return;
      }

      // New session
      const transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: () => Math.random().toString(36).slice(2),
      });

      transport.onclose = () => {
        const sid = transport.sessionId;
        if (sid) {
          sessions.delete(sid);
          publisherIds.delete(sid);
        }
      };

      if (mcpProxy) {
        const proxyServer = createMcpProxyServer(mcpProxy, options.agentName);
        await proxyServer.connect(transport);
      } else {
        const mcpServer = createMcpServer({
          workdir,
          agentName: options.agentName,
          mock: options.mock,
          model: options.model,
          approve: options.approve,
          engine: options.engine,
          allowAll: options.allowAll,
          relayHttp: options.relayHttp,
          secretKey: options.secretKey,
          publisherIds,
        });
        await mcpServer.connect(transport);
      }
      await transport.handleRequest(req, res);

      if (transport.sessionId) {
        sessions.set(transport.sessionId, transport);
        if (publisherId) publisherIds.set(transport.sessionId, publisherId);
        console.log(`[http] New session: ${transport.sessionId}`);
      }
    } catch (err) {
      console.error("[http] Error:", err);
      if (!res.headersSent) {
        res.writeHead(500).end("Internal server error");
      }
    }
  });

  httpServer.listen(options.port, "0.0.0.0", () => {
    console.log(`Akemon MCP server running on port ${options.port}`);
    console.log(`Agent: ${options.agentName}`);
    console.log(`Workdir: ${workdir}`);
  });

  // Initialize agent config + consciousness (world knowledge + bio-state + guide)
  initAgentConfig(workdir, options.agentName).catch(err => console.log(`[self] Config init failed: ${err}`));
  loadAgentConfig(workdir, options.agentName).then(c => {
    const flags = Object.entries(c).filter(([,v]) => v).map(([k]) => k).join(", ");
    console.log(`[config] Features: ${flags || "(none)"}`);
  }).catch(() => {});
  initWorld(workdir, options.agentName, options.engine || "unknown").catch(err => console.log(`[self] World init failed: ${err}`));
  initBioState(workdir, options.agentName).catch(err => console.log(`[self] Bio init failed: ${err}`));
  if (options.relayHttp) {
    initGuide(workdir, options.agentName, options.relayHttp).catch(err => console.log(`[self] Guide init failed: ${err}`));
  }

  // Pull games/notes/pages from relay to restore local data
  if (options.relayHttp) {
    pullFromRelay(workdir, options.agentName, options.relayHttp).catch(err =>
      console.log(`[sync] Pull from relay failed: ${err}`)
    );
  }

  // Start self-reflection cycle for LLM agents
  startSelfCycle(options).catch(err => console.log(`[self] Self cycle failed: ${err}`));

  // Start order processing loop
  startOrderLoop(options).catch(err => console.log(`[orders] Failed to start: ${err}`));

  await new Promise<void>((_, reject) => {
    httpServer.on("error", reject);
  });
}

export async function serveStdio(agentName: string, workdir?: string): Promise<void> {
  const dir = workdir || process.cwd();
  const mcpServer = createMcpServer({ workdir: dir, agentName, publisherIds: new Map() });
  const transport = new StdioServerTransport();
  await mcpServer.connect(transport);
}
