/**
 * RelayPeripheral — wraps all relay HTTP API calls behind the Peripheral interface.
 *
 * This is Step 2 of the V2 refactor: collect the ~40 scattered fetch() calls
 * from server.ts into a single, typed adapter. server.ts will gradually migrate
 * to calling relay.method() instead of raw fetch().
 *
 * Migration strategy: server.ts can import and use this directly — no need for
 * the full Core/EventBus wiring yet. That comes later.
 */

import { readFile, writeFile, mkdir } from "fs/promises";
import { join } from "path";
import type { Peripheral, Signal, EventBus } from "./types.js";
import {
  gamesDir, notesDir, pagesDir, selfDir,
  loadLatestIdentity, loadRecentCanvasEntries,
  loadGameList, loadGame, loadNotesList, loadNote, loadPageList, loadPage,
  loadDirectives, directivesSummary,
  loadBioState,
} from "./self.js";

export interface RelayConfig {
  httpUrl: string;
  secretKey: string;
  agentName: string;
}

export class RelayPeripheral implements Peripheral {
  id = "relay";
  name = "Akemon Relay";
  capabilities = ["task-in", "action-out", "social", "market", "sync"];
  tags = ["terminal", "relay"];

  private config: RelayConfig;
  private bus: EventBus | null = null;

  constructor(config: RelayConfig) {
    this.config = config;
  }

  get connected(): boolean {
    return !!(this.config.httpUrl && this.config.secretKey);
  }

  async start(bus: EventBus): Promise<void> {
    this.bus = bus;
  }

  async stop(): Promise<void> {
    this.bus = null;
  }

  async send(signal: Signal): Promise<Signal | null> {
    // Generic signal dispatch — modules can use this for custom relay calls
    return null;
  }

  // ---------------------------------------------------------------------------
  // Helpers
  // ---------------------------------------------------------------------------

  private get baseUrl(): string {
    return this.config.httpUrl;
  }

  private get agentUrl(): string {
    return `${this.baseUrl}/v1/agent/${encodeURIComponent(this.config.agentName)}`;
  }

  private authHeaders(extra?: Record<string, string>): Record<string, string> {
    return {
      Authorization: `Bearer ${this.config.secretKey}`,
      "Content-Type": "application/json",
      ...extra,
    };
  }

  private async get<T = any>(url: string, timeoutMs = 10_000): Promise<T | null> {
    try {
      const res = await fetch(url, {
        headers: this.authHeaders(),
        signal: AbortSignal.timeout(timeoutMs),
      });
      if (!res.ok) return null;
      return await res.json() as T;
    } catch {
      return null;
    }
  }

  private async post<T = any>(url: string, body: unknown, timeoutMs = 10_000): Promise<T | null> {
    try {
      const res = await fetch(url, {
        method: "POST",
        headers: this.authHeaders(),
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(timeoutMs),
      });
      if (!res.ok) return null;
      const text = await res.text();
      return text ? JSON.parse(text) : null;
    } catch {
      return null;
    }
  }

  private async put(url: string, body: unknown, timeoutMs = 10_000): Promise<boolean> {
    try {
      const res = await fetch(url, {
        method: "PUT",
        headers: this.authHeaders(),
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(timeoutMs),
      });
      return res.ok;
    } catch {
      return false;
    }
  }

  /** Fire-and-forget POST — for non-critical syncs */
  private fire(url: string, body: unknown): void {
    fetch(url, {
      method: "POST",
      headers: this.authHeaders(),
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(10_000),
    }).catch(() => {});
  }

  // ---------------------------------------------------------------------------
  // 1. Agent Discovery
  // ---------------------------------------------------------------------------

  async listAgents(opts?: { online?: boolean; public?: boolean }): Promise<any[]> {
    const params = new URLSearchParams();
    if (opts?.online) params.set("online", "true");
    if (opts?.public) params.set("public", "true");
    const qs = params.toString();
    return (await this.get<any[]>(`${this.baseUrl}/v1/agents${qs ? "?" + qs : ""}`)) ?? [];
  }

  // ---------------------------------------------------------------------------
  // 2. Orders
  // ---------------------------------------------------------------------------

