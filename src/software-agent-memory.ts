import { buildLLMContext, loadConversation } from "./context.js";
import { buildRoleContext } from "./role-module.js";
import type { MemoryScope, RoleScope, TaskEnvelope } from "./software-agent-peripheral.js";

export interface SoftwareAgentMemoryBuildOptions {
  workdir: string;
  agentName: string;
  envelope: Pick<TaskEnvelope, "goal" | "roleScope" | "memoryScope">;
  request?: Record<string, unknown>;
  contextBudget?: number;
}

const DEFAULT_CONTEXT_BUDGET = 6000;

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

  const request = opts.request || {};
  const roleTrigger = readString(request.roleTrigger) || triggerForRoleScope(opts.envelope.roleScope);
  const productName = readString(request.productName);
  const productId = readString(request.productId);
  const roleContext = await buildRoleContext(opts.workdir, opts.agentName, roleTrigger, productName, productId);
  if (roleContext.trim()) {
    parts.push("");
    parts.push("[Role/product context]");
    parts.push(limitText(roleContext.trim(), Math.floor(budget * 0.55)));
  }

  const taskContext = readString(request.taskContext);
  if (taskContext) {
    parts.push("");
    parts.push("[Task-provided context]");
    parts.push(limitText(taskContext, Math.floor(budget * 0.25)));
  }

  const conversationId = readString(request.conversationId);
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

  const ownerMemory = readString(request.memorySummary);
  if (ownerMemory && canIncludeOwnerMemory(opts.envelope.roleScope, opts.envelope.memoryScope)) {
    parts.push("");
    parts.push("[Owner-visible memory]");
    parts.push(limitText(ownerMemory, Math.floor(budget * 0.35)));
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

function readString(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function limitText(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text;
  const head = Math.floor(maxChars * 0.45);
  const tail = Math.max(0, maxChars - head - 40);
  return `${text.slice(0, head)}\n[truncated ${text.length - head - tail} chars]\n${text.slice(-tail)}`;
}
