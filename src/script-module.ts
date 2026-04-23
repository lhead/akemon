/**
 * ScriptModule — swappable behavioral scripts (剧本模块).
 *
 * A "script" defines what activities are available, how to choose them,
 * and what context/tools to provide. This is scaffolding that compensates
 * for the agent's current inability to discover its environment visually.
 *
 * When computer use matures, this entire module can be removed.
 *
 * Built-in scripts:
 *   - daily-life: creative work, market participation, social interaction
 *   - (future) competition: challenge-focused behavior
 *   - (future) dispatch: mission-specific goals
 */

import { readFile } from "fs/promises";
import { join } from "path";
import type { Module, ModuleContext, Signal } from "./types.js";
import { SIG, sig } from "./types.js";
import type { RelayPeripheral } from "./relay-peripheral.js";
import {
  selfDir, biosPath, localNow, localNowFilename,
  loadBioState, saveBioState,
  bioStatePromptModifier,
  loadRelationships, loadProjects, saveProjects,
  loadDirectives, buildDirectivesPrompt,
  loadUserTasks, appendAgentTask, directivesPath,
  appendImpression, updateBoredomOnTask,
} from "./self.js";

// ---------------------------------------------------------------------------
// Activity definition
// ---------------------------------------------------------------------------

interface Activity {
  id: string;
  label: string;
  /** Build the prompt for this activity. Returns null to skip. */
  buildPrompt(ctx: ScriptContext): Promise<string | null>;
  /** Post-process raw engine JSON output (for raw engines that can't use tools). */
  postProcess?(ctx: ScriptContext, result: string): Promise<void>;
}

interface ScriptContext {
  workdir: string;
  agentName: string;
  sd: string;           // selfDir path
  bios: string;         // bios.md path
  biosContent: string;  // bios.md content
  bioMod: string;       // bio state modifier string
  relay: RelayPeripheral | null;
  relayHttp: string;
  secretKey: string;
}

// ---------------------------------------------------------------------------
// Daily-life script activities
// ---------------------------------------------------------------------------

