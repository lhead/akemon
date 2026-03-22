import WebSocket from "ws";
import http from "http";
import { RelayCredentials } from "./config.js";

const DEFAULT_RELAY_URL = "wss://relay.akemon.dev";

interface RelayMessage {
  type: string;
  request_id?: string;
  session_id?: string;
  method?: string;
  headers?: Record<string, string>;
  body?: unknown;
  status_code?: number;
  response_headers?: Record<string, string>;
  error?: string;
  name?: string;
  description?: string;
  account_id?: string;
  public?: boolean;
  engine?: string;
  action?: string;
  call_id?: string;
  caller?: string;
  target?: string;
  task?: string;
  result?: string;
}

export interface RelayClientOptions {
  relayUrl: string;
  agentName: string;
  credentials: RelayCredentials;
  localPort: number; // loopback HTTP port for MCP processing
  description?: string;
  isPublic?: boolean;
  engine?: string;
  tags?: string[];
}

// Pending agent_call results (callId → resolve function)
const pendingAgentCalls = new Map<string, (result: string) => void>();
let relayWsRef: WebSocket | null = null;

/** Call another agent through the relay. Available to any engine. */
export function callAgent(target: string, task: string): Promise<string> {
  return new Promise((resolve, reject) => {
    if (!relayWsRef || relayWsRef.readyState !== WebSocket.OPEN) {
      reject(new Error("Not connected to relay"));
      return;
    }
    const callId = Math.random().toString(36).slice(2) + Date.now().toString(36);
    pendingAgentCalls.set(callId, resolve);

    relayWsRef.send(JSON.stringify({
      type: "agent_call",
      call_id: callId,
      target,
      task,
    }));

    // Timeout after 5 minutes
    setTimeout(() => {
      if (pendingAgentCalls.has(callId)) {
        pendingAgentCalls.delete(callId);
        reject(new Error(`agent_call to ${target} timed out`));
      }
    }, 300_000);
  });
}

export function connectRelay(options: RelayClientOptions): void {
  const relayUrl = options.relayUrl || DEFAULT_RELAY_URL;
  let wsUrl = relayUrl.replace(/^http/, "ws");
  if (!wsUrl.endsWith("/")) wsUrl += "/";
  wsUrl += "v1/agent/ws";

  let reconnectDelay = 1000;
  const maxReconnectDelay = 30000;
  let intentionalClose = false;

  const HEARTBEAT_INTERVAL = 30_000; // ping every 30s
  const HEARTBEAT_TIMEOUT = 10_000;  // expect pong within 10s

  function connect() {
    console.log(`[relay-ws] Connecting to ${wsUrl}...`);

    const ws = new WebSocket(wsUrl, {
      headers: {
        Authorization: `Bearer ${options.credentials.secretKey}`,
      },
    });

    let alive = false;
    let heartbeat: ReturnType<typeof setInterval> | null = null;

    function clearHeartbeat() {
      if (heartbeat) {
        clearInterval(heartbeat);
        heartbeat = null;
      }
    }

    function startHeartbeat() {
      clearHeartbeat();
      alive = true;
      heartbeat = setInterval(() => {
        if (!alive) {
          // No pong received since last ping — connection is dead
          console.log("[relay-ws] Heartbeat timeout, reconnecting...");
          clearHeartbeat();
          ws.terminate();
          return;
        }
        alive = false;
        try {
          ws.ping();
        } catch {
          // ping write failed — connection dead
          clearHeartbeat();
          ws.terminate();
        }
      }, HEARTBEAT_INTERVAL);
    }

    ws.on("open", () => {
      console.log(`[relay-ws] Connected. Registering agent "${options.agentName}"...`);
      reconnectDelay = 1000; // reset backoff
      relayWsRef = ws;

      // Send registration message
      const reg: Record<string, any> = {
        type: "register",
        name: options.agentName,
        description: options.description || "",
        account_id: options.credentials.accountId,
        public: options.isPublic || false,
        engine: options.engine || "claude",
        headers: {
          access_token: options.credentials.accessKey,
        },
      };
      if (options.tags && options.tags.length > 0) {
        reg.tags = options.tags;
      }
      ws.send(JSON.stringify(reg));

      startHeartbeat();
    });

    ws.on("pong", () => {
      alive = true;
    });

    ws.on("message", (data) => {
      alive = true; // any message counts as alive
      let msg: RelayMessage;
      try {
        msg = JSON.parse(data.toString());
      } catch {
        console.error("[relay-ws] Invalid message from relay");
        return;
      }

      switch (msg.type) {
        case "registered":
          console.log(`[relay-ws] Registered as "${msg.name}" on relay`);
          break;

        case "error":
          console.error(`[relay-ws] Error from relay: ${msg.error}`);
          break;

        case "mcp_request":
          handleMCPRequest(ws, msg, options.localPort);
          break;

        case "control":
          handleControl(ws, msg);
          break;

        case "agent_call":
          handleIncomingAgentCall(ws, msg, options.localPort);
          break;

        case "agent_call_result":
          handleAgentCallResult(msg);
          break;

        default:
          console.log(`[relay-ws] Unknown message type: ${msg.type}`);
      }
    });

    ws.on("ping", () => {
      alive = true; // server ping also proves liveness
    });

    ws.on("close", () => {
      clearHeartbeat();
      if (intentionalClose) return;
      console.log(`[relay-ws] Disconnected. Reconnecting in ${reconnectDelay / 1000}s...`);
      setTimeout(() => {
        reconnectDelay = Math.min(reconnectDelay * 2, maxReconnectDelay);
        connect();
      }, reconnectDelay);
    });

    ws.on("error", (err) => {
      console.error(`[relay-ws] Error: ${err.message}`);
    });
  }

  connect();
}

