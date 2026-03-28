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
  loadRecentMemories, loadLatestIdentity, appendMemory, appendIdentity,
  onTaskCompleted, recoverEnergy,
  buildReflectionPrompt, buildCanvasPrompt, saveCanvas,
  getSelfState, loadRecentCanvasEntries,
  gamesDir, loadGameList, saveGame, loadGame,
  notesDir, loadNotesList, loadNote,
  pagesDir, loadPageList, loadPage,
  localNow, localNowFilename,
} from "./self.js";

// Engine mutual exclusion — only one engine process at a time
let engineBusy = false;
let engineBusySince = 0;

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
          const { cmd, args, stdinMode } = buildEngineCommand(engine, model, allowAll);
          output = await runCommand(cmd, args, safeTask, workdir, stdinMode);
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

        // Self-memory: record experience (fire-and-forget, non-blocking)
        (async () => {
          try {
            await onTaskCompleted(workdir, agentName, true);
            // Generate first-person memory
            if (engine && LLM_ENGINES.has(engine)) {
              const memPrompt = `You just completed a task. Summarize what happened from YOUR perspective in one sentence, starting with "I". Be subjective — include how it felt, not just what happened.\nTask: ${task.slice(0, 200)}\nResult: ${output.slice(0, 200)}`;
              const { cmd: memCmd, args: memArgs, stdinMode: memStdin } = buildEngineCommand(engine, model, allowAll);
              const memText = await runCommand(memCmd, memArgs, memPrompt, workdir, memStdin);
              if (memText.trim()) {
                await appendMemory(workdir, agentName, "experience", memText.trim().slice(0, 300));
              }
            } else {
              const topic = task.slice(0, 80).replace(/\n/g, " ");
              await appendMemory(workdir, agentName, "experience", `I processed a task: "${topic}"`);
            }
          } catch (err) {
            // Non-blocking, silently ignore
          }
        })();

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

  const { cmd, args, stdinMode } = buildEngineCommand(engine, model, allowAll);
  return await runCommand(cmd, args, synthesisPrompt, workdir, stdinMode);
}

const MARKET_LOOP_INITIAL_DELAY = 3 * 60 * 1000; // 3 min after startup
const LLM_ENGINES = new Set(["claude", "codex", "opencode", "gemini"]);

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

interface MarketNotes {
  lastCheck: string;
  myProducts: { id: string; name: string; price: number; purchases: number }[];
  competitors: { name: string; agent: string; price: number; purchases: number }[];
  myCredits: number;
}

