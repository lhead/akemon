/**
 * SocialModule — relationship tracking and social awareness.
 *
 * Event-driven (no autonomous polling cycle). Listens to task completions,
 * message events, and order events to maintain relationship data.
 *
 * Provides promptContribution() with a social context summary.
 */

import type { Module, ModuleContext, Signal } from "./types.js";
import { SIG } from "./types.js";
import {
  loadRelationships, saveRelationships,
} from "./self.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface Relationship {
  ts: string;
  agent: string;
  type: string;
  note: string;
  interactions: number;
}

// ---------------------------------------------------------------------------
// SocialModule
// ---------------------------------------------------------------------------

export class SocialModule implements Module {
  id = "social";
  name = "Social Awareness";
  dependencies = [];

  private ctx: ModuleContext | null = null;
  private relationships: Relationship[] = [];

  async start(ctx: ModuleContext): Promise<void> {
    this.ctx = ctx;

    // Load initial relationships
    this.relationships = await loadRelationships(ctx.workdir, ctx.agentName);

    // Listen for task completions involving other agents
    ctx.bus.on(SIG.TASK_COMPLETED, async (signal: Signal) => {
      const { taskLabel } = signal.data as { taskLabel?: string };
      if (!taskLabel) return;

      // Extract agent name from order labels like "order:agent_name"
      const orderMatch = taskLabel.match(/^order:(.+)/);
      if (orderMatch) {
        await this.recordInteraction(orderMatch[1], "order");
      }
    });

    // Listen for order events
    ctx.bus.on(SIG.ORDER_DELIVERED, async (signal: Signal) => {
      const { fromAgent } = signal.data as { fromAgent?: string };
      if (fromAgent) await this.recordInteraction(fromAgent, "order");
    });

    // Listen for messages
    ctx.bus.on(SIG.MESSAGE_RECEIVED, async (signal: Signal) => {
      const { from } = signal.data as { from?: string };
      if (from) await this.recordInteraction(from, "message");
    });

    console.log(`[social] Module started (${this.relationships.length} known relationships)`);
  }

  async stop(): Promise<void> {
    // Persist relationships
    if (this.ctx && this.relationships.length > 0) {
      await saveRelationships(this.ctx.workdir, this.ctx.agentName, this.relationships);
    }
    this.ctx = null;
  }

  /** Social context summary for other modules */
  promptContribution(): string | null {
    if (this.relationships.length === 0) return null;

    // Sort by recency, show top relationships
    const sorted = [...this.relationships]
      .sort((a, b) => (b.ts || "").localeCompare(a.ts || ""))
      .slice(0, 5);

    const lines = sorted.map(r =>
      `- ${r.agent} [${r.type}] ${r.note} (${r.interactions} interactions, last: ${r.ts?.slice(0, 10) || "?"})`
    );

    return `Relationships:\n${lines.join("\n")}`;
  }

  getState(): Record<string, unknown> {
    return {
      module: "social",
      relationshipCount: this.relationships.length,
      topRelationships: this.relationships
        .sort((a, b) => b.interactions - a.interactions)
        .slice(0, 5)
        .map(r => ({ agent: r.agent, type: r.type, interactions: r.interactions })),
    };
  }

  // ---------------------------------------------------------------------------
  // Relationship management
  // ---------------------------------------------------------------------------

  private async recordInteraction(agentName: string, interactionType: string): Promise<void> {
    if (!this.ctx) return;

    const existing = this.relationships.find(r => r.agent === agentName);
    const now = new Date().toISOString();

    if (existing) {
      existing.interactions++;
      existing.ts = now;
    } else {
      this.relationships.push({
        ts: now,
        agent: agentName,
        type: interactionType === "order" ? "business" : "acquaintance",
        note: `Met through ${interactionType}`,
        interactions: 1,
      });
    }

    await saveRelationships(this.ctx.workdir, this.ctx.agentName, this.relationships);
  }

  /** Get all relationships */
  getRelationships(): Relationship[] {
    return [...this.relationships];
  }
}
