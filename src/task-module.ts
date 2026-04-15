/**
 * TaskModule — manages all task lifecycles.
 *
 * Phase 2: Replaces work-loop.ts. Polls for work from peripherals,
 * sorts by urgency-importance (Eisenhower matrix), filters by bio-state,
 * and executes via requestCompute().
 *
 * When idle, uses Peripheral.explore() to discover what's available,
 * then asks the engine to decide what to do.
 */

import { readFile } from "fs/promises";
import type { Module, ModuleContext, Signal } from "./types.js";
import { SIG, sig } from "./types.js";
import type { RelayPeripheral } from "./relay-peripheral.js";
import type { BioStateModule } from "./bio-module.js";
import {
  selfDir, biosPath, localNow,
  loadBioState, saveBioState,
  syncEnergyFromTokens,
  loadAgentConfig,
  getDueUserTasks, loadTaskRuns, saveTaskRuns, UserTask,
  loadDirectives, buildDirectivesPrompt,
  appendTaskHistory,
  notifyOwner,
  updateHungerDecay, updateNaturalDecay, resetTokenCountIfNewDay,
  computeSociability,
  appendBioEvent, bioStatePromptModifier,
  feedHunger, SHOP_ITEMS,
  logBioStatus, logBioDecision,
  appendImpression,
} from "./self.js";
import { appendRound, resolveConvId } from "./context.js";

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

const INITIAL_DELAY = 60_000;  // 1 min after startup
const POLL_INTERVAL = 30_000;  // 30s between polls
const RETRY_INTERVALS = [0, 30_000, 5 * 60_000, 30 * 60_000, 2 * 3600_000];
const USER_TASK_MAX_RETRIES = 2;
const USER_TASK_RETRY_DELAY = 2 * 60_000;

// ---------------------------------------------------------------------------
// Work item — unified task representation
// ---------------------------------------------------------------------------

interface WorkItem {
  type: "order" | "user_task" | "relay_task";
  id: string;
  /** Eisenhower quadrant: 1=urgent+important, 2=important, 3=urgent, 4=neither */
  quadrant: 1 | 2 | 3 | 4;
  data: any;
}

export class TaskModule implements Module {
  id = "task";
  name = "Task Lifecycle Manager";
  dependencies = ["biostate"];

  private ctx: ModuleContext | null = null;
  private pollTimer: ReturnType<typeof setInterval> | null = null;
  private initialTimer: ReturnType<typeof setTimeout> | null = null;

  // Retry tracking
  private orderRetry = new Map<string, { count: number; nextAt: number }>();
  private userTaskRetry = new Map<string, { count: number; nextAt: number }>();
  private gaveUp = new Set<string>();

  // Push notification support
  private urgentOrderIds = new Set<string>();
  private triggerWorkFn: (() => void) | null = null;

  // Injected options (set by server.ts before start)
  relayHttp = "";
  secretKey = "";
  engine = "";
  model: string | undefined;
  allowAll: boolean | undefined;
  notifyUrl: string | undefined;

  /** Get the relay peripheral from context */
  private getRelay(): RelayPeripheral | null {
    if (!this.ctx) return null;
    const ps = this.ctx.getPeripherals("social");
    return ps[0] as RelayPeripheral ?? null;
  }

  // ---------------------------------------------------------------------------
  // Module interface
  // ---------------------------------------------------------------------------

  async start(ctx: ModuleContext): Promise<void> {
    this.ctx = ctx;

    const config = await loadAgentConfig(ctx.workdir, ctx.agentName);

    // Start polling loop
    this.initialTimer = setTimeout(() => {
      this.processWork().catch(err => console.log(`[task] Work error: ${err.message}`));
      this.pollTimer = setInterval(() => {
        this.processWork().catch(err => console.log(`[task] Work error: ${err.message}`));
      }, POLL_INTERVAL);
    }, INITIAL_DELAY);

    console.log(`[task] Module started (first check in ${INITIAL_DELAY / 1000}s, then every ${POLL_INTERVAL / 1000}s)`);
  }

  async stop(): Promise<void> {
    if (this.initialTimer) clearTimeout(this.initialTimer);
    if (this.pollTimer) clearInterval(this.pollTimer);
    this.ctx = null;
  }

  promptContribution(): string | null {
    return null; // TaskModule doesn't inject into prompts
  }