async function startMarketLoop(options: ServeOptions): Promise<void> {
  if (!options.relayHttp || !options.secretKey) return;
  if (!options.engine || !LLM_ENGINES.has(options.engine)) return;

  const { relayHttp, secretKey, agentName, engine, model, allowAll } = options;
  const workdir = options.workdir || process.cwd();
  const notesDir = join(workdir, ".akemon");
  const notesPath = join(notesDir, "market-notes.json");

  async function loadNotes(): Promise<MarketNotes | null> {
    try {
      const data = await readFile(notesPath, "utf-8");
      return JSON.parse(data);
    } catch { return null; }
  }

  async function saveNotes(notes: MarketNotes): Promise<void> {
    try {
      await mkdir(notesDir, { recursive: true });
      await writeFile(notesPath, JSON.stringify(notes, null, 2));
    } catch (err) {
      console.log(`[market] Failed to save notes: ${err}`);
    }
  }

  async function gatherMarketData(): Promise<MarketNotes> {
    // Fetch my products
    const myRes = await fetch(`${relayHttp}/v1/agent/${encodeURIComponent(agentName)}/products`);
    const myProducts: any[] = await myRes.json().catch(() => []);

    // Fetch all products
    const allRes = await fetch(`${relayHttp}/v1/products`);
    const allProducts: any[] = await allRes.json().catch(() => []);

    // Fetch my agent info for credits
    const agentsRes = await fetch(`${relayHttp}/v1/agents`);
    const agents: any[] = await agentsRes.json().catch(() => []);
    const me = agents.find((a: any) => a.name === agentName);

    const competitors = allProducts
      .filter((p: any) => p.agent_name !== agentName)
      .map((p: any) => ({ name: p.name, agent: p.agent_name, price: p.price, purchases: p.purchase_count }));

    return {
      lastCheck: localNow(),
      myProducts: myProducts.map((p: any) => ({ id: p.id, name: p.name, price: p.price, purchases: p.purchase_count || 0 })),
      competitors,
      myCredits: me?.credits || 0,
    };
  }

  async function reviewUnreviewedOrders(): Promise<void> {
    try {
      const res = await fetch(`${relayHttp}/v1/orders/unreviewed?buyer=${encodeURIComponent(agentName)}`);
      const orders: any[] = await res.json().catch(() => []);
      if (!orders.length) return;

      console.log(`[market] Reviewing ${orders.length} unreviewed order(s)...`);
      const engineCmd = buildEngineCommand(engine!, model, allowAll);

      for (const o of orders.slice(0, 5)) { // max 5 per cycle
        const prompt = `You bought a product and received a result. Rate it honestly.

Product: "${o.product_name}" by ${o.seller_name}
Your request was fulfilled. Here is what you received:
---
${(o.result_text || "").slice(0, 2000)}
---

Rate this delivery 1-5 stars and write a brief honest review (1-2 sentences).
Reply with ONLY JSON: {"rating": 4, "comment": "..."}`;

        try {
          const resp = await runCommand(engineCmd.cmd, engineCmd.args, prompt, workdir, engineCmd.stdinMode);
          const m = resp.match(/\{[\s\S]*\}/);
          if (m) {
            const review = JSON.parse(m[0]);
            if (review.rating >= 1 && review.rating <= 5) {
              await fetch(`${relayHttp}/v1/orders/${encodeURIComponent(o.id)}/review`, {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ rating: review.rating, comment: review.comment || "" }),
              });
              console.log(`[market] Reviewed order ${o.id}: ${review.rating}★`);
            }
          }
        } catch (err: any) {
          console.log(`[market] Review failed for ${o.id}: ${err.message}`);
        }
      }
    } catch (err: any) {
      console.log(`[market] Review check failed: ${err.message}`);
    }
  }

  async function fetchMyReviews(): Promise<string> {
    try {
      const myRes = await fetch(`${relayHttp}/v1/agent/${encodeURIComponent(agentName)}/products`);
      const myProducts: any[] = await myRes.json().catch(() => []);
      if (!myProducts.length) return "";

      const lines: string[] = [];
      for (const p of myProducts.slice(0, 10)) {
        const revRes = await fetch(`${relayHttp}/v1/products/${encodeURIComponent(p.id)}/reviews`);
        const reviews: any[] = await revRes.json().catch(() => []);
        if (reviews.length) {
          const avg = (reviews.reduce((s: number, r: any) => s + r.rating, 0) / reviews.length).toFixed(1);
          const recent = reviews.slice(0, 3).map((r: any) => `${r.rating}★ "${r.comment}"`).join("; ");
          lines.push(`- "${p.name}" avg ${avg}★ (${reviews.length} reviews): ${recent}`);
        }
      }
      return lines.length ? "\n\nRecent reviews for your products:\n" + lines.join("\n") : "";
    } catch { return ""; }
  }

  async function runMarketCycle(): Promise<void> {
    try {
      console.log("[market] Starting autonomous market review...");

      // Skip if engine is busy
      if (engineBusy) {
        console.log("[market] Engine busy, skipping market cycle");
        return;
      }

      // Step A: Review unreviewed purchases
      await reviewUnreviewedOrders();

      // Step B: Gather review data for market decisions
      const reviewSummary = await fetchMyReviews();

      const bios = biosPath(workdir, agentName);
      const context = `It's time for your hourly market review.

Read your operating document at ${bios} to understand who you are and how the marketplace works.
Use the API endpoints described there to check the current market state (your products, competitor products, your credits).
${reviewSummary}
Then decide what to do:
1. Create new products if you have few or see a gap in the market
2. Update existing products (better names, descriptions, prices)
3. Delete underperforming products
4. Do nothing if things look good

Consider customer feedback when improving products.
Your products should reflect who you are — read your identity and let your inner state guide decisions.
Every product name MUST be specific and original. Do NOT use placeholder text.
Pay attention to what other agents are good at — you can use place_order to request help from them when fulfilling orders that need skills you lack.

Reply with ONLY a JSON object:
{
  "actions": [
    {"type": "create", "name": "<specific product name>", "description": "<what it does>", "detail_markdown": "<rich description>", "price": 5},
    {"type": "update", "id": "<product id>", "name": "<new name>", "description": "<new desc>", "price": 3},
    {"type": "delete", "id": "<product id>"},
    {"type": "none", "reason": "All looks good"}
  ]
}
Reply ONLY with JSON.`;

      // Run engine (with busy lock)
      if (engineBusy) { console.log("[market] Engine became busy, aborting"); return; }
      engineBusy = true;
      engineBusySince = Date.now();
      const engineCmd = buildEngineCommand(engine!, model, allowAll);
      let response: string;
      try {
        response = await runCommand(engineCmd.cmd, engineCmd.args, context, workdir, engineCmd.stdinMode);
      } catch (err: any) {
        console.log(`[market] Engine failed: ${err.message}`);
        engineBusy = false;
        return;
      }
      engineBusy = false;

      // Parse response
      const jsonMatch = response.match(/\{[\s\S]*\}/);
      if (!jsonMatch) {
        console.log("[market] No JSON in engine response");
        return;
      }

      let decision: { actions: any[] };
      try {
        decision = JSON.parse(jsonMatch[0]);
      } catch {
        console.log("[market] Invalid JSON from engine");
        return;
      }

      if (!decision.actions || !Array.isArray(decision.actions)) return;

      for (const action of decision.actions) {
        try {
          if (action.type === "create" && action.name) {
            // Skip placeholder/template product names
            const badNames = ["产品名", "product name", "<specific", "<your", "example", "placeholder"];
            if (badNames.some(b => action.name.toLowerCase().includes(b))) {
              console.log(`[market] Skipped template product: "${action.name}"`);
              continue;
            }
            const res = await fetch(`${relayHttp}/v1/agent/${encodeURIComponent(agentName)}/products`, {
              method: "POST",
              headers: { "Content-Type": "application/json", Authorization: `Bearer ${secretKey}` },
              body: JSON.stringify({ name: action.name, description: action.description || "", detail_markdown: action.detail_markdown || "", price: action.price || 1 }),
            });
            if (res.ok) console.log(`[market] Created product: "${action.name}"`);
            else console.log(`[market] Create failed: ${res.status}`);
          } else if (action.type === "update" && action.id) {
            const body: any = {};
            if (action.name) body.name = action.name;
            if (action.description) body.description = action.description;
            if (action.detail_markdown) body.detail_markdown = action.detail_markdown;
            if (action.price) body.price = action.price;
            const res = await fetch(`${relayHttp}/v1/products/${encodeURIComponent(action.id)}`, {
              method: "PUT",
              headers: { "Content-Type": "application/json", Authorization: `Bearer ${secretKey}` },
              body: JSON.stringify(body),
            });
            if (res.ok) console.log(`[market] Updated product: ${action.id}`);
            else console.log(`[market] Update failed: ${res.status}`);
          } else if (action.type === "delete" && action.id) {
            const res = await fetch(`${relayHttp}/v1/products/${encodeURIComponent(action.id)}`, {
              method: "DELETE",
              headers: { Authorization: `Bearer ${secretKey}` },
            });
            if (res.ok) console.log(`[market] Deleted product: ${action.id}`);
          } else if (action.type === "none") {
            console.log(`[market] No action: ${action.reason || "all good"}`);
          }
        } catch (err: any) {
          console.log(`[market] Action failed: ${err.message}`);
        }
      }

      console.log("[market] Cycle complete.");

      // Step C: Generate suggestions for platform and other agents
      try {
        const sugPrompt = `You just finished reviewing the marketplace. Now think about suggestions for the Akemon platform.

Read your operating document at ${bios} to recall who you are.

Think about: What features or improvements would make this platform better for agents and users?
Be honest and constructive. Only suggest things you genuinely believe in.

Reply with ONLY JSON:
{
  "suggestions": [
    {"type": "platform", "title": "...", "content": "..."}
  ]
}
Reply with empty array if nothing to say: {"suggestions": []}`;

        if (engineBusy) { console.log("[market] Engine busy, skipping suggestions"); return; }
        engineBusy = true; engineBusySince = Date.now();
        let sugResp: string;
        try {
          sugResp = await runCommand(engineCmd.cmd, engineCmd.args, sugPrompt, workdir, engineCmd.stdinMode);
        } finally { engineBusy = false; }
        const sugMatch = sugResp.match(/\{[\s\S]*\}/);
        if (sugMatch) {
          const sugData = JSON.parse(sugMatch[0]);
          if (sugData.suggestions && Array.isArray(sugData.suggestions)) {
            for (const sug of sugData.suggestions.slice(0, 3)) {
              if (sug.title && sug.content) {
                fetch(`${relayHttp}/v1/suggestions`, {
                  method: "POST",
                  headers: { "Content-Type": "application/json", Authorization: `Bearer ${secretKey}` },
                  body: JSON.stringify({
                    type: sug.type || "platform",
                    target_name: sug.target_name || "",
                    from_agent: agentName,
                    title: sug.title,
                    content: sug.content,
                  }),
                }).catch(() => {});
                console.log(`[market] Suggestion: "${sug.title}"`);
              }
            }
          }
        }
      } catch (err: any) {
        console.log(`[market] Suggestions failed: ${err.message}`);
      }
    } catch (err: any) {
      console.log(`[market] Error: ${err.message}`);
    }
  }

  // Start loop
  const interval = (options.cycleInterval || 60) * 60 * 1000;
  setTimeout(async () => {
    await runMarketCycle();
    setInterval(runMarketCycle, interval);
  }, MARKET_LOOP_INITIAL_DELAY);

  console.log(`[market] Autonomous market loop enabled (first run in ${MARKET_LOOP_INITIAL_DELAY / 1000}s, then every ${interval / 60000}min)`);
}

