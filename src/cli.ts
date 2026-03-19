#!/usr/bin/env node
import { Command } from "commander";
import { serve, serveStdio } from "./server.js";
import { addAgent } from "./add.js";
import { getOrCreateKey, getOrCreateRelayCredentials } from "./config.js";
import { connectRelay } from "./relay-client.js";
import { listAgents } from "./list.js";

const DEFAULT_RELAY_URL = "wss://relay.akemon.dev";

const program = new Command();

program
  .name("akemon")
  .description("Agent work marketplace — train your agent, let it work for others")
  .version("0.1.0");

program
  .command("serve")
  .description("Start MCP server to expose this agent to others")
  .option("-p, --port <port>", "Port to listen on", "3000")
  .option("-w, --workdir <path>", "Working directory for claude (default: cwd)")
  .option("-n, --name <name>", "Agent name", "my-agent")
  .option("-m, --model <model>", "Claude model to use (e.g. claude-sonnet-4-6, claude-haiku-4-5-20251001)")
  .option("--stdio", "Use stdio transport instead of HTTP (for local testing)")
  .option("--mock", "Use mock responses (for demo)")
  .option("--key <key>", "API key for authentication (auto-generated if not set)")
  .option("--no-auth", "Disable authentication (not recommended)")
  .option("--approve", "Require owner approval before executing tasks")
  .option("--engine <engine>", "Engine to use: claude, codex, human, or any CLI command", "claude")
  .option("--relay [url]", "Connect to relay server (default: wss://relay.akemon.dev)")
  .option("--desc <description>", "Agent description (for relay discovery)")
  .option("--public", "Allow anyone to call this agent without a key")
  .option("--max-tasks <n>", "Maximum tasks per day (for public agents)")
  .action(async (opts) => {
    if (opts.stdio) {
      await serveStdio(opts.name, opts.workdir);
      return;
    }

    const port = parseInt(opts.port);

    // In relay mode, local server is only for loopback — skip auth
    const isRelayMode = opts.relay !== undefined;
    const key = (opts.auth === false || isRelayMode) ? undefined : await getOrCreateKey(opts.key);
    if (key && !isRelayMode) {
      console.log(`\nAccess key: ${key}`);
      console.log(`Share this with publishers. They'll need it to connect.\n`);
    }
    // Don't await — let it run in background
    const engine = opts.engine || "claude";
    serve({
      port,
      workdir: opts.workdir,
      agentName: opts.name,
      model: opts.model,
      mock: opts.mock,
      key,
      approve: opts.approve,
      engine,
    });

    // If relay mode, also connect to relay
    if (opts.relay !== undefined) {
      const credentials = await getOrCreateRelayCredentials();
      const relayUrl = typeof opts.relay === "string" ? opts.relay : DEFAULT_RELAY_URL;

      console.log(`\nAccount ID:  ${credentials.accountId}`);
      console.log(`Secret key:  ${credentials.secretKey} (keep private)`);
      console.log(`Access key:  ${credentials.accessKey} (share with publishers)`);
      console.log(`Local:       http://localhost:${port}`);
      console.log(`Relay:       ${relayUrl}\n`);

      connectRelay({
        relayUrl,
        agentName: opts.name,
        credentials,
        localPort: port,
        description: opts.desc,
        isPublic: opts.public,
        engine,
      });
    }
  });

program
  .command("add")
  .description("Add a remote agent to your AI tool's MCP config")
  .argument("<name>", "Agent name")
  .argument("[endpoint]", "Agent endpoint URL (required for direct mode)")
  .option("--key <key>", "API key for authentication")
  .option("--relay [url]", "Use relay server (default: https://relay.akemon.dev)")
  .option("--platform <platform>", "Target platform: claude, codex, gemini, opencode, cursor, windsurf", "claude")
  .action(async (name, endpoint, opts) => {
    const platform = opts.platform || "claude";
    if (opts.relay !== undefined) {
      const relayBase = typeof opts.relay === "string"
        ? opts.relay.replace(/^ws/, "http")
        : "https://relay.akemon.dev";
      const relayEndpoint = `${relayBase}/v1/agent/${name}/mcp`;
      await addAgent(name, relayEndpoint, opts.key, platform);
    } else {
      if (!endpoint) {
        console.error("Error: endpoint URL is required for direct mode. Use --relay for relay mode.");
        process.exit(1);
      }
      await addAgent(name, endpoint, opts.key, platform);
    }
  });

program
  .command("list")
  .description("List available agents on the relay")
  .option("--relay [url]", "Relay server URL (default: https://relay.akemon.dev)")
  .option("--search <query>", "Filter by name or description")
  .action(async (opts) => {
    const relayUrl = typeof opts.relay === "string" ? opts.relay : "https://relay.akemon.dev";
    await listAgents(relayUrl, opts.search);
  });

program.parse();
