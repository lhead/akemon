import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  resolveEngineConfig,
  resolveEngineRoute,
  EngineRegistry,
  deriveChildOrigin,
  downgradeForRetry,
  type EngineRouting,
  type Origin,
} from "./engine-routing.js";

// ---------------------------------------------------------------------------
// resolveEngineConfig
// ---------------------------------------------------------------------------

describe("resolveEngineConfig", () => {
  const claudeEntry = { engine: "claude", model: "claude-opus-4-5" };
  const rawEntry = { engine: "raw", rawApiUrl: "https://api.deepseek.com/v1", model: "deepseek-chat", rawApiKeyEnv: "DEEPSEEK_API_KEY" };
  const defaultEntry = { engine: "raw", rawApiUrl: "https://api.anthropic.com/v1", model: "claude-haiku-4-5", rawApiKeyEnv: "ANTHROPIC_API_KEY" };

  it("returns exact origin entry when routing has that origin", () => {
    const routing: EngineRouting = {
      user_manual: claudeEntry,
      platform: rawEntry,
      default: defaultEntry,
    };
    const result = resolveEngineConfig(routing, "user_manual");
    assert.deepEqual(result, claudeEntry);
  });

  it("returns platform entry for platform origin", () => {
    const routing: EngineRouting = {
      user_manual: claudeEntry,
      platform: rawEntry,
      default: defaultEntry,
    };
    const result = resolveEngineConfig(routing, "platform");
    assert.deepEqual(result, rawEntry);
  });

  it("falls back to default when origin not in routing", () => {
    const routing: EngineRouting = {
      user_manual: claudeEntry,
      default: defaultEntry,
    };
    // self_cycle not in routing → fallback to default
    const result = resolveEngineConfig(routing, "self_cycle");
    assert.deepEqual(result, defaultEntry);
  });

  it("falls back to default when origin is undefined", () => {
    const routing: EngineRouting = { default: defaultEntry };
    const result = resolveEngineConfig(routing, undefined);
    assert.deepEqual(result, defaultEntry);
  });

  it("returns null when routing is undefined (backward-compat: use base config)", () => {
    const result = resolveEngineConfig(undefined, "user_manual");
    assert.equal(result, null);
  });

  it("returns null when routing is null", () => {
    const result = resolveEngineConfig(null, "user_manual");
    assert.equal(result, null);
  });

  it("returns null when routing has no matching entry and no default", () => {
    const routing: EngineRouting = { user_manual: claudeEntry };
    // self_cycle not in routing, no default
    const result = resolveEngineConfig(routing, "self_cycle");
    assert.equal(result, null);
  });

  it("returns null when routing is empty object and origin is undefined", () => {
    const result = resolveEngineConfig({}, undefined);
    assert.equal(result, null);
  });

  it("retry origin resolves to its own routing entry when configured", () => {
    const retryEntry = { engine: "raw", rawApiUrl: "https://api.deepseek.com/v1", model: "deepseek-chat" };
    const routing: EngineRouting = {
      user_manual: claudeEntry,
      retry: retryEntry,
      default: defaultEntry,
    };
    const result = resolveEngineConfig(routing, "retry");
    assert.deepEqual(result, retryEntry);
  });

  it("retry origin falls back to default when no retry entry configured", () => {
    const routing: EngineRouting = {
      user_manual: claudeEntry,
      default: defaultEntry,
    };
    const result = resolveEngineConfig(routing, "retry");
    assert.deepEqual(result, defaultEntry);
  });

  it("reflection origin resolves correctly", () => {
    const reflEntry = { engine: "raw", model: "gemma3:4b" };
    const routing: EngineRouting = { reflection: reflEntry, default: defaultEntry };
    const result = resolveEngineConfig(routing, "reflection");
    assert.deepEqual(result, reflEntry);
  });
});

