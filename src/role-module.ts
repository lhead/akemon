/**
 * RoleModule — agent identity and expertise system.
 *
 * Role = who you are (tone, privacy boundary)
 * Playbook = what you know (domain strategy, toolchain)
 * Product = what you sell (specific offering, references a playbook)
 *
 * All three are orthogonal and decoupled.
 * Core functions are exported for TaskModule to call directly (pure-function style).
 */

import { readdir, readFile, mkdir, writeFile } from "fs/promises";
import { join, basename } from "path";
import type { Module, ModuleContext } from "./types.js";
import { rolesDir, playbooksDir, productsDir } from "./self.js";

// ---------------------------------------------------------------------------
// Data types
// ---------------------------------------------------------------------------

export interface RoleDef {
  name: string;           // filename without .md
  description: string;    // first non-heading paragraph after #
  triggers: string[];     // trigger:xxx tags
  include: string[];      // context include declarations
  exclude: string[];      // context exclude declarations
  customRules: string;    // content outside ## 激活 and ## 上下文范围
  raw: string;            // full md content
}

export interface PlaybookDef {
  name: string;
  raw: string;
}

export interface ProductDef {
  name: string;
  playbook: string;       // referenced playbook name from ## playbook
  productIds: string[];   // relay product IDs from ## products
  raw: string;
}

// ---------------------------------------------------------------------------
// Parsing
// ---------------------------------------------------------------------------

export function parseRole(name: string, raw: string): RoleDef {
  const lines = raw.split("\n");
  let description = "";
  const triggers: string[] = [];
  const include: string[] = [];
  const exclude: string[] = [];
  const customLines: string[] = [];

  let section = ""; // current ## section name
  let pastTitle = false;

  for (const line of lines) {
    // Track ## sections
    if (line.startsWith("## ")) {
      const heading = line.slice(3).trim().toLowerCase();
      if (heading.includes("激活") || heading === "triggers") {
        section = "triggers";
      } else if (heading.includes("上下文") || heading.includes("context")) {
        section = "context";
      } else {
        section = "custom";
      }
      continue;
    }

    // Skip # title
    if (line.startsWith("# ")) {
      pastTitle = true;
      continue;
    }

    // Extract description: first non-empty line after title, before any ##
    if (pastTitle && !description && !section && line.trim()) {
      description = line.trim();
      continue;
    }

    const trimmed = line.trim();
    if (!trimmed) continue;

    if (section === "triggers") {
      // Extract trigger:xxx from list items
      const match = trimmed.match(/^-\s*(trigger:\S+)/);
      if (match) triggers.push(match[1]);
    } else if (section === "context") {
      // Parse include/exclude lines
      if (trimmed.toLowerCase().startsWith("include:")) {
        include.push(...trimmed.slice(8).split(",").map(s => s.trim()).filter(Boolean));
      } else if (trimmed.toLowerCase().startsWith("exclude:")) {
        exclude.push(...trimmed.slice(8).split(",").map(s => s.trim()).filter(Boolean));
      }
    } else if (section === "custom") {
      customLines.push(line);
    }
  }

  return { name, description, triggers, include, exclude, customRules: customLines.join("\n").trim(), raw };
}

export function parseProduct(name: string, raw: string): ProductDef {
  let playbook = "";
  const productIds: string[] = [];
  const lines = raw.split("\n");
  let section = "";
  for (const line of lines) {
    if (line.startsWith("## ")) {
      const heading = line.slice(3).trim().toLowerCase();
      if (heading.includes("playbook")) {
        section = "playbook";
      } else if (heading.includes("product")) {
        section = "products";
      } else {
        section = "";
      }
      continue;
    }
    const trimmed = line.trim();
    if (!trimmed) continue;
    if (section === "playbook" && !playbook) {
      playbook = trimmed;
      section = "";
    } else if (section === "products") {
      const match = trimmed.match(/^-\s*(.+)/);
      if (match) productIds.push(match[1].trim());
    }
  }
  return { name, playbook, productIds, raw };
}