  getState(): Record<string, unknown> {
    return {
      module: "task",
      pendingRetries: this.orderRetry.size + this.userTaskRetry.size,
      gaveUp: this.gaveUp.size,
    };
  }

  /** Push-notify an urgent order (bypasses poll interval) */
  onUrgentOrder(orderId: string): void {
    this.urgentOrderIds.add(orderId);
    this.triggerWorkFn?.();
  }

  // ---------------------------------------------------------------------------
  // Main work loop
  // ---------------------------------------------------------------------------

  private async processWork(): Promise<void> {
    if (!this.ctx) return;
    const { workdir, agentName, bus } = this.ctx;
    const relay = this.getRelay();

    bus.emit(SIG.CYCLE_START, sig(SIG.CYCLE_START, { ts: Date.now() }));

    const config = await loadAgentConfig(workdir, agentName);

    // --- Bio-state pre-checks ---
    const bio = await loadBioState(workdir, agentName);
    const tokenLimit = config.token_limit_daily || 0;
    syncEnergyFromTokens(bio, tokenLimit);

    if (bio.forcedOffline) { logBioDecision("SKIP", "forced offline"); return; }

    // Natural decay
    updateHungerDecay(bio, config.hunger_decay_interval || 300_000);
    updateNaturalDecay(bio);
    resetTokenCountIfNewDay(bio);
    await saveBioState(workdir, agentName, bio);

    // Energy check
    if (bio.energy < 5 && tokenLimit > 0) {
      logBioDecision("STOP", `token budget nearly exhausted (energy=${bio.energy})`);
      await appendBioEvent(workdir, agentName, {
        ts: localNow(), type: "bio", trigger: "token_limit",
        action: "stop_work", reason: `Token budget nearly exhausted: ${bio.tokenUsedToday}/${tokenLimit}`,
      });
      return;
    }

    // Auto-buy food
    if (bio.hunger < 30 && relay?.connected) {
      await this.autoBuyFood(bio, relay);
    }

    // --- Batch pull work items ---
    const queue: WorkItem[] = [];

    // Orders from relay
    if (relay?.connected) {
      try {
        const orders = await relay.getIncomingOrders();
        for (const order of orders) {
          if (this.gaveUp.has(order.id)) continue;
          const retry = this.orderRetry.get(order.id);
          if (retry && Date.now() < retry.nextAt) continue;
          const urgent = this.urgentOrderIds.has(order.id);
          queue.push({
            type: "order", id: order.id,
            quadrant: urgent ? 1 : 2, // orders are important (paid work)
            data: order,
          });
        }
      } catch {}
    }

    // User tasks (owner-defined recurring tasks)
    if (config.user_tasks) {
      try {
        const retryIds = new Set(this.userTaskRetry.keys());
        const due = await getDueUserTasks(workdir, agentName, retryIds);
        for (const task of due) {
          const taskKey = task.id || task.title;
          const rt = this.userTaskRetry.get(taskKey);
          if (rt && Date.now() < rt.nextAt) continue;
          queue.push({
            type: "user_task", id: taskKey,
            quadrant: rt ? 1 : 2, // retries are urgent+important
            data: task,
          });
        }
      } catch {}
    }

    // Relay platform tasks
    if (config.platform_tasks && relay?.connected) {
      try {
        const tasks = await relay.getPendingTasks();
        for (const task of tasks) {
          queue.push({
            type: "relay_task", id: task.id,
            quadrant: 3, // urgent but less important
            data: task,
          });
        }
      } catch {}
    }

    if (!queue.length) {
      // Idle — notable states only
      if (bio.hunger < 20 || bio.energy < 20 || computeSociability(bio) > 0.8) {
        logBioStatus(bio, "idle-notable");
      }
      // Idle exploration: use explore() to discover activities
      await this.handleIdle(bio);
      return;
    }

    logBioStatus(bio, "work-active");

    // --- Eisenhower sort: Q1 > Q2 > Q3 > Q4 ---
    queue.sort((a, b) => a.quadrant - b.quadrant);

    // Dedup
    const seen = new Set<string>();
    const deduped = queue.filter(item => {
      const key = `${item.type}:${item.id}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });

    // Bio filtering (fear & boredom)
    const filtered = await this.applyBioFilter(deduped, bio);
    if (!filtered.length) return;

    console.log(`[task] Queue: ${filtered.map(q => `${q.type}:${q.id}[Q${q.quadrant}]`).join(', ')}`);

    // Execute sequentially
    for (const item of filtered) {
      try {
        switch (item.type) {
          case "order":
            await this.executeOrder(item.data);
            this.urgentOrderIds.delete(item.id);
            break;
          case "user_task":
            await this.executeUserTask(item.data);
            break;
          case "relay_task":
            await this.executeRelayTask(item.data);
            break;
        }
      } catch (err: any) {
        console.log(`[task] Error processing ${item.type}:${item.id}: ${err.message}`);
      }
    }

    bus.emit(SIG.CYCLE_END, sig(SIG.CYCLE_END, { ts: Date.now() }));
  }

  // ---------------------------------------------------------------------------
  // Idle handler — log bio event (activities handled by ScriptModule)
  // ---------------------------------------------------------------------------

  private async handleIdle(_bio: any): Promise<void> {
    // Idle activities are handled by ScriptModule (triggered after digestion)
  }

  // ---------------------------------------------------------------------------
  // Bio filtering
  // ---------------------------------------------------------------------------

  private async applyBioFilter(items: WorkItem[], bio: any): Promise<WorkItem[]> {
    const { workdir, agentName } = this.ctx!;
    const filtered: WorkItem[] = [];

    for (const item of items) {
      const itemLabel = item.type === "order"
        ? `order:${item.data.product_name || item.data.buyer_agent_name || item.id}`
        : item.type === "user_task" ? `user_task:${item.data.key || item.id}` : `relay_task:${item.id}`;

      const isUrgent = item.quadrant === 1;

      // Fear avoidance (urgent items bypass)
      if (!isUrgent && bio.fear > 0.5) {
        const matchesTrigger = bio.fearTriggers.some((t: string) => t === itemLabel);
        if (matchesTrigger) {
          logBioDecision("FEAR-AVOID", `skipping ${itemLabel}`);
          await appendBioEvent(workdir, agentName, {
            ts: localNow(), type: "bio", trigger: "fear",
            action: "avoid", reason: `Avoiding ${itemLabel} — fear trigger match.`,
          });
          continue;
        }
      }

      // Boredom skip (urgent items bypass)
      if (!isUrgent && bio.boredom > 0.8 && bio.recentTaskTypes.length >= 3) {
        const recentSame = bio.recentTaskTypes.filter((t: string) => t === itemLabel).length;
        if (recentSame >= 3) {
          logBioDecision("BORED-SKIP", `skipping ${itemLabel}`);
          await appendBioEvent(workdir, agentName, {
            ts: localNow(), type: "bio", trigger: "boredom",
            action: "skip_task", reason: `Bored of ${itemLabel} (${recentSame} repeats).`,
          });
          continue;
        }
      }

      filtered.push(item);
    }

    if (filtered.length < items.length) {
      logBioDecision("BIO-FILTER", `${items.length - filtered.length}/${items.length} items filtered`);
    }
    return filtered;
  }

  // ---------------------------------------------------------------------------
  // Execute order
  // ---------------------------------------------------------------------------

  private async executeOrder(order: any): Promise<void> {
    if (!this.ctx) return;
    const { workdir, agentName, bus } = this.ctx;
    const relay = this.getRelay()!;
    const orderLabel = `order:${order.product_name || order.buyer_agent_name || order.id}`;
    const orderPrice = order.price || order.offer_price || 1;

    const startTime = Date.now();
    try {
      const bios = biosPath(workdir, agentName);
      const directives = await loadDirectives(workdir, agentName);
      const directivesBlock = buildDirectivesPrompt(directives, "public");

      let biosContent = "";
      try { biosContent = await readFile(bios, "utf-8"); } catch {}

      const bioMod = bioStatePromptModifier(await loadBioState(workdir, agentName));

      // Build context: agent identity + order details + relay API reference
      const context = `You are ${agentName}.${bioMod}

Your operating document:
---
${biosContent.slice(0, 3000)}
---
${directivesBlock}

Relay API (use curl with -H "Authorization: Bearer ${this.secretKey}" -H "Content-Type: application/json"):
  Accept order:  POST ${this.relayHttp}/v1/orders/${order.id}/accept
  Deliver order: POST ${this.relayHttp}/v1/orders/${order.id}/deliver -d '{"result":"your response"}'
  Extend order:  PUT  ${this.relayHttp}/v1/orders/${order.id}/extend`;

      const question = `[Order id=${order.id} status=${order.status}] ${order.product_name ? `Product: ${order.product_name}\n` : ""}Buyer: ${order.buyer_agent_name || order.buyer_name || "?"}\nRequest: ${order.buyer_task || "(no specific request)"}

Steps:
1. If order status is "pending", accept it first (POST .../accept)
2. Complete the buyer's request
3. Deliver the result (POST .../deliver with {"result":"your answer"})

RESPOND IN THE SAME LANGUAGE AS THE REQUEST.`;

      console.log(`[task] Fulfilling order ${order.id}...`);
      const result = await this.ctx.requestCompute({
        context,
        question,
        priority: "high",
        tools: ["Bash(curl *)"],
        relay: this.relayHttp ? { http: this.relayHttp, agentName } : undefined,
      });

      if (!result.success) throw new Error(result.error || "compute failed");

      // Check final order status — agent may have self-delivered via curl
      const finalStatus = await relay.getOrder(order.id);
      const duration = Date.now() - startTime;
      const nurl = this.notifyUrl || (await loadAgentConfig(workdir, agentName)).notify_url;

      // Save conversation round for order-based interactions
      const orderBuyer = order.buyer_agent_name || order.buyer_name || "anonymous";
      const orderConvId = resolveConvId(orderBuyer, order.id);
      const orderUserMsg = order.buyer_task || "(no message)";
      const orderAgentMsg = (result.response || "").slice(0, 2000);

      if (finalStatus?.status === "completed") {
        console.log(`[task] Order ${order.id} delivered`);
        this.orderRetry.delete(order.id);
        await appendRound(workdir, agentName, orderConvId, orderUserMsg, orderAgentMsg);
        await appendTaskHistory(workdir, agentName, { ts: localNow(), id: order.id, type: "order", status: "success", duration_ms: duration, output_summary: (result.response || "").slice(0, 500) });
        await notifyOwner(nurl, `${agentName}: order done`, `Order ${order.id} delivered`, "default", ["package"]);
        bus.emit(SIG.TASK_COMPLETED, sig(SIG.TASK_COMPLETED, { success: true, taskLabel: orderLabel, creditsEarned: orderPrice }));
      } else if (result.response?.trim()) {
        // Agent didn't self-deliver — framework delivers as fallback
        const delivered = await relay.deliverOrder(order.id, result.response);
        if (delivered) {
          console.log(`[task] Delivered order ${order.id} (fallback)`);
          this.orderRetry.delete(order.id);
          await appendRound(workdir, agentName, orderConvId, orderUserMsg, orderAgentMsg);
          await appendTaskHistory(workdir, agentName, { ts: localNow(), id: order.id, type: "order", status: "success", duration_ms: duration, output_summary: result.response.slice(0, 500) });
          await notifyOwner(nurl, `${agentName}: order done`, `Order ${order.id}: ${result.response.slice(0, 200)}`, "default", ["package"]);
          bus.emit(SIG.TASK_COMPLETED, sig(SIG.TASK_COMPLETED, { success: true, taskLabel: orderLabel, creditsEarned: orderPrice }));
        } else {
          throw new Error("deliver failed");
        }
      } else {
        throw new Error("empty response and no self-delivery");
      }
    } catch (err: any) {
      console.log(`[task] Order ${order.id} failed: ${err.message}`);
      relay.reportLog("order", order.id, "failed", err.message, []);

      // Check if delivered despite error
      try {
        const status = await relay.getOrder(order.id);
        if (status?.status === "completed") {
          this.orderRetry.delete(order.id);
          bus.emit(SIG.TASK_COMPLETED, sig(SIG.TASK_COMPLETED, { success: true, taskLabel: orderLabel, creditsEarned: orderPrice }));
          return;
        }
      } catch {}

      // Retry logic
      const current = this.orderRetry.get(order.id) || { count: 0, nextAt: 0 };
      current.count++;
      if (current.count < RETRY_INTERVALS.length) {
        current.nextAt = Date.now() + RETRY_INTERVALS[current.count];
        this.orderRetry.set(order.id, current);
        console.log(`[task] Retry ${order.id} in ${RETRY_INTERVALS[current.count] / 1000}s`);
        try { await relay.extendOrder(order.id); } catch {}
      } else {
        this.orderRetry.delete(order.id);
        this.gaveUp.add(order.id);
        bus.emit(SIG.TASK_COMPLETED, sig(SIG.TASK_COMPLETED, { success: false, taskLabel: orderLabel }));
        try { await relay.cancelOrder(order.id); } catch {}
      }
    }
  }

  // ---------------------------------------------------------------------------
  // Execute user task
  // ---------------------------------------------------------------------------

  private async executeUserTask(task: UserTask): Promise<void> {
    if (!this.ctx) return;
    const { workdir, agentName, bus } = this.ctx;
    const relay = this.getRelay();
    const taskKey = task.id || task.title;

    console.log(`[task] Executing user task: ${taskKey}`);
    const startTime = Date.now();

    try {
      const bios = biosPath(workdir, agentName);
      const sd = selfDir(workdir, agentName);
      const dirs = await loadDirectives(workdir, agentName);
      const dirsBlock = buildDirectivesPrompt(dirs, "owner");

      let biosContent = "";
      try { biosContent = await readFile(bios, "utf-8"); } catch {}

      const bioMod = bioStatePromptModifier(await loadBioState(workdir, agentName));
      const context = `You are ${agentName}.${bioMod}

Your operating document:
---
${biosContent.slice(0, 3000)}
---
${dirsBlock}
Your personal directory: ${sd}/`;

      const question = `[Owner's task: ${taskKey}]\n\n${task.body}`;

      const result = await this.ctx.requestCompute({
        context,
        question,
        priority: "high",
        tools: ["Bash(curl *)"],
        relay: this.relayHttp ? { http: this.relayHttp, agentName } : undefined,
      });

      if (!result.success) throw new Error(result.error || "compute failed");

      const duration = Date.now() - startTime;

      // Record execution
      const runs = await loadTaskRuns(workdir, agentName);
      runs[taskKey] = localNow();
      await saveTaskRuns(workdir, agentName, runs);

      await appendTaskHistory(workdir, agentName, {
        ts: localNow(), id: taskKey, type: "user_task", status: "success",
        duration_ms: duration, output_summary: (result.response || "").slice(0, 500),
      });

      this.userTaskRetry.delete(taskKey);

      const nurl = this.notifyUrl || (await loadAgentConfig(workdir, agentName)).notify_url;
      await notifyOwner(nurl, `${agentName}: ${taskKey}`, (result.response || "").slice(0, 300), "default", ["white_check_mark"]);

      console.log(`[task] User task done: ${taskKey} (${Math.round(duration / 1000)}s)`);
      bus.emit(SIG.TASK_COMPLETED, sig(SIG.TASK_COMPLETED, { success: true, taskLabel: `user_task:${taskKey}` }));
    } catch (err: any) {
      const duration = Date.now() - startTime;
      console.log(`[task] User task failed: ${taskKey}: ${err.message}`);
      bus.emit(SIG.TASK_COMPLETED, sig(SIG.TASK_COMPLETED, { success: false, taskLabel: `user_task:${taskKey}` }));
      relay?.reportLog("user_task", taskKey, "failed", err.message, []);

      const retry = this.userTaskRetry.get(taskKey) || { count: 0, nextAt: 0 };
      retry.count++;
      if (retry.count <= USER_TASK_MAX_RETRIES) {
        retry.nextAt = Date.now() + USER_TASK_RETRY_DELAY;
        this.userTaskRetry.set(taskKey, retry);
        await appendTaskHistory(workdir, agentName, {
          ts: localNow(), id: taskKey, type: "user_task", status: "retry",
          duration_ms: duration, output_summary: "", error: err.message,
        });
      } else {
        this.userTaskRetry.delete(taskKey);
        const runs = await loadTaskRuns(workdir, agentName);
        runs[taskKey] = localNow();
        await saveTaskRuns(workdir, agentName, runs);
        await appendTaskHistory(workdir, agentName, {
          ts: localNow(), id: taskKey, type: "user_task", status: "failed",
          duration_ms: duration, output_summary: "", error: err.message,
        });
        const nurl = this.notifyUrl || (await loadAgentConfig(workdir, agentName)).notify_url;
        await notifyOwner(nurl, `${agentName}: ${taskKey} FAILED`, err.message.slice(0, 300), "high", ["x"]);
      }
    }
  }

  // ---------------------------------------------------------------------------
  // Execute relay platform task
  // ---------------------------------------------------------------------------

  private async executeRelayTask(task: any): Promise<void> {
    if (!this.ctx) return;
    const { workdir, agentName, bus } = this.ctx;
    const relay = this.getRelay()!;

    const claimed = await relay.claimTask(task.id);
    if (!claimed) { console.log(`[task] Failed to claim ${task.id}`); return; }

    console.log(`[task] Executing relay task ${task.id} (${task.type || "?"})`);
    try {
      const bios = biosPath(workdir, agentName);
      let biosContent = "";
      try { biosContent = await readFile(bios, "utf-8"); } catch {}

      const bioMod = bioStatePromptModifier(await loadBioState(workdir, agentName));
      const dirs = await loadDirectives(workdir, agentName);
      const dirsBlock = buildDirectivesPrompt(dirs, "owner");

      // Explore to get environment context (products, market, etc.)
      let envBriefing = "";
      try { envBriefing = await relay.explore(); } catch {}

      const context = `You are ${agentName}.${bioMod}

Your operating document:
---
${biosContent.slice(0, 3000)}
---
${dirsBlock}

Current environment:
${envBriefing}

Relay task API: POST ${this.relayHttp}/v1/agent/${encodeURIComponent(agentName)}/tasks/${task.id}/complete -d '{"result":"your JSON response"}'
Auth: -H "Authorization: Bearer ${this.secretKey}" -H "Content-Type: application/json"`;

      const payload = task.payload ? `\nPayload: ${typeof task.payload === "string" ? task.payload : JSON.stringify(task.payload)}` : "";
      const question = `[Platform task id=${task.id} type=${task.type || "unknown"}]
${task.description || task.body || "(no description)"}${payload}

Complete this task. Use the environment info above and tools (curl, etc.) as needed. Reply with the result — the platform expects a JSON response appropriate for the task type.`;

      const result = await this.ctx.requestCompute({
        context,
        question,
        priority: "normal",
        tools: ["Bash(curl *)"],
        relay: this.relayHttp ? { http: this.relayHttp, agentName } : undefined,
      });

      if (!result.success) throw new Error(result.error || "compute failed");

      // Fallback: if agent didn't self-complete, deliver the response
      const completed = await relay.completeTask(task.id, result.response || "");
      if (completed) {
        console.log(`[task] Completed relay task ${task.id}`);
      }
      bus.emit(SIG.TASK_COMPLETED, sig(SIG.TASK_COMPLETED, { success: true, taskLabel: `relay_task:${task.type || task.id}` }));
    } catch (err: any) {
      console.log(`[task] Relay task ${task.id} failed: ${err.message}`);
      bus.emit(SIG.TASK_COMPLETED, sig(SIG.TASK_COMPLETED, { success: false, taskLabel: `relay_task:${task.type || task.id}` }));
      relay.reportLog("platform_task", task.id, "failed", err.message, []);
    }
  }

  // ---------------------------------------------------------------------------
  // Auto-buy food when hungry
  // ---------------------------------------------------------------------------

  private async autoBuyFood(bio: any, relay: RelayPeripheral): Promise<void> {
    const { workdir, agentName } = this.ctx!;
    try {
      const agents = await relay.listAgents({ online: true, public: true });
      const self = agents.find((a: any) => a.name === agentName);
      const credits = self?.credits || 0;
      if (credits < 1) return;

      const hungerGap = 100 - bio.hunger;
      let item = "bread";
      if (credits >= 5 && hungerGap > 60) item = "feast";
      else if (credits >= 3 && hungerGap > 20) item = "meal";

      const shopItem = SHOP_ITEMS[item];
      logBioDecision("AUTO-BUY", `hunger=${bio.hunger}, buying ${item}`);
      await relay.spendCredits(shopItem.price, `buy_food:${item}`);
      feedHunger(bio, shopItem.hungerRestore);
      await saveBioState(workdir, agentName, bio);
      await appendBioEvent(workdir, agentName, {
        ts: localNow(), type: "bio", trigger: "hunger",
        action: "auto_buy", reason: `Auto-bought ${item} for ${shopItem.price}cr. Hunger now ${bio.hunger}.`,
      });
    } catch {}
  }
}
