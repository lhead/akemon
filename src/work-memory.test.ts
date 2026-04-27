import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import {
  appendWorkMemoryNote,
  buildWorkMemoryContext,
  workMemoryDir,
  workMemoryInboxPath,
} from "./work-memory.js";

async function makeFixture(): Promise<{ workdir: string; agentName: string; cleanup(): Promise<void> }> {
  const workdir = await mkdtemp(join(tmpdir(), "akemon-work-memory-"));
  const agentName = "momo";
  const workBase = workMemoryDir(workdir, agentName);
  const selfBase = join(workdir, ".akemon", "agents", agentName, "self");
  await mkdir(join(workBase, "projects", "akemon"), { recursive: true });
  await mkdir(selfBase, { recursive: true });

  await writeFile(
    join(workBase, "README.md"),
    "Shared work memory for engineering tools.\napi_key=sk-testsecretvalue000000000000\n",
  );
  await writeFile(join(workBase, "decisions.md"), "# Decisions\nKeep Codex focused on work memory.");
  await writeFile(join(workBase, "projects", "akemon", "handoff.md"), "# Akemon\nContinue Codex UX polish.");
  await writeFile(join(selfBase, "identity.jsonl"), JSON.stringify({ who: "self memory must not appear" }) + "\n");

  return {
    workdir,
    agentName,
    cleanup: () => rm(workdir, { recursive: true, force: true }),
  };
}

describe("buildWorkMemoryContext", () => {
  it("renders a redacted work-only packet with a file index", async () => {
    const fixture = await makeFixture();
    try {
      const packet = await buildWorkMemoryContext({
        workdir: fixture.workdir,
        agentName: fixture.agentName,
        purpose: "codex handoff",
        budget: 8_000,
      });

      assert.equal(packet.agentName, fixture.agentName);
      assert.equal(packet.workMemoryDir, workMemoryDir(fixture.workdir, fixture.agentName));
      assert.match(packet.text, /Akemon Work Memory Context/);
      assert.match(packet.text, /user-owned work memory/);
      assert.match(packet.text, /codex handoff/);
      assert.match(packet.text, /Shared work memory for engineering tools/);
      assert.match(packet.text, /Keep Codex focused on work memory/);
      assert.match(packet.text, /projects\/akemon\/handoff\.md/);
      assert.doesNotMatch(packet.text, /self memory must not appear/);
      assert.doesNotMatch(packet.text, /sk-testsecretvalue/);
      assert.match(packet.text, /\[REDACTED\]/);
    } finally {
      await fixture.cleanup();
    }
  });

  it("rejects agent names with path separators", async () => {
    const fixture = await makeFixture();
    try {
      await assert.rejects(
        () => buildWorkMemoryContext({
          workdir: fixture.workdir,
          agentName: "../momo",
        }),
        /Invalid agentName/,
      );
    } finally {
      await fixture.cleanup();
    }
  });
});

describe("appendWorkMemoryNote", () => {
  it("appends a redacted note to work inbox by default", async () => {
    const fixture = await makeFixture();
    try {
      const result = await appendWorkMemoryNote({
        workdir: fixture.workdir,
        agentName: fixture.agentName,
        text: "The user wants Codex UX polished before adding more tools.",
        source: "codex",
        sessionId: "project-alpha",
        kind: "decision",
      });

      assert.equal(result.note.source, "codex");
      assert.equal(result.note.sessionId, "project-alpha");
      assert.equal(result.note.kind, "decision");
      assert.equal(result.path, workMemoryInboxPath(fixture.workdir, fixture.agentName));

      const saved = await readFile(result.path, "utf-8");
      assert.match(saved, /The user wants Codex UX polished/);
      assert.match(saved, /Source: codex/);
      assert.match(saved, /Session: project-alpha/);
    } finally {
      await fixture.cleanup();
    }
  });

  it("can append to a caller-selected work-memory target file", async () => {
    const fixture = await makeFixture();
    try {
      const result = await appendWorkMemoryNote({
        workdir: fixture.workdir,
        agentName: fixture.agentName,
        text: "Use work memory only. token=sk-testsecretvalue000000000000",
        source: "claude-code",
        kind: "note",
        target: "projects/akemon/notes.md",
      });

      assert.equal(result.path, join(workMemoryDir(fixture.workdir, fixture.agentName), "projects", "akemon", "notes.md"));
      const saved = await readFile(result.path, "utf-8");
      assert.match(saved, /Use work memory only/);
      assert.doesNotMatch(saved, /sk-testsecretvalue/);
      assert.match(saved, /\[REDACTED\]/);
    } finally {
      await fixture.cleanup();
    }
  });

  it("rejects target paths outside work memory", async () => {
    const fixture = await makeFixture();
    try {
      await assert.rejects(
        () => appendWorkMemoryNote({
          workdir: fixture.workdir,
          agentName: fixture.agentName,
          text: "durable work note",
          target: "../self/identity.jsonl",
        }),
        /Invalid target path/,
      );
    } finally {
      await fixture.cleanup();
    }
  });
});