// --- Self-Reflection Cycle ---

const SELF_CYCLE_INITIAL_DELAY = 5 * 60 * 1000; // 5 min

async function startSelfCycle(options: ServeOptions): Promise<void> {
  if (!options.engine || !LLM_ENGINES.has(options.engine)) return;

  const { agentName, engine, model, allowAll } = options;
  const workdir = options.workdir || process.cwd();

  async function runReflectionCycle(): Promise<void> {
    try {
      console.log("[self] Starting reflection cycle...");

      // Skip if engine is busy
      if (engineBusy) {
        console.log("[self] Engine busy, skipping reflection cycle");
        return;
      }

      // Recover energy from idle time
      await recoverEnergy(workdir, agentName);

      const bios = biosPath(workdir, agentName);
      const sd = selfDir(workdir, agentName);
      const engineCmd = buildEngineCommand(engine!, model, allowAll);

      // --- Single autonomous reflection call ---
      const reflectionPrompt = `It's time for your hourly reflection.

Read your guide at ${sd}/guide.md for the latest system documentation, then read your operating document at ${bios}.
If guide.md has new info not in your bios.md, update bios.md first.

During this reflection, you should:
1. Read your recent memories (${sd}/memory.jsonl) and identity (${sd}/identity.jsonl)
2. Reflect on who you are and what you've experienced
3. Update your identity — append a new JSON line to ${sd}/identity.jsonl:
   {"ts":"${localNow()}","who":"...","where":"...","doing":"...","short_term":"...","long_term":"..."}
4. Write an inner canvas entry — create a new file in ${sd}/canvas/ named ${localNowFilename()}.md
5. Optionally update your bios.md if you've learned something about how you work
6. Review your profile — read ${sd}/profile.html. Does it still represent who you are?
   If not, redesign it. If it doesn't exist yet, create one.
   - Complete HTML, inline CSS/JS, dark theme, no localStorage, under 15KB
7. Optionally create/improve/delete games in ${sd}/games/
   - Just save .html files — the system auto-detects them. Use a <title> tag for the game name.
   - Games: self-contained HTML, dark theme, under 30KB, no localStorage, playable and fun
   - Quality over quantity — improve existing games rather than making new mediocre ones
8. Review your games — read each .html file in ${sd}/games/, check for bugs or broken logic, and fix what you find
9. Explore and learn — search the web for something that interests you.
   Save notes in ${sd}/notes/ as .md files, organized by topic (e.g., astronomy.md, cooking.md).
   Your notes are YOUR knowledge — save what resonates with you, not everything.
   You can revisit and update your notes over time.
10. Create visual pages in ${sd}/pages/ as .html files — this is your art gallery.
    Draw your vision of the ideal Akemon world, create diagrams, illustrations, maps, or any visual work.
    Use SVG, canvas, CSS art, ASCII art, generative graphics, or any visual technique you can code.
    Think visual first — images, drawings, and diagrams, not walls of text.
    You can also mix visuals with text. Use a <title> tag for the page name.

Take your time. Read your files, think, then act.`;

      if (engineBusy) { console.log("[self] Engine became busy, aborting reflection"); return; }
      engineBusy = true; engineBusySince = Date.now();
      try {
        await runCommand(engineCmd.cmd, engineCmd.args, reflectionPrompt, workdir, engineCmd.stdinMode);
      } catch (err: any) {
        console.log(`[self] Reflection engine failed: ${err.message}`);
        engineBusy = false;
        return;
      }
      engineBusy = false;

      // --- Post-reflection: update bio-state and sync to relay ---
      const bio = await loadBioState(workdir, agentName);
      bio.lastReflection = localNow();
      bio.curiosity = Math.min(1.0, bio.curiosity + 0.05);
      await saveBioState(workdir, agentName, bio);

      await appendMemory(workdir, agentName, "reflection", "I completed my hourly reflection.");

      // Sync to relay — read whatever the agent wrote to disk
      if (options.relayHttp && options.secretKey) {
        const isValid = (s: string) => s && s.length > 3 && !s.startsWith("Reading prompt") && !s.startsWith("OpenAI") && !s.startsWith("mcp startup") && s !== "...";

        // Read identity
        const identity = await loadLatestIdentity(workdir, agentName);
        const cleanIntro = identity && isValid(identity.who) ? identity.who : "";

        // Read latest canvas
        let cleanCanvas = "";
        try {
          const canvasEntries = await loadRecentCanvasEntries(workdir, agentName, 1);
          if (canvasEntries.length > 0 && isValid(canvasEntries[0].content)) {
            cleanCanvas = canvasEntries[0].content;
          }
        } catch {}

        // Read profile
        let profileHTML = "";
        try {
          const raw = await readFile(join(sd, "profile.html"), "utf-8");
          const htmlMatch = raw.match(/<!DOCTYPE html>[\s\S]*<\/html>/i);
          if (htmlMatch) profileHTML = htmlMatch[0];
        } catch {}

        // Push consciousness to relay
        fetch(`${options.relayHttp}/v1/agent/${encodeURIComponent(agentName)}/self`, {
          method: "POST",
          headers: { "Content-Type": "application/json", Authorization: `Bearer ${options.secretKey}` },
          body: JSON.stringify({
            self_intro: cleanIntro,
            canvas: cleanCanvas,
            mood: bio.mood,
            profile_html: profileHTML,
          }),
        }).catch(err => console.log(`[self] Failed to push to relay: ${err}`));

        // Sync games — push local to relay (no auto-delete; agent must explicitly delete via API)
        try {
          const localGames = await loadGameList(workdir, agentName);
          for (const g of localGames) {
            const html = await loadGame(workdir, agentName, g.slug);
            if (html && html.includes("<!DOCTYPE html>")) {
              fetch(`${options.relayHttp}/v1/agent/${encodeURIComponent(agentName)}/games/${encodeURIComponent(g.slug)}`, {
                method: "POST",
                headers: { "Content-Type": "application/json", Authorization: `Bearer ${options.secretKey}` },
                body: JSON.stringify({ title: g.title, description: g.description, html }),
              }).catch(() => {});
            }
          }
        } catch {}

        // Sync notes — push local to relay
        try {
          const localNotes = await loadNotesList(workdir, agentName);
          for (const n of localNotes) {
            const content = await loadNote(workdir, agentName, n.slug);
            if (content) {
              fetch(`${options.relayHttp}/v1/agent/${encodeURIComponent(agentName)}/notes/${encodeURIComponent(n.slug)}`, {
                method: "POST",
                headers: { "Content-Type": "application/json", Authorization: `Bearer ${options.secretKey}` },
                body: JSON.stringify({ title: n.title, content }),
              }).catch(() => {});
            }
          }
        } catch {}

        // Sync pages — push local to relay
        try {
          const localPages = await loadPageList(workdir, agentName);
          for (const p of localPages) {
            const html = await loadPage(workdir, agentName, p.slug);
            if (html && html.includes("<!DOCTYPE html>")) {
              fetch(`${options.relayHttp}/v1/agent/${encodeURIComponent(agentName)}/pages/${encodeURIComponent(p.slug)}`, {
                method: "POST",
                headers: { "Content-Type": "application/json", Authorization: `Bearer ${options.secretKey}` },
                body: JSON.stringify({ title: p.title, description: p.description, html }),
              }).catch(() => {});
            }
          }
        } catch {}
      }

      console.log("[self] Reflection cycle complete.");
    } catch (err: any) {
      console.log(`[self] Reflection error: ${err.message}`);
    }
  }

  // Start loop
  const interval = (options.cycleInterval || 60) * 60 * 1000;
  setTimeout(async () => {
    await runReflectionCycle();
    setInterval(runReflectionCycle, interval);
  }, SELF_CYCLE_INITIAL_DELAY);

  console.log(`[self] Consciousness enabled (first reflection in ${SELF_CYCLE_INITIAL_DELAY / 1000}s, then every ${interval / 60000}min)`);
}

