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

import type { Peripheral, Signal, EventBus } from "./types.js";

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
}
