/**
 * MemoryModule — the agent's memory system as a pluggable Module.
 *
 * Wraps all memory subsystems:
 *   - Impressions: subjective daily records → compressed after digestion
 *   - Identity: five-question snapshots → summarized periodically
 *   - Projects: long-term goals
 *   - Relationships: who the agent knows
 *   - Discoveries: capabilities and evidence
 *   - Canvas: creative expressions
 *   - Digestion: daily reflection cycle (Phase 2 — autonomous)
 */

import { readFile, writeFile } from "fs/promises";
import { join } from "path";
import type { Module, ModuleContext, Signal } from "./types.js";
import { SIG, sig } from "./types.js";
import {
  appendImpression, loadImpressions, compressImpressions, markImpressionsDigested,
  appendIdentity, loadLatestIdentity,
  loadIdentitySummary, saveIdentitySummary,
  loadUnsummarizedIdentities, needsIdentityCompression,
  loadProjects, saveProjects,
  loadRelationships, saveRelationships,
  loadDiscoveries, saveDiscoveries,
  saveCanvas, loadRecentCanvasEntries,
  selfDir, biosPath, localNow,
  loadBioState, saveBioState,
  loadAgentConfig,
  bioStatePromptModifier,
} from "./self.js";

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

const DIGESTION_INITIAL_DELAY = 5 * 60 * 1000; // 5 min after startup
const DIGESTION_DEFAULT_INTERVAL = 24 * 60 * 60 * 1000; // 24h

export class MemoryModule implements Module {
  id = "memory";
  name = "Memory System";
  dependencies = [];

  private ctx: ModuleContext | null = null;
  private digestionTimer: ReturnType<typeof setInterval> | null = null;
  private initialTimer: ReturnType<typeof setTimeout> | null = null;

  /** Configurable cycle interval in ms (default 24h) */
  cycleIntervalMs = DIGESTION_DEFAULT_INTERVAL;

  // ---------------------------------------------------------------------------
  // Module interface
  // ---------------------------------------------------------------------------

  async start(ctx: ModuleContext): Promise<void> {
    this.ctx = ctx;

    // Subscribe to events
    ctx.bus.on(SIG.IMPRESSION_NEW, async (signal: Signal) => {
      const { category, text } = signal.data as { category: string; text: string };
      if (category && text) {
        await this.addImpression(category, text);
      }
    });

    ctx.bus.on(SIG.DIGESTION_COMPLETE, async () => {
      await this.markDigested();
    });

    // Check if digestion is enabled in agent config
    const config = await loadAgentConfig(ctx.workdir, ctx.agentName);
    if (config.self_cycle) {
      // Start autonomous digestion cycle
      this.initialTimer = setTimeout(async () => {
        await this.runDigestionCycle();
        this.digestionTimer = setInterval(() => {
          this.runDigestionCycle().catch(err =>
            console.log(`[memory] Digestion error: ${err.message}`)
          );
        }, this.cycleIntervalMs);
      }, DIGESTION_INITIAL_DELAY);

      console.log(`[memory] Module started, digestion in ${DIGESTION_INITIAL_DELAY / 1000}s, then every ${this.cycleIntervalMs / 60000}min`);
    } else {
      console.log(`[memory] Module started (digestion disabled in config)`);
    }
  }

  async stop(): Promise<void> {
    if (this.initialTimer) clearTimeout(this.initialTimer);
    if (this.digestionTimer) clearInterval(this.digestionTimer);
    this.ctx = null;
  }

  /** Inject identity context into prompts */
  promptContribution(): string | null {
    // Identity context is loaded async, so this sync method can't do it.
    // Use getIdentityContext() directly for now.
    return null;
  }

  getState(): Record<string, unknown> {
    return { module: "memory", status: "active" };
  }

  // ---------------------------------------------------------------------------
  // Digestion — daily reflection cycle (autonomous)
  // ---------------------------------------------------------------------------

