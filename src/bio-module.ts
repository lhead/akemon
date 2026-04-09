/**
 * BioStateModule — the agent's biological drive system as a pluggable Module.
 *
 * Step 4 of V2 refactor: first Module implementation.
 * Wraps all bio-state logic (hunger, fear, boredom, energy, personality, mood)
 * behind the Module interface. Caches state in memory to reduce file I/O.
 *
 * Current: server.ts calls methods directly.
 * Future (Step 6): subscribes to EventBus events (task:completed, digestion:start, etc.)
 */

import type { Module, ModuleContext } from "./types.js";
import { SIG } from "./types.js";
import {
  initBioState, loadBioState, saveBioState,
  onTaskCompleted, applyDigestionCost,
  updateHungerDecay, updateNaturalDecay, resetTokenCountIfNewDay,
  addTokenUsage, syncEnergyFromTokens,
  computeAggression, computeSociability,
  bioStatePromptModifier, logBioStatus, logBioDecision,
  feedHunger, reviveAgent as reviveAgentRaw,
  updateBoredomOnTask, onFearEvent,
  appendBioEvent, loadBioEvents,
  SHOP_ITEMS,
  type BioState, type BioEvent, type Personality,
} from "./self.js";

export class BioStateModule implements Module {
  id = "biostate";
  name = "Bio-State Drive System";
  dependencies = []; // no deps on other modules

  private ctx: ModuleContext | null = null;
  private _state: BioState | null = null;

  // ---------------------------------------------------------------------------
  // Module interface
  // ---------------------------------------------------------------------------

  async start(ctx: ModuleContext): Promise<void> {
    this.ctx = ctx;

    // Initialize and load state
    await initBioState(ctx.workdir, ctx.agentName);
    this._state = await loadBioState(ctx.workdir, ctx.agentName);

    // Subscribe to events (Step 6)
    ctx.bus.on(SIG.TASK_COMPLETED, async (signal) => {
      const { success, taskLabel, creditsEarned } = signal.data;
      await this.onTaskCompleted(success as boolean, taskLabel as string, creditsEarned as number);
    });

    ctx.bus.on(SIG.DIGESTION_START, async () => {
      await this.reload();
      this.logStatus("digestion-start");
      await this.applyDigestionCost();
    });

    ctx.bus.on(SIG.DIGESTION_COMPLETE, async () => {
      await this.reload();
    });

    ctx.bus.on(SIG.ENGINE_RESPONSE, async (signal) => {
      const { promptLen, resultLen, tokenLimit } = signal.data as {
        promptLen?: number; resultLen?: number; tokenLimit?: number;
      };
      if (promptLen && resultLen) {
        const estTokens = Math.ceil(((promptLen as number) + (resultLen as number)) / 4);
        await this.addTokenUsage(estTokens, (tokenLimit as number) || 0);
      }
    });

    console.log(`[biostate] Module started, subscribed to events`);
  }

  async stop(): Promise<void> {
    // Persist final state
    if (this._state && this.ctx) {
      await saveBioState(this.ctx.workdir, this.ctx.agentName, this._state);
    }
    this.ctx = null;
  }

  /** Inject bio-state context into prompts before engine calls */
  promptContribution(): string | null {
    if (!this._state) return null;
    const mod = bioStatePromptModifier(this._state);
    return mod || null;
  }

  /** Current state for dashboard / API */
  getState(): Record<string, unknown> {
    if (!this._state) return {};
    return {
      ...this._state,
      aggression: computeAggression(this._state),
      sociability: computeSociability(this._state),
    };
  }

  // ---------------------------------------------------------------------------
  // State access (cached)
  // ---------------------------------------------------------------------------

  /** Get cached bio state (reloads from disk if not cached) */
  async state(): Promise<BioState> {
    if (!this._state && this.ctx) {
      this._state = await loadBioState(this.ctx.workdir, this.ctx.agentName);
    }
    return this._state!;
  }

  /** Force reload from disk */
  async reload(): Promise<BioState> {
    if (this.ctx) {
      this._state = await loadBioState(this.ctx.workdir, this.ctx.agentName);
    }
    return this._state!;
  }

  /** Persist cached state to disk */
  async save(): Promise<void> {
    if (this._state && this.ctx) {
      await saveBioState(this.ctx.workdir, this.ctx.agentName, this._state);
    }
  }

  // ---------------------------------------------------------------------------
  // Bio operations (mutate cached state + persist)
  // ---------------------------------------------------------------------------

