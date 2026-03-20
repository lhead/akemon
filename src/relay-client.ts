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
}

export interface RelayClientOptions {
  relayUrl: string;
  agentName: string;
  credentials: RelayCredentials;
  localPort: number; // loopback HTTP port for MCP processing
  description?: string;
  isPublic?: boolean;
  engine?: string;
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

      // Send registration message
      const reg: RelayMessage = {
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