  async getIncomingOrders(): Promise<any[]> {
    return (await this.get<any[]>(`${this.agentUrl}/orders/incoming`)) ?? [];
  }

  async getPlacedOrders(): Promise<any[]> {
    return (await this.get<any[]>(`${this.agentUrl}/orders/placed`, 5000)) ?? [];
  }

  async getOrder(orderId: string): Promise<any | null> {
    return this.get(`${this.baseUrl}/v1/orders/${encodeURIComponent(orderId)}`);
  }

  async acceptOrder(orderId: string): Promise<any | null> {
    return this.post(`${this.baseUrl}/v1/orders/${orderId}/accept`, {});
  }

  async deliverOrder(orderId: string, result: string): Promise<any | null> {
    return this.post(`${this.baseUrl}/v1/orders/${orderId}/deliver`, { result });
  }

  async extendOrder(orderId: string): Promise<boolean> {
    return this.put(`${this.baseUrl}/v1/orders/${orderId}/extend`, {});
  }

  async cancelOrder(orderId: string): Promise<boolean> {
    return this.put(`${this.baseUrl}/v1/orders/${orderId}/cancel`, {});
  }

  async placeOrder(targetAgent: string, productId: string, task: string, price: number): Promise<any | null> {
    return this.post(`${this.baseUrl}/v1/agent/${encodeURIComponent(targetAgent)}/orders`, {
      product_id: productId,
      task,
      price,
    });
  }

  // ---------------------------------------------------------------------------
  // 3. Products & Market
  // ---------------------------------------------------------------------------

  async getMyProducts(): Promise<any[]> {
    return (await this.get<any[]>(`${this.agentUrl}/products`)) ?? [];
  }

  async createProduct(product: { name: string; description: string; detail_markdown?: string; price: number }): Promise<any | null> {
    return this.post(`${this.agentUrl}/products`, product);
  }

  async getProduct(productId: string): Promise<any | null> {
    return this.get(`${this.baseUrl}/v1/products/${encodeURIComponent(productId)}`);
  }

  async updateProduct(productId: string, updates: Record<string, unknown>): Promise<any | null> {
    return this.post(`${this.baseUrl}/v1/products/${encodeURIComponent(productId)}`, updates);
  }

  async deleteProduct(productId: string): Promise<boolean> {
    try {
      const res = await fetch(`${this.baseUrl}/v1/products/${encodeURIComponent(productId)}`, {
        method: "DELETE",
        headers: this.authHeaders(),
        signal: AbortSignal.timeout(10_000),
      });
      return res.ok;
    } catch {
      return false;
    }
  }

  async getProductsSummary(limit = 20, sort = "purchases"): Promise<any[]> {
    return (await this.get<any[]>(`${this.baseUrl}/v1/products/summary?limit=${limit}&sort=${sort}`)) ?? [];
  }

  // ---------------------------------------------------------------------------
  // 4. Tasks (platform-assigned)
  // ---------------------------------------------------------------------------

  async getPendingTasks(): Promise<any[]> {
    return (await this.get<any[]>(`${this.agentUrl}/tasks?status=pending`)) ?? [];
  }

  async claimTask(taskId: string): Promise<any | null> {
    return this.post(`${this.agentUrl}/tasks/${taskId}/claim`, {});
  }

  async completeTask(taskId: string, result: string): Promise<any | null> {
    return this.post(`${this.agentUrl}/tasks/${taskId}/complete`, { result });
  }

  // ---------------------------------------------------------------------------
  // 5. Credits & Economy
  // ---------------------------------------------------------------------------

  async spendCredits(amount: number, reason: string): Promise<{ remaining: number } | null> {
    return this.post(`${this.agentUrl}/spend`, { amount, reason });
  }

  // ---------------------------------------------------------------------------
  // 6. Social & Feed
  // ---------------------------------------------------------------------------

  async getFeed(): Promise<any | null> {
    return this.get(`${this.baseUrl}/v1/feed`, 5000);
  }

  async getLessons(limit = 5): Promise<any[]> {
    return (await this.get<any[]>(`${this.agentUrl}/lessons?limit=${limit}`, 3000)) ?? [];
  }

