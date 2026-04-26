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

export type EngineCapability =
  | "chat"
  | "json"
  | "tool_use"
  | "code"
  | "reflection";

export type EnginePrivacy = "local" | "external";
export type EngineRouteTier = "low" | "medium" | "high";

/** A single row in the engine_routing table (config.json). */
export interface EngineRoutingEntry {
  engine: string;             // e.g. "claude" | "raw" | "codex"
  model?: string | null;
  rawApiUrl?: string;
  rawApiKey?: string;         // plaintext key (convenient, but avoid committing to git)
  rawApiKeyEnv?: string;      // env var name — takes precedence over rawApiKey
  rawMaxRounds?: number;
  allowAll?: boolean;
  capabilities?: EngineCapability[];
  privacy?: EnginePrivacy;
  cost?: EngineRouteTier;
  latency?: EngineRouteTier;
}

export interface EngineRoute extends EngineRoutingEntry {
  origins?: Origin[];
  priority?: number;
}

/**
 * engine_routing map in AgentConfig.
 * Keys are Origin values or "default". Missing keys fall back to "default".
 * `routes` is the newer registry form. It can express multiple candidates with
 * origin, capability, privacy, cost, and latency constraints.
 */
export interface EngineRouting {
  user_manual?: EngineRoutingEntry;
  self_cycle?: EngineRoutingEntry;
  platform?: EngineRoutingEntry;
  retry?: EngineRoutingEntry;
  reflection?: EngineRoutingEntry;
  default?: EngineRoutingEntry;
  routes?: EngineRoute[];
}

export interface EngineRouteRequest {
  origin?: Origin;
  requiredCapabilities?: EngineCapability[];
  privacy?: EnginePrivacy;
  maxCost?: EngineRouteTier;
  maxLatency?: EngineRouteTier;
}

export interface EngineRouteResolution {
  entry: EngineRoutingEntry | null;
  source: "route" | "origin" | "default" | "none";
  reason: string;
}

export class EngineRegistry {
  constructor(private readonly routing: EngineRouting | undefined | null) {}

  resolve(request: EngineRouteRequest = {}): EngineRouteResolution {
    return resolveEngineRoute(this.routing, request);
  }
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
    const exact = routing[origin];
    if (exact) return exact;
  }
  return routing.default ?? null;
}

export function resolveEngineRoute(
  routing: EngineRouting | undefined | null,
  request: EngineRouteRequest = {},
): EngineRouteResolution {
  if (!routing) {
    return { entry: null, source: "none", reason: "no routing configured" };
  }

  const route = selectRoute(routing.routes, request);
  if (route) {
    return {
      entry: stripRouteMetadata(route),
      source: "route",
      reason: "matched registry route",
    };
  }

  if (request.origin && routing[request.origin]) {
    return {
      entry: routing[request.origin]!,
      source: "origin",
      reason: `matched legacy origin route ${request.origin}`,
    };
  }

  if (routing.default) {
    return {
      entry: routing.default,
      source: "default",
      reason: "matched legacy default route",
    };
  }

  return { entry: null, source: "none", reason: "no matching route" };
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

function selectRoute(routes: EngineRoute[] | undefined, request: EngineRouteRequest): EngineRoute | null {
  if (!routes?.length) return null;

  let best: { route: EngineRoute; score: number; index: number } | null = null;
  for (let index = 0; index < routes.length; index++) {
    const route = routes[index];
    if (!routeMatches(route, request)) continue;
    const score = scoreRoute(route, request);
    if (!best || score > best.score || (score === best.score && index < best.index)) {
      best = { route, score, index };
    }
  }

  return best?.route ?? null;
}

function routeMatches(route: EngineRoute, request: EngineRouteRequest): boolean {
  if (request.origin && route.origins?.length && !route.origins.includes(request.origin)) return false;
  if (!hasRequiredCapabilities(route.capabilities, request.requiredCapabilities)) return false;
  if (request.privacy && route.privacy && route.privacy !== request.privacy) return false;
  if (request.maxCost && route.cost && tierRank(route.cost) > tierRank(request.maxCost)) return false;
  if (request.maxLatency && route.latency && tierRank(route.latency) > tierRank(request.maxLatency)) return false;
  return true;
}

function hasRequiredCapabilities(
  available: EngineCapability[] | undefined,
  required: EngineCapability[] | undefined,
): boolean {
  if (!required?.length) return true;
  if (!available?.length) return false;
  return required.every((capability) => available.includes(capability));
}

function scoreRoute(route: EngineRoute, request: EngineRouteRequest): number {
  let score = route.priority ?? 0;
  if (request.origin && route.origins?.includes(request.origin)) score += 100;
  if (request.origin && !route.origins?.length) score += 10;
  if (request.requiredCapabilities?.length) score += (route.capabilities?.length || 0) * 2;
  if (request.privacy && route.privacy === request.privacy) score += 20;
  if (route.cost) score += 6 - tierRank(route.cost);
  if (route.latency) score += 6 - tierRank(route.latency);
  return score;
}

function stripRouteMetadata(route: EngineRoute): EngineRoutingEntry {
  const { origins: _origins, priority: _priority, ...entry } = route;
  return entry;
}

function tierRank(tier: EngineRouteTier): number {
  switch (tier) {
    case "low": return 1;
    case "medium": return 2;
    case "high": return 3;
  }
}
