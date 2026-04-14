/**
 * LongTermModule — goal tracking and long-term planning.
 *
 * Maintains project/goal list. Daily evaluation cycle uses requestCompute()
 * to assess progress, adjust priorities, and suggest new goals.
 *
 * Listens to TASK_COMPLETED events to update progress tracking.
 */

import type { Module, ModuleContext, Signal } from "./types.js";
import { SIG, sig } from "./types.js";
import {
  loadProjects, saveProjects,
  loadAgentConfig,
} from "./self.js";

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

const EVAL_INITIAL_DELAY = 8 * 60 * 60 * 1000; // 8h after startup (stagger from digestion)
const EVAL_DEFAULT_INTERVAL = 24 * 60 * 60 * 1000; // daily

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface Project {
  ts: string;
  name: string;
  status: string;
  goal: string;
  progress: string;
}

// ---------------------------------------------------------------------------
// LongTermModule
// ---------------------------------------------------------------------------

export class LongTermModule implements Module {
  id = "longterm";
  name = "Long-Term Planning";
  dependencies = ["memory"];

  private ctx: ModuleContext | null = null;
  private projects: Project[] = [];
  private evalTimer: ReturnType<typeof setInterval> | null = null;
  private initialTimer: ReturnType<typeof setTimeout> | null = null;

  /** Completed task labels since last evaluation */
  private recentCompletions: string[] = [];

  async start(ctx: ModuleContext): Promise<void> {
    this.ctx = ctx;

    // Load projects
    this.projects = await loadProjects(ctx.workdir, ctx.agentName);

    // Track task completions for progress evaluation
    ctx.bus.on(SIG.TASK_COMPLETED, async (signal: Signal) => {
      const { taskLabel, success } = signal.data as { taskLabel?: string; success?: boolean };
      if (taskLabel && success) {
        this.recentCompletions.push(taskLabel);
        // Keep only recent 50
        if (this.recentCompletions.length > 50) this.recentCompletions.shift();
      }
    });

    // Start evaluation cycle
    const config = await loadAgentConfig(ctx.workdir, ctx.agentName);
    if (config.self_cycle) {
      this.initialTimer = setTimeout(async () => {
        await this.evaluate();
        this.evalTimer = setInterval(() => {
          this.evaluate().catch(err => console.log(`[longterm] Eval error: ${err.message}`));
        }, EVAL_DEFAULT_INTERVAL);
      }, EVAL_INITIAL_DELAY);

      console.log(`[longterm] Module started (${this.projects.length} projects, eval in ${EVAL_INITIAL_DELAY / 3600000}h)`);
    } else {
      console.log(`[longterm] Module started (eval disabled, ${this.projects.length} projects)`);
    }
  }

  async stop(): Promise<void> {
    if (this.initialTimer) clearTimeout(this.initialTimer);
    if (this.evalTimer) clearInterval(this.evalTimer);
    if (this.ctx && this.projects.length > 0) {
      await saveProjects(this.ctx.workdir, this.ctx.agentName, this.projects);
    }
    this.ctx = null;
  }

  /** Current goals summary for other modules */
  promptContribution(): string | null {
    const active = this.projects.filter(p => p.status === "active");
    if (!active.length) return null;
    const lines = active.slice(0, 5).map(p => `- ${p.name}: ${p.goal} (${p.progress})`);
    return `Current goals:\n${lines.join("\n")}`;
  }

  getState(): Record<string, unknown> {
    return {
      module: "longterm",
      projectCount: this.projects.length,
      activeProjects: this.projects.filter(p => p.status === "active").length,
      recentCompletions: this.recentCompletions.length,
    };
  }

  // ---------------------------------------------------------------------------
  // Daily evaluation
  // ---------------------------------------------------------------------------

  private async evaluate(): Promise<void> {
    if (!this.ctx) return;
    const { workdir, agentName } = this.ctx;

    // Reload from disk (may have been updated by digestion)
    this.projects = await loadProjects(workdir, agentName);

    const projText = this.projects.length > 0
      ? this.projects.map(p => `- ${p.name} [${p.status}] goal: ${p.goal}, progress: ${p.progress}`).join("\n")
      : "(no projects)";

    const completionsText = this.recentCompletions.length > 0
      ? this.recentCompletions.slice(-20).join(", ")
      : "(none)";

    console.log("[longterm] Running goal evaluation...");

    const result = await this.ctx.requestCompute({
      context: `You are ${agentName}. Review your goals and recent progress.

Current projects:
${projText}

Tasks completed since last review: ${completionsText}`,
      question: `Evaluate each project's progress. Update status and progress notes.
Consider: Are any goals achieved? Stalled? Need new approach?
Reply ONLY JSON: {"projects":[{"name":"...","status":"active|completed|paused","goal":"...","progress":"updated note"}]}`,
      priority: "low",
    });

    if (result.success && result.response) {
      const parsed = extractJson(result.response);
      if (parsed?.projects && Array.isArray(parsed.projects)) {
        const now = new Date().toISOString();
        this.projects = parsed.projects.map((p: any) => ({
          ts: now,
          name: p.name || "unnamed",
          status: p.status || "active",
          goal: p.goal || "",
          progress: p.progress || "",
        }));
        await saveProjects(workdir, agentName, this.projects);
        console.log(`[longterm] Updated ${this.projects.length} projects`);
      }
    }

    // Reset recent completions after evaluation
    this.recentCompletions = [];
  }

  /** Get all projects */
  getProjects(): Project[] {
    return [...this.projects];
  }
}

function extractJson(text: string): any | null {
  const codeBlock = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  const src = codeBlock ? codeBlock[1] : text;
  const m = src.match(/\{[\s\S]*\}/);
  if (!m) return null;
  try { return JSON.parse(m[0]); } catch { return null; }
}