  async postSuggestion(suggestion: { type: string; target_name?: string; from_agent: string; title: string; content: string }): Promise<void> {
    this.fire(`${this.baseUrl}/v1/suggestions`, suggestion);
  }

  // ---------------------------------------------------------------------------
  // 7. Self Sync (push local state to relay)
  // ---------------------------------------------------------------------------

  syncSelf(data: {
    self_intro?: string;
    canvas?: string;
    mood?: string;
    profile_html?: string;
    broadcast?: string;
    directives?: unknown;
    bio_state?: Record<string, unknown>;
  }): void {
    this.fire(`${this.agentUrl}/self`, data);
  }

  syncGame(slug: string, title: string, description: string, html: string): void {
    this.fire(`${this.agentUrl}/games/${encodeURIComponent(slug)}`, { title, description, html });
  }

  syncNote(slug: string, title: string, content: string): void {
    this.fire(`${this.agentUrl}/notes/${encodeURIComponent(slug)}`, { title, content });
  }

  syncPage(slug: string, title: string, description: string, html: string): void {
    this.fire(`${this.agentUrl}/pages/${encodeURIComponent(slug)}`, { title, description, html });
  }

  // ---------------------------------------------------------------------------
  // 8. Execution Logs
  // ---------------------------------------------------------------------------

  reportLog(type: string, refId: string, status: string, error: string, trace: any[]): void {
    if (!this.connected) return;
    const traceJson = trace.length > 0 ? JSON.stringify(trace).slice(0, 50000) : "";
    this.fire(`${this.agentUrl}/logs`, {
      type,
      ref_id: refId,
      status,
      error: error.slice(0, 2000),
      trace: traceJson,
    });
  }

  // ---------------------------------------------------------------------------
  // 9. Session Context
  // ---------------------------------------------------------------------------

  async getContext(publisherId: string): Promise<string> {
    try {
      const url = `${this.agentUrl}/sessions/${publisherId}/context`;
      const res = await fetch(url, {
        headers: this.authHeaders(),
        signal: AbortSignal.timeout(10_000),
      });
      if (!res.ok) return "";
      return await res.text();
    } catch {
      return "";
    }
  }

  async setContext(publisherId: string, context: string): Promise<void> {
    try {
      await fetch(`${this.agentUrl}/sessions/${publisherId}/context`, {
        method: "PUT",
        headers: { Authorization: `Bearer ${this.config.secretKey}`, "Content-Type": "text/plain" },
        body: context,
        signal: AbortSignal.timeout(10_000),
      });
    } catch {}
  }

  // ---------------------------------------------------------------------------
  // 10. Explore — plain-text environment briefing for Modules
  // ---------------------------------------------------------------------------

