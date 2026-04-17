import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  parseRole,
  parseProduct,
  resolveRoles,
  resolveProduct,
  buildRoleContext,
  type RoleDef,
  type ProductDef,
  type PlaybookDef,
} from "./role-module.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeRole(name: string, triggers: string[] = [], extras: Partial<RoleDef> = {}): RoleDef {
  return { name, description: "", triggers, include: [], exclude: [], customRules: "", raw: "", ...extras };
}

function makeProduct(name: string, extras: Partial<ProductDef> = {}): ProductDef {
  return { name, playbook: "", productIds: [], raw: "", ...extras };
}

function makePlaybook(name: string, raw = ""): PlaybookDef {
  return { name, raw };
}

// ---------------------------------------------------------------------------
// Pure parsing — parseRole
// ---------------------------------------------------------------------------

describe("parseRole — pure parsing", () => {
  it("extracts description, triggers, include, exclude from standard role md", () => {
    const raw = `# Sales Rep

Expert in closing deals and building client relationships.

## 激活
- trigger:order
- trigger:chat:public

## 上下文范围
include: buyer history, product catalog
exclude: owner notes, private diary
`;
    const role = parseRole("sales-rep", raw);
    assert.equal(role.name, "sales-rep");
    assert.equal(role.description, "Expert in closing deals and building client relationships.");
    assert.deepEqual(role.triggers, ["trigger:order", "trigger:chat:public"]);
    assert.deepEqual(role.include, ["buyer history", "product catalog"]);
    assert.deepEqual(role.exclude, ["owner notes", "private diary"]);
  });

  it("returns empty arrays for include/exclude/triggers when sections are missing", () => {
    const raw = `# Simple Role

A minimal role with no activation or context sections.
`;
    const role = parseRole("simple", raw);
    assert.deepEqual(role.triggers, []);
    assert.deepEqual(role.include, []);
    assert.deepEqual(role.exclude, []);
    assert.equal(role.description, "A minimal role with no activation or context sections.");
  });

  it("collects content outside 激活 and 上下文范围 into customRules", () => {
    const raw = `# Worker

Efficient task executor.

## 激活
- trigger:agent_call

## Operating Principles
Always reply in the language the user writes in.
Be concise and accurate.

## Tone
Professional and neutral.
`;
    const role = parseRole("worker", raw);
    assert.ok(role.customRules.includes("Always reply in the language the user writes in."), "should include content from ## Operating Principles");
    assert.ok(role.customRules.includes("Professional and neutral."), "should include content from ## Tone");
    // triggers and standard sections should not bleed in
    assert.deepEqual(role.triggers, ["trigger:agent_call"]);
  });
});

// ---------------------------------------------------------------------------
// Pure parsing — parseProduct
// ---------------------------------------------------------------------------

describe("parseProduct — pure parsing", () => {
  it("extracts playbook and multiple productIds correctly", () => {
    const raw = `# Widget Pro

## playbook
widget-strategy

## products
- p_abc123
- p_def456
- p_ghi789
`;
    const product = parseProduct("widget-pro", raw);
    assert.equal(product.name, "widget-pro");
    assert.equal(product.playbook, "widget-strategy");
    assert.deepEqual(product.productIds, ["p_abc123", "p_def456", "p_ghi789"]);
  });

  it("returns empty productIds when ## products section is absent", () => {
    const raw = `# No Products

## playbook
some-playbook
`;
    const product = parseProduct("no-products", raw);
    assert.deepEqual(product.productIds, []);
    assert.equal(product.playbook, "some-playbook");
  });

  it("returns empty string for playbook when ## playbook section is absent", () => {
    const raw = `# No Playbook

## products
- p_xyz
`;
    const product = parseProduct("no-playbook", raw);
    assert.equal(product.playbook, "");
    assert.deepEqual(product.productIds, ["p_xyz"]);
  });
});

// ---------------------------------------------------------------------------
// Resolution — resolveRoles
// ---------------------------------------------------------------------------