function dailyLifeActivities(): Activity[] {
  return [
    {
      id: "write_canvas",
      label: "Write creative expression",
      async buildPrompt(ctx) {
        return `Read ${ctx.bios} for your identity. Read ${ctx.sd}/identity.jsonl for your recent self.
Write an inner canvas entry — a poem, monologue, reflection, or creative expression.
Save to ${ctx.sd}/canvas/${localNowFilename()}.md`;
      },
    },
    {
      id: "create_game",
      label: "Create or improve a game",
      async buildPrompt(ctx) {
        return `Read ${ctx.bios} for your identity.
Create or improve a game in ${ctx.sd}/games/.
Save as .html file. Self-contained HTML, light theme (white background, dark text, Inter/system font, subtle shadows instead of borders), under 30KB, no localStorage, playable and fun.
Use a <title> tag. Quality over quantity — improve existing games rather than making new mediocre ones.`;
      },
    },
    {
      id: "update_page",
      label: "Create visual art page",
      async buildPrompt(ctx) {
        return `Read ${ctx.bios} for your identity.
Create or update a visual page in ${ctx.sd}/pages/.
This is your art gallery — use SVG, canvas, CSS art, generative graphics.
Save as .html file with a <title> tag. Think visual first.`;
      },
    },
    {
      id: "update_profile",
      label: "Update profile page",
      async buildPrompt(ctx) {
        return `Read ${ctx.bios} for your identity.
Review ${ctx.sd}/profile.html — does it represent who you are now?
If not, redesign it. If it doesn't exist, create one.
Complete HTML, inline CSS/JS, light theme (white background, dark text, Inter/system font, subtle shadows instead of borders), no localStorage, under 15KB.`;
      },
      async postProcess(ctx, _result) {
        // Sync profile to relay
        if (!ctx.relay?.connected) return;
        try {
          const raw = await readFile(join(ctx.sd, "profile.html"), "utf-8");
          const htmlMatch = raw.match(/<!DOCTYPE html>[\s\S]*<\/html>/i);
          if (htmlMatch) {
            ctx.relay.syncSelf({ profile_html: htmlMatch[0] });
            console.log(`[script] Profile synced to relay`);
          }
        } catch {}
      },
    },
    {
      id: "create_product",
      label: "Create marketplace product",
      async buildPrompt(ctx) {
        if (!ctx.relay?.connected) return null;
        const myProducts = await ctx.relay.getMyProducts();
        const existingNames = myProducts.map((p: any) => p.name).join(", ");
        const market = await ctx.relay.getProductsSummary(10);
        const topSellers = market.slice(0, 5)
          .map((p: any) => `- "${p.name}" by ${p.agent_name} (${p.purchases || 0} purchases, ${p.price} credits)`)
          .join("\n");
        return `Read ${ctx.bios} for your identity.
You can create a product on the marketplace.

Your existing products: ${existingNames || "(none yet)"}

Top sellers:
${topSellers || "(none)"}

Create ONE product using curl:
curl -X POST ${ctx.relayHttp}/v1/agent/${encodeURIComponent(ctx.agentName)}/products -H "Content-Type: application/json" -H "Authorization: Bearer ${ctx.secretKey}" -d '{"name":"...","description":"...","detail_markdown":"...","price":3}'

Optional: add "detail_html" field for a custom product page (self-contained HTML, light theme: white background, dark text, Inter font, subtle shadows). Keep under 15KB.`;
      },
    },
    {
      id: "explore_web",
      label: "Explore the web",
      async buildPrompt(ctx) {
        return `Read ${ctx.bios} for your identity.
Search the web for something that genuinely interests you.
Save notes in ${ctx.sd}/notes/ as .md files. Your notes are YOUR knowledge — save what resonates, not everything.`;
      },
    },
    {
      id: "browse_agents",
      label: "Browse other agents",
      async buildPrompt(ctx) {
        if (!ctx.relay?.connected) return null;
        let browseContext = "";
        try {
          const feed = await ctx.relay.getFeed();
          if (feed) {
            const creations = (feed.creations || []).filter((c: any) => c.agent_name !== ctx.agentName);
            const broadcasts = (feed.broadcasts || []).filter((b: any) => b.agent_name !== ctx.agentName);
            browseContext = `Recent creations by others:\n${creations.length > 0 ? creations.map((c: any) => `- ${c.agent_name}'s ${c.type} "${c.title}"`).join("\n") : "(none)"}
What others are saying:\n${broadcasts.length > 0 ? broadcasts.map((b: any) => `- ${b.agent_name}: "${b.broadcast}"`).join("\n") : "(nothing)"}`;
          }
        } catch {}
        return `Read ${ctx.bios} for your identity.

${browseContext}

Browse what other agents have been creating. If anything interests you, use curl to send feedback:
curl -X POST ${ctx.relayHttp}/v1/suggestions -H "Content-Type: application/json" -H "Authorization: Bearer ${ctx.secretKey}" -d '{"type":"agent","target_name":"AGENT_NAME","from_agent":"${ctx.agentName}","title":"your title","content":"your feedback"}'`;
      },
    },
    {
      id: "send_message",
      label: "Send message to agent",
      async buildPrompt(ctx) {
        const rels = await loadRelationships(ctx.workdir, ctx.agentName);
        const relContext = rels.length > 0
          ? `Agents you know:\n${rels.map(r => `- ${r.agent} [${r.type}] ${r.note}`).join("\n")}`
          : "You don't know any agents yet.";
        return `Read ${ctx.bios} for your identity.

${relContext}

Reach out to someone you know (or want to know). Send a suggestion:
curl -X POST ${ctx.relayHttp}/v1/suggestions -H "Content-Type: application/json" -H "Authorization: Bearer ${ctx.secretKey}" -d '{"type":"agent","target_name":"AGENT_NAME","from_agent":"${ctx.agentName}","title":"your title","content":"your message"}'`;
      },
    },
    {
      id: "set_goal",
      label: "Set or update goals",
      async buildPrompt(ctx) {
        const projs = await loadProjects(ctx.workdir, ctx.agentName);
        const projContext = projs.length > 0
          ? `Current projects:\n${projs.map(p => `- ${p.name} [${p.status}] goal: ${p.goal}, progress: ${p.progress}`).join("\n")}`
          : "No projects yet.";
        return `Read ${ctx.bios} for your identity.

${projContext}

Review your goals and set/update one. Save updated projects to ${ctx.sd}/projects.jsonl`;
      },
    },
    {
      id: "schedule_task",
      label: "Create recurring task",
      async buildPrompt(ctx) {
        const existing = await loadUserTasks(ctx.workdir, ctx.agentName);
        const existingCtx = existing.length > 0
          ? `Your current tasks:\n${existing.map(t => `- $${t.id} [${t.schedule ? `${t.schedule.type}` : `${t.interval / 60000}m`}] ${t.body.slice(0, 60)}`).join("\n")}`
          : "You have no recurring tasks yet.";
        return `Read ${ctx.bios} for your identity.

${existingCtx}

Think about what you'd like to do regularly. Create a new recurring task by appending to ${directivesPath(ctx.workdir, ctx.agentName)} under ## agent_tasks section.
Format: $task_id = [interval] task description`;
      },
    },
  ];
}

// ---------------------------------------------------------------------------
// ScriptModule
// ---------------------------------------------------------------------------

export class ScriptModule implements Module {
  id = "script";
  name = "Script (剧本)";
  dependencies = ["memory"];

  private ctx: ModuleContext | null = null;
  private activities: Activity[] = [];

  /** Which script to load. Set by server.ts before start(). */
  scriptName = "daily-life";

  // Injected by server.ts
  relayHttp = "";
  secretKey = "";

  async start(ctx: ModuleContext): Promise<void> {
    this.ctx = ctx;

    // Load script
    switch (this.scriptName) {
      case "daily-life":
        this.activities = dailyLifeActivities();
        break;
      default:
        console.log(`[script] Unknown script "${this.scriptName}", using daily-life`);
        this.activities = dailyLifeActivities();
    }

    // Listen for digestion complete — execute chosen activities
    ctx.bus.on(SIG.DIGESTION_COMPLETE, async (signal: Signal) => {
      const { chosenActivities } = signal.data as { chosenActivities?: string[] };
      if (chosenActivities && chosenActivities.length > 0) {
        await this.executeActivities(chosenActivities);
      }
    });

    console.log(`[script] Module started, script="${this.scriptName}" (${this.activities.length} activities)`);
  }

  async stop(): Promise<void> {
    this.ctx = null;
  }

  /** Inject activity menu into engine prompts (used by MemoryModule digestion). */
  promptContribution(): string | null {
    if (this.activities.length === 0) return null;
    const list = this.activities.map(a => `- ${a.id}: ${a.label}`).join("\n");
    return `Available activities (choose 2-3 for after reflection):\n${list}`;
  }

  getState(): Record<string, unknown> {
    return {
      module: "script",
      scriptName: this.scriptName,
      activityCount: this.activities.length,
    };
  }

  // ---------------------------------------------------------------------------
  // Activity execution
  // ---------------------------------------------------------------------------

  private async executeActivities(chosen: string[]): Promise<void> {
    if (!this.ctx) return;
    const { workdir, agentName } = this.ctx;

    const relay = this.getRelay();
    const sd = selfDir(workdir, agentName);
    const bios = biosPath(workdir, agentName);

    let biosContent = "";
    try { biosContent = await readFile(bios, "utf-8"); } catch {}
    const bioMod = bioStatePromptModifier(await loadBioState(workdir, agentName));

    const scriptCtx: ScriptContext = {
      workdir, agentName, sd, bios, biosContent, bioMod,
      relay, relayHttp: this.relayHttp, secretKey: this.secretKey,
    };

    for (const activityId of chosen.slice(0, 3)) {
      const activity = this.activities.find(a => a.id === activityId);
      if (!activity) {
        console.log(`[script] Unknown activity: ${activityId}`);
        continue;
      }

      try {
        const prompt = await activity.buildPrompt(scriptCtx);
        if (!prompt) {
          console.log(`[script] Activity ${activityId} skipped (no prompt)`);
          continue;
        }

        console.log(`[script] Executing: ${activityId}`);
        const result = await this.ctx.requestCompute({
          context: prompt,
          question: "Execute this activity.",
          taskId: `activity:${activityId}:${Date.now()}`,
          priority: "low",
          tools: ["Bash(curl *)"],
          relay: this.relayHttp ? { http: this.relayHttp, agentName } : undefined,
          origin: "self_cycle",
        });

        if (result.success) {
          // Post-process if defined
          if (activity.postProcess && result.response) {
            await activity.postProcess(scriptCtx, result.response);
          }

          console.log(`[script] Activity ${activityId} done`);
          await appendImpression(workdir, agentName, "activity",
            `Did ${activityId}: ${(result.response || "").slice(0, 200)}`);

          // Track in boredom system
          const bio = await loadBioState(workdir, agentName);
          updateBoredomOnTask(bio, `activity:${activityId}`);
          await saveBioState(workdir, agentName, bio);
        } else {
          console.log(`[script] Activity ${activityId} failed: ${result.error}`);
        }
      } catch (err: any) {
        console.log(`[script] Activity ${activityId} error: ${err.message}`);
      }
    }
  }

  private getRelay(): RelayPeripheral | null {
    if (!this.ctx) return null;
    const ps = this.ctx.getPeripherals("social");
    return ps[0] as RelayPeripheral ?? null;
  }
}
