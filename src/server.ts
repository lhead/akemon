import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { exec } from "child_process";
import { scanAndKillOrphans } from "./orphan-scan.js";
import { createServer, type IncomingMessage, type ServerResponse } from "http";
import { createInterface } from "readline";
import { mkdir } from "fs/promises";
import { join } from "path";
import {
  initWorld, initBioState, initGuide,
  getSelfState, loadRecentCanvasEntries,
  initAgentConfig, loadAgentConfig,
  loadDirectives,
  loadTaskHistory,
  reviveAgent,
} from "./self.js";

// V2: module-level instances (set in serve())
let _engineP: EnginePeripheral | null = null;
let _bus: import("./types.js").EventBus | null = null;

// Engine mutual exclusion — priority queue so modules can't starve each other
const engineQueue = new EngineQueue();
let lastEngineTrace: any[] = [];

// How long a caller will wait for the engine slot before giving up.
const ENGINE_WAIT_DEADLINE_MS = 5 * 60 * 1000;
// Hard cap on a single engine run. Beyond this the subprocess is aborted so
// the slot is returned to the queue. Shorter than the old 8 min — opencode
// runs that take longer almost always hang forever.
const ENGINE_EXEC_TIMEOUT_MS = 3 * 60 * 1000;


// ---------------------------------------------------------------------------
// V2 Event helpers — emit signals to EventBus
// ---------------------------------------------------------------------------

function emitTaskCompleted(success: boolean, taskLabel?: string, creditsEarned?: number): void {
  if (_bus) {
    _bus.emit(SIG.TASK_COMPLETED, sig(SIG.TASK_COMPLETED, {
      success, taskLabel: taskLabel || "", creditsEarned: creditsEarned || 0,
    }));
  }
}

function emitTokenUsage(promptLen: number, resultLen: number, tokenLimit = 0): void {
  if (_bus) {
    _bus.emit(SIG.ENGINE_RESPONSE, sig(SIG.ENGINE_RESPONSE, {
      promptLen, resultLen, tokenLimit,
    }));
  }
}

// V2: TaskModule ref for push notifications
let _taskModule: TaskModule | null = null;

export function onOrderNotify(orderId: string): void {
  if (_taskModule) _taskModule.onUrgentOrder(orderId);
}

// runCommand and buildEngineCommand moved to engine-peripheral.ts (V2 Step 3)

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

function bearerToken(req: IncomingMessage): string | null {
  const auth = req.headers["authorization"];
  return auth?.startsWith("Bearer ") ? auth.slice(7) : null;
}

function isOwnerRequest(req: IncomingMessage, options: Pick<ServeOptions, "secretKey" | "key">): boolean {
  const token = bearerToken(req);
  const validTokens = [options.secretKey, options.key].filter(Boolean);
  return !!token && validTokens.includes(token);
}

function readJsonBody(req: IncomingMessage, maxBytes = 256 * 1024): Promise<any> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > maxBytes) {
        reject(new Error(`Request body too large (max ${maxBytes} bytes)`));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => {
      const raw = Buffer.concat(chunks).toString("utf-8").trim();
      if (!raw) {
        resolve({});
        return;
      }
      try { resolve(JSON.parse(raw)); }
      catch { reject(new Error("Invalid JSON body")); }
    });
    req.on("error", reject);
  });
}