// ---------------------------------------------------------------------------
// Loading (pure functions — called by TaskModule directly)
// ---------------------------------------------------------------------------

async function loadMdFiles(dir: string): Promise<{ name: string; raw: string }[]> {
  try {
    const files = await readdir(dir);
    const results: { name: string; raw: string }[] = [];
    for (const f of files) {
      if (!f.endsWith(".md")) continue;
      const raw = await readFile(join(dir, f), "utf-8");
      results.push({ name: basename(f, ".md"), raw });
    }
    return results;
  } catch {
    return []; // directory doesn't exist or empty
  }
}

export async function loadRoles(workdir: string, agentName: string): Promise<RoleDef[]> {
  const entries = await loadMdFiles(rolesDir(workdir, agentName));
  return entries.map(e => parseRole(e.name, e.raw));
}

export async function loadPlaybooks(workdir: string, agentName: string): Promise<PlaybookDef[]> {
  const entries = await loadMdFiles(playbooksDir(workdir, agentName));
  return entries.map(e => ({ name: e.name, raw: e.raw }));
}

export async function loadProducts(workdir: string, agentName: string): Promise<ProductDef[]> {
  const entries = await loadMdFiles(productsDir(workdir, agentName));
  return entries.map(e => parseProduct(e.name, e.raw));
}

// ---------------------------------------------------------------------------
// Resolution
// ---------------------------------------------------------------------------

export function resolveRoles(roles: RoleDef[], trigger: string): { primary: RoleDef | null; secondary: RoleDef[] } {
  const matched = roles.filter(r => r.triggers.some(t => trigger.includes(t) || t.includes(trigger)));
  if (matched.length === 0) return { primary: null, secondary: [] };
  return { primary: matched[0], secondary: matched.slice(1) };
}

export function resolveProduct(
  products: ProductDef[],
  playbooks: PlaybookDef[],
  productName: string,
  productId?: string,
): { product: ProductDef; playbook: PlaybookDef | null } | null {
  if (!productName && !productId) return null;

  // Priority 1: match by product ID
  let product: ProductDef | undefined;
  if (productId) {
    product = products.find(p => p.productIds.includes(productId));
  }

  // Priority 2: fuzzy match by name
  if (!product && productName) {
    const normalized = productName.toLowerCase().replace(/[\s_-]+/g, "");
    product = products.find(p => {
      const pNorm = p.name.toLowerCase().replace(/[\s_-]+/g, "");
      return pNorm === normalized || normalized.includes(pNorm) || pNorm.includes(normalized);
    });
  }

  if (!product) return null;
  const playbook = product.playbook
    ? playbooks.find(pb => pb.name.toLowerCase() === product!.playbook.toLowerCase()) ?? null
    : null;
  return { product, playbook };
}

// ---------------------------------------------------------------------------
// Context building (main entry point for TaskModule)
// ---------------------------------------------------------------------------

export async function buildRoleContext(
  workdir: string,
  agentName: string,
  trigger: string,
  productName?: string,
  productId?: string,
): Promise<string> {
  const roles = await loadRoles(workdir, agentName);
  const playbooks = await loadPlaybooks(workdir, agentName);
  const products = await loadProducts(workdir, agentName);

  const { primary, secondary } = resolveRoles(roles, trigger);

  if (primary) {
    console.log(`[role] trigger=${trigger} → primary=${primary.name}${secondary.length > 0 ? ` secondary=${secondary.map(r => r.name).join(",")}` : ""}`);
  }

  const parts: string[] = [];

  // Primary role: full content
  if (primary) {
    parts.push(`[Active role: ${primary.name}]\n${primary.raw}`);
  }

  // Secondary roles: description only
  for (const r of secondary) {
    if (r.description) {
      parts.push(`[Secondary role: ${r.name}] ${r.description}`);
    }
  }

  // Product + playbook
  if (productName) {
    const resolved = resolveProduct(products, playbooks, productName, productId);
    if (resolved) {
      parts.push(`[Product: ${resolved.product.name}]\n${resolved.product.raw}`);
      if (resolved.playbook) {
        parts.push(`[Playbook: ${resolved.playbook.name}]\n${resolved.playbook.raw}`);
      }
    }
  }

  // If no product matched but playbooks exist, list them for reference
  if (!productName && playbooks.length > 0) {
    parts.push(`Available playbooks: ${playbooks.map(p => p.name).join(", ")}`);
  }

  return parts.join("\n\n");
}