  /** Called after any task completes */
  async onTaskCompleted(success: boolean, taskLabel?: string, creditsEarned?: number): Promise<void> {
    if (!this.ctx) return;
    // Delegates to self.ts function (which loads+saves independently)
    await onTaskCompleted(this.ctx.workdir, this.ctx.agentName, success, taskLabel, creditsEarned);
    // Refresh cache
    this._state = await loadBioState(this.ctx.workdir, this.ctx.agentName);
  }

  /** Digestion costs hunger */
  async applyDigestionCost(): Promise<void> {
    if (!this.ctx) return;
    await applyDigestionCost(this.ctx.workdir, this.ctx.agentName);
    this._state = await loadBioState(this.ctx.workdir, this.ctx.agentName);
  }

  /** Update all natural decays (hunger, boredom, fear) */
  async updateDecays(hungerDecayInterval?: number): Promise<void> {
    const bio = await this.state();
    updateHungerDecay(bio, hungerDecayInterval);
    updateNaturalDecay(bio);
    resetTokenCountIfNewDay(bio);
    await this.save();
  }

  /** Sync energy from token budget */
  async syncEnergy(tokenLimit: number): Promise<void> {
    const bio = await this.state();
    syncEnergyFromTokens(bio, tokenLimit);
    await this.save();
  }

  /** Add token usage and update energy */
  async addTokenUsage(tokens: number, tokenLimit: number): Promise<void> {
    const bio = await this.state();
    addTokenUsage(bio, tokens, tokenLimit);
    await this.save();
  }

  /** Update boredom based on task repetition */
  async updateBoredom(taskLabel: string): Promise<void> {
    const bio = await this.state();
    updateBoredomOnTask(bio, taskLabel);
    await this.save();
  }

  /** Feed hunger (from credits earned or shop) */
  async feed(amount: number): Promise<void> {
    const bio = await this.state();
    feedHunger(bio, amount);
    await this.save();
  }

  /** Register a fear-inducing event */
  async addFear(trigger: string): Promise<void> {
    const bio = await this.state();
    onFearEvent(bio, trigger);
    await this.save();
  }

  /** Update mood/bio after digestion results */
  async updateFromDigestion(digest: { mood?: string; activities?: string[] }): Promise<void> {
    const bio = await this.state();
    if (digest.mood) {
      bio.mood = digest.mood;
      // Derive valence from mood word
      const moodMap: Record<string, number> = {
        excited: 0.7, content: 0.3, curious: 0.4, neutral: 0,
        restless: -0.2, tired: -0.4, exhausted: -0.6,
      };
      bio.moodValence = moodMap[digest.mood] ?? bio.moodValence;
    }
    bio.lastReflection = new Date().toISOString();
    await this.save();
  }

  /** Revive agent from forced offline */
  async revive(): Promise<void> {
    if (!this.ctx) return;
    await reviveAgentRaw(this.ctx.workdir, this.ctx.agentName);
    this._state = await loadBioState(this.ctx.workdir, this.ctx.agentName);
  }

  /** Append a bio event to the log */
  async logEvent(event: BioEvent): Promise<void> {
    if (!this.ctx) return;
    await appendBioEvent(this.ctx.workdir, this.ctx.agentName, event);
  }

  /** Load recent bio events */
  async loadEvents(limit = 20): Promise<BioEvent[]> {
    if (!this.ctx) return [];
    return loadBioEvents(this.ctx.workdir, this.ctx.agentName, limit);
  }

  // ---------------------------------------------------------------------------
  // Computed properties
  // ---------------------------------------------------------------------------

  get aggression(): number {
    return this._state ? computeAggression(this._state) : 0;
  }

  get sociability(): number {
    return this._state ? computeSociability(this._state) : 0.5;
  }

  get isOffline(): boolean {
    return this._state?.forcedOffline ?? false;
  }

  get hunger(): number {
    return this._state?.hunger ?? 80;
  }

  get energy(): number {
    return this._state?.energy ?? 100;
  }

  get mood(): string {
    return this._state?.mood ?? "neutral";
  }

  get personality(): Personality | null {
    return this._state?.personality ?? null;
  }

  // ---------------------------------------------------------------------------
  // Logging
  // ---------------------------------------------------------------------------

  logStatus(context: string): void {
    if (this._state) logBioStatus(this._state, context);
  }

  logDecision(decision: string, reason: string): void {
    logBioDecision(decision, reason);
  }

  // ---------------------------------------------------------------------------
  // Shop
  // ---------------------------------------------------------------------------

  static readonly SHOP_ITEMS = SHOP_ITEMS;
}