export async function handleSoftwareAgentRunHttp(
  req: IncomingMessage,
  res: ServerResponse,
  deps: {
    options: Pick<ServeOptions, "secretKey" | "key">;
    workdir: string;
    softwareAgent: Pick<CodexSoftwareAgentPeripheral, "sendTask"> | null;
  },
): Promise<void> {
  if (!isOwnerRequest(req, deps.options)) {
    res.writeHead(401, { "Content-Type": "application/json" })
      .end(JSON.stringify({ error: "Owner token required" }));
    return;
  }
  if (!deps.softwareAgent) {
    res.writeHead(503, { "Content-Type": "application/json" })
      .end(JSON.stringify({ error: "Software agent peripheral not ready" }));
    return;
  }

  let body: any;
  try {
    body = await readJsonBody(req);
  } catch (err: any) {
    res.writeHead(400, { "Content-Type": "application/json" })
      .end(JSON.stringify({ error: err.message || "Invalid request body" }));
    return;
  }

  let envelope;
  try {
    envelope = createOwnerTaskEnvelope(body, deps.workdir);
  } catch (err: any) {
    res.writeHead(400, { "Content-Type": "application/json" })
      .end(JSON.stringify({ error: err.message || "Invalid software-agent envelope" }));
    return;
  }

  try {
    const result = await deps.softwareAgent.sendTask(envelope);
    res.writeHead(result.success ? 200 : 500, { "Content-Type": "application/json" })
      .end(JSON.stringify(result, null, 2));
  } catch (err: any) {
    const busy = String(err.message || "").includes("busy");
    res.writeHead(busy ? 409 : 500, { "Content-Type": "application/json" })
      .end(JSON.stringify({ error: err.message || String(err) }));
  }
}

export async function handleSoftwareAgentStatusHttp(
  req: IncomingMessage,
  res: ServerResponse,
  deps: {
    options: Pick<ServeOptions, "secretKey" | "key">;
    softwareAgent: Pick<CodexSoftwareAgentPeripheral, "getState"> | null;
  },
): Promise<void> {
  if (!isOwnerRequest(req, deps.options)) {
    res.writeHead(401, { "Content-Type": "application/json" })
      .end(JSON.stringify({ error: "Owner token required" }));
    return;
  }
  if (!deps.softwareAgent) {
    res.writeHead(503, { "Content-Type": "application/json" })
      .end(JSON.stringify({ error: "Software agent peripheral not ready" }));
    return;
  }

  res.writeHead(200, { "Content-Type": "application/json" })
    .end(JSON.stringify(deps.softwareAgent.getState(), null, 2));
}

export async function handleSoftwareAgentResetHttp(
  req: IncomingMessage,
  res: ServerResponse,
  deps: {
    options: Pick<ServeOptions, "secretKey" | "key">;
    softwareAgent: Pick<CodexSoftwareAgentPeripheral, "getState" | "resetSession"> | null;
  },
): Promise<void> {
  if (!isOwnerRequest(req, deps.options)) {
    res.writeHead(401, { "Content-Type": "application/json" })
      .end(JSON.stringify({ error: "Owner token required" }));
    return;
  }
  if (!deps.softwareAgent) {
    res.writeHead(503, { "Content-Type": "application/json" })
      .end(JSON.stringify({ error: "Software agent peripheral not ready" }));
    return;
  }

  try {
    await deps.softwareAgent.resetSession();
    res.writeHead(200, { "Content-Type": "application/json" })
      .end(JSON.stringify({ ok: true, state: deps.softwareAgent.getState() }, null, 2));
  } catch (err: any) {
    res.writeHead(500, { "Content-Type": "application/json" })
      .end(JSON.stringify({ error: err.message || String(err) }));
  }
}

import { RelayPeripheral } from "./relay-peripheral.js";
import { EnginePeripheral, LLM_ENGINES as LLM_ENGINES_SET } from "./engine-peripheral.js";
import { EngineQueue } from "./engine-queue.js";
import { BioStateModule } from "./bio-module.js";
import { MemoryModule } from "./memory-module.js";
import { RoleModule } from "./role-module.js";
import { TaskModule } from "./task-module.js";
import { SocialModule } from "./social-module.js";
import { LongTermModule } from "./longterm-module.js";
import { ReflectionModule } from "./reflection-module.js";
import { ScriptModule } from "./script-module.js";
import { FileEventLog, PersistentEventBus } from "./event-bus.js";
import { CodexSoftwareAgentPeripheral, createOwnerTaskEnvelope } from "./software-agent-peripheral.js";
import { SIG, sig } from "./types.js";
import type { ComputeRequest, ComputeResult, Peripheral } from "./types.js";
import { ServeOptions, loadConversation, listConversations, buildLLMContext, resolveConvId } from "./context.js";
export type { ServeOptions } from "./context.js";

