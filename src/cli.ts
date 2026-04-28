#!/usr/bin/env node
import { Command } from "commander";
import { serve, onOrderNotify } from "./server.js";
import { addAgent } from "./add.js";
import { getOrCreateRelayCredentials } from "./config.js";
import { connectRelay } from "./relay-client.js";
import { listAgents } from "./list.js";
import { connect } from "./connect.js";
import {
  PrivacyFilterUnavailableError,
  sanitizeText,
  type PrivacyFilterBackend,
  type PrivacyFilterMode,
} from "./privacy-filter.js";
import { SoftwareAgentStreamCliRenderer } from "./software-agent-stream-cli.js";
import type { SoftwareAgentEnvPolicy } from "./software-agent-peripheral.js";
import {
  appendWorkMemoryNote,
  buildWorkMemoryContext,
} from "./work-memory.js";
import { renderSoftwareAgentRunResult } from "./software-agent-result-cli.js";
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

function parsePrivacyFilterMode(value: string): PrivacyFilterMode {
  if (value === "fast" || value === "pii" || value === "strict") return value;
  console.error("--mode must be one of: fast, pii, strict");
  process.exit(1);
}

function parsePrivacyFilterBackend(value: string | undefined): PrivacyFilterBackend | undefined {
  if (value === undefined) return undefined;
  if (value === "fast" || value === "opf") return value;
  console.error("--backend must be one of: fast, opf");
  process.exit(1);
}

function parseSoftwareAgentEnvPolicy(value: string | undefined): SoftwareAgentEnvPolicy {
  const normalized = (value || "inherit").trim().toLowerCase();
  if (normalized === "inherit" || normalized === "allowlist") return normalized;
  console.error("--software-agent-env must be one of: inherit, allowlist");
  process.exit(1);
}

function parseCommaSeparatedCliOption(value: string | undefined): string[] | undefined {
  if (!value) return undefined;
  const items = value.split(",").map((item) => item.trim()).filter(Boolean);
  return items.length ? items : undefined;
}

function parsePositiveIntCliOption(value: string | number | undefined, optionName: string): number | undefined {
  if (value === undefined) return undefined;
  const parsed = typeof value === "number" ? value : Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    console.error(`${optionName} must be a positive integer`);
    process.exit(1);
  }
  return parsed;
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
    if (task.contextSession?.sessionId) console.log(`  session: ${task.contextSession.sessionId}`);
    const workMemoryDir = task.envelope?.workMemoryDir || task.result?.workMemoryDir;
    if (workMemoryDir) console.log(`  work memory: ${workMemoryDir}`);
    if (goal) console.log(`  ${goal}`);
  }
}

function printSoftwareAgentSessionList(sessions: any[]): void {
  if (!sessions.length) {
    console.log("No software-agent context sessions found.");
    return;
  }

  for (const session of sessions) {
    const result = session.lastResult?.success === true ? "ok" : session.lastResult?.success === false ? "error" : "pending";
    const duration = typeof session.lastResult?.durationMs === "number" ? `${session.lastResult.durationMs}ms` : "-";
    const updatedAt = session.updatedAt || "-";
    const goal = truncateOneLine(session.lastGoal || "", 90);
    console.log(`${session.sessionId}  ${result}  ${duration}  ${updatedAt}`);
    if (session.lastTaskId) console.log(`  last task: ${session.lastTaskId}`);
    if (goal) console.log(`  ${goal}`);
    if (session.packetPath) console.log(`  context: ${session.packetPath}`);
    if (session.workMemoryDir) console.log(`  work memory: ${session.workMemoryDir}`);
  }
}

function truncateOneLine(value: string, max: number): string {
  const oneLine = value.replace(/\s+/g, " ").trim();
  if (oneLine.length <= max) return oneLine;
  return `${oneLine.slice(0, Math.max(0, max - 3))}...`;
}

