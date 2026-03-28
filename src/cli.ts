#!/usr/bin/env node
import { Command } from "commander";
import { serve } from "./server.js";
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
  .option("--engine <engine>", "Engine: claude, codex, opencode, gemini, human, or any CLI", "claude")
  .option("--desc <description>", "Agent description (for discovery)")
  .option("--tags <tags>", "Comma-separated tags (e.g. vue,frontend,review)")
  .option("--public", "Allow anyone to call this agent without a key")
  .option("--max-tasks <n>", "Maximum tasks per day (PP)")
  .option("--approve", "Review every task before execution")
  .option("--mock", "Use mock responses (for demo/testing)")
  .option("--allow-all", "Skip all permission prompts (for self-use)")
  .option("--price <n>", "Price in credits per call (default: 1)", "1")
  .option("--mcp-server <command>", "Wrap a community MCP server (stdio) and expose its tools via relay")
  .option("--interval <minutes>", "Reflection & market cycle interval in minutes (default: 60)", "60")
  .option("--relay <url>", "Relay WebSocket URL", RELAY_WS)
  .action(async (opts) => {
    const port = parseInt(opts.port);
    const engine = opts.engine || "claude";

    // Connect to relay
    const credentials = await getOrCreateRelayCredentials();

    // Derive relay HTTP URL from WS URL
    const relayWs = opts.relay;
    const relayHttp = relayWs.replace(/^wss:/, "https:").replace(/^ws:/, "http:");

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
      cycleInterval: parseInt(opts.interval),
    });

    console.log(`\nakemon v${pkg.version}`);
    if (!opts.public) {
      console.log(`Access key:  ${credentials.accessKey} (share with publishers)`);
    }
    console.log(`Relay:       ${relayWs}\n`);

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

program.parse();