// ---------------------------------------------------------------------------
// Default templates
// ---------------------------------------------------------------------------

const DEFAULT_ROLES: Record<string, string> = {
  merchant: `# 商家

你作为商家为客户服务，行为和表达要符合职业规范，不断提高服务水平。

## 激活
- trigger:order
- trigger:chat:public

## 上下文范围
include: buyer 历史订单, 商品信息
exclude: owner 对话, 个人笔记, bio 状态
`,
  companion: `# 陪伴者

你是 owner 的伙伴和助手，了解 owner 的偏好和习惯，提供贴心的支持。

## 激活
- trigger:chat:owner
- trigger:user_task

## 上下文范围
include: owner 对话历史, 个人笔记, bio 状态, 全部记忆
exclude: 其他 buyer 的对话和订单
`,
  worker: `# 打工人

你按照要求完成任务，高效、准确、不多废话。

## 激活
- trigger:agent_call

## 上下文范围
include: 任务相关上下文
exclude: owner 私人对话, buyer 信息
`,
};

async function ensureDefaultRoles(workdir: string, agentName: string): Promise<void> {
  const dir = rolesDir(workdir, agentName);
  try {
    await readdir(dir);
    // Directory exists — respect user's choices, don't create defaults
    return;
  } catch {
    // Directory doesn't exist — create with defaults
  }
  await mkdir(dir, { recursive: true });
  for (const [name, content] of Object.entries(DEFAULT_ROLES)) {
    await writeFile(join(dir, `${name}.md`), content, "utf-8");
  }
  console.log(`[role] Created default role templates in ${dir}`);
}

// ---------------------------------------------------------------------------
// RoleModule class (Module interface)
// ---------------------------------------------------------------------------

export class RoleModule implements Module {
  id = "role";
  name = "Role & Playbook System";
  dependencies = ["memory"];

  private ctx: ModuleContext | null = null;
  private currentPrimary: RoleDef | null = null;

  async start(ctx: ModuleContext): Promise<void> {
    this.ctx = ctx;
    const { workdir, agentName } = ctx;

    // Create default templates if roles/ doesn't exist
    await ensureDefaultRoles(workdir, agentName);

    // Also ensure playbooks/ and products/ directories exist
    await mkdir(playbooksDir(workdir, agentName), { recursive: true });
    await mkdir(productsDir(workdir, agentName), { recursive: true });

    // Load and log
    const roles = await loadRoles(workdir, agentName);
    const playbooks = await loadPlaybooks(workdir, agentName);
    const products = await loadProducts(workdir, agentName);
    console.log(`[role] Loaded ${roles.length} roles, ${playbooks.length} playbooks, ${products.length} products`);
  }

  async stop(): Promise<void> {
    this.currentPrimary = null;
    this.ctx = null;
  }

  /** Current active role summary — lets other modules (Memory, Reflection) sense the role */
  promptContribution(): string | null {
    if (!this.currentPrimary) return null;
    return `Current role: ${this.currentPrimary.name} — ${this.currentPrimary.description}`;
  }

  getState(): Record<string, unknown> {
    return {
      currentRole: this.currentPrimary?.name ?? null,
    };
  }

  /** Called by buildRoleContext to update current role state */
  updateCurrentRole(role: RoleDef | null): void {
    this.currentPrimary = role;
  }
}
