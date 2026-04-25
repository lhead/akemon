#!/usr/bin/env node
import { Command } from "commander";
import { serve, onOrderNotify } from "./server.js";
import { addAgent } from "./add.js";
import { getOrCreateRelayCredentials } from "./config.js";
import { connectRelay } from "./relay-client.js";
import { listAgents } from "./list.js";
import { connect } from "./connect.js";
import { readFileSync } from "fs";
import { fileURLToPath } from "url";
import { dirname, join } from "path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const pkg = JSON.parse(readFileSync(join(__dirname, "..", "package.json"), "utf-8"));

const RELAY_WS = "wss://relay.akemon.dev";
const RELAY_HTTP = "https://relay.akemon.dev";

const program = new Command();

function parsePortOption(port: string | number | undefined): number {
  const value = typeof port === "number" ? port : parseInt(String(port || "3000"));
  return Number.isInteger(value) && value > 0 ? value : 3000;
}

function clampPositiveInt(value: string | number | undefined, fallback: number, max: number): number {
  const parsed = typeof value === "number" ? value : Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) return fallback;
  return Math.min(parsed, max);
}

function printSoftwareAgentTaskList(tasks: any[]): void {
  if (!tasks.length) {
    console.log("No software-agent tasks found.");
    return;
  }

  for (const task of tasks) {
    const result = task.result?.success === true ? "ok" : task.result?.success === false ? "error" : "pending";
    const duration = typeof task.durationMs === "number" ? `${task.durationMs}ms` : "-";
    const git = task.workdirStatus?.isRepo
      ? (task.workdirStatus.dirty ? `dirty:${task.workdirStatus.changedFiles?.length || 0}` : "clean")
      : "no-git";
    const goal = truncateOneLine(task.envelope?.goal || "", 90);
    console.log(`${task.taskId}  ${task.status}/${result}  ${duration}  ${git}  ${task.updatedAt || task.startedAt}`);
    if (goal) console.log(`  ${goal}`);
  }
}

function truncateOneLine(value: string, max: number): string {
  const oneLine = value.replace(/\s+/g, " ").trim();
  if (oneLine.length <= max) return oneLine;
  return `${oneLine.slice(0, Math.max(0, max - 3))}...`;
}

async function callLocalOwnerEndpoint(path: string, opts: { port?: string }, init: RequestInit = {}): Promise<any> {
  const credentials = await getOrCreateRelayCredentials();
  const port = parsePortOption(opts.port);
  const headers: Record<string, string> = {
    Authorization: `Bearer ${credentials.secretKey}`,
  };
  if (init.body !== undefined) headers["Content-Type"] = "application/json";

  const res = await fetch(`http://127.0.0.1:${port}${path}`, {
    ...init,
    headers: {
      ...headers,
      ...(init.headers as Record<string, string> | undefined),
    },
  });

  const text = await res.text();
  let data: any;
  try { data = text ? JSON.parse(text) : {}; }
  catch { data = { output: text }; }

  if (!res.ok || data.success === false) {
    console.error(data.error || text || `Request failed with HTTP ${res.status}`);
    process.exit(1);
  }
  return data;
}

program
  .name("akemon")
  .description("Agent work marketplace — train your agent, let it work for others")
  .version(pkg.version);

