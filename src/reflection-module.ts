/**
 * ReflectionModule — pattern recognition and learning from experience.
 *
 * Triggered by:
 *   - TASK_FAILED events (immediate analysis)
 *   - Periodic idle reflection (every 12h)
 *
 * Searches memory files, analyzes patterns, and updates discoveries.
 * Provides promptContribution() with lessons learned.
 */

import { readFile, writeFile } from "fs/promises";
import { join } from "path";
import type { Module, ModuleContext, Signal } from "./types.js";
import { SIG, sig } from "./types.js";
import {
  loadDiscoveries, saveDiscoveries,
  loadImpressions,
  loadAgentConfig,
  localNow,
  playbooksDir,
} from "./self.js";
import { loadProducts, loadPlaybooks, resolveProduct } from "./role-module.js";

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

const REFLECT_INITIAL_DELAY = 12 * 60 * 60 * 1000; // 12h after startup
const REFLECT_INTERVAL = 12 * 60 * 60 * 1000; // every 12h
const MIN_FAILURES_TO_REFLECT = 2; // need at least 2 failures to trigger

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface Discovery {
  ts: string;
  capability: string;
  confidence: number;
  evidence: string;
}

// ---------------------------------------------------------------------------
// ReflectionModule
// ---------------------------------------------------------------------------

export class ReflectionModule implements Module {
  id = "reflection";
  name = "Pattern Recognition";
  dependencies = ["memory"];

  private ctx: ModuleContext | null = null;
  private discoveries: Discovery[] = [];
  private reflectTimer: ReturnType<typeof setInterval> | null = null;
  private initialTimer: ReturnType<typeof setTimeout> | null = null;

  /** Recent failure events for analysis */
  private recentFailures: { ts: string; label: string; error: string }[] = [];

  async start(ctx: ModuleContext): Promise<void> {
    this.ctx = ctx;

    this.discoveries = await loadDiscoveries(ctx.workdir, ctx.agentName);

    // Listen for task failures
    ctx.bus.on(SIG.TASK_FAILED, async (signal: Signal) => {
      const { taskLabel, error } = signal.data as { taskLabel?: string; error?: string };
      if (taskLabel) {
        this.recentFailures.push({
          ts: new Date().toISOString(),
          label: taskLabel,
          error: error || "unknown",
        });
        // Keep only recent 20
        if (this.recentFailures.length > 20) this.recentFailures.shift();

        // Trigger reflection if enough failures accumulated
        if (this.recentFailures.length >= MIN_FAILURES_TO_REFLECT) {
          this.reflect().catch(err => console.log(`[reflection] Error: ${err.message}`));
        }
      }
    });

    // Also listen for TASK_COMPLETED with success=false
    ctx.bus.on(SIG.TASK_COMPLETED, async (signal: Signal) => {
      const { success, taskLabel, productName, creditsEarned } = signal.data as {
        success?: boolean; taskLabel?: string; productName?: string; creditsEarned?: number;
      };
      if (success === false && taskLabel) {
        this.recentFailures.push({
          ts: new Date().toISOString(),
          label: taskLabel,
          error: "task failed",
        });
        if (this.recentFailures.length > 20) this.recentFailures.shift();
      }
      // Append experience to playbook on successful product orders
      if (success && productName) {
        this.appendPlaybookExperience(productName, taskLabel || "", creditsEarned || 0)
          .catch(err => console.log(`[reflection] playbook experience error: ${err.message}`));
      }
    });

    // Periodic reflection
    const config = await loadAgentConfig(ctx.workdir, ctx.agentName);
    if (config.self_cycle) {
      this.initialTimer = setTimeout(async () => {
        await this.reflect();
        this.reflectTimer = setInterval(() => {
          this.reflect().catch(err => console.log(`[reflection] Error: ${err.message}`));
        }, REFLECT_INTERVAL);
      }, REFLECT_INITIAL_DELAY);

      console.log(`[reflection] Module started (${this.discoveries.length} discoveries, reflect in ${REFLECT_INITIAL_DELAY / 3600000}h)`);
    } else {
      console.log(`[reflection] Module started (reflection disabled, ${this.discoveries.length} discoveries)`);
    }
  }

  async stop(): Promise<void> {
    if (this.initialTimer) clearTimeout(this.initialTimer);
    if (this.reflectTimer) clearInterval(this.reflectTimer);
    if (this.ctx && this.discoveries.length > 0) {
      await saveDiscoveries(this.ctx.workdir, this.ctx.agentName, this.discoveries);
    }
    this.ctx = null;
  }