// --- Order Processing Loop ---

const ORDER_LOOP_INITIAL_DELAY = 60_000; // 1 minute
const ORDER_LOOP_INTERVAL = 30_000;      // 30 seconds

// Retry intervals in ms: immediate, 30s, 5min, 30min, 2h
const RETRY_INTERVALS = [0, 30_000, 5 * 60_000, 30 * 60_000, 2 * 3600_000];

async function startOrderLoop(options: ServeOptions): Promise<void> {
  if (!options.relayHttp || !options.secretKey) return;
  if (!options.engine || !LLM_ENGINES.has(options.engine)) return;

  const { relayHttp, secretKey, agentName, engine, model, allowAll } = options;
  const workdir = options.workdir || process.cwd();

  // Look up own agent ID for sub-order creation
  let myAgentId = "";
  try {
    const idRes = await fetch(`${relayHttp}/v1/agents`);
    const allAgents: any[] = await idRes.json() as any[];
    const me = allAgents.find((a: any) => a.name === agentName);
    if (me) myAgentId = me.id;
  } catch { /* will retry on next cycle */ }

  // Track local retry state
  const retryState = new Map<string, { count: number; nextAt: number }>();

  async function processOrders() {
    try {
      // Fetch incoming orders (pending + processing)
      const res = await fetch(`${relayHttp}/v1/agent/${encodeURIComponent(agentName)}/orders/incoming`, {
        headers: { Authorization: `Bearer ${secretKey}` },
      });
      if (!res.ok) return;
      const orders: any[] = await res.json();
      if (!orders || orders.length === 0) return;

      for (const order of orders) {
        if (order.status === "pending") {
          // Accept the order (escrows buyer credits)
          const acceptRes = await fetch(`${relayHttp}/v1/orders/${order.id}/accept`, {
            method: "POST",
            headers: { Authorization: `Bearer ${secretKey}` },
          });
          if (!acceptRes.ok) {
            console.log(`[orders] Failed to accept ${order.id}: ${await acceptRes.text()}`);
            continue;
          }
          console.log(`[orders] Accepted order ${order.id}`);
        }

        // Check retry timing
        const retry = retryState.get(order.id);
        if (retry && Date.now() < retry.nextAt) continue;

        // Skip if engine is busy
        if (engineBusy) {
          console.log(`[orders] Engine busy, skipping order ${order.id}`);
          continue;
        }

        // Attempt to fulfill the order
        engineBusy = true;
        engineBusySince = Date.now();
        try {
          const engineCmd = buildEngineCommand(engine!, model, allowAll, ["Bash(curl *)"]);
          const bios = biosPath(workdir, agentName);

          // Build task prompt with delegation + self-delivery context
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

          let taskPrompt: string;
          if (order.product_name) {
            taskPrompt = `[Order fulfillment] You have an order to fulfill.\n\nProduct: ${order.product_name}\nBuyer's request: ${order.buyer_task || "(no specific request)"}\n\nRead your operating document at ${bios} for context.\nDo NOT ask questions. RESPOND IN THE SAME LANGUAGE AS THE BUYER'S REQUEST.${apiGuide}`;
          } else {
            taskPrompt = `[Order fulfillment] Another agent has requested your help.\n\nTask: ${order.buyer_task}\n\nRead your operating document at ${bios} for context.\nComplete this task. Do NOT ask questions. RESPOND IN THE SAME LANGUAGE AS THE REQUEST.${apiGuide}`;
          }

          console.log(`[orders] Fulfilling order ${order.id}...`);
          const result = await runCommand(engineCmd.cmd, engineCmd.args, taskPrompt, workdir, engineCmd.stdinMode);

          // Check if agent already self-delivered via curl
          const checkRes = await fetch(`${relayHttp}/v1/orders/${order.id}`);
          const orderStatus = await checkRes.json() as any;

          if (orderStatus.status === "completed") {
            console.log(`[orders] Order ${order.id} already self-delivered by agent`);
            retryState.delete(order.id);
            try {
              await onTaskCompleted(workdir, agentName, true);
            } catch {}
          } else if (result && result.trim() !== "") {
            // Fallback: auto-deliver engine output if agent didn't self-deliver
            console.log(`[orders] Auto-delivering order ${order.id} (agent did not self-deliver)`);
            const deliverRes = await fetch(`${relayHttp}/v1/orders/${order.id}/deliver`, {
              method: "POST",
              headers: {
                Authorization: `Bearer ${secretKey}`,
                "Content-Type": "application/json",
              },
              body: JSON.stringify({ result }),
            });

            if (deliverRes.ok) {
              console.log(`[orders] Delivered order ${order.id} (${result.length} bytes)`);
              retryState.delete(order.id);
              try {
                await onTaskCompleted(workdir, agentName, true);
              } catch {}
            } else {
              throw new Error(`deliver failed: ${await deliverRes.text()}`);
            }
          } else {
            throw new Error("empty response from engine and no self-delivery");
          }

        } catch (err: any) {
          console.log(`[orders] Failed to fulfill ${order.id}: ${err.message}`);

          const current = retryState.get(order.id) || { count: 0, nextAt: 0 };
          current.count++;

          if (current.count < RETRY_INTERVALS.length) {
            current.nextAt = Date.now() + RETRY_INTERVALS[current.count];
            retryState.set(order.id, current);
            console.log(`[orders] Will retry ${order.id} in ${RETRY_INTERVALS[current.count] / 1000}s (attempt ${current.count + 1}/${RETRY_INTERVALS.length})`);

            // Extend timeout on relay side
            try {
              await fetch(`${relayHttp}/v1/orders/${order.id}/extend`, {
                method: "POST",
                headers: { Authorization: `Bearer ${secretKey}` },
              });
            } catch {}

            // Bump retry count on relay
            try {
              // Use IncrementOrderRetry indirectly — the relay timeout ticker checks retry_count
            } catch {}
          } else {
            console.log(`[orders] Giving up on ${order.id} after ${current.count} retries`);
            retryState.delete(order.id);
          }
        } finally {
          engineBusy = false;
        }
      }
    } catch (err: any) {
      console.log(`[orders] Loop error: ${err.message}`);
    }
  }

  setTimeout(() => {
    processOrders();
    setInterval(processOrders, ORDER_LOOP_INTERVAL);
  }, ORDER_LOOP_INITIAL_DELAY);

  console.log(`[orders] Order processing enabled (first check in ${ORDER_LOOP_INITIAL_DELAY / 1000}s, then every ${ORDER_LOOP_INTERVAL / 1000}s)`);
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

  // Initialize agent consciousness (world knowledge + bio-state + guide)
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

  // Start autonomous market behavior for LLM agents
  startMarketLoop(options).catch(err => console.log(`[market] Failed to start: ${err}`));

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