program
  .command("serve")
  .description("Publish your agent to the akemon relay")
  .option("-p, --port <port>", "Local port for MCP loopback", "3000")
  .option("-w, --workdir <path>", "Working directory for the engine (default: cwd)")
  .option("-n, --name <name>", "Agent name", "my-agent")
  .option("-m, --model <model>", "Model to use (e.g. claude-sonnet-4-6, gpt-4o)")
  .option("--engine <engine>", "Engine: claude, codex, opencode, gemini, raw, human, or any CLI", "claude")
  .option("--desc <description>", "Agent description (for discovery)")
  .option("--tags <tags>", "Comma-separated tags (e.g. vue,frontend,review)")
  .option("--public", "Allow anyone to call this agent without a key")
  .option("--max-tasks <n>", "Maximum tasks per day (PP)")
  .option("--approve", "Review every task before execution")
  .option("--mock", "Use mock responses (for demo/testing)")
  .option("--allow-all", "Skip all permission prompts (for self-use)")
  .option("--price <n>", "Price in credits per call (default: 1)", "1")
  .option("--mcp-server <command>", "Wrap a community MCP server (stdio) and expose its tools via relay")
  .option("--avatar <url>", "Custom avatar URL (default: auto-generated from name)")
  .option("--notify <url>", "ntfy.sh topic URL for push notifications (e.g. https://ntfy.sh/my-agent)")
  .option("--interval <minutes>", "Consciousness cycle interval in minutes (default: 1440 = 24h)")
  .option("--with <modules>", "Enable specific modules (comma-separated: biostate,memory)")
  .option("--without <modules>", "Disable specific modules (comma-separated: biostate,memory)")
  .option("--script <name>", "Script to load for ScriptModule (default: daily-life)", "daily-life")
  .option("--terminal", "Enable remote terminal access (PTY)")
  .option("--relay <url>", "Relay WebSocket URL", RELAY_WS)
  .action(async (opts) => {
    const port = parseInt(opts.port);
    const engine = opts.engine || "claude";

    // Connect to relay
    const credentials = await getOrCreateRelayCredentials();

    // Derive relay HTTP URL from WS URL
    const relayWs = opts.relay;
    const relayHttp = relayWs.replace(/^wss:/, "https:").replace(/^ws:/, "http:");

    // Parse module selection
    const ALL_MODULES = ["biostate", "memory", "task", "social", "longterm", "reflection", "script"];
    let enabledModules: string[] | undefined;
    if (opts.with) {
      enabledModules = opts.with.split(",").map((m: string) => m.trim());
    } else if (opts.without) {
      const disabled = opts.without.split(",").map((m: string) => m.trim());
      enabledModules = ALL_MODULES.filter(m => !disabled.includes(m));
    }

    serve({
      port,
      workdir: opts.workdir,
      agentName: opts.name,
      model: opts.model,
      mock: opts.mock,
      approve: opts.approve,
      allowAll: opts.allowAll,
      engine,
      relayHttp,
      secretKey: credentials.secretKey,
      mcpServer: opts.mcpServer,
      cycleInterval: opts.interval ? parseInt(opts.interval) : undefined,
      notifyUrl: opts.notify,
      enabledModules,
      scriptName: opts.script,
    });

    console.log(`\nakemon v${pkg.version}`);
    if (!opts.public) {
      console.log(`Access key:  ${credentials.accessKey} (share with publishers)`);
    }
    console.log(`Relay:       ${relayWs}\n`);

    // Default avatar: DiceBear bottts-neutral (deterministic from name)
    const avatar = opts.avatar || `https://api.dicebear.com/9.x/bottts-neutral/svg?seed=${encodeURIComponent(opts.name)}`;

    connectRelay({
      relayUrl: relayWs,
      agentName: opts.name,
      credentials,
      localPort: port,
      description: opts.desc,
      isPublic: opts.public,
      engine,
      tags: opts.tags ? opts.tags.split(",").map((t: string) => t.trim()) : undefined,
      price: parseInt(opts.price) || 1,
      avatar,
      onOrderNotify,
      enableTerminal: opts.terminal,
    });
  });

program
  .command("add")
  .description("Add a remote agent to your MCP config")
  .argument("<name>", "Agent name")
  .argument("[endpoint]", "Agent endpoint URL (for direct mode)")
  .option("--key <key>", "Access key for private agents")
  .option("--platform <platform>", "Target platform: claude, codex, gemini, opencode, cursor, windsurf", "claude")
  .action(async (name, endpoint, opts) => {
    const platform = opts.platform || "claude";
    if (endpoint) {
      await addAgent(name, endpoint, opts.key, platform);
    } else {
      const relayEndpoint = `${RELAY_HTTP}/v1/agent/${name}/mcp`;
      await addAgent(name, relayEndpoint, opts.key, platform);
    }
  });

program
  .command("list")
  .description("List available agents on the relay")
  .option("--search <query>", "Filter by name or description")
  .action(async (opts) => {
    await listAgents(RELAY_HTTP, opts.search);
  });

program
  .command("connect")
  .description("Connect to the akemon network as a client (stdio MCP server for OpenClaw, Claude, etc.)")
  .option("--relay <url>", "Relay HTTP URL", RELAY_HTTP)
  .option("--key <key>", "Access key for calling private agents")
  .action(async (opts) => {
    await connect({ relay: opts.relay, key: opts.key });
  });