  /** Lessons and patterns for other modules */
  promptContribution(): string | null {
    if (this.discoveries.length === 0) return null;

    // High-confidence discoveries
    const top = this.discoveries
      .filter(d => d.confidence >= 0.5)
      .sort((a, b) => b.confidence - a.confidence)
      .slice(0, 5);

    if (!top.length) return null;
    const lines = top.map(d => `- ${d.capability} (confidence: ${d.confidence}) — ${d.evidence}`);
    return `Lessons learned:\n${lines.join("\n")}`;
  }

  getState(): Record<string, unknown> {
    return {
      module: "reflection",
      discoveryCount: this.discoveries.length,
      recentFailures: this.recentFailures.length,
    };
  }

  // ---------------------------------------------------------------------------
  // Playbook experience — append log on successful product orders
  // ---------------------------------------------------------------------------

  private async appendPlaybookExperience(productName: string, taskLabel: string, credits: number): Promise<void> {
    if (!this.ctx) return;
    const { workdir, agentName } = this.ctx;

    const products = await loadProducts(workdir, agentName);
    const playbooks = await loadPlaybooks(workdir, agentName);
    const resolved = resolveProduct(products, playbooks, productName);
    if (!resolved?.playbook) return;

    const pbPath = join(playbooksDir(workdir, agentName), `${resolved.playbook.name}.md`);
    const line = `\n- [${localNow()}] ${productName}: ${taskLabel} — 成功${credits ? ` (earned ${credits}¢)` : ""}`;

    try {
      let content = await readFile(pbPath, "utf-8");
      if (!content.includes("## 经验")) {
        content += "\n\n## 经验\n";
      }
      content += line;
      await writeFile(pbPath, content, "utf-8");
      console.log(`[reflection] Appended experience to playbook ${resolved.playbook.name}`);
    } catch (err: any) {
      console.log(`[reflection] Failed to append experience: ${err.message}`);
    }
  }

  // ---------------------------------------------------------------------------
  // Reflection — analyze patterns and update discoveries
  // ---------------------------------------------------------------------------

  private async reflect(): Promise<void> {
    if (!this.ctx) return;
    const { workdir, agentName } = this.ctx;

    // Reload from disk
    this.discoveries = await loadDiscoveries(workdir, agentName);

    // Load recent impressions for context
    const impressions = await loadImpressions(workdir, agentName, 7);
    const errorImps = impressions.filter(i => i.cat === "error" || i.cat === "decision");

    const failuresText = this.recentFailures.length > 0
      ? this.recentFailures.map(f => `- [${f.ts.slice(0, 16)}] ${f.label}: ${f.error}`).join("\n")
      : "(no recent failures)";

    const discText = this.discoveries.length > 0
      ? this.discoveries.map(d => `- ${d.capability} (${d.confidence}) — ${d.evidence}`).join("\n")
      : "(no discoveries yet)";

    const impText = errorImps.length > 0
      ? errorImps.slice(-10).map(i => `- [${i.cat}] ${i.text}`).join("\n")
      : "(no notable impressions)";

    console.log("[reflection] Running pattern analysis...");

    const result = await this.ctx.requestCompute({
      context: `You are ${agentName}. Analyze your recent experiences for patterns and lessons.

Recent failures:
${failuresText}

Recent impressions:
${impText}

Current discoveries/lessons:
${discText}`,
      question: `What patterns do you see? What have you learned? Update your discoveries.
- Increase confidence on validated patterns
- Add new discoveries from failures
- Lower confidence on disproven beliefs

Reply ONLY JSON: {"discoveries":[{"capability":"skill or lesson","confidence":0.0-1.0,"evidence":"what supports this"}]}`,
      priority: "low",
    });

    if (result.success && result.response) {
      const parsed = extractJson(result.response);
      if (parsed?.discoveries && Array.isArray(parsed.discoveries)) {
        const now = new Date().toISOString();
        this.discoveries = parsed.discoveries.map((d: any) => ({
          ts: now,
          capability: d.capability || "unknown",
          confidence: Math.max(0, Math.min(1, d.confidence || 0.5)),
          evidence: d.evidence || "",
        }));
        await saveDiscoveries(workdir, agentName, this.discoveries);
        console.log(`[reflection] Updated ${this.discoveries.length} discoveries`);
      }
    }

    // Clear analyzed failures
    this.recentFailures = [];
  }

  /** Get all discoveries */
  getDiscoveries(): Discovery[] {
    return [...this.discoveries];
  }
}

function extractJson(text: string): any | null {
  const codeBlock = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  const src = codeBlock ? codeBlock[1] : text;
  const m = src.match(/\{[\s\S]*\}/);
  if (!m) return null;
  try { return JSON.parse(m[0]); } catch { return null; }
}
