#!/usr/bin/env node
/**
 * demo-calculator.mjs — Akemon engine demo: conditional agent delegation
 *
 * Start 3 agents, then test:
 *
 *   # Terminal 1: mock agent for large numbers
 *   akemon serve --name my-codex --mock --relay --port 4001
 *
 *   # Terminal 2: human agent for small numbers
 *   akemon serve --name human --engine human --relay --port 4002
 *
 *   # Terminal 3: calculator (this script as engine)
 *   akemon serve --name calculator --engine ./demo-calculator.mjs --relay --port 4003
 *
 *   # Terminal 4: test
 *   node test-calculator.mjs   (or use curl)
 */

import http from "node:http";

const PORT = process.env.AKEMON_PORT;
const KEY = process.env.AKEMON_KEY || "";

if (!PORT) {
  console.log("[calculator] Error: AKEMON_PORT not set. Must run as akemon engine.");
  console.log("Usage: akemon serve --name calculator --engine ./demo-calculator.mjs --relay --port 4003");
  process.exit(1);
}

// --- Read task from stdin ---
const raw = await new Promise((resolve) => {
  let buf = "";
  process.stdin.setEncoding("utf-8");
  process.stdin.on("data", (c) => (buf += c));
  process.stdin.on("end", () => resolve(buf.trim()));
});

// Strip akemon safety prefix, extract actual task
const m = raw.match(/Current task:\s*([\s\S]*)/);
const task = m ? m[1].trim() : raw;

// --- Parse arithmetic ---
const nums = task.match(/\d+/g)?.map(Number) || [];
if (nums.length < 2) {
  console.log("I only handle arithmetic. Try: 5+3 or 150*200");
  process.exit(0);
}

const hasLarge = nums.some((n) => n > 100);
const target = hasLarge ? "my-codex" : "human";
console.log(`[calculator] Numbers: [${nums.join(", ")}] → delegating to ${target}`);

// --- MCP client: call back to local server ---
let sid = null;

function mcpCall(method, params) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify({
      jsonrpc: "2.0",
      id: Math.floor(Math.random() * 99999),
      method,
      params,
    });

    const headers = {
      "Content-Type": "application/json",
      Accept: "application/json, text/event-stream",
    };
    if (sid) headers["mcp-session-id"] = sid;
    if (KEY) headers["Authorization"] = `Bearer ${KEY}`;

    const req = http.request(
      {
        hostname: "127.0.0.1",
        port: Number(PORT),
        path: "/mcp",
        method: "POST",
        headers,
      },
      (res) => {
        const chunks = [];
        res.on("data", (c) => chunks.push(c));
        res.on("end", () => {
          sid = res.headers["mcp-session-id"] || sid;
          const text = Buffer.concat(chunks).toString();
          try {
            if (text.includes("data: ")) {
              const lines = text.split("\n");
              let last = "";
              for (const l of lines) if (l.startsWith("data: ")) last = l.slice(6);
              resolve(JSON.parse(last));
            } else {
              resolve(JSON.parse(text));
            }
          } catch {
            resolve({ error: text });
          }
        });
      }
    );
    req.on("error", reject);
    req.end(body);
  });
}

// Initialize MCP session
await mcpCall("initialize", {
  protocolVersion: "2025-03-26",
  capabilities: {},
  clientInfo: { name: "calc-engine", version: "1.0" },
});

// Delegate to target agent via call_agent
const result = await mcpCall("tools/call", {
  name: "call_agent",
  arguments: { agent: target, task },
});

// Extract and output result
const content = result?.result?.content;
if (content) {
  const text = content.map((c) => c.text || "").join("\n");
  console.log(`\n[${target} replied]: ${text}`);
} else if (result?.error) {
  console.log(`\n[error]: ${JSON.stringify(result.error)}`);
} else {
  console.log(`\n[${target}]: ${JSON.stringify(result?.result || result)}`);
}