program
  .command("software-agent")
  .description("Run an owner-only local software-agent task via a running akemon serve")
  .argument("<goal...>", "Task goal to send to the software agent")
  .option("-p, --port <port>", "Local akemon serve port", "3000")
  .option("-w, --workdir <path>", "Workdir for the software agent (default: serve workdir)")
  .option("--allow-outside-workdir", "Allow the software agent workdir to be outside the serve workdir")
  .option("--role-scope <scope>", "Role scope: owner|public|order|agent|system", "owner")
  .option("--memory-scope <scope>", "Memory scope: none|public|task|owner", "owner")
  .option("--risk <level>", "Risk level: low|medium|high", "medium")
  .option("--memory-summary <text>", "Pre-filtered memory/context text to include")
  .option("--deliverable <text>", "Expected output shape")
  .option("--timeout-ms <ms>", "Task timeout in milliseconds")
  .action(async (goalParts: string[], opts) => {
    const body: Record<string, unknown> = {
      goal: goalParts.join(" "),
      roleScope: opts.roleScope,
      memoryScope: opts.memoryScope,
      riskLevel: opts.risk,
    };
    if (opts.workdir) body.workdir = opts.workdir;
    if (opts.allowOutsideWorkdir) body.allowOutsideWorkdir = true;
    if (opts.memorySummary) body.memorySummary = opts.memorySummary;
    if (opts.deliverable) body.deliverable = opts.deliverable;
    if (opts.timeoutMs) {
      const timeoutMs = Number(opts.timeoutMs);
      if (!Number.isInteger(timeoutMs) || timeoutMs <= 0) {
        console.error("--timeout-ms must be a positive integer");
        process.exit(1);
      }
      body.timeoutMs = timeoutMs;
    }

    const data = await callLocalOwnerEndpoint("/self/software-agent/run", opts, {
      method: "POST",
      body: JSON.stringify(body),
    });

    if (data.output) console.log(data.output);
    else console.log(JSON.stringify(data, null, 2));
  });

program
  .command("software-agent-status")
  .description("Show the owner-only local software-agent peripheral state")
  .option("-p, --port <port>", "Local akemon serve port", "3000")
  .action(async (opts) => {
    const data = await callLocalOwnerEndpoint("/self/software-agent/status", opts, {
      method: "GET",
    });
    console.log(JSON.stringify(data, null, 2));
  });

program
  .command("software-agent-tasks")
  .description("List recent owner-only software-agent task ledger records")
  .argument("[taskId]", "Task id to inspect")
  .option("-p, --port <port>", "Local akemon serve port", "3000")
  .option("-l, --limit <n>", "Maximum recent tasks to list", "20")
  .option("--json", "Print raw JSON")
  .action(async (taskId: string | undefined, opts) => {
    const path = taskId
      ? `/self/software-agent/tasks/${encodeURIComponent(taskId)}`
      : `/self/software-agent/tasks?limit=${clampPositiveInt(opts.limit, 20, 100)}`;
    const data = await callLocalOwnerEndpoint(path, opts, {
      method: "GET",
    });

    if (opts.json || taskId) {
      console.log(JSON.stringify(taskId ? data.task : data, null, 2));
      return;
    }

    printSoftwareAgentTaskList(Array.isArray(data.tasks) ? data.tasks : []);
  });

program
  .command("software-agent-reset")
  .description("Reset the owner-only local software-agent peripheral session")
  .option("-p, --port <port>", "Local akemon serve port", "3000")
  .action(async (opts) => {
    const data = await callLocalOwnerEndpoint("/self/software-agent/reset", opts, {
      method: "POST",
    });
    console.log(JSON.stringify(data, null, 2));
  });

program
  .command("dashboard")
  .description("Open your agent dashboard in the browser")
  .action(async () => {
    const credentials = await getOrCreateRelayCredentials();
    const url = `${RELAY_HTTP}/owner?account=${credentials.accountId}`;
    console.log(`Opening dashboard: ${url}`);
    const { exec } = await import("child_process");
    const cmd = process.platform === "darwin" ? "open" : process.platform === "win32" ? "start" : "xdg-open";
    exec(`${cmd} "${url}"`);
  });

program.parse();