describe("EngineRegistry", () => {
  it("selects a registry route by origin, capabilities, privacy, cost, and latency", () => {
    const routing: EngineRouting = {
      routes: [
        {
          engine: "claude",
          model: "opus",
          origins: ["user_manual"],
          capabilities: ["chat", "code"],
          privacy: "external",
          cost: "high",
          latency: "medium",
        },
        {
          engine: "raw",
          model: "local-code",
          origins: ["user_manual", "self_cycle"],
          capabilities: ["chat", "code", "json"],
          privacy: "local",
          cost: "low",
          latency: "low",
        },
      ],
      default: { engine: "claude" },
    };

    const result = new EngineRegistry(routing).resolve({
      origin: "user_manual",
      requiredCapabilities: ["code"],
      privacy: "local",
      maxCost: "medium",
      maxLatency: "medium",
    });

    assert.equal(result.source, "route");
    assert.equal(result.entry?.engine, "raw");
    assert.equal(result.entry?.model, "local-code");
  });

  it("falls back to legacy origin/default routes when no registry route matches", () => {
    const routing: EngineRouting = {
      routes: [
        {
          engine: "raw",
          origins: ["self_cycle"],
          capabilities: ["reflection"],
          privacy: "local",
        },
      ],
      user_manual: { engine: "codex", model: "gpt-5.4" },
      default: { engine: "claude" },
    };

    const exact = resolveEngineRoute(routing, {
      origin: "user_manual",
      requiredCapabilities: ["code"],
    });
    const fallback = resolveEngineRoute(routing, {
      origin: "platform",
      requiredCapabilities: ["tool_use"],
    });

    assert.equal(exact.source, "origin");
    assert.equal(exact.entry?.engine, "codex");
    assert.equal(fallback.source, "default");
    assert.equal(fallback.entry?.engine, "claude");
  });

  it("keeps legacy resolveEngineConfig behavior stable", () => {
    const routing: EngineRouting = {
      routes: [{ engine: "raw", origins: ["user_manual"] }],
      user_manual: { engine: "claude" },
      default: { engine: "codex" },
    };

    assert.deepEqual(resolveEngineConfig(routing, "user_manual"), { engine: "claude" });
    assert.deepEqual(resolveEngineConfig(routing, "platform"), { engine: "codex" });
  });
});

// ---------------------------------------------------------------------------
// downgradeForRetry
// ---------------------------------------------------------------------------

describe("downgradeForRetry", () => {
  const origins: Origin[] = ["user_manual", "self_cycle", "platform", "retry", "reflection"];

  it("always returns 'retry' regardless of input", () => {
    for (const origin of origins) {
      assert.equal(downgradeForRetry(origin), "retry", `downgradeForRetry(${origin}) should be 'retry'`);
    }
  });

  it("user_manual + isRetry=true → 'retry' (not user_manual)", () => {
    // This is the spec's explicit test case for the downgrade rule
    const original: Origin = "user_manual";
    const downgraded = downgradeForRetry(original);
    assert.equal(downgraded, "retry");
    assert.notEqual(downgraded, "user_manual");
  });
});

// ---------------------------------------------------------------------------
// deriveChildOrigin
// ---------------------------------------------------------------------------

describe("deriveChildOrigin", () => {
  const origins: Origin[] = ["user_manual", "self_cycle", "platform", "retry", "reflection"];

  it("always returns 'platform' regardless of parent", () => {
    for (const origin of origins) {
      assert.equal(deriveChildOrigin(origin), "platform", `deriveChildOrigin(${origin}) should be 'platform'`);
    }
  });

  it("user_manual parent does NOT propagate to child (anti-contamination rule)", () => {
    const child = deriveChildOrigin("user_manual");
    assert.equal(child, "platform");
    assert.notEqual(child, "user_manual");
  });

  it("self_cycle parent → child is platform, not self_cycle", () => {
    assert.equal(deriveChildOrigin("self_cycle"), "platform");
  });
});