async function callLocalOwnerEndpoint(path: string, opts: { port?: string }, init: RequestInit = {}): Promise<any> {
  const res = await fetchLocalOwnerEndpoint(path, opts, init);

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

async function fetchLocalOwnerEndpoint(path: string, opts: { port?: string }, init: RequestInit = {}): Promise<Response> {
  const credentials = await getOrCreateRelayCredentials();
  const port = parsePortOption(opts.port);
  const headers: Record<string, string> = {
    Authorization: `Bearer ${credentials.secretKey}`,
  };
  if (init.body !== undefined) headers["Content-Type"] = "application/json";

  let res: Response;
  try {
    res = await fetch(`http://127.0.0.1:${port}${path}`, {
      ...init,
      headers: {
        ...headers,
        ...(init.headers as Record<string, string> | undefined),
      },
    });
  } catch (error) {
    const cause = (error as { cause?: { message?: string } }).cause;
    if (error instanceof TypeError && error.message === "fetch failed" && cause?.message === "bad port") {
      console.error(`Port ${port} cannot be used for the local akemon serve connection. Choose a different --port.`);
      process.exit(1);
    }
    if (error instanceof TypeError && error.message === "fetch failed") {
      console.error(`Cannot connect to local akemon serve on port ${port}. Start it with: akemon serve --port ${port}`);
      process.exit(1);
    }
    throw error;
  }

  return res;
}

async function streamLocalOwnerEndpoint(path: string, opts: { port?: string }, body: Record<string, unknown>): Promise<void> {
  const res = await fetchLocalOwnerEndpoint(path, opts, {
    method: "POST",
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    const text = await res.text();
    let data: any;
    try { data = text ? JSON.parse(text) : {}; }
    catch { data = { error: text }; }
    console.error(data.error || text || `Request failed with HTTP ${res.status}`);
    process.exit(1);
  }

  if (!res.body) return;

  const decoder = new TextDecoder();
  let buffer = "";
  let failed = false;
  const streamRenderer = new SoftwareAgentStreamCliRenderer();
  const reader = res.body.getReader();
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split(/\r?\n/);
    buffer = lines.pop() || "";
    for (const line of lines) {
      if (streamRenderer.handleLine(line)) failed = true;
    }
  }
  buffer += decoder.decode();
  if (buffer.trim() && streamRenderer.handleLine(buffer)) failed = true;
  if (failed) process.exit(1);
}

async function runSoftwareAgentCli(goalParts: string[], opts: any, forcedSessionId?: string): Promise<void> {
  const body: Record<string, unknown> = {
    goal: goalParts.join(" "),
    roleScope: opts.roleScope,
    memoryScope: opts.memoryScope,
    riskLevel: opts.risk,
  };
  if (opts.workdir) body.workdir = opts.workdir;
  if (opts.allowOutsideWorkdir) body.allowOutsideWorkdir = true;
  if (opts.memorySummary) body.memorySummary = opts.memorySummary;
  const workContextBudget = parsePositiveIntCliOption(opts.workContextBudget, "--work-context-budget");
  if (opts.workContext || workContextBudget !== undefined) body.includeWorkMemoryContext = true;
  if (workContextBudget !== undefined) body.workMemoryContextBudget = workContextBudget;
  const sessionId = forcedSessionId || opts.session;
  if (sessionId) body.contextSessionId = sessionId;
  if (opts.deliverable) body.deliverable = opts.deliverable;
  if (opts.timeoutMs) {
    const timeoutMs = Number(opts.timeoutMs);
    if (!Number.isInteger(timeoutMs) || timeoutMs <= 0) {
      console.error("--timeout-ms must be a positive integer");
      process.exit(1);
    }
    body.timeoutMs = timeoutMs;
  }

  if (opts.stream !== false) {
    await streamLocalOwnerEndpoint("/self/software-agent/run-stream", opts, body);
    return;
  }

  const res = await fetchLocalOwnerEndpoint("/self/software-agent/run", opts, {
    method: "POST",
    body: JSON.stringify(body),
  });

  const text = await res.text();
  let data: any;
  try { data = text ? JSON.parse(text) : {}; }
  catch { data = { output: text }; }

  if (!res.ok) {
    console.error(data.error || text || `Request failed with HTTP ${res.status}`);
    process.exit(1);
  }

  const failed = renderSoftwareAgentRunResult(data);
  if (failed) process.exit(1);
}

program
  .name("akemon")
  .description("Local AI companion runtime with memory, modules, relay sync, and software-agent control")
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
  .option("--software-agent-env <policy>", "Software-agent child environment policy: inherit or allowlist", process.env.AKEMON_SOFTWARE_AGENT_ENV_POLICY || "inherit")
  .option("--software-agent-env-allow <vars>", "Comma-separated extra env vars for software-agent allowlist")
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
      softwareAgentEnvPolicy: parseSoftwareAgentEnvPolicy(opts.softwareAgentEnv),
      softwareAgentEnvAllowlist: parseCommaSeparatedCliOption(opts.softwareAgentEnvAllow),
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
  .option("--work-context", "Embed a bounded work-memory context packet in the task envelope")
  .option("--work-context-budget <chars>", "Maximum embedded work-memory context size; also enables --work-context")
  .option("--session <id>", "Akemon-side context session id for explicit software-agent continuity")
  .option("--deliverable <text>", "Expected output shape")
  .option("--timeout-ms <ms>", "Task timeout in milliseconds")
  .option("--no-stream", "Disable local streaming and wait for the final response")
  .action(async (goalParts: string[], opts) => {
    await runSoftwareAgentCli(goalParts, opts);
  });

program
  .command("software-agent-continue")
  .description("Continue an Akemon-side software-agent context session")
  .argument("<sessionId>", "Akemon-side context session id to continue")
  .argument("<goal...>", "Task goal to send to the software agent")
  .option("-p, --port <port>", "Local akemon serve port", "3000")
  .option("-w, --workdir <path>", "Workdir for the software agent (default: serve workdir)")
  .option("--allow-outside-workdir", "Allow the software agent workdir to be outside the serve workdir")
  .option("--role-scope <scope>", "Role scope: owner|public|order|agent|system", "owner")
  .option("--memory-scope <scope>", "Memory scope: none|public|task|owner", "owner")
  .option("--risk <level>", "Risk level: low|medium|high", "medium")
  .option("--memory-summary <text>", "Pre-filtered memory/context text to include")
  .option("--work-context", "Embed a bounded work-memory context packet in the task envelope")
  .option("--work-context-budget <chars>", "Maximum embedded work-memory context size; also enables --work-context")
  .option("--deliverable <text>", "Expected output shape")
  .option("--timeout-ms <ms>", "Task timeout in milliseconds")
  .option("--no-stream", "Disable local streaming and wait for the final response")
  .action(async (sessionId: string, goalParts: string[], opts) => {
    await runSoftwareAgentCli(goalParts, opts, sessionId);
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
  .option("--session <id>", "Filter listed tasks by Akemon-side context session id")
  .option("--context", "Print the task's Akemon TASK_CONTEXT.md content when inspecting one task")
  .option("--json", "Print raw JSON")
  .action(async (taskId: string | undefined, opts) => {
    if (!taskId && opts.context) {
      console.error("--context requires a taskId");
      process.exit(1);
    }
    if (taskId && opts.session) {
      console.error("--session cannot be used when inspecting a single taskId");
      process.exit(1);
    }
    const path = taskId
      ? `/self/software-agent/tasks/${encodeURIComponent(taskId)}${opts.context ? "?includeContext=1" : ""}`
      : `/self/software-agent/tasks?limit=${clampPositiveInt(opts.limit, 20, 100)}${opts.session ? `&session=${encodeURIComponent(opts.session)}` : ""}`;
    const data = await callLocalOwnerEndpoint(path, opts, {
      method: "GET",
    });

    if (taskId && opts.context) {
      const contextPacket = data.contextSession?.contextPacket;
      if (typeof contextPacket === "string" && contextPacket.length > 0) {
        process.stdout.write(contextPacket);
        if (!contextPacket.endsWith("\n")) process.stdout.write("\n");
        return;
      }
      console.error("No TASK_CONTEXT.md content found for this task.");
      process.exit(1);
    }

    if (opts.json || taskId) {
      console.log(JSON.stringify(taskId ? data.task : data, null, 2));
      return;
    }

    printSoftwareAgentTaskList(Array.isArray(data.tasks) ? data.tasks : []);
  });

program
  .command("software-agent-sessions")
  .description("List or inspect owner-only Akemon-side software-agent context sessions")
  .argument("[sessionId]", "Context session id to inspect")
  .option("-p, --port <port>", "Local akemon serve port", "3000")
  .option("-l, --limit <n>", "Maximum recent sessions to list", "20")
  .option("--context", "Print the session TASK_CONTEXT.md content")
  .option("--json", "Print raw JSON")
  .action(async (sessionId: string | undefined, opts) => {
    const query = sessionId && opts.context ? "?includeContext=1" : "";
    const path = sessionId
      ? `/self/software-agent/sessions/${encodeURIComponent(sessionId)}${query}`
      : `/self/software-agent/sessions?limit=${clampPositiveInt(opts.limit, 20, 100)}`;
    const data = await callLocalOwnerEndpoint(path, opts, {
      method: "GET",
    });

    if (sessionId) {
      if (opts.context) {
        const contextPacket = data.session?.contextPacket;
        if (typeof contextPacket === "string" && contextPacket.length > 0) {
          process.stdout.write(contextPacket);
          if (!contextPacket.endsWith("\n")) process.stdout.write("\n");
          return;
        }
        console.error("No TASK_CONTEXT.md content found for this session.");
        process.exit(1);
      }
      console.log(JSON.stringify(data.session, null, 2));
      return;
    }

    if (opts.json) {
      console.log(JSON.stringify(data, null, 2));
      return;
    }

    printSoftwareAgentSessionList(Array.isArray(data.sessions) ? data.sessions : []);
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
  .command("privacy-filter")
  .description("Sanitize text with built-in redaction and optional OpenAI Privacy Filter")
  .argument("<text...>", "Text to sanitize")
  .option("--mode <mode>", "Mode: fast, pii, or strict", "fast")
  .option("--backend <backend>", "Backend: fast or opf")
  .option("--command <command>", "OPF command (default: opf)")
  .option("--device <device>", "OPF device, e.g. cpu or cuda")
  .option("--checkpoint <path>", "OPF checkpoint directory")
  .option("--timeout-ms <ms>", "OPF timeout in milliseconds")
  .option("--max-input-chars <n>", "Maximum text length to pass to OPF")
  .option("--json", "Print result metadata as JSON")
  .action(async (textParts: string[], opts) => {
    try {
      const result = await sanitizeText(textParts.join(" "), {
        mode: parsePrivacyFilterMode(opts.mode),
        backend: parsePrivacyFilterBackend(opts.backend),
        command: opts.command,
        device: opts.device,
        checkpoint: opts.checkpoint,
        timeoutMs: parsePositiveIntCliOption(opts.timeoutMs, "--timeout-ms"),
        maxInputChars: parsePositiveIntCliOption(opts.maxInputChars, "--max-input-chars"),
      });

      if (opts.json) {
        console.log(JSON.stringify(result, null, 2));
        return;
      }

      console.log(result.text);
      for (const warning of result.warnings) {
        console.error(`[privacy-filter] ${warning}`);
      }
    } catch (error) {
      if (error instanceof PrivacyFilterUnavailableError || error instanceof TypeError) {
        console.error(error.message);
        process.exit(1);
      }
      throw error;
    }
  });

program
  .command("work-context")
  .description("Print a work-memory context packet for external software agents")
  .option("-w, --workdir <path>", "Akemon workdir (default: cwd)")
  .option("-n, --name <name>", "Agent name", "my-agent")
  .option("--purpose <text>", "Purpose of this context packet", "external software-agent work context")
  .option("--budget <chars>", "Maximum packet size in characters", "12000")
  .option("--json", "Print raw JSON")
  .action(async (opts) => {
    try {
      const packet = await buildWorkMemoryContext({
        workdir: opts.workdir || process.cwd(),
        agentName: opts.name,
        purpose: opts.purpose,
        budget: parsePositiveIntCliOption(opts.budget, "--budget"),
      });
      if (opts.json) {
        console.log(JSON.stringify(packet, null, 2));
        return;
      }
      process.stdout.write(packet.text);
      if (!packet.text.endsWith("\n")) process.stdout.write("\n");
    } catch (error) {
      console.error(error instanceof Error ? error.message : String(error));
      process.exit(1);
    }
  });

program
  .command("work-note")
  .description("Append a note to Akemon work memory")
  .argument("<text...>", "Durable work-memory note")
  .option("-w, --workdir <path>", "Akemon workdir (default: cwd)")
  .option("-n, --name <name>", "Agent name", "my-agent")
  .option("--source <source>", "Note source, e.g. user, codex, or claude-code", "user")
  .option("--session <id>", "External or Akemon-side session id")
  .option("--kind <kind>", "Work-memory kind, e.g. note, decision, command, project", "note")
  .option("--target <path>", "Optional target file under the work memory directory")
  .option("--json", "Print raw JSON")
  .action(async (textParts: string[], opts) => {
    try {
      const result = await appendWorkMemoryNote({
        workdir: opts.workdir || process.cwd(),
        agentName: opts.name,
        text: textParts.join(" "),
        source: opts.source,
        sessionId: opts.session,
        kind: opts.kind,
        target: opts.target,
      });
      if (opts.json) {
        console.log(JSON.stringify(result, null, 2));
        return;
      }
      console.log(`Work memory note appended: ${result.note.id}`);
      console.log(`Path: ${result.path}`);
    } catch (error) {
      console.error(error instanceof Error ? error.message : String(error));
      process.exit(1);
    }
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