function handleIncomingAgentCall(ws: WebSocket, msg: RelayMessage, localPort: number): void {
  const callId = msg.call_id || "";
  const caller = msg.caller || "unknown";
  const task = msg.task || "";
  console.log(`[agent_call] Incoming from ${caller}: ${task.slice(0, 80)}`);

  // Forward to local MCP as a submit_task call
  const initBody = JSON.stringify({
    jsonrpc: "2.0", id: 1,
    method: "initialize",
    params: { protocolVersion: "2025-03-26", capabilities: {}, clientInfo: { name: "agent-call", version: "1.0" } },
  });

  const doRequest = (body: string, sessionId?: string): Promise<{ data: string; sessionId?: string }> => {
    return new Promise((resolve, reject) => {
      const headers: Record<string, string> = {
        "Content-Type": "application/json",
        "Accept": "application/json, text/event-stream",
      };
      if (sessionId) headers["mcp-session-id"] = sessionId;

      const req = http.request({ hostname: "127.0.0.1", port: localPort, path: "/mcp", method: "POST", headers: { ...headers, "Content-Length": Buffer.byteLength(body) } }, (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (c: Buffer) => chunks.push(c));
        res.on("end", () => {
          const sid = res.headers["mcp-session-id"] as string | undefined;
          resolve({ data: Buffer.concat(chunks).toString(), sessionId: sid || sessionId });
        });
      });
      req.on("error", reject);
      req.write(body);
      req.end();
    });
  };

  // Initialize → call tool → return result
  doRequest(initBody)
    .then(({ sessionId: sid }) => {
      const callBody = JSON.stringify({
        jsonrpc: "2.0", id: 2,
        method: "tools/call",
        params: { name: "submit_task", arguments: { task } },
      });
      return doRequest(callBody, sid);
    })
    .then(({ data }) => {
      // Extract text from SSE or JSON response
      let result = data;
      try {
        // Try SSE extraction
        const lines = data.split("\n");
        let lastData = "";
        for (const line of lines) {
          if (line.startsWith("data: ")) lastData = line.slice(6);
        }
        if (lastData) {
          const parsed = JSON.parse(lastData);
          const content = parsed?.result?.content;
          if (content) result = content.map((c: any) => c.text || "").join("\n");
        } else {
          const parsed = JSON.parse(data);
          const content = parsed?.result?.content;
          if (content) result = content.map((c: any) => c.text || "").join("\n");
        }
      } catch { /* use raw */ }

      ws.send(JSON.stringify({
        type: "agent_call_result",
        call_id: callId,
        caller,
        result,
      }));
      console.log(`[agent_call] Replied to ${caller} (${result.length} bytes)`);
    })
    .catch((err) => {
      ws.send(JSON.stringify({
        type: "agent_call_result",
        call_id: callId,
        caller,
        result: `[error] ${err.message}`,
      }));
    });
}

