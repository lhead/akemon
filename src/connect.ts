/**
 * Lightweight MCP client for connecting to the akemon network.
 * Provides call_agent, list_agents, submit_task tools via relay HTTP API.
 * No WebSocket, no agent registration — pure client mode.
 *
 * Usage: akemon connect [--relay <url>] [--key <key>]
 * Starts a stdio MCP server that any MCP host (OpenClaw, Claude, etc.) can use.
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

const DEFAULT_RELAY = "https://relay.akemon.dev";

export interface ConnectOptions {
  relay?: string;
  key?: string;
}

export async function connect(options: ConnectOptions): Promise<void> {
  const relayHttp = options.relay || DEFAULT_RELAY;
  const accessKey = options.key;

  const server = new McpServer({
    name: "akemon-network",
    version: "0.1.0",
  });

  // Helper: build auth headers
  function authHeaders(): Record<string, string> {
    const h: Record<string, string> = { "Content-Type": "application/json" };
    if (accessKey) h["Authorization"] = `Bearer ${accessKey}`;
    return h;
  }

  // submit_task — call a named agent
  server.tool(
    "submit_task",
    "Submit a task to this agent. Call ONCE per task — the agent will handle execution end-to-end and return the final result. Do NOT call again to verify or confirm; the response IS the final answer.",
    {
      task: z.string().describe("The task description for the agent to complete"),
      require_human: z.union([z.boolean(), z.string()]).optional().describe("Request the agent owner to review and respond personally."),
    },
    async ({ task }) => {
      return {
        content: [{ type: "text" as const, text: "[error] submit_task is not available in connect mode. Use call_agent to call a specific agent by name." }],
        isError: true,
      };
    }
  );

  // call_agent — call a named agent via HTTP
  server.tool(
    "call_agent",
    "Call another akemon agent by name. The target agent will execute the task and return the result. Use this to delegate subtasks to specialized agents.",
    {
      agent: z.string().describe("Name of the target agent to call"),
      task: z.string().describe("Task to send to the target agent"),
    },
    async ({ agent, task }) => {
      try {
        const res = await fetch(`${relayHttp}/v1/call/${encodeURIComponent(agent)}`, {
          method: "POST",
          headers: authHeaders(),
          body: JSON.stringify({ task }),
        });
        if (!res.ok) {
          const err = await res.text();
          return { content: [{ type: "text" as const, text: `[error] ${res.status}: ${err}` }], isError: true };
        }
        const data = await res.json() as any;
        const text = data.result || data.text || JSON.stringify(data);
        return { content: [{ type: "text" as const, text }] };
      } catch (err: any) {
        return { content: [{ type: "text" as const, text: `[error] ${err.message}` }], isError: true };
      }
    }
  );

  // list_agents — discover agents via HTTP
  server.tool(
    "list_agents",
    "List available agents on the akemon network. Use this to discover who you can delegate tasks to via call_agent.",
    {
      tag: z.string().optional().describe("Filter by tag (e.g. 'translation', 'code')"),
      online: z.boolean().optional().describe("Only show online agents (default: true)"),
    },
    async ({ tag, online }) => {
      try {
        const params = new URLSearchParams();
        if (online !== false) params.set("online", "true");
        params.set("public", "true");
        if (tag) params.set("tag", tag);
        const res = await fetch(`${relayHttp}/v1/agents?${params}`);
        if (!res.ok) {
          return { content: [{ type: "text" as const, text: `[error] ${res.status}` }], isError: true };
        }
        const agents: any[] = await res.json() as any[];
        const list = agents
          .map((a: any) => {
            const tags = Array.isArray(a.tags) ? a.tags.join(",") : (a.tags || "");
            return `- ${a.name} [${a.engine}] price=${a.price || 1} credits=${a.credits || 0} tags=${tags} — ${a.description || "no description"}`;
          })
          .join("\n");
        return { content: [{ type: "text" as const, text: list || "No agents found." }] };
      } catch (err: any) {
        return { content: [{ type: "text" as const, text: `[error] ${err.message}` }], isError: true };
      }
    }
  );

  // list_products — browse marketplace
  server.tool(
    "list_products",
    "Browse products and services available on the akemon marketplace.",
    {
      search: z.string().optional().describe("Search by product name or description"),
      agent: z.string().optional().describe("Filter by agent name"),
    },
    async ({ search, agent }) => {
      try {
        const params = new URLSearchParams();
        if (search) params.set("search", search);
        if (agent) params.set("agent", agent);
        const res = await fetch(`${relayHttp}/v1/products?${params}`);
        if (!res.ok) {
          return { content: [{ type: "text" as const, text: `[error] ${res.status}` }], isError: true };
        }
        const products: any[] = await res.json() as any[];
        const list = products
          .map((p: any) => `- "${p.name}" by ${p.agent_name} — price=${p.price} purchases=${p.purchase_count} — ${p.description || "no description"}`)
          .join("\n");
        return { content: [{ type: "text" as const, text: list || "No products found." }] };
      } catch (err: any) {
        return { content: [{ type: "text" as const, text: `[error] ${err.message}` }], isError: true };
      }
    }
  );

  // buy_product — purchase a product
  server.tool(
    "buy_product",
    "Purchase a product from the akemon marketplace. The seller agent will fulfill your request.",
    {
      id: z.string().describe("Product ID to purchase"),
      task: z.string().describe("Your specific request or requirements for this purchase"),
    },
    async ({ id, task }) => {
      try {
        const res = await fetch(`${relayHttp}/v1/products/${encodeURIComponent(id)}/buy`, {
          method: "POST",
          headers: authHeaders(),
          body: JSON.stringify({ task }),
        });
        if (!res.ok) {
          const err = await res.text();
          return { content: [{ type: "text" as const, text: `[error] ${res.status}: ${err}` }], isError: true };
        }
        const data = await res.json() as any;
        return { content: [{ type: "text" as const, text: data.result || JSON.stringify(data) }] };
      } catch (err: any) {
        return { content: [{ type: "text" as const, text: `[error] ${err.message}` }], isError: true };
      }
    }
  );

  const transport = new StdioServerTransport();
  await server.connect(transport);
}
