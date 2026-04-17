import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { appendPlaybookExperience } from "./reflection-module.js";

const AGENT = "test-agent";

// ---------------------------------------------------------------------------
// Shared tmp dir — each test uses uniquely-named products/playbooks to avoid
// state bleed between cases within the single before/after lifecycle.
// ---------------------------------------------------------------------------

describe("appendPlaybookExperience", () => {
  let tmpDir: string;
  let selfBase: string;
  let pbDir: string;
  let prodDir: string;

  before(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), "akemon-test-"));
    selfBase = join(tmpDir, ".akemon", "agents", AGENT, "self");
    pbDir   = join(selfBase, "playbooks");
    prodDir = join(selfBase, "products");
    await mkdir(pbDir,   { recursive: true });
    await mkdir(prodDir, { recursive: true });
  });

  after(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  it("happy path: appends experience line with date, productName, taskLabel, and credits", async () => {
    await writeFile(
      join(prodDir, "widget.md"),
      `# Widget\n\n## playbook\nwidget-pb\n\n## products\n- p_w1\n`,
    );
    await writeFile(
      join(pbDir, "widget-pb.md"),
      `# Widget Playbook\n\n## 经验\n- [2026-01-01T00:00:00] Old entry.\n`,
    );

    await appendPlaybookExperience(tmpDir, AGENT, "widget", "design-logo", 8);

    const content = await readFile(join(pbDir, "widget-pb.md"), "utf-8");
    assert.ok(content.includes("widget"),      "should contain productName");
    assert.ok(content.includes("design-logo"), "should contain taskLabel");
    assert.ok(content.includes("(earned 8¢)"), "should contain credits suffix");
    // original entry must still be there
    assert.ok(content.includes("Old entry."), "original 经验 entry must be preserved");
  });

  it("creates ## 经验 section when it does not exist in the playbook file", async () => {
    await writeFile(
      join(prodDir, "alpha.md"),
      `# Alpha\n\n## playbook\nalpha-pb\n\n## products\n- p_a1\n`,
    );
    await writeFile(
      join(pbDir, "alpha-pb.md"),
      `# Alpha Playbook\n\nSome strategy text without experience section.\n`,
    );

    await appendPlaybookExperience(tmpDir, AGENT, "alpha", "run-campaign", 3);

    const content = await readFile(join(pbDir, "alpha-pb.md"), "utf-8");
    assert.ok(content.includes("## 经验"), "should have created ## 经验 section");
    assert.ok(content.includes("run-campaign"), "should contain taskLabel");
    assert.ok(content.includes("(earned 3¢)"),  "should contain credits suffix");
  });

  it("does not throw and writes nothing when product is not found", async () => {
    // No product file for "ghost-product" exists in prodDir
    await assert.doesNotReject(
      () => appendPlaybookExperience(tmpDir, AGENT, "ghost-product", "some-task", 5),
    );
  });

  it("catches exception and does not throw when playbook file is missing", async () => {
    // Product file references "missing-pb", but no such file in pbDir
    await writeFile(
      join(prodDir, "orphan.md"),
      `# Orphan\n\n## playbook\nmissing-pb\n\n## products\n- p_o1\n`,
    );

    await assert.doesNotReject(
      () => appendPlaybookExperience(tmpDir, AGENT, "orphan", "orphan-task", 2),
    );
    // Ensure nothing was written to any unexpected place
  });

  it("omits (earned X¢) suffix when credits is 0", async () => {
    await writeFile(
      join(prodDir, "freebie.md"),
      `# Freebie\n\n## playbook\nfreebie-pb\n\n## products\n- p_f1\n`,
    );
    await writeFile(
      join(pbDir, "freebie-pb.md"),
      `# Freebie Playbook\n\n## 经验\n`,
    );

    await appendPlaybookExperience(tmpDir, AGENT, "freebie", "free-task", 0);

    const content = await readFile(join(pbDir, "freebie-pb.md"), "utf-8");
    assert.ok(content.includes("free-task"),      "should contain taskLabel");
    assert.ok(!content.includes("earned"),        "should NOT contain 'earned' when credits=0");
  });
});