import { createMcpServer, initMcpProxy, createMcpProxyServer } from "./mcp-server.js";
import type { McpDeps, McpServerOptions, McpProxyState } from "./mcp-server.js";
import { autoRoute, runCollaborativeQuery } from "./agent-utils.js";

// createMcpServer, initMcpProxy, createMcpProxyServer → see mcp-server.ts
const LLM_ENGINES = LLM_ENGINES_SET;

// ---------------------------------------------------------------------------
// Engine execution — delegates to EnginePeripheral (V2 Step 3)
// ---------------------------------------------------------------------------

/** Unified engine runner — delegates to EnginePeripheral */
function runEngine(
  engine: string,
  model: string | undefined,
  allowAll: boolean | undefined,
  task: string,
  workdir: string,
  extraAllowedTools?: string[],
  relay?: { http: string; agentName: string },
  signal?: AbortSignal,
  origin?: import("./engine-routing.js").Origin,
  routing?: import("./engine-routing.js").EngineRouting,
  taskId?: string,
): Promise<string> {
  if (!_engineP) {
    throw new Error("Engine peripheral not initialized");
  }
  const result = _engineP.runEngine(task, allowAll, extraAllowedTools, signal, origin, routing, taskId);
  // Sync trace back to module-level for reporting
  result.then(() => { lastEngineTrace = _engineP!.lastTrace; }).catch(() => { lastEngineTrace = _engineP!.lastTrace; });
  return result;
}

