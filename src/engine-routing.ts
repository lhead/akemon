/**
 * engine-routing.ts — pure helpers for origin-based engine selection.
 *
 * Three exported pure functions (each independently unit-tested):
 *   resolveEngineConfig  — picks which engine/model to use for a given origin
 *   deriveChildOrigin    — returns the origin a child/sub-task should carry
 *   downgradeForRetry    — downgrades any origin to "retry" when a task retries
 */

/** Where a work item came from. */
export type Origin =
  | "user_manual"   // owner placed the order / user_task directly
  | "self_cycle"    // self-initiated: digestion, idle exploration, bio decisions
  | "platform"      // received from another agent or platform task queue
  | "retry"         // any task that failed and is being retried
  | "reflection";   // reflection module compute

/** A single row in the engine_routing table (config.json). */
export interface EngineRoutingEntry {
  engine: string;             // e.g. "claude" | "raw" | "codex"
  model?: string | null;
  rawApiUrl?: string;
  rawApiKeyEnv?: string;      // env var name → resolved to rawApiKey at call time
  rawMaxRounds?: number;
  allowAll?: boolean;
}

/**
 * engine_routing map in AgentConfig.
 * Keys are Origin values or "default". Missing keys fall back to "default".
 */
export interface EngineRouting {
  user_manual?: EngineRoutingEntry;
  self_cycle?: EngineRoutingEntry;
  platform?: EngineRoutingEntry;
  retry?: EngineRoutingEntry;
  reflection?: EngineRoutingEntry;
  default?: EngineRoutingEntry;
}

/**
 * Resolve which engine routing entry to use for a given origin.
 *
 * Lookup order:
 *   1. routing[origin]   (exact match)
 *   2. routing.default   (fallback)
 *   3. null              (no routing configured → caller uses base engine config)
 *
 * Backward-compatible: if routing is undefined/null, returns null, meaning the
 * caller should use whatever engine is already in the base EngineConfig.
 */
export function resolveEngineConfig(
  routing: EngineRouting | undefined | null,
  origin: Origin | undefined,
): EngineRoutingEntry | null {
  if (!routing) return null;
  if (origin) {
    const exact = routing[origin as keyof EngineRouting];
    if (exact) return exact;
  }
  return routing.default ?? null;
}

/**
 * Derive the origin that a child task should carry.
 *
 * "Human contamination" rule: human intent does NOT cross agent boundaries.
 * Regardless of what the parent's origin is, any task spawned for/from another
 * agent is always "platform" on the receiving side.
 *
 * Example: user_manual order → agent A calls agent B via MCP →
 *          agent B's resulting order has origin "platform", not "user_manual".
 */
export function deriveChildOrigin(_parentOrigin: Origin): Origin {
  return "platform";
}

/**
 * Downgrade the origin when a task enters the retry path.
 *
 * Retries must not consume the subscription CLI budget even if the original
 * task was user_manual. Downgrading to "retry" lets the routing table send
 * them to a cheaper API engine.
 */
export function downgradeForRetry(_origin: Origin): Origin {
  return "retry";
}
