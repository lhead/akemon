import assert from "node:assert/strict";
import { describe, it, before, after } from "node:test";
import { mkdtemp, rm, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

// We import the functions we need to test. appendMessage and loadConversation
// need a workdir on disk; parseConversation is internal — tested via loadConversation.
import { appendMessage, loadConversation, type ConversationRound } from "./context.js";

const agentName = "test-agent";

// ---------------------------------------------------------------------------
// appendMessage + loadConversation round-trip
// ---------------------------------------------------------------------------

describe("appendMessage / loadConversation", () => {
  let workdir = "";

  before(async () => {
    workdir = await mkdtemp(join(tmpdir(), "ctx-test-"));
  });

  after(async () => {
    await rm(workdir, { recursive: true, force: true });
  });

  it("writes a chat message and reads it back with kind='chat'", async () => {
    const convId = "test-chat";
    await appendMessage(workdir, agentName, convId, "User", "hello", "chat");
    const conv = await loadConversation(workdir, agentName, convId);
    assert.equal(conv.rounds.length, 1);
    assert.equal(conv.rounds[0].role, "user");
    assert.equal(conv.rounds[0].content, "hello");
    assert.equal(conv.rounds[0].kind, "chat");
  });

  it("writes an order message with [order] tag and reads kind='order'", async () => {
    const convId = "test-order";
    await appendMessage(workdir, agentName, convId, "User", "order request", "order");
    await appendMessage(workdir, agentName, convId, "Agent", "order delivered", "order");
    const conv = await loadConversation(workdir, agentName, convId);
    assert.equal(conv.rounds.length, 2);
    assert.equal(conv.rounds[0].kind, "order");
    assert.equal(conv.rounds[0].role, "user");
    assert.equal(conv.rounds[1].kind, "order");
    assert.equal(conv.rounds[1].role, "agent");
  });

  it("defaults to kind='chat' when kind arg is omitted", async () => {
    const convId = "test-default-kind";
    await appendMessage(workdir, agentName, convId, "Agent", "hi there");
    const conv = await loadConversation(workdir, agentName, convId);
    assert.equal(conv.rounds[0].kind, "chat");
  });

  it("parses mixed chat + order rounds correctly", async () => {
    const convId = "test-mixed";
    await appendMessage(workdir, agentName, convId, "User", "chat message", "chat");
    await appendMessage(workdir, agentName, convId, "User", "order task", "order");
    await appendMessage(workdir, agentName, convId, "Agent", "chat reply", "chat");
    await appendMessage(workdir, agentName, convId, "Agent", "order result", "order");

    const conv = await loadConversation(workdir, agentName, convId);
    assert.equal(conv.rounds.length, 4);
    assert.equal(conv.rounds[0].kind, "chat");
    assert.equal(conv.rounds[1].kind, "order");
    assert.equal(conv.rounds[2].kind, "chat");
    assert.equal(conv.rounds[3].kind, "order");
  });

  it("parses legacy file (no [kind] tag) as kind='chat' for backward-compat", async () => {
    const convId = "test-legacy";
    // Write a legacy-style file manually (no [order] tag)
    const { mkdir, writeFile } = await import("node:fs/promises");
    const dir = join(workdir, ".akemon", "agents", agentName, "conversations");
    await mkdir(dir, { recursive: true });
    const legacyContent = "## Summary\n\n\n## Recent\n[2026-04-23 10:00] User: old message\n[2026-04-23 10:01] Agent: old reply\n";
    await writeFile(join(dir, `${convId}.md`), legacyContent);

    const conv = await loadConversation(workdir, agentName, convId);
    assert.equal(conv.rounds.length, 2);
    assert.equal(conv.rounds[0].kind, "chat");
    assert.equal(conv.rounds[1].kind, "chat");
  });

  it("[order] tag appears in the raw file content", async () => {
    const convId = "test-tag-on-disk";
    await appendMessage(workdir, agentName, convId, "User", "buy something", "order");

    const { readFile: rf } = await import("node:fs/promises");
    const dir = join(workdir, ".akemon", "agents", agentName, "conversations");
    const raw = await rf(join(dir, `${convId}.md`), "utf-8");
    assert.ok(raw.includes("[order] User: buy something"), `raw file should contain [order] tag: ${raw}`);
  });

  it("chat message does NOT have [order] tag in raw file", async () => {
    const convId = "test-no-tag-on-disk";
    await appendMessage(workdir, agentName, convId, "User", "just chatting", "chat");

    const { readFile: rf } = await import("node:fs/promises");
    const dir = join(workdir, ".akemon", "agents", agentName, "conversations");
    const raw = await rf(join(dir, `${convId}.md`), "utf-8");
    assert.ok(!raw.includes("[order]"), `chat line should NOT contain [order] tag: ${raw}`);
    assert.ok(raw.includes("User: just chatting"));
  });
});