// trackTokenUsage moved to BioStateModule via EventBus (V2 Step 6)
// pullFromRelay → see relay-peripheral.ts
export async function serve(options: ServeOptions): Promise<void> {
  const workdir = options.workdir || process.cwd();

  // Reclaim stale CLI children from any previous daemon crash before starting.
  await scanAndKillOrphans();

  // V2: Relay peripheral — unified relay API access
  const relay = new RelayPeripheral({
    httpUrl: options.relayHttp || "",
    secretKey: options.secretKey || "",
    agentName: options.agentName,
  });

  // V2: Engine peripheral — unified engine execution
  const engineP = new EnginePeripheral({
    engine: options.engine || "claude",
    model: options.model,
    workdir,
    allowAll: options.allowAll,
    rawApiUrl: process.env.AKEMON_RAW_URL,
    rawApiKey: process.env.AKEMON_RAW_KEY,
    rawMaxRounds: 20,
    relay: options.relayHttp ? { http: options.relayHttp, agentName: options.agentName } : undefined,
  });

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

  // Build deps for MCP server
  const mcpDeps: McpDeps = {
    runEngine,
    runTerminal,
    promptOwner,
    runCollaborativeQuery: (task, selfName, relayHttp, engine, model, allowAll, workdir, relay?) =>
      runCollaborativeQuery(task, selfName, relayHttp, engine, model, allowAll, workdir, runEngine, relay),
    autoRoute,
    isEngineBusy: () => engineQueue.isBusy(),
    setEngineBusy: (busy: boolean) => {
      if (busy) engineQueue.tryAcquire();
      else engineQueue.release();
    },
    emitTaskCompleted,
  };

  let codexSoftwareAgent: CodexSoftwareAgentPeripheral | null = null;

  const httpServer = createServer(async (req, res) => {
    // Suppress noisy polling endpoints from log
    const isQuiet = req.url === "/self/state" || req.url?.startsWith("/self/state?");
    if (!isQuiet) console.log(`[http] ${req.method} ${req.url} session=${req.headers["mcp-session-id"] || "none"}`);

    try {
      if (req.url === "/self/software-agent/run" && req.method === "POST") {
        await handleSoftwareAgentRunHttp(req, res, {
          options,
          workdir,
          softwareAgent: codexSoftwareAgent,
        });
        return;
      }
      if (req.url === "/self/software-agent/status" && req.method === "GET") {
        await handleSoftwareAgentStatusHttp(req, res, {
          options,
          softwareAgent: codexSoftwareAgent,
        });
        return;
      }
      if (req.url === "/self/software-agent/reset" && req.method === "POST") {
        await handleSoftwareAgentResetHttp(req, res, {
          options,
          softwareAgent: codexSoftwareAgent,
        });
        return;
      }

      // Auth check
      if (options.key) {
        const token = bearerToken(req);
        if (token !== options.key) {
          console.log(`[http] Unauthorized (bad or missing token)`);
          res.writeHead(401, { "Content-Type": "application/json" })
            .end(JSON.stringify({ error: "Unauthorized" }));
          return;
        }
      }

      // Live — agent life visualization
      if ((req.url === "/live" || req.url === "/live/") && req.method === "GET") {
        try {
          const { readFile: rf } = await import("fs/promises");
          const { fileURLToPath } = await import("url");
          const { dirname, join: pjoin } = await import("path");
          const __filename = fileURLToPath(import.meta.url);
          const __dirname = dirname(__filename);
          let html: string;
          try { html = await rf(pjoin(__dirname, "live.html"), "utf-8"); }
          catch { html = await rf(pjoin(__dirname, "..", "src", "live.html"), "utf-8"); }
          res.writeHead(200, { "Content-Type": "text/html" }).end(html);
        } catch (err: any) {
          res.writeHead(500).end("Live page not found: " + err.message);
        }
        return;
      }

      // Self-state API (no auth required for local monitoring)
      if (req.url === "/self/state" && req.method === "GET") {
        const state = await getSelfState(workdir, options.agentName) as any;
        // Enrich with credits from relay (best-effort)
        if (relay.connected) {
          try {
            const agents = await relay.listAgents({ online: true, public: true });
            const self = agents.find((a: any) => a.name === options.agentName);
            state.credits = self?.credits ?? 0;
            state.level = self?.level ?? 0;
          } catch { state.credits = null; }
        }
        res.writeHead(200, { "Content-Type": "application/json" }).end(JSON.stringify(state, null, 2));
        return;
      }
      // Revive endpoint — owner brings a forced-offline agent back
      if (req.url === "/self/revive" && req.method === "POST") {
        await reviveAgent(workdir, options.agentName);
        res.writeHead(200, { "Content-Type": "application/json" }).end(JSON.stringify({ ok: true, message: "Agent revived. Energy=50, Hunger=50." }));
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
      if (req.url === "/self/conversations" && req.method === "GET") {
        const list = await listConversations(workdir, options.agentName);
        res.writeHead(200, { "Content-Type": "application/json" }).end(JSON.stringify(list, null, 2));
        return;
      }
      if (req.url?.startsWith("/self/conversation/") && req.method === "GET") {
        const convId = decodeURIComponent(req.url.slice("/self/conversation/".length));
        if (!convId) { res.writeHead(400).end("Missing conversation ID"); return; }
        const conv = await loadConversation(workdir, options.agentName, convId);
        const config = await loadAgentConfig(workdir, options.agentName);
        const budget = config.context_budget ?? 4096;
        const { recentStartIndex } = buildLLMContext(conv, budget);
        res.writeHead(200, { "Content-Type": "application/json" }).end(JSON.stringify({
          summary: conv.summary,
          rounds: conv.rounds,
          recentStartIndex,
        }, null, 2));
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
          relay,
        }, mcpDeps);
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
    relay.pullFromRelay(workdir, options.agentName).catch(err =>
      console.log(`[sync] Pull from relay failed: ${err}`)
    );
  }

  // V2: Shared module context + persistent EventBus.
  // This is the durable spine for module/peripheral/engine activity; recovery
  // side effects are intentionally deferred until the event schema stabilizes.
  const eventLogDir = join(workdir, ".akemon", "agents", options.agentName, "events");
  await mkdir(eventLogDir, { recursive: true });
  const eventLogPath = join(eventLogDir, "events.jsonl");
  const bus = new PersistentEventBus(new FileEventLog(eventLogPath));
  console.log(`[v2] Event log: ${eventLogPath}`);

  codexSoftwareAgent = new CodexSoftwareAgentPeripheral({
    workdir,
    model: process.env.AKEMON_CODEX_MODEL,
    sandbox: "workspace-write",
  });
  await codexSoftwareAgent.start(bus);

  // Peripheral registry — Core routes by capability
  const peripherals: Peripheral[] = [relay, engineP, codexSoftwareAgent];

  // requestCompute: acquire the engine slot (priority-aware), execute with a
  // hard timeout, and release. The slot release and subprocess kill are both
  // driven by the same AbortController so a stuck engine can't hold the lock.
  async function requestCompute(req: ComputeRequest): Promise<ComputeResult> {
    // Load latest agent config for routing table (fast file read, changes rarely)
    const agentCfg = await loadAgentConfig(workdir, options.agentName);
    const routing = agentCfg.engine_routing;

    // user_manual tasks also hold a subscription-CLI semaphore to cap claude CLI concurrency
    const isUserManual = req.origin === "user_manual";
    if (isUserManual) {
      try {
        await engineQueue.acquireUserManualSlot(ENGINE_WAIT_DEADLINE_MS);
      } catch (err: any) {
        return { success: false, error: err.message || "User manual slot timeout" };
      }
    }

    try {
      await engineQueue.acquire(req.priority, ENGINE_WAIT_DEADLINE_MS);
    } catch (err: any) {
      if (isUserManual) engineQueue.releaseUserManualSlot();
      return { success: false, error: err.message || "Engine busy timeout" };
    }

    const prompt = req.context
      ? `${req.context}\n\n---\n\n${req.question}`
      : req.question;

    const abortController = new AbortController();
    const timer = setTimeout(() => abortController.abort(), ENGINE_EXEC_TIMEOUT_MS);

    try {
      const response = await runEngine(
        options.engine || "claude",
        options.model,
        options.allowAll,
        prompt,
        workdir,
        req.tools,
        req.relay,
        abortController.signal,
        req.origin,
        routing,
        req.taskId,
      );
      emitTokenUsage(prompt.length, response.length);
      return { success: true, response };
    } catch (err: any) {
      const msg = abortController.signal.aborted
        ? `Engine execution timeout (${Math.round(ENGINE_EXEC_TIMEOUT_MS / 60000)} min)`
        : (err.message || String(err));
      return { success: false, error: msg };
    } finally {
      clearTimeout(timer);
      engineQueue.release();
      if (isUserManual) engineQueue.releaseUserManualSlot();
    }
  }

  const moduleCtx = {
    bus,
    agentName: options.agentName,
    workdir,
    getPeripherals: (capability: string) =>
      peripherals.filter(p => p.capabilities.includes(capability)),
    sendTo: async (capability: string, signal: import("./types.js").Signal) => {
      const p = peripherals.find(p => p.capabilities.includes(capability));
      return p ? p.send(signal) : null;
    },
    requestCompute,
    getPromptContributions: () => {
      const contributions: string[] = [];
      for (const m of allModules) {
        if (m.promptContribution) {
          const c = m.promptContribution();
          if (c) contributions.push(c);
        }
      }
      return contributions;
    },
  };

  // V2: Conditionally load modules based on --with/--without
  const enabled = options.enabledModules ?? ["biostate", "memory", "role", "task", "social", "longterm", "reflection", "script"];
  const loadedModules: string[] = [];
  const allModules: import("./types.js").Module[] = [];

  if (enabled.includes("biostate")) {
    const bioModule = new BioStateModule();
    await bioModule.start(moduleCtx);
    options.bioModule = bioModule;
    allModules.push(bioModule);
    loadedModules.push("biostate");
  }

  if (enabled.includes("memory")) {
    const memoryModule = new MemoryModule();
    if (options.cycleInterval) memoryModule.cycleIntervalMs = options.cycleInterval * 60 * 1000;
    await memoryModule.start(moduleCtx);
    options.memoryModule = memoryModule;
    allModules.push(memoryModule);
    loadedModules.push("memory");
  }

  if (enabled.includes("role")) {
    const roleModule = new RoleModule();
    await roleModule.start(moduleCtx);
    allModules.push(roleModule);
    loadedModules.push("role");
  }

  if (enabled.includes("task")) {
    const taskModule = new TaskModule();
    taskModule.relayHttp = options.relayHttp || "";
    taskModule.secretKey = options.secretKey || "";
    taskModule.engine = options.engine || "";
    taskModule.model = options.model;
    taskModule.allowAll = options.allowAll;
    taskModule.notifyUrl = options.notifyUrl;
    await taskModule.start(moduleCtx);
    _taskModule = taskModule;
    allModules.push(taskModule);
    loadedModules.push("task");
  }

  if (enabled.includes("social")) {
    const socialModule = new SocialModule();
    await socialModule.start(moduleCtx);
    allModules.push(socialModule);
    loadedModules.push("social");
  }

  if (enabled.includes("longterm")) {
    const longtermModule = new LongTermModule();
    await longtermModule.start(moduleCtx);
    allModules.push(longtermModule);
    loadedModules.push("longterm");
  }

  if (enabled.includes("reflection")) {
    const reflectionModule = new ReflectionModule();
    await reflectionModule.start(moduleCtx);
    allModules.push(reflectionModule);
    loadedModules.push("reflection");
  }

  if (enabled.includes("script")) {
    const scriptModule = new ScriptModule();
    scriptModule.scriptName = options.scriptName || "daily-life";
    scriptModule.relayHttp = options.relayHttp || "";
    scriptModule.secretKey = options.secretKey || "";
    await scriptModule.start(moduleCtx);
    allModules.push(scriptModule);
    loadedModules.push("script");
  }

  console.log(`[v2] Modules: ${loadedModules.join(", ") || "(none)"}`);

  // Inject peripherals into options
  options.relay = relay;
  options.enginePeripheral = engineP;
  _engineP = engineP;
  _bus = bus;

  // V2: Emit agent start lifecycle event
  bus.emit(SIG.AGENT_START, sig(SIG.AGENT_START, {
    agentName: options.agentName,
    engine: options.engine,
    modules: loadedModules,
  }));

  // Graceful shutdown — kill engine children first, then stop modules.
  // Engine children are killed via process group signal so any sub-forks
  // (e.g. opencode's internal Node workers) are also terminated.
  const shutdown = async () => {
    console.log("[v2] Shutting down...");
    if (_engineP) _engineP.killAllChildren();
    bus.emit(SIG.AGENT_STOP, sig(SIG.AGENT_STOP, {}));
    for (const m of allModules) {
      try { await m.stop(); } catch {}
    }
    try { await codexSoftwareAgent?.stop(); } catch {}
    bus.getLog().close();
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);

  await new Promise<void>((_, reject) => {
    httpServer.on("error", reject);
  });
}

export async function serveStdio(agentName: string, workdir?: string): Promise<void> {
  const dir = workdir || process.cwd();
  const stdioMcpDeps: McpDeps = {
    runEngine,
    runTerminal,
    promptOwner,
    runCollaborativeQuery: (task, selfName, relayHttp, engine, model, allowAll, workdir, relay?) =>
      runCollaborativeQuery(task, selfName, relayHttp, engine, model, allowAll, workdir, runEngine, relay),
    autoRoute,
    isEngineBusy: () => engineQueue.isBusy(),
    setEngineBusy: (busy: boolean) => {
      if (busy) engineQueue.tryAcquire();
      else engineQueue.release();
    },
    emitTaskCompleted,
  };
  const mcpServer = createMcpServer({ workdir: dir, agentName, publisherIds: new Map() }, stdioMcpDeps);
  const transport = new StdioServerTransport();
  await mcpServer.connect(transport);
}
