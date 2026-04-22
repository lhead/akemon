/**
 * EnginePeripheral — wraps LLM engine execution behind the Peripheral interface.
 *
 * Step 3 of V2 refactor: extract runEngine/runRawEngine/buildEngineCommand/
 * RAW_TOOLS/executeRawTool from server.ts into a single, testable adapter.
 *
 * Supports two paths:
 *   - CLI engines (claude, codex, opencode, gemini): spawn child process
 *   - Raw engine: OpenAI-compatible API with tool call loop (Ollama, llama.cpp, etc)
 */

import { spawn, exec, type ChildProcess } from "child_process";
import { readFile, writeFile, mkdir } from "fs/promises";
import { join, dirname, isAbsolute } from "path";
import { callAgent } from "./relay-client.js";
import type { Peripheral, Signal, EventBus } from "./types.js";
import { SIG, sig } from "./types.js";
import { updateMetrics, pushExecMs } from "./metrics.js";
import { sendFailureEvent } from "./relay-client.js";
import {
  type Origin,
  type EngineRouting,
  type EngineRoutingEntry,
  resolveEngineConfig,
} from "./engine-routing.js";

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

export interface EngineConfig {
  engine: string;               // "claude" | "codex" | "opencode" | "gemini" | "raw" | custom
  model?: string;
  workdir: string;
  allowAll?: boolean;

  // Raw engine settings
  rawApiUrl?: string;           // default: http://localhost:11434/v1
  rawApiKey?: string;
  rawMaxRounds?: number;        // default: 20

  // Relay info for raw engine tools (ask_agent, discover_agents)
  relay?: { http: string; agentName: string };
}

export const LLM_ENGINES = new Set(["claude", "codex", "opencode", "gemini", "raw"]);

// ---------------------------------------------------------------------------
// EnginePeripheral
// ---------------------------------------------------------------------------

export class EnginePeripheral implements Peripheral {
  id: string;
  name: string;
  capabilities = ["text-in", "text-out"];
  tags = ["engine", "llm"];

  private config: EngineConfig;
  private bus: EventBus | null = null;

  /** Last execution trace (for error reporting) */
  lastTrace: any[] = [];

  /** Active CLI child processes — tracked so SIGTERM handler can kill them. */
  private activeChildren = new Set<ChildProcess>();

  /**
   * Send SIGKILL to all active child process groups. Called during daemon shutdown.
   *
   * NOTE: sends SIGKILL directly (no SIGTERM grace) — safe for stateless
   * request/response CLIs. Must change to SIGTERM+3s+SIGKILL when Batch 5.1
   * persistent-session mode lands (sessions need graceful teardown).
   */
  killAllChildren(): void {
    for (const child of this.activeChildren) {
      if (!child.pid) continue;
      console.log(`[engine] shutdown: killing pgid=-${child.pid}`);
      try { process.kill(-child.pid, "SIGKILL"); } catch {}
    }
    this.activeChildren.clear();
  }

  constructor(config: EngineConfig) {
    this.config = config;
    this.id = `engine:${config.engine}`;
    this.name = config.engine === "raw" ? "Local Raw Engine" : `${config.engine} CLI`;
  }

  get connected(): boolean {
    return true; // engines are always "available"
  }

  async start(bus: EventBus): Promise<void> {
    this.bus = bus;
  }

  async stop(): Promise<void> {
    this.bus = null;
  }

  /**
   * Send a prompt signal, receive a response signal.
   *
   * Input signal.data:
   *   - task: string (the prompt)
   *   - allowAll?: boolean
   *   - extraAllowedTools?: string[]
   *
   * Output signal.data:
   *   - output: string (the response)
   *   - trace: any[] (execution trace)
   */
  async send(signal: Signal): Promise<Signal | null> {
    if (signal.type !== SIG.ENGINE_PROMPT) return null;

    const { task, allowAll, extraAllowedTools } = signal.data as {
      task: string;
      allowAll?: boolean;
      extraAllowedTools?: string[];
    };
    if (!task) return null;

    const output = await this.runEngine(
      task as string,
      allowAll as boolean | undefined,
      extraAllowedTools as string[] | undefined,
    );

    return sig(SIG.ENGINE_RESPONSE, {
      output,
      engine: this.config.engine,
      model: this.config.model,
      trace: this.lastTrace,
    }, this.id);
  }

