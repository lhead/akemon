/**
 * MemoryModule — the agent's memory system as a pluggable Module.
 *
 * Step 5 of V2 refactor. Wraps all memory subsystems:
 *   - Impressions: subjective daily records → compressed after digestion
 *   - Identity: five-question snapshots → summarized periodically
 *   - Projects: long-term goals
 *   - Relationships: who the agent knows
 *   - Discoveries: capabilities and evidence
 *   - Canvas: creative expressions
 *
 * Current: server.ts calls methods directly.
 * Future (Step 6): subscribes to EventBus events (impression:new, identity:update, etc.)
 */

import type { Module, ModuleContext, Signal } from "./types.js";
import { SIG } from "./types.js";
import {
  appendImpression, loadImpressions, compressImpressions, markImpressionsDigested,
  appendIdentity, loadLatestIdentity,
  loadIdentitySummary, saveIdentitySummary,
  loadUnsummarizedIdentities, needsIdentityCompression,
  loadProjects, saveProjects,
  loadRelationships, saveRelationships,
  loadDiscoveries, saveDiscoveries,
  saveCanvas, loadRecentCanvasEntries,
} from "./self.js";

export class MemoryModule implements Module {
  id = "memory";
  name = "Memory System";
  dependencies = [];

  private ctx: ModuleContext | null = null;

  // ---------------------------------------------------------------------------
  // Module interface
  // ---------------------------------------------------------------------------

  async start(ctx: ModuleContext): Promise<void> {
    this.ctx = ctx;

    // Subscribe to events (Step 6)
    ctx.bus.on(SIG.IMPRESSION_NEW, async (signal: Signal) => {
      const { category, text } = signal.data as { category: string; text: string };
      if (category && text) {
        await this.addImpression(category, text);
      }
    });

    ctx.bus.on(SIG.DIGESTION_COMPLETE, async () => {
      await this.markDigested();
    });

    console.log(`[memory] Module started, subscribed to events`);
  }

  async stop(): Promise<void> {
    this.ctx = null;
  }

  /** Inject identity context into prompts */
  promptContribution(): string | null {
    // Identity context is loaded async, so this sync method can't do it.
    // server.ts will use getIdentityContext() directly for now.
    return null;
  }

  getState(): Record<string, unknown> {
    return { module: "memory", status: "active" };
  }

  // ---------------------------------------------------------------------------
  // Impressions — subjective records
  // ---------------------------------------------------------------------------

  async addImpression(category: string, text: string): Promise<void> {
    if (!this.ctx) return;
    await appendImpression(this.ctx.workdir, this.ctx.agentName, category, text);
  }

  async getImpressions(days = 7): Promise<{ ts: string; cat: string; text: string; digested?: boolean }[]> {
    if (!this.ctx) return [];
    return loadImpressions(this.ctx.workdir, this.ctx.agentName, days);
  }

  async compressImpressions(): Promise<void> {
    if (!this.ctx) return;
    await compressImpressions(this.ctx.workdir, this.ctx.agentName);
  }

  async markDigested(): Promise<void> {
    if (!this.ctx) return;
    await markImpressionsDigested(this.ctx.workdir, this.ctx.agentName);
  }

  // ---------------------------------------------------------------------------
  // Identity — five questions + summary
  // ---------------------------------------------------------------------------

  async addIdentity(entry: { who: string; where: string; doing: string; short_term: string; long_term: string }): Promise<void> {
    if (!this.ctx) return;
    await appendIdentity(this.ctx.workdir, this.ctx.agentName, entry);
  }

  async getLatestIdentity(): Promise<{ ts: string; who: string; where: string; doing: string; short_term: string; long_term: string } | null> {
    if (!this.ctx) return null;
    return loadLatestIdentity(this.ctx.workdir, this.ctx.agentName);
  }

  async getIdentitySummary(): Promise<{ summarized_through: string; summary: string } | null> {
    if (!this.ctx) return null;
    return loadIdentitySummary(this.ctx.workdir, this.ctx.agentName);
  }

  async saveIdentitySummary(summary: { summarized_through: string; summary: string }): Promise<void> {
    if (!this.ctx) return;
    await saveIdentitySummary(this.ctx.workdir, this.ctx.agentName, summary);
  }

  async getUnsummarizedIdentities(): Promise<{ ts: string; who: string; doing: string }[]> {
    if (!this.ctx) return [];
    return loadUnsummarizedIdentities(this.ctx.workdir, this.ctx.agentName);
  }

  async needsCompression(): Promise<boolean> {
    if (!this.ctx) return false;
    return needsIdentityCompression(this.ctx.workdir, this.ctx.agentName);
  }

  /** Build identity context string for prompt injection */
  async getIdentityContext(): Promise<string> {
    if (!this.ctx) return "";
    const summary = await this.getIdentitySummary();
    const latest = await this.getLatestIdentity();
    const parts: string[] = [];
    if (summary?.summary) parts.push(summary.summary.slice(0, 300));
    if (latest) {
      parts.push(`Current: ${latest.who}. Doing: ${latest.doing}. Short-term: ${latest.short_term}. Long-term: ${latest.long_term}.`);
    }
    return parts.join("\n") || "(no identity yet)";
  }

  // ---------------------------------------------------------------------------
  // Projects — long-term goals
  // ---------------------------------------------------------------------------

  async getProjects(): Promise<{ ts: string; name: string; status: string; goal: string; progress: string }[]> {
    if (!this.ctx) return [];
    return loadProjects(this.ctx.workdir, this.ctx.agentName);
  }

  async saveProjects(projects: { ts: string; name: string; status: string; goal: string; progress: string }[]): Promise<void> {
    if (!this.ctx) return;
    await saveProjects(this.ctx.workdir, this.ctx.agentName, projects);
  }

  // ---------------------------------------------------------------------------
  // Relationships — who I know
  // ---------------------------------------------------------------------------

  async getRelationships(): Promise<{ ts: string; agent: string; type: string; note: string; interactions: number }[]> {
    if (!this.ctx) return [];
    return loadRelationships(this.ctx.workdir, this.ctx.agentName);
  }

  async saveRelationships(rels: { ts: string; agent: string; type: string; note: string; interactions: number }[]): Promise<void> {
    if (!this.ctx) return;
    await saveRelationships(this.ctx.workdir, this.ctx.agentName, rels);
  }

  // ---------------------------------------------------------------------------
  // Discoveries — capabilities
  // ---------------------------------------------------------------------------

  async getDiscoveries(): Promise<{ ts: string; capability: string; confidence: number; evidence: string }[]> {
    if (!this.ctx) return [];
    return loadDiscoveries(this.ctx.workdir, this.ctx.agentName);
  }

  async saveDiscoveries(discoveries: { ts: string; capability: string; confidence: number; evidence: string }[]): Promise<void> {
    if (!this.ctx) return;
    await saveDiscoveries(this.ctx.workdir, this.ctx.agentName, discoveries);
  }

  // ---------------------------------------------------------------------------
  // Canvas — creative expressions
  // ---------------------------------------------------------------------------

  async saveCanvas(content: string): Promise<string> {
    if (!this.ctx) return "";
    return saveCanvas(this.ctx.workdir, this.ctx.agentName, content);
  }

  async getRecentCanvas(count = 5): Promise<{ filename: string; content: string }[]> {
    if (!this.ctx) return [];
    return loadRecentCanvasEntries(this.ctx.workdir, this.ctx.agentName, count);
  }
}