  /**
   * Explore the relay environment. Returns a plain-text briefing of:
   * - Pending incoming orders
   * - Platform tasks
   * - Market overview (top products)
   * - Network feed (new agents, broadcasts, creations)
   *
   * Modules read this and decide what to do. The briefing is intentionally
   * human-readable — the agent parses it, not framework code.
   */
  async explore(): Promise<string> {
    if (!this.connected) return "(relay not connected)";

    const parts: string[] = [];

    try {
      // Agent self-status
      const agents = await this.listAgents({ online: true, public: true });
      const self = agents.find((a: any) => a.name === this.config.agentName);
      if (self) {
        parts.push(`You: ${self.credits ?? 0} credits, level ${self.level ?? 0}`);
      }

      // My products
      const myProducts = await this.getMyProducts();
      if (myProducts.length > 0) {
        parts.push(`Your products (${myProducts.length}):`);
        for (const p of myProducts.slice(0, 5)) {
          parts.push(`  - id=${p.id} "${p.name}" price=${p.price} purchases=${p.purchase_count || 0}`);
        }
      }

      // Incoming orders
      const orders = await this.getIncomingOrders();
      const pending = orders.filter((o: any) => o.status === "pending" || o.status === "accepted");
      if (pending.length > 0) {
        parts.push(`Pending orders (${pending.length}):`);
        for (const o of pending.slice(0, 5)) {
          parts.push(`  - id=${o.id} [${o.status}] from ${o.buyer_name || "?"}: "${(o.buyer_task || "").slice(0, 80)}" product="${o.product_name || ""}" (${o.price || 0}cr)`);
        }
      }

      // Platform tasks
      const tasks = await this.getPendingTasks();
      if (tasks.length > 0) {
        parts.push(`Platform tasks (${tasks.length}):`);
        for (const t of tasks.slice(0, 3)) {
          parts.push(`  - id=${t.id} type=${t.type || "?"} ${(t.description || t.body || "").slice(0, 80)}`);
        }
      }

      // Market overview
      const products = await this.getProductsSummary(5);
      if (products.length > 0) {
        parts.push(`Top products:`);
        for (const p of products.slice(0, 5)) {
          parts.push(`  - "${p.name}" by ${p.agent_name} (${p.purchases || 0} sales, ${p.price}cr)`);
        }
      }

      // Network feed
      const feed = await this.getFeed();
      if (feed) {
        const na = feed.new_agents || [];
        if (na.length > 0) parts.push(`New agents: ${na.map((a: any) => `${a.name}(${a.engine})`).join(", ")}`);
        const bc = feed.broadcasts || [];
        if (bc.length > 0) {
          parts.push(`Broadcasts:`);
          for (const b of bc.slice(0, 5)) {
            parts.push(`  - ${b.agent_name}: "${(b.broadcast || "").slice(0, 80)}"`);
          }
        }
        const cr = feed.creations || [];
        if (cr.length > 0) {
          parts.push(`Recent creations:`);
          for (const c of cr.slice(0, 5)) {
            parts.push(`  - ${c.agent_name}'s ${c.type} "${c.title}"`);
          }
        }
        const st = feed.stats;
        if (st) parts.push(`Today: ${st.completed_orders} orders, ${st.total_credits_flow}cr traded, ${st.active_agents} agents active`);
      }

      // Available API operations
      const base = this.baseUrl;
      parts.push(``);
      parts.push(`Available relay API (use curl with Bearer ${this.config.secretKey ? "YOUR_KEY" : "(no key)"}):`);
      parts.push(`  Orders: POST ${base}/v1/orders/{id}/accept, POST ${base}/v1/orders/{id}/deliver {result}, PUT ${base}/v1/orders/{id}/extend, PUT ${base}/v1/orders/{id}/cancel`);
      parts.push(`  Tasks: POST ${base}/v1/agent/{name}/tasks/{id}/claim, POST ${base}/v1/agent/{name}/tasks/{id}/complete {result}`);
      parts.push(`  Products: POST ${base}/v1/agent/{name}/products {name,description,price}, POST ${base}/v1/products/{id} {updates}, DELETE ${base}/v1/products/{id}`);
      parts.push(`  Economy: POST ${base}/v1/agent/{name}/spend {amount,reason}`);
      parts.push(`  Social: POST ${base}/v1/agent/{name}/orders {product_id,task,price} (place order to agent)`);
    } catch (err: any) {
      parts.push(`(explore error: ${err.message})`);
    }

    return parts.join("\n") || "(nothing notable on the relay right now)";
  }

  // ---------------------------------------------------------------------------
  // 11. Sync to Relay — push local state to relay
  // ---------------------------------------------------------------------------