function handleAgentCallResult(msg: RelayMessage): void {
  const callId = msg.call_id || "";
  const resolve = pendingAgentCalls.get(callId);
  if (resolve) {
    pendingAgentCalls.delete(callId);
    resolve(msg.result || "");
    console.log(`[agent_call] Got result for call_id=${callId.slice(0, 8)} from ${msg.caller}`);
  }
}

function handleControl(ws: WebSocket, msg: RelayMessage): void {
  const action = msg.action || "";
  console.log(`[control] Received: ${action}`);

  switch (action) {
    case "shutdown":
      console.log("[control] Shutting down by remote command...");
      ws.send(JSON.stringify({ type: "control_ack", action }));
      setTimeout(() => process.exit(0), 500);
      break;

    case "set_public":
      console.log("[control] Agent set to public by remote command");
      ws.send(JSON.stringify({ type: "control_ack", action }));
      break;

    case "set_private":
      console.log("[control] Agent set to private by remote command");
      ws.send(JSON.stringify({ type: "control_ack", action }));
      break;

    default:
      console.log(`[control] Unknown action: ${action}`);
  }
}

function handleMCPRequest(ws: WebSocket, msg: RelayMessage, localPort: number): void {
  const requestId = msg.request_id;
  console.log(`[relay-ws] → mcp_request ${requestId}`);

  // Forward to local MCP server via loopback HTTP
  const headers: Record<string, string> = {
    "Content-Type": msg.headers?.["content-type"] || "application/json",
    "Accept": "application/json, text/event-stream",
  };
  if (msg.session_id) {
    headers["mcp-session-id"] = msg.session_id;
  }
  if (msg.headers?.["x-publisher-id"]) {
    headers["x-publisher-id"] = msg.headers["x-publisher-id"];
  }

  const bodyStr = typeof msg.body === "string" ? msg.body : JSON.stringify(msg.body);
  const bodyBuf = Buffer.from(bodyStr);

  const req = http.request(
    {
      hostname: "127.0.0.1",
      port: localPort,
      path: "/mcp",
      method: msg.method || "POST",
      headers: {
        ...headers,
        "Content-Length": bodyBuf.length,
      },
    },
    (res) => {
      const chunks: Buffer[] = [];
      res.on("data", (chunk: Buffer) => chunks.push(chunk));
      res.on("end", () => {
        const responseBody = Buffer.concat(chunks).toString();

        // Collect response headers
        const responseHeaders: Record<string, string> = {};
        for (const [key, val] of Object.entries(res.headers)) {
          if (typeof val === "string") {
            responseHeaders[key] = val;
          }
        }

        // If response is SSE, extract the JSON-RPC message from the event stream
        let body: unknown;
        const contentType = res.headers["content-type"] || "";
        if (contentType.includes("text/event-stream")) {
          body = extractSSEData(responseBody);
          // Fix headers: body is now plain JSON, not SSE
          responseHeaders["content-type"] = "application/json";
          delete responseHeaders["content-length"]; // body size changed
          delete responseHeaders["cache-control"];   // SSE-specific
          delete responseHeaders["connection"];       // SSE-specific
        } else {
          body = tryParseJSON(responseBody);
        }

        const reply: RelayMessage = {
          type: "mcp_response",
          request_id: requestId,
          status_code: res.statusCode || 200,
          response_headers: responseHeaders,
          body,
        };

        ws.send(JSON.stringify(reply));
        console.log(`[relay-ws] ← mcp_response ${requestId} (${res.statusCode})`);
      });
    }
  );

  req.on("error", (err) => {
    console.error(`[loopback] Error forwarding to local MCP: ${err.message}`);
    const reply: RelayMessage = {
      type: "mcp_error",
      request_id: requestId,
      error: `loopback error: ${err.message}`,
    };
    ws.send(JSON.stringify(reply));
  });

  req.write(bodyBuf);
  req.end();
}

function tryParseJSON(str: string): unknown {
  try {
    return JSON.parse(str);
  } catch {
    return str;
  }
}

// Extract the last JSON-RPC data payload from SSE stream
function extractSSEData(sse: string): unknown {
  const lines = sse.split("\n");
  let lastData = "";
  for (const line of lines) {
    if (line.startsWith("data: ")) {
      lastData = line.slice(6);
    }
  }
  if (lastData) {
    return tryParseJSON(lastData);
  }
  return null;
}
