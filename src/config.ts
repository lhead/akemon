import { readFile, writeFile, mkdir } from "fs/promises";
import { existsSync } from "fs";
import { join } from "path";
import { homedir } from "os";
import { randomBytes, randomUUID } from "crypto";

const CONFIG_DIR = join(homedir(), ".akemon");
const CONFIG_PATH = join(CONFIG_DIR, "config.json");

interface AkemonConfig {
  key?: string;           // legacy single key (direct mode)
  account_id?: string;    // UUID, auto-generated
  secret_key?: string;    // ak_secret_xxx (for relay registration)
  access_key?: string;    // ak_access_xxx (share with publishers)
  [k: string]: unknown;
}

export function generateKey(prefix: string = "ak"): string {
  return prefix + "_" + randomBytes(24).toString("base64url");
}

export async function loadConfig(): Promise<AkemonConfig> {
  if (!existsSync(CONFIG_PATH)) return {};
  const raw = await readFile(CONFIG_PATH, "utf-8");
  return JSON.parse(raw);
}

export async function saveConfig(config: AkemonConfig): Promise<void> {
  if (!existsSync(CONFIG_DIR)) {
    await mkdir(CONFIG_DIR, { recursive: true });
  }
  await writeFile(CONFIG_PATH, JSON.stringify(config, null, 2));
}

// Legacy: single key for direct mode
export async function getOrCreateKey(explicitKey?: string): Promise<string> {
  const config = await loadConfig();

  if (explicitKey) {
    config.key = explicitKey;
    await saveConfig(config);
    return explicitKey;
  }

  if (config.key) return config.key;

  const key = generateKey();
  config.key = key;
  await saveConfig(config);
  return key;
}

// Relay mode: account_id + dual tokens
export interface RelayCredentials {
  accountId: string;
  secretKey: string;
  accessKey: string;
}

export async function getOrCreateRelayCredentials(): Promise<RelayCredentials> {
  const config = await loadConfig();
  let changed = false;

  if (!config.account_id) {
    config.account_id = randomUUID();
    changed = true;
  }
  if (!config.secret_key) {
    config.secret_key = generateKey("ak_secret");
    changed = true;
  }
  if (!config.access_key) {
    config.access_key = generateKey("ak_access");
    changed = true;
  }

  if (changed) {
    await saveConfig(config);
  }

  return {
    accountId: config.account_id,
    secretKey: config.secret_key,
    accessKey: config.access_key,
  };
}
