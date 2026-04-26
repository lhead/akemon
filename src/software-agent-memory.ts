import { buildLLMContext, loadConversation } from "./context.js";
import { buildRoleContext, loadRoles, resolveRoles } from "./role-module.js";
import type { MemoryScope, RoleScope, TaskEnvelope } from "./software-agent-peripheral.js";

export interface SoftwareAgentMemoryBuildOptions {
  workdir: string;
  agentName: string;
  envelope: Pick<TaskEnvelope, "goal" | "roleScope" | "memoryScope">;
  request?: Record<string, unknown>;
  contextBudget?: number;
}

const DEFAULT_CONTEXT_BUDGET = 6000;

interface RoleMemoryPolicy {
  roleName: string | null;
  exclude: string[];
}

const OWNER_MEMORY_EXCLUDE_TERMS = [
  "owner",
  "private",
  "personal",
  "note",
  "diary",
  "bio",
];

const OWNER_MEMORY_EXCLUDE_CJK_TERMS = [
  "全部记忆",
  "个人",
  "笔记",
  "日记",
  "状态",
];

export async function buildSoftwareAgentMemorySummary(opts: SoftwareAgentMemoryBuildOptions): Promise<string> {
  const budget = opts.contextBudget ?? DEFAULT_CONTEXT_BUDGET;
  const parts: string[] = [
    "[Akemon memory boundary]",
    `Role scope: ${opts.envelope.roleScope}`,
    `Memory scope: ${opts.envelope.memoryScope}`,
    boundaryDescription(opts.envelope.roleScope, opts.envelope.memoryScope),
  ];

  if (opts.envelope.memoryScope === "none") {
    parts.push("No Akemon memory/context is included for this task.");
    return parts.join("\n");
  }

  const request = normalizeRequest(opts.request);
  const roleTrigger = readRequestString(request, "roleTrigger") || triggerForRoleScope(opts.envelope.roleScope);
  const productName = readRequestString(request, "productName");
  const productId = readRequestString(request, "productId");
  const rolePolicy = await resolveRoleMemoryPolicy(opts.workdir, opts.agentName, roleTrigger);
  if (rolePolicy.exclude.length) {
    parts.push(`Active role exclusions: ${rolePolicy.exclude.join(", ")}`);
  }

  const roleContext = await buildRoleContext(opts.workdir, opts.agentName, roleTrigger, productName, productId);
  if (roleContext.trim()) {
    parts.push("");
    parts.push("[Role/product context]");
    parts.push(limitText(roleContext.trim(), Math.floor(budget * 0.55)));
  }

  const taskContext = readRequestString(request, "taskContext");
  if (taskContext) {
    parts.push("");
    parts.push("[Task-provided context]");
    parts.push(limitText(taskContext, Math.floor(budget * 0.25)));
  }

  const conversationId = readRequestString(request, "conversationId");
  if (conversationId && canIncludeConversation(opts.envelope.roleScope, opts.envelope.memoryScope)) {
    const conv = await loadConversation(opts.workdir, opts.agentName, conversationId);
    const { text } = buildLLMContext(conv, Math.floor(budget * 0.3));
    if (text.trim()) {
      parts.push("");
      parts.push("[Conversation context]");
      parts.push(text.trim());
    }
  } else if (conversationId) {
    parts.push("");
    parts.push("[Excluded conversation context]");
    parts.push("A conversationId was supplied, but conversation memory is only included for owner-scoped software-agent tasks in v1.");
  }

  const ownerMemory = readRequestString(request, "memorySummary");
  if (ownerMemory && canIncludeOwnerMemory(opts.envelope.roleScope, opts.envelope.memoryScope)) {
    if (roleExcludesOwnerMemory(rolePolicy)) {
      parts.push("");
      parts.push("[Role-excluded owner memory]");
      parts.push(`The active role (${rolePolicy.roleName || "unknown"}) excludes ${rolePolicy.exclude.join(", ")}, so owner-provided memory was not included.`);
    } else {
      parts.push("");
      parts.push("[Owner-visible memory]");
      parts.push(limitText(ownerMemory, Math.floor(budget * 0.35)));
    }
  } else if (ownerMemory) {
    parts.push("");
    parts.push("[Excluded owner memory]");
    parts.push("A memorySummary was supplied, but it was not included because this envelope is not owner/owner scoped.");
  }

  return limitText(parts.join("\n"), budget);
}

export function canIncludeOwnerMemory(roleScope: RoleScope, memoryScope: MemoryScope): boolean {
  return roleScope === "owner" && memoryScope === "owner";
}

function canIncludeConversation(roleScope: RoleScope, memoryScope: MemoryScope): boolean {
  return roleScope === "owner" && (memoryScope === "owner" || memoryScope === "task");
}

function triggerForRoleScope(roleScope: RoleScope): string {
  switch (roleScope) {
    case "owner": return "trigger:chat:owner";
    case "public": return "trigger:chat:public";
    case "order": return "trigger:order";
    case "agent": return "trigger:agent_call";
    case "system": return "trigger:system";
  }
}

function boundaryDescription(roleScope: RoleScope, memoryScope: MemoryScope): string {
  if (roleScope === "owner" && memoryScope === "owner") {
    return "Owner-scoped task: owner-visible memory may be included after Akemon-side selection.";
  }
  if (memoryScope === "none") {
    return "No-memory task: do not use Akemon private memory, conversation history, or subjective state.";
  }
  return "Non-owner task: exclude owner private conversations, personal notes, bio state, diary, subjective impressions, and owner-only memory.";
}

async function resolveRoleMemoryPolicy(
  workdir: string,
  agentName: string,
  roleTrigger: string,
): Promise<RoleMemoryPolicy> {
  const roles = await loadRoles(workdir, agentName);
  const { primary } = resolveRoles(roles, roleTrigger);
  return {
    roleName: primary?.name || null,
    exclude: primary?.exclude || [],
  };
}

function roleExcludesOwnerMemory(policy: RoleMemoryPolicy): boolean {
  return policy.exclude.some((item) => {
    const normalized = item.toLowerCase();
    return OWNER_MEMORY_EXCLUDE_TERMS.some((term) => normalized.includes(term))
      || OWNER_MEMORY_EXCLUDE_CJK_TERMS.some((term) => item.includes(term));
  });
}

function normalizeRequest(value: Record<string, unknown> | undefined): Record<string, unknown> {
  if (value === undefined || value === null) return {};
  if (typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Invalid request: expected object");
  }
  return value;
}

function readRequestString(request: Record<string, unknown>, field: string): string {
  const value = request[field];
  if (value === undefined || value === null) return "";
  if (typeof value !== "string") throw new Error(`Invalid ${field}: expected string`);
  return value.trim();
}

function limitText(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text;
  const head = Math.floor(maxChars * 0.45);
  const tail = Math.max(0, maxChars - head - 40);
  return `${text.slice(0, head)}\n[truncated ${text.length - head - tail} chars]\n${text.slice(-tail)}`;
}