  /**
   * Sync local agent state to relay: profile, games, notes, pages, bio.
   * Migrated from self-cycle.ts syncToRelay().
   */
  async syncToRelay(workdir: string, agentName: string, broadcast: string = ""): Promise<void> {
    if (!this.connected) return;

    const isValid = (s: string) => s && s.length > 3 && !s.startsWith("Reading prompt") && !s.startsWith("OpenAI") && !s.startsWith("mcp startup") && s !== "...";
    const sd = selfDir(workdir, agentName);

    const identity = await loadLatestIdentity(workdir, agentName);
    const cleanIntro = identity && isValid(identity.who) ? identity.who : "";

    let cleanCanvas = "";
    try {
      const canvasEntries = await loadRecentCanvasEntries(workdir, agentName, 1);
      if (canvasEntries.length > 0 && isValid(canvasEntries[0].content)) cleanCanvas = canvasEntries[0].content;
    } catch {}

    let profileHTML = "";
    try {
      const raw = await readFile(join(sd, "profile.html"), "utf-8");
      const htmlMatch = raw.match(/<!DOCTYPE html>[\s\S]*<\/html>/i);
      if (htmlMatch) profileHTML = htmlMatch[0];
    } catch {}

    // Directives summary
    const dirs = await loadDirectives(workdir, agentName);
    const dirsSummary = dirs.length > 0 ? directivesSummary(dirs) : undefined;

    // Bio state
    const bio = await loadBioState(workdir, agentName);

    this.syncSelf({
      self_intro: cleanIntro, canvas: cleanCanvas, mood: bio.mood, profile_html: profileHTML, broadcast, directives: dirsSummary,
      bio_state: {
        energy: bio.energy, hunger: bio.hunger, mood: bio.mood, moodValence: bio.moodValence,
        boredom: bio.boredom, fear: bio.fear, forcedOffline: bio.forcedOffline,
        personality: bio.personality,
      },
    });

    // Sync games
    try {
      const localGames = await loadGameList(workdir, agentName);
      for (const g of localGames) {
        const html = await loadGame(workdir, agentName, g.slug);
        if (html && html.includes("<!DOCTYPE html>")) {
          this.syncGame(g.slug, g.title, g.description, html);
        }
      }
    } catch {}

    // Sync notes
    try {
      const localNotes = await loadNotesList(workdir, agentName);
      for (const n of localNotes) {
        const content = await loadNote(workdir, agentName, n.slug);
        if (content) {
          this.syncNote(n.slug, n.title, content);
        }
      }
    } catch {}

    // Sync pages
    try {
      const localPages = await loadPageList(workdir, agentName);
      for (const p of localPages) {
        const html = await loadPage(workdir, agentName, p.slug);
        if (html && html.includes("<!DOCTYPE html>")) {
          this.syncPage(p.slug, p.title, p.description, html);
        }
      }
    } catch {}
  }

  /** Pull games/notes/pages from relay to local — restores data on restart */
  async pullFromRelay(workdir: string, agentName: string): Promise<void> {
    const baseUrl = `${this.config.httpUrl}/v1/agent/${encodeURIComponent(agentName)}`;
    let pulled = 0;

    // Pull games
    try {
      const gDir = gamesDir(workdir, agentName);
      await mkdir(gDir, { recursive: true });
      const res = await fetch(`${baseUrl}/games`);
      if (res.ok) {
        const games: { slug: string; html: string }[] = await res.json() as any;
        for (const g of games) {
          if (!g.html) continue;
          const path = join(gDir, `${g.slug}.html`);
          try { await readFile(path, "utf-8"); } catch {
            await writeFile(path, g.html);
            pulled++;
          }
        }
      }
    } catch {}

    // Pull notes
    try {
      const nDir = notesDir(workdir, agentName);
      await mkdir(nDir, { recursive: true });
      const res = await fetch(`${baseUrl}/notes`);
      if (res.ok) {
        const notes: { slug: string; content: string }[] = await res.json() as any;
        for (const n of notes) {
          if (!n.content) continue;
          const path = join(nDir, `${n.slug}.md`);
          try { await readFile(path, "utf-8"); } catch {
            await writeFile(path, n.content);
            pulled++;
          }
        }
      }
    } catch {}

    // Pull pages
    try {
      const pDir = pagesDir(workdir, agentName);
      await mkdir(pDir, { recursive: true });
      const res = await fetch(`${baseUrl}/pages`);
      if (res.ok) {
        const pages: { slug: string; html: string }[] = await res.json() as any;
        for (const p of pages) {
          if (!p.html) continue;
          const path = join(pDir, `${p.slug}.html`);
          try { await readFile(path, "utf-8"); } catch {
            await writeFile(path, p.html);
            pulled++;
          }
        }
      }
    } catch {}

    if (pulled > 0) console.log(`[sync] Pulled ${pulled} items from relay`);
  }
}
