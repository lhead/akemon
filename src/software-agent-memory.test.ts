import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import {
  buildSoftwareAgentMemorySummary,
  canIncludeOwnerMemory,
} from "./software-agent-memory.js";
import type { TaskEnvelope } from "./software-agent-peripheral.js";

function envelope(overrides: Partial<TaskEnvelope> = {}): TaskEnvelope {
  return {
    taskId: "mem-test",
    sourceModule: "owner-http",
    purpose: "test",
    goal: "inspect repo",
    workdir: "/repo",
    roleScope: "owner",
    memoryScope: "owner",
    riskLevel: "medium",
    ...overrides,
  };
}

async function makeMemoryFixture(): Promise<{ workdir: string; agentName: string; cleanup(): Promise<void> }> {
  const workdir = await mkdtemp(join(tmpdir(), "akemon-memory-boundary-"));
  const agentName = "momo";
  const selfBase = join(workdir, ".akemon", "agents", agentName, "self");
  await mkdir(join(selfBase, "roles"), { recursive: true });
  await mkdir(join(selfBase, "products"), { recursive: true });
  await mkdir(join(selfBase, "playbooks"), { recursive: true });

  await writeFile(join(selfBase, "roles", "merchant.md"), `# Merchant
Public service role.

## 激活
- trigger:order

## 上下文范围
include: buyer history, product information
exclude: owner private notes, bio state, personal diary
`);
  await writeFile(join(selfBase, "roles", "companion.md"), `# Companion
Owner companion role.

## 激活
- trigger:chat:owner
`);
  await writeFile(join(selfBase, "products", "widget.md"), `# Widget

## playbook
widget-playbook
`);
  await writeFile(join(selfBase, "playbooks", "widget-playbook.md"), "# Widget Playbook\nProduct strategy.");

  return {
    workdir,
    agentName,
    cleanup: () => rm(workdir, { recursive: true, force: true }),
  };
}

describe("buildSoftwareAgentMemorySummary", () => {
  it("includes owner-provided memory only for owner/owner envelopes", async () => {
    const fixture = await makeMemoryFixture();
    try {
      const summary = await buildSoftwareAgentMemorySummary({
        workdir: fixture.workdir,
        agentName: fixture.agentName,
        envelope: envelope(),
        request: {
          memorySummary: "owner secret context",
          taskContext: "repo-local task context",
        },
      });

      assert.match(summary, /Owner-visible memory/);
      assert.match(summary, /owner secret context/);
      assert.match(summary, /repo-local task context/);
      assert.match(summary, /Companion/);
    } finally {
      await fixture.cleanup();
    }
  });

  it("excludes owner memory for order/public scopes while keeping role and product context", async () => {
    const fixture = await makeMemoryFixture();
    try {
      const summary = await buildSoftwareAgentMemorySummary({
        workdir: fixture.workdir,
        agentName: fixture.agentName,
        envelope: envelope({ roleScope: "order", memoryScope: "task" }),
        request: {
          memorySummary: "owner secret context",
          taskContext: "buyer-visible task context",
          productName: "widget",
        },
      });

      assert.match(summary, /Non-owner task/);
      assert.match(summary, /Excluded owner memory/);
      assert.doesNotMatch(summary, /\[Owner-visible memory\]/);
      assert.doesNotMatch(summary, /^owner secret context$/m);
      assert.match(summary, /buyer-visible task context/);
      assert.match(summary, /Merchant/);
      assert.match(summary, /Widget Playbook/);
    } finally {
      await fixture.cleanup();
    }
  });

  it("returns a no-memory boundary for memoryScope none", async () => {
    const fixture = await makeMemoryFixture();
    try {
      const summary = await buildSoftwareAgentMemorySummary({
        workdir: fixture.workdir,
        agentName: fixture.agentName,
        envelope: envelope({ roleScope: "public", memoryScope: "none" }),
        request: {
          memorySummary: "owner secret context",
          taskContext: "public task context",
        },
      });

      assert.match(summary, /No Akemon memory\/context is included/);
      assert.doesNotMatch(summary, /owner secret context/);
      assert.doesNotMatch(summary, /public task context/);
    } finally {
      await fixture.cleanup();
    }
  });
});

describe("canIncludeOwnerMemory", () => {
  it("only allows owner memory for owner/owner scope", () => {
    assert.equal(canIncludeOwnerMemory("owner", "owner"), true);
    assert.equal(canIncludeOwnerMemory("owner", "task"), false);
    assert.equal(canIncludeOwnerMemory("order", "owner"), false);
    assert.equal(canIncludeOwnerMemory("public", "public"), false);
  });
});