describe("resolveRoles — resolution", () => {
  it("partial trigger match: first match is primary, remaining are secondary", () => {
    const roles: RoleDef[] = [
      makeRole("general-chat", ["trigger:chat"]),
      makeRole("owner-companion", ["trigger:chat:owner"]),
    ];
    // "trigger:chat:owner" includes "trigger:chat" → both match
    const { primary, secondary } = resolveRoles(roles, "trigger:chat:owner");
    assert.equal(primary?.name, "general-chat");
    assert.equal(secondary.length, 1);
    assert.equal(secondary[0].name, "owner-companion");
  });

  it("returns primary=null and empty secondary when no trigger matches", () => {
    const roles: RoleDef[] = [
      makeRole("merchant", ["trigger:order"]),
      makeRole("companion", ["trigger:chat:owner"]),
    ];
    const { primary, secondary } = resolveRoles(roles, "trigger:nonexistent");
    assert.equal(primary, null);
    assert.deepEqual(secondary, []);
  });
});

// ---------------------------------------------------------------------------
// Resolution — resolveProduct
// ---------------------------------------------------------------------------

describe("resolveProduct — resolution", () => {
  const products: ProductDef[] = [
    makeProduct("Alpha Product", { productIds: ["p_alpha"], playbook: "alpha-pb" }),
    makeProduct("Beta Service",  { productIds: ["p_beta"],  playbook: "beta-pb" }),
  ];
  const playbooks: PlaybookDef[] = [
    makePlaybook("alpha-pb", "# Alpha Playbook\nContent."),
    makePlaybook("beta-pb",  "# Beta Playbook\nContent."),
  ];

  it("productId takes priority over productName when both are provided", () => {
    // productId matches "Alpha Product", productName matches "Beta Service"
    const result = resolveProduct(products, playbooks, "Beta Service", "p_alpha");
    assert.ok(result !== null);
    assert.equal(result.product.name, "Alpha Product");
  });

  it("fuzzy name match is case- and separator-insensitive", () => {
    // "alpha_product" → normalized "alphaproduct"
    // "Alpha Product" → normalized "alphaproduct" → exact match
    const result = resolveProduct(products, playbooks, "alpha_product");
    assert.ok(result !== null);
    assert.equal(result.product.name, "Alpha Product");
  });

  it("returns null when neither productId nor productName matches", () => {
    const result = resolveProduct(products, playbooks, "Completely Unknown");
    assert.equal(result, null);
  });

  it("playbook lookup is case-insensitive", () => {
    const prods: ProductDef[] = [makeProduct("my-widget", { playbook: "My-Playbook", productIds: [] })];
    const pbs: PlaybookDef[] = [makePlaybook("my-playbook", "# PB Content")];
    const result = resolveProduct(prods, pbs, "my-widget");
    assert.ok(result !== null);
    assert.ok(result.playbook !== null);
    assert.equal(result.playbook?.name, "my-playbook");
  });
});

// ---------------------------------------------------------------------------
// buildRoleContext — real fs with tmp dir
// ---------------------------------------------------------------------------

describe("buildRoleContext — fs integration", () => {
  let tmpDir: string;
  const agentName = "test-agent";

  before(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), "akemon-test-"));
    const selfBase = join(tmpDir, ".akemon", "agents", agentName, "self");
    await mkdir(join(selfBase, "roles"),     { recursive: true });
    await mkdir(join(selfBase, "playbooks"), { recursive: true });
    await mkdir(join(selfBase, "products"),  { recursive: true });

    await writeFile(
      join(selfBase, "roles", "worker.md"),
      `# 工人\n执行任务的专业角色。\n\n## 激活\n- trigger:order\n`,
    );
    await writeFile(
      join(selfBase, "playbooks", "strategy.md"),
      `# Strategy\n核心策略内容。\n`,
    );
    await writeFile(
      join(selfBase, "products", "widget.md"),
      `# Widget\n\n## playbook\nstrategy\n\n## products\n- p_1234\n`,
    );
  });

  after(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  it("matching trigger produces output with [Active role: ...]", async () => {
    const result = await buildRoleContext(tmpDir, agentName, "trigger:order:001");
    assert.ok(result.includes("[Active role: worker]"), `expected '[Active role: worker]' in:\n${result}`);
  });

  it("passing productName produces output with [Product: ...] and [Playbook: ...]", async () => {
    const result = await buildRoleContext(tmpDir, agentName, "trigger:other", "widget");
    assert.ok(result.includes("[Product: widget]"),    `expected '[Product: widget]' in:\n${result}`);
    assert.ok(result.includes("[Playbook: strategy]"), `expected '[Playbook: strategy]' in:\n${result}`);
  });
});
