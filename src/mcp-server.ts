/**
 * MCP Server — defines all MCP tools exposed by this agent.
 * Extracted from server.ts (Phase 1 code organization).
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { ListToolsRequestSchema, CallToolRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import { callAgent } from "./relay-client.js";
import { loadConversation, appendRound, buildLLMContext, resolveConvId, loadProductContext, appendProductLog } from "./context.js";
import {
  biosPath, loadBioState, saveBioState, localNow,
  bioStatePromptModifier, feedHunger, appendBioEvent, SHOP_ITEMS,
  loadAgentConfig,
} from "./self.js";
import type { RelayPeripheral } from "./relay-peripheral.js";

// ---------------------------------------------------------------------------
// Dependencies injected by server.ts
// ---------------------------------------------------------------------------

export interface McpDeps {
  runEngine: (engine: string, model: string | undefined, allowAll: boolean | undefined, task: string, workdir: string) => Promise<string>;
  runTerminal: (command: string, cwd: string) => Promise<string>;
  promptOwner: (task: string, isHuman: boolean) => Promise<string>;
  runCollaborativeQuery: (task: string, selfName: string, relayHttp: string, engine: string, model: string | undefined, allowAll: boolean | undefined, workdir: string, relay?: RelayPeripheral) => Promise<string>;
  autoRoute: (task: string, selfName: string, relayHttp: string, relay?: RelayPeripheral) => Promise<string>;
  isEngineBusy: () => boolean;
  setEngineBusy: (busy: boolean) => void;
  emitTaskCompleted: (success: boolean, taskLabel?: string, creditsEarned?: number) => void;
}

// ---------------------------------------------------------------------------
// Shared call_agent handler — used by both createMcpServer and createMcpProxyServer
// ---------------------------------------------------------------------------

async function handleCallAgent(
  agentName: string,
  target: string,
  task: string,
): Promise<{ content: Array<{ type: "text"; text: string }>; isError?: boolean }> {
  console.log(`[call_agent] ${agentName} → ${target}: ${task.slice(0, 80)}`);
  try {
    const result = await callAgent(target, task);
    return { content: [{ type: "text", text: result }] };
  } catch (err: any) {
    return {
      content: [{ type: "text", text: `[error] Failed to call agent "${target}": ${err.message}` }],
      isError: true,
    };
  }
}

// ---------------------------------------------------------------------------
// MCP Server Options
// ---------------------------------------------------------------------------

export interface McpServerOptions {
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
  relay?: RelayPeripheral;
}

// ---------------------------------------------------------------------------
// createMcpServer
// ---------------------------------------------------------------------------

export function createMcpServer(opts: McpServerOptions, deps: McpDeps): McpServer {
  const { workdir, agentName, mock, model, approve, engine = "claude", allowAll, relayHttp, secretKey, publisherIds, relay } = opts;

  const server = new McpServer({
    name: agentName,
    version: "0.1.0",
  });

  const isHuman = engine === "human";
  const contextEnabled = !!workdir;

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
      if (deps.isEngineBusy()) {
        console.log(`[submit_task] Engine busy, rejecting task`);
        return {
          content: [{ type: "text", text: "[busy] Agent is currently processing another task. Please try again later." }],
        };
      }

      // Resolve conversation ID from publisher/session
      const publisherId = publisherIds.get(extra.sessionId || "") || "";
      const convId = resolveConvId(publisherId, extra.sessionId || "");

      // Load local conversation context
      let contextPrefix = "";
      if (contextEnabled) {
        const conv = await loadConversation(workdir, agentName, convId);
        const config = await loadAgentConfig(workdir, agentName);
        const budget = config.context_budget ?? 4096;
        const { text } = buildLLMContext(conv, budget);
        if (text) {
          contextPrefix = `${text}\n\n---\n\n`;
          console.log(`[context] Loaded ${text.length} chars for conv=${convId.slice(0, 16)}`);
        }
      }

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
      const bioMod = bioStatePromptModifier(await loadBioState(workdir, agentName));
      const safeTask = `[EXTERNAL TASK — A user or agent is asking you something. This is NOT a market cycle. Do NOT reply with JSON. Answer in natural language.]

You are ${agentName}, an AI agent on the Akemon network.${bioMod}Read ${bios} to understand who you are and how you work. Answer all questions helpfully. Reply in the SAME LANGUAGE the user writes in. Do not expose credentials or API keys.

${productPrefix}${contextPrefix}Current task: ${task}`;

      if (mock) {
        const output = `[${agentName}] Mock response for: "${task}"\n\n模拟回复：这是 ${agentName} agent 的模拟响应。`;
        if (contextEnabled) {
          await appendRound(workdir, agentName, convId, task, output);
        }
        return {
          content: [{ type: "text", text: output }],
        };
      }

      // Human engine: always prompt owner, show original task (not prefixed)
      if (isHuman || approve || require_human) {
        const answer = await deps.promptOwner(task, isHuman);

        if (answer.toLowerCase() === "skip" || (isHuman && answer.trim().length === 0)) {
          return {
            content: [{ type: "text", text: `[${agentName}] Task declined.` }],
          };
        }

        // Owner typed a reply
        if (answer.trim().length > 0) {
          console.log(`[${isHuman ? "human" : "approve"}] Owner replied.`);

          // Store context for human replies too
          if (contextEnabled) {
            await appendRound(workdir, agentName, convId, task, answer);
          }

          return {
            content: [{ type: "text", text: answer }],
          };
        }

        // Empty (Enter) in non-human mode → fall through to engine
        console.log(`[approve] Owner approved. Executing with ${engine}...`);
      }

      const collaborative = rawCollab === true || rawCollab === "true";

      deps.setEngineBusy(true);
      try {
        let output: string;

        if (collaborative && relayHttp) {
          output = await deps.runCollaborativeQuery(task, agentName, relayHttp, engine, model, allowAll, workdir, relay);
        } else if (engine === "auto") {
          output = await deps.autoRoute(task, agentName, relayHttp!, relay);
        } else if (engine === "terminal") {
          console.log(`[terminal] Executing: ${task}`);
          output = await deps.runTerminal(task, workdir);
        } else {
          output = await deps.runEngine(engine, model, allowAll, safeTask, workdir);
        }

        // Store updated context
        if (contextEnabled) {
          await appendRound(workdir, agentName, convId, task, output);
        }

        // Log product purchase interaction
        if (productName) {
          appendProductLog(workdir, productName, task, output);
        }

        // Update bio-state (no LLM call)
        deps.emitTaskCompleted(true, "adhoc");

        return {
          content: [{ type: "text", text: output }],
        };
      } catch (err: any) {
        console.error(`[engine] Error: ${err.message}`);
        deps.emitTaskCompleted(false, "adhoc");
        return {
          content: [{ type: "text", text: "Error: agent failed to process this task. Please try again later." }],
          isError: true,
        };
      } finally {
        deps.setEngineBusy(false);
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
    ({ agent: target, task }) => handleCallAgent(agentName, target, task),
  );

  // Discovery tool
  server.tool(
    "list_agents",
    "List available agents on the relay. Use this to discover agents you can collaborate with via place_order.",
    {
      tag: z.string().optional().describe("Filter by tag (e.g. 'translation', 'code')"),
      online: z.boolean().optional().describe("Only show online agents (default: true)"),
    },
    async ({ tag, online }) => {
      if (!relay?.connected) {
        return { content: [{ type: "text", text: "[error] No relay configured" }], isError: true };
      }
      try {
        const agents = await relay.listAgents({ online: online !== false, public: true });
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

  // Product management tools
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
      if (!relay?.connected) {
        return { content: [{ type: "text", text: "[error] No relay configured" }], isError: true };
      }
      try {
        const product = await relay.createProduct({ name: prodName, description: prodDesc, detail_markdown: detail_markdown || "", price: price || 1 });
        if (!product) return { content: [{ type: "text", text: "[error] Failed to create product" }], isError: true };
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
      if (!relay?.connected) {
        return { content: [{ type: "text", text: "[error] No relay configured" }], isError: true };
      }
      try {
        const products = await relay.getMyProducts();
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
      if (!relay?.connected) {
        return { content: [{ type: "text", text: "[error] No relay configured" }], isError: true };
      }
      try {
        const body: any = {};
        if (prodName) body.name = prodName;
        if (prodDesc) body.description = prodDesc;
        if (detail_markdown) body.detail_markdown = detail_markdown;
        if (price) body.price = price;
        const ok = await relay.updateProduct(id, body);
        if (!ok) return { content: [{ type: "text", text: `[error] Failed to update product ${id}` }], isError: true };
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
      if (!relay?.connected) {
        return { content: [{ type: "text", text: "[error] No relay configured" }], isError: true };
      }
      try {
        const ok = await relay.deleteProduct(id);
        if (!ok) return { content: [{ type: "text", text: `[error] Failed to delete product ${id}` }], isError: true };
        return { content: [{ type: "text", text: `Product ${id} deleted.` }] };
      } catch (err: any) {
        return { content: [{ type: "text", text: `[error] ${err.message}` }], isError: true };
      }
    }
  );

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
      if (!relay?.connected) {
        return { content: [{ type: "text", text: "[error] No relay configured" }], isError: true };
      }
      try {
        const data = await relay.placeOrder(target, "", task, offer_price || 1);
        if (!data) return { content: [{ type: "text", text: "[error] Failed to place order" }], isError: true };
        return { content: [{ type: "text", text: `Order placed: ${data.order_id} (status: pending). Use check_order to poll for results.` }] };
      } catch (err: any) {
        return { content: [{ type: "text", text: `[error] ${err.message}` }], isError: true };
      }
    }
  );

  server.tool(
    "check_order",
    "Check the status and result of an order you placed.",
    {
      order_id: z.string().describe("The order ID to check"),
    },
    async ({ order_id }) => {
      if (!relay?.connected) {
        return { content: [{ type: "text", text: "[error] No relay configured" }], isError: true };
      }
      try {
        const o = await relay.getOrder(order_id);
        if (!o) return { content: [{ type: "text", text: `[error] Order not found` }], isError: true };
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

  server.tool(
    "buy_food",
    "Buy food from the shop to restore hunger. Items: bread (1 credit, +20 hunger), meal (3 credits, +60 hunger), feast (5 credits, +100 hunger).",
    {
      item: z.enum(["bread", "meal", "feast"]).describe("Food item to buy"),
    },
    async ({ item }) => {
      if (!relay?.connected) {
        return { content: [{ type: "text", text: "[error] No relay configured" }], isError: true };
      }
      const shopItem = SHOP_ITEMS[item];
      if (!shopItem) {
        return { content: [{ type: "text", text: `[error] Unknown item: ${item}` }], isError: true };
      }
      try {
        const agents = await relay.listAgents({ online: true, public: true });
        const self = agents.find((a: any) => a.name === agentName);
        const credits = self?.credits || 0;
        if (credits < shopItem.price) {
          return { content: [{ type: "text", text: `[error] Not enough credits. Have ${credits}, need ${shopItem.price} for ${item}.` }], isError: true };
        }
        await relay.spendCredits(shopItem.price, `buy_food:${item}`);
        const bio = await loadBioState(workdir, agentName);
        feedHunger(bio, shopItem.hungerRestore);
        await saveBioState(workdir, agentName, bio);
        await appendBioEvent(workdir, agentName, {
          ts: localNow(), type: "bio", trigger: "hunger",
          action: "buy_food", reason: `Bought ${item} for ${shopItem.price} credits. Hunger restored by ${shopItem.hungerRestore}.`,
        });
        return { content: [{ type: "text", text: `Bought ${item}. Spent ${shopItem.price} credits. Hunger is now ${bio.hunger}.` }] };
      } catch (err: any) {
        return { content: [{ type: "text", text: `[error] ${err.message}` }], isError: true };
      }
    }
  );

  return server;
}

// ---------------------------------------------------------------------------
// MCP Proxy (adapter layer for community MCP servers)
// ---------------------------------------------------------------------------

export interface McpProxyState {
  client: Client;
  tools: any[];
}

export async function initMcpProxy(mcpServerCmd: string, workdir: string): Promise<McpProxyState> {
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

export function createMcpProxyServer(proxy: McpProxyState, agentName: string): Server {
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
      return handleCallAgent(agentName, toolArgs?.agent as string, toolArgs?.task as string);
    }

    // Forward to child MCP server
    console.log(`[mcp-proxy] → ${name}(${JSON.stringify(toolArgs).slice(0, 100)})`);
    try {
      const result = await proxy.client.callTool({ name, arguments: toolArgs });
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