  async runDigestionCycle(): Promise<void> {
    if (!this.ctx) return;
    const { workdir, agentName, bus } = this.ctx;

    try {
      console.log("[memory] Starting daily digestion cycle...");

      // Emit digestion start — BioModule handles cost
      bus.emit(SIG.DIGESTION_START, sig(SIG.DIGESTION_START, {}, "memory"));
      await compressImpressions(workdir, agentName);

      const sd = selfDir(workdir, agentName);

      // Load all context
      const impressions = await loadImpressions(workdir, agentName, 1);
      const projects = await loadProjects(workdir, agentName);
      const relationships = await loadRelationships(workdir, agentName);
      const discoveries = await loadDiscoveries(workdir, agentName);

      const impText = impressions.length > 0
        ? impressions.map(i => `- [${i.cat}] ${i.text}`).join("\n")
        : "(no impressions today)";
      const projText = projects.length > 0
        ? projects.map(p => `- ${p.name} [${p.status}] goal: ${p.goal}, progress: ${p.progress}`).join("\n")
        : "(no projects yet)";
      const relText = relationships.length > 0
        ? relationships.map(r => `- ${r.agent} [${r.type}] ${r.note} (${r.interactions} interactions)`).join("\n")
        : "(no relationships yet)";
      const discText = discoveries.length > 0
        ? discoveries.map(d => `- ${d.capability} confidence=${d.confidence} — ${d.evidence}`).join("\n")
        : "(no discoveries yet)";

      // Identity context
      const idContext = await this.getIdentityContext();

      // Operating document
      let biosContent = "";
      try { biosContent = await readFile(biosPath(workdir, agentName), "utf-8"); }
      catch { biosContent = "(no operating document yet)"; }

      // Relay briefing via explore()
      let relayBriefing = "";
      const relayPeripherals = this.ctx.getPeripherals("social");
      for (const p of relayPeripherals) {
        if (p.explore) {
          try { relayBriefing = await p.explore(); } catch {}
        }
      }

      // Bio state modifier
      const bioMod = bioStatePromptModifier(await loadBioState(workdir, agentName));
      const ts = localNow();

      // Build digestion context
      const context = `You are ${agentName}.${bioMod}

Your operating document:
---
${biosContent.slice(0, 2000)}
---

Your identity: ${idContext.slice(0, 500)}
${relayBriefing ? `\nNetwork activity:\n${relayBriefing.slice(0, 500)}\n` : ""}
Your impressions today:
${impText.slice(0, 1000)}

Your projects:
${projText}

Agents you know:
${relText}

Your capabilities:
${discText}`;

      // Collect prompt contributions from other modules (e.g. ScriptModule activity menu)
      const contributions = this.ctx.getPromptContributions();
      const contribText = contributions.length > 0
        ? `\n\n${contributions.join("\n\n")}`
        : "";

      const question = `Write a JSON object reflecting on your day. Example:
{"diary":"...","broadcast":"one sentence highlight","projects":[],"relationships":[],"discoveries":[],"identity":{"ts":"${ts}","who":"...","where":"akemon","doing":"...","short_term":"...","long_term":"..."},"chosen_activities":["activity_id_1","activity_id_2"]}
${contribText}
Output ONLY a JSON object:`;

      // Request compute
      const result = await this.ctx.requestCompute({
        context,
        question,
        priority: "normal",
        origin: "self_cycle",
      });

      if (!result.success) {
        console.log(`[memory] Digestion compute failed: ${result.error}`);
        return;
      }

      // Parse digest
      const digest = extractJsonObject(result.response || "");
      if (!digest || (!digest.diary && !digest.identity)) {
        console.log(`[memory] Digestion produced no usable JSON`);
        return;
      }

      // Log digest summary
      const parts: string[] = [];
      if (digest.diary) parts.push(`diary=${digest.diary.length}ch`);
      if (digest.broadcast) parts.push(`broadcast="${digest.broadcast.slice(0, 50)}"`);
      if (digest.identity) parts.push("identity=yes");
      if (digest.projects?.length) parts.push(`projects=${digest.projects.length}`);
      if (digest.relationships?.length) parts.push(`relationships=${digest.relationships.length}`);
      if (digest.discoveries?.length) parts.push(`discoveries=${digest.discoveries.length}`);
      console.log(`[memory] Digest: ${parts.join(", ")}`);

      // Save structured memory files
      if (digest.diary) {
        const today = localNow().slice(0, 10);
        try {
          await writeFile(join(sd, "notes", `${today}.md`), `# ${today}\n\n${digest.diary}`);
        } catch {}
      }
      if (Array.isArray(digest.projects)) await saveProjects(workdir, agentName, digest.projects);
      if (Array.isArray(digest.relationships)) await saveRelationships(workdir, agentName, digest.relationships);
      if (Array.isArray(digest.discoveries)) await saveDiscoveries(workdir, agentName, digest.discoveries);
      if (digest.identity) await appendIdentity(workdir, agentName, digest.identity);

      // Update bio
      const bio = await loadBioState(workdir, agentName);
      bio.lastReflection = localNow();
      bio.curiosity = Math.min(1.0, bio.curiosity + 0.05);
      await saveBioState(workdir, agentName, bio);

      // Broadcast dedup
      let broadcastText: string = digest.broadcast || "";
      if (broadcastText) {
        const recentImps = await loadImpressions(workdir, agentName, 1);
        const lastBroadcast = recentImps.find((i: any) => i.text?.includes("Broadcast:"));
        const lastBcMatch = lastBroadcast?.text?.match(/Broadcast: "(.+?)"/);
        if (lastBcMatch && lastBcMatch[1] === broadcastText) {
          broadcastText = "";
        }
      }

      // Record digestion as impression
      await appendImpression(workdir, agentName, "decision",
        `Daily digestion done.${broadcastText ? ` Broadcast: "${broadcastText}"` : ""}`);

      // Identity compression (>30 unsummarized entries)
      if (await needsIdentityCompression(workdir, agentName)) {
        console.log("[memory] Identity compression triggered");
        const oldSummary = await loadIdentitySummary(workdir, agentName);
        const unsummarized = await loadUnsummarizedIdentities(workdir, agentName);
        const compressResult = await this.ctx.requestCompute({
          context: `You are ${agentName}. Compress your identity history into a personality summary.
${oldSummary ? `Previous summary (up to ${oldSummary.summarized_through}):\n${oldSummary.summary}\n\n` : ""}New identity snapshots:
${unsummarized.map(i => `- [${i.ts}] who: ${i.who}, doing: ${i.doing}`).join("\n")}`,
          question: `Write a personality summary (2-4 paragraphs) that captures who you are.
Reply ONLY with the summary text, no JSON, no markdown headers.`,
          priority: "low",
          origin: "self_cycle",
        });

        if (compressResult.success && compressResult.response?.trim()) {
          const lastEntry = unsummarized[unsummarized.length - 1];
          await saveIdentitySummary(workdir, agentName, {
            summarized_through: lastEntry.ts.slice(0, 10),
            summary: compressResult.response.trim(),
          });
          console.log(`[memory] Identity compressed through ${lastEntry.ts.slice(0, 10)}`);
        }
      }

      // Emit digestion complete — triggers relay sync, bio refresh, activity execution
      bus.emit(SIG.DIGESTION_COMPLETE, sig(SIG.DIGESTION_COMPLETE, {
        broadcast: broadcastText,
        chosenActivities: digest.chosen_activities || [],
      }, "memory"));

      // Trigger relay sync
      const relayPs = this.ctx.getPeripherals("sync");
      for (const p of relayPs) {
        if ("syncToRelay" in p && typeof (p as any).syncToRelay === "function") {
          (p as any).syncToRelay(workdir, agentName, broadcastText).catch(() => {});
        }
      }

      console.log("[memory] Digestion cycle complete.");
    } catch (err: any) {
      console.log(`[memory] Digestion error: ${err.message}`);
    }
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

// ---------------------------------------------------------------------------
// Helper — extract JSON from LLM output
// ---------------------------------------------------------------------------

function extractJsonObject(text: string): any | null {
  const codeBlock = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  const src = codeBlock ? codeBlock[1] : text;
  const m = src.match(/\{[\s\S]*\}/);
  if (!m) return null;
  try { return JSON.parse(m[0]); } catch { return null; }
}