  // ---------------------------------------------------------------------------
  // Unified engine runner
  // ---------------------------------------------------------------------------

  async runEngine(
    task: string,
    allowAll?: boolean,
    extraAllowedTools?: string[],
    signal?: AbortSignal,
    origin?: Origin,
    routing?: EngineRouting,
  ): Promise<string> {
    const entry = resolveEngineConfig(routing, origin);
    const cfg = entry ? applyRoutingEntry(this.config, entry) : this.config;
    if (origin && entry) {
      console.log(`[engine] using ${cfg.engine}${cfg.model ? `/${cfg.model}` : ""} (origin=${origin})`);
    }
    const t0 = Date.now();
    try {
      if (cfg.engine === "raw") {
        return await this.runRawEngine(task, cfg);
      }
      const cmd = buildEngineCommand(cfg.engine, cfg.model, allowAll ?? cfg.allowAll, extraAllowedTools);
      return await runCommand(cmd.cmd, cmd.args, task, cfg.workdir, cmd.stdinMode, signal, this.activeChildren);
    } finally {
      pushExecMs(Date.now() - t0);
    }
  }

  // ---------------------------------------------------------------------------
  // Raw engine: OpenAI-compatible API with tool call loop
  // ---------------------------------------------------------------------------

  private async runRawEngine(task: string, cfg: EngineConfig = this.config): Promise<string> {
    const apiUrl = (cfg.rawApiUrl || "http://localhost:11434/v1") + "/chat/completions";
    const modelName = cfg.model || "gemma4:4b";
    const maxRounds = cfg.rawMaxRounds || 20;
    const apiKey = cfg.rawApiKey || "";

    console.log(`[raw] Task:\n${task}`);

    const trace: any[] = [];
    this.lastTrace = trace;

    const wantsJson = /output ONLY.*json|reply ONLY.*json|respond.*ONLY.*json/i.test(task);

    const messages: any[] = [
      { role: "system", content: wantsJson
        ? "You are a helpful agent. Output valid JSON only. No explanations, no markdown, just the JSON object."
        : "You are a helpful agent. Use tools when needed to complete the task. When done, reply with your final answer in plain text." },
      { role: "user", content: task },
    ];

    for (let round = 0; round < maxRounds; round++) {
      const body: any = { model: modelName, messages, tools: wantsJson ? undefined : RAW_TOOLS };
      if (wantsJson) {
        body.response_format = { type: "json_object" };
      }

      let data: any;
      try {
        const headers: Record<string, string> = { "Content-Type": "application/json" };
        if (apiKey) headers["Authorization"] = `Bearer ${apiKey}`;
        const res = await fetch(apiUrl, {
          method: "POST",
          headers,
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

      if (msg.tool_calls && msg.tool_calls.length > 0) {
        for (const tc of msg.tool_calls) {
          const fnName = tc.function.name;
          let fnArgs: any;
          let parseError = false;
          try {
            fnArgs = typeof tc.function.arguments === "string"
              ? JSON.parse(tc.function.arguments)
              : tc.function.arguments;
          } catch {
            fnArgs = {};
            parseError = true;
          }

          console.log(`[raw] Tool call: ${fnName}(${JSON.stringify(fnArgs).slice(0, 100)})${parseError ? " [BAD ARGS]" : ""}`);

          let result: string;
          if (parseError) {
            result = `[error] Your tool call arguments were malformed (not valid JSON). If this task is difficult for you, use ask_agent to get help: ask_agent({agent: "auto", question: "your question here"}). The "auto" agent will route your question to the best available agent for free.`;
            trace.push({ role: "tool_error", name: fnName, raw_args: String(tc.function.arguments).slice(0, 500), guidance: "delegation suggested" });
          } else {
            result = await this.executeRawTool(fnName, fnArgs);
            trace.push({ role: "tool_call", name: fnName, args: fnArgs, result: result.slice(0, 2000) });
          }
          messages.push({
            role: "tool",
            tool_call_id: tc.id,
            content: result,
          });
        }
        continue;
      }

      const content = msg.content || "";
      if (content.trim()) {
        console.log(`[raw] Done in ${round + 1} round(s), response:\n${content}`);
        trace.push({ role: "assistant", content: content.trim().slice(0, 4000) });
        return content.trim();
      }
    }

    throw new Error(`Raw engine exceeded ${maxRounds} rounds without final answer`);
  }

  // ---------------------------------------------------------------------------
  // Raw engine tool execution
  // ---------------------------------------------------------------------------

  private async executeRawTool(name: string, args: any): Promise<string> {
    const workdir = this.config.workdir;
    const relay = this.config.relay;
    const resolvePath = (p: string) => isAbsolute(p) ? p : join(workdir, p);

    try {
      switch (name) {
        case "read_file": {
          return await readFile(resolvePath(args.path), "utf-8");
        }
        case "write_file": {
          const fp = resolvePath(args.path);
          await mkdir(dirname(fp), { recursive: true });
          await writeFile(fp, args.content);
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
          return text.length > 8192 ? text.slice(0, 8192) + "\n...[truncated]" : text;
        }
        case "ask_agent": {
          if (!relay) return "[error] No relay configured";
          const target = args.agent || "auto";
          const question = args.question || "";
          try {
            const result = await callAgent(target, question);
            return result || "[no response]";
          } catch (err: any) {
            return `[error] Agent "${target}" did not respond: ${err.message}. Try asking "auto" which routes to the best available agent.`;
          }
        }
        case "discover_agents": {
          if (!relay) return "[error] No relay configured";
          try {
            const url = args.tag
              ? `${relay.http}/v1/agents?online=true&public=true&tag=${encodeURIComponent(args.tag)}`
              : `${relay.http}/v1/agents?online=true&public=true`;
            const res = await fetch(url, { signal: AbortSignal.timeout(5000) });
            const agents: any[] = await res.json() as any[];
            const others = agents.filter((a: any) => a.name !== relay.agentName);
            if (!others.length) return "No other agents are online right now.";
            return others.map((a: any) =>
              `- ${a.name} [${a.engine}] ${a.description || ""} (${a.tags?.join(",") || "no tags"})`
            ).join("\n");
          } catch {
            return "[error] Could not reach relay";
          }
        }
        default:
          return `Unknown tool: ${name}`;
      }
    } catch (err: any) {
      return `[error] ${err.message}`;
    }
  }
}

// ---------------------------------------------------------------------------
// Raw engine tool definitions (OpenAI function calling format)
// ---------------------------------------------------------------------------

export const RAW_TOOLS = [
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
  {
    type: "function" as const,
    function: {
      name: "ask_agent",
      description: "Ask another agent a question for free. Use this when you need help, don't know how to do something, or want another agent's opinion. This is FREE — no credits are charged.",
      parameters: {
        type: "object",
        properties: {
          agent: { type: "string", description: "Agent name to ask (use 'auto' for auto-routing to the best available agent)" },
          question: { type: "string", description: "Your question or request" },
        },
        required: ["agent", "question"],
      },
    },
  },
  {
    type: "function" as const,
    function: {
      name: "discover_agents",
      description: "List online agents you can ask for help. Returns agent names, descriptions, and specialties.",
      parameters: {
        type: "object",
        properties: {
          tag: { type: "string", description: "Optional tag to filter by (e.g. 'coding', 'writing')" },
        },
      },
    },
  },
];

// ---------------------------------------------------------------------------
// CLI engine helpers (shared, non-class)
// ---------------------------------------------------------------------------

/**
 * Build a local EngineConfig copy that merges in a routing entry's overrides.
 * Resolves rawApiKeyEnv → rawApiKey from environment at call time.
 * Never mutates the base config.
 */
function applyRoutingEntry(base: EngineConfig, entry: EngineRoutingEntry): EngineConfig {
  const override: Partial<EngineConfig> = { engine: entry.engine };
  if (entry.model !== undefined) override.model = entry.model ?? undefined;
  if (entry.rawApiUrl !== undefined) override.rawApiUrl = entry.rawApiUrl;
  if (entry.rawMaxRounds !== undefined) override.rawMaxRounds = entry.rawMaxRounds;
  if (entry.allowAll !== undefined) override.allowAll = entry.allowAll;
  if (entry.rawApiKeyEnv) override.rawApiKey = process.env[entry.rawApiKeyEnv] ?? "";
  return { ...base, ...override };
}

function buildEngineCommand(
  engine: string,
  model?: string,
  allowAll?: boolean,
  extraAllowedTools?: string[],
): { cmd: string; args: string[]; stdinMode: boolean } {
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
      return { cmd: "opencode", args, stdinMode: false };
    }
    case "gemini":
      return { cmd: "gemini", args: ["-p"], stdinMode: false };
    default:
      return { cmd: engine, args: [], stdinMode: true };
  }
}

function runCommand(
  cmd: string,
  args: string[],
  task: string,
  cwd: string,
  stdinMode: boolean = true,
  signal?: AbortSignal,
  activeChildren?: Set<ChildProcess>,
): Promise<string> {
  return new Promise((resolve, reject) => {
    const { CLAUDECODE, ...cleanEnv } = process.env;
    const finalArgs = stdinMode ? args : [...args, task];
    console.log(`[engine] Running: ${cmd} ${finalArgs.join(" ")}`);
    const child = spawn(cmd, finalArgs, {
      cwd,
      env: cleanEnv,
      stdio: [stdinMode ? "pipe" : "ignore", "pipe", "pipe"],
      detached: true,  // child becomes process-group leader; enables pgid kill
    });
    if (activeChildren) {
      activeChildren.add(child);
      updateMetrics({ engine_children_active: activeChildren.size });
    }

    // Abort → SIGTERM to process group, then SIGKILL after grace period.
    // Using -pid (negative) sends the signal to the entire process group,
    // so any sub-forks spawned by the CLI are also terminated.
    let aborted = false;
    const onAbort = () => {
      if (aborted || !child.pid) return;
      aborted = true;
      console.log(`[${cmd}] aborted, killing pgid=-${child.pid}`);
      sendFailureEvent("engine_abort", cmd, "engine subprocess aborted via signal");
      try { process.kill(-child.pid, "SIGTERM"); } catch {}
      setTimeout(() => {
        try { process.kill(-child.pid!, "SIGKILL"); } catch {}
      }, 3000).unref();
    };
    if (signal) {
      if (signal.aborted) onAbort();
      else signal.addEventListener("abort", onAbort, { once: true });
    }

    if (stdinMode && child.stdin) {
      child.stdin.on("error", () => {});
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

    child.on("close", (code, killSignal) => {
      signal?.removeEventListener("abort", onAbort);
      if (activeChildren) {
        activeChildren.delete(child);
        updateMetrics({ engine_children_active: activeChildren.size });
      }
      child.unref();
      console.log(`[${cmd}] exit=${code}${killSignal ? ` signal=${killSignal}` : ""} stdout=${stdout.length}b stderr=${stderr.length}b`);
      if (stderr) console.log(`[${cmd}] stderr:\n${stderr}`);
      if (stdout) console.log(`[${cmd}] stdout:\n${stdout}`);
      if (aborted) {
        reject(new Error(`${cmd} aborted`));
        return;
      }
      const output = stdout.trim();
      if (output) {
        resolve(output);
      } else {
        reject(new Error(`${cmd} exited with code ${code}, no stdout`));
      }
    });

    child.on("error", (err) => {
      signal?.removeEventListener("abort", onAbort);
      if (activeChildren) {
        activeChildren.delete(child);
        updateMetrics({ engine_children_active: activeChildren.size });
      }
      child.unref();
      reject(err);
    });
  });
}
