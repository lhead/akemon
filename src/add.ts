import { execFile } from "child_process";
import { promisify } from "util";
import { readFile, writeFile, mkdir } from "fs/promises";
import { existsSync } from "fs";
import { join } from "path";
import { homedir } from "os";

const execFileAsync = promisify(execFile);

async function checkAgentPublic(endpoint: string, name: string): Promise<boolean | null> {
  try {
    const url = endpoint.replace(`/v1/agent/${name}/mcp`, "/v1/agents");
    const res = await fetch(url);
    if (!res.ok) return null;
    const agents: { name: string; public: boolean }[] = await res.json();
    const agent = agents.find((a) => a.name === name);
    if (!agent) return null;
    return agent.public;
  } catch {
    return null;
  }
}

export type Platform = "claude" | "cursor" | "windsurf" | "codex" | "gemini" | "opencode";

export async function addAgent(name: string, endpoint: string, key?: string, platform: Platform = "claude"): Promise<void> {
  const mcpName = `akemon--${name}`;

  // Check if private agent needs a key
  const isPublic = await checkAgentPublic(endpoint, name);
  if (isPublic === false && !key) {
    console.error(`Error: Agent "${name}" is private. You must provide an access key:`);
    console.error(`  akemon add ${name} --relay --key <access_key>`);
    console.error(`\nAsk the agent owner for the access key.`);
    process.exit(1);
  }

  switch (platform) {
    case "claude":
      await addViaCli("claude", ["mcp", "add", "-s", "user", "--transport", "http"], mcpName, endpoint, key, "Claude Code");
      break;
    case "codex":
      await addViaCli("codex", ["mcp", "add", "--transport", "http"], mcpName, endpoint, key, "Codex");
      break;
    case "gemini":
      await addViaCli("gemini", ["mcp", "add", "--transport", "http"], mcpName, endpoint, key, "Gemini CLI");
      break;
    case "cursor":
      await addToJsonConfig(mcpName, endpoint, key, join(homedir(), ".cursor", "mcp.json"), "Cursor");
      break;
    case "windsurf":
      await addToJsonConfig(mcpName, endpoint, key, join(homedir(), ".codeium", "windsurf", "mcp_config.json"), "Windsurf");
      break;
    case "opencode":
      await addToOpenCode(mcpName, endpoint, key);
      break;
  }
}

async function addViaCli(cmd: string, baseArgs: string[], mcpName: string, endpoint: string, key: string | undefined, platformName: string): Promise<void> {
  try {
    const args = [...baseArgs, mcpName, endpoint];
    if (key) {
      args.push("--header", `Authorization: Bearer ${key}`);
    }
    await execFileAsync(cmd, args);
    console.log(`Added agent "${mcpName}" → ${endpoint}`);
    if (key) console.log(`With authentication enabled.`);
    console.log(`Restart ${platformName} to activate.`);
  } catch (err: any) {
    console.error(`Failed to add agent to ${platformName}: ${err.message}`);
    process.exit(1);
  }
}

async function addToOpenCode(mcpName: string, endpoint: string, key?: string): Promise<void> {
  const configPath = join(homedir(), ".config", "opencode", "opencode.json");
  try {
    const dir = join(configPath, "..");
    if (!existsSync(dir)) {
      await mkdir(dir, { recursive: true });
    }

    let config: any = {};
    if (existsSync(configPath)) {
      config = JSON.parse(await readFile(configPath, "utf-8"));
    }

    if (!config.mcp) config.mcp = {};

    const serverConfig: any = {
      type: "remote",
      url: endpoint,
    };
    if (key) {
      serverConfig.headers = { Authorization: `Bearer ${key}` };
    }

    config.mcp[mcpName] = serverConfig;
    await writeFile(configPath, JSON.stringify(config, null, 2));

    console.log(`Added agent "${mcpName}" → ${endpoint}`);
    console.log(`Config: ${configPath}`);
    if (key) console.log(`With authentication enabled.`);
    console.log(`Restart OpenCode to activate.`);
  } catch (err: any) {
    console.error(`Failed to add agent to OpenCode: ${err.message}`);
    process.exit(1);
  }
}

async function addToJsonConfig(mcpName: string, endpoint: string, key: string | undefined, configPath: string, platformName: string): Promise<void> {
  try {
    const dir = join(configPath, "..");
    if (!existsSync(dir)) {
      await mkdir(dir, { recursive: true });
    }

    let config: any = {};
    if (existsSync(configPath)) {
      config = JSON.parse(await readFile(configPath, "utf-8"));
    }

    if (!config.mcpServers) config.mcpServers = {};

    const serverConfig: any = {
      url: endpoint,
    };
    if (key) {
      serverConfig.headers = { Authorization: `Bearer ${key}` };
    }

    config.mcpServers[mcpName] = serverConfig;
    await writeFile(configPath, JSON.stringify(config, null, 2));

    console.log(`Added agent "${mcpName}" → ${endpoint}`);
    console.log(`Config: ${configPath}`);
    if (key) console.log(`With authentication enabled.`);
    console.log(`Restart ${platformName} to activate.`);
  } catch (err: any) {
    console.error(`Failed to add agent to ${platformName}: ${err.message}`);
    process.exit(1);
  }
}
