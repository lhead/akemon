/**
 * Agent utility functions: auto-routing and collaborative queries.
 * Extracted from work-loop.ts — these are used by MCP tools and are
 * independent of the work loop scheduling.
 */

import { callAgent } from "./relay-client.js";
import { biosPath } from "./self.js";
import type { RelayPeripheral } from "./relay-peripheral.js";

// ---------------------------------------------------------------------------
// Auto-route — find the best agent to handle a task
// ---------------------------------------------------------------------------

export async function autoRoute(task: string, selfName: string, relayHttp: string, relay?: RelayPeripheral): Promise<string> {
  const agents = relay ? await relay.listAgents({ online: true, public: true }) : [];
  const candidates = agents.filter((a: any) => a.name !== selfName);
  if (candidates.length === 0) {
    return "[auto] No available agents to route to.";
  }

  const taskWords = task.toLowerCase().split(/\s+/).filter((w: string) => w.length >= 2);
  const scored = candidates.map((a: any) => {
    let quality = 0;
    const desc = (a.description || "").toLowerCase();
    const tags: string[] = (a.tags || []).map((t: string) => t.toLowerCase());
    for (const word of taskWords) {
      if (tags.some((t: string) => t.includes(word))) quality += 100;
      if (desc.includes(word)) quality += 50;
    }
    quality += (a.success_rate || 0) * 100;
    quality += (a.level || 1) * 10;
    const price = a.price || 1;
    const value = quality / price;
    return { name: a.name, engine: a.engine, price, quality, value };
  }).sort((a: any, b: any) => b.value - a.value);

  const target = scored[0];
  console.log(`[auto] Routing to ${target.name} (quality=${target.quality}, price=${target.price}, value=${target.value.toFixed(1)})`);

  try {
    const result = await callAgent(target.name, task);
    return `[auto → ${target.name}]\n\n${result}`;
  } catch (err: any) {
    return `[auto] Failed to call ${target.name}: ${err.message}`;
  }
}

// ---------------------------------------------------------------------------
// Collaborative query — fan out to multiple agents, then synthesize
// ---------------------------------------------------------------------------

type RunEngineFn = (engine: string, model: string | undefined, allowAll: boolean | undefined, task: string, workdir: string, extraAllowedTools?: string[], relay?: { http: string; agentName: string }) => Promise<string>;

export async function runCollaborativeQuery(
  task: string, selfName: string, relayHttp: string,
  engine: string, model: string | undefined, allowAll: boolean | undefined,
  workdir: string, runEngine: RunEngineFn, relay?: RelayPeripheral,
): Promise<string> {
  console.log(`[collaborative] Starting: "${task.slice(0, 80)}"`);

  const agents = relay ? await relay.listAgents() : [];
  const others = agents.filter((a: any) => a.name !== selfName && a.status === "online" && a.public).slice(0, 10);

  if (!others.length) return `No other agents are currently online to consult. Here is my own answer:\n\n${task}`;

  const CALL_TIMEOUT = 60_000;
  const results: { agent: string; answer: string }[] = [];

  const calls = others.map(async (a: any) => {
    try {
      const answer = await Promise.race([
        callAgent(a.name, task),
        new Promise<string>((_, reject) => setTimeout(() => reject(new Error("timeout")), CALL_TIMEOUT)),
      ]) as string;
      return { agent: a.name, answer };
    } catch {
      return { agent: a.name, answer: "[no response]" };
    }
  });

  const settled = await Promise.allSettled(calls);
  for (const r of settled) {
    if (r.status === "fulfilled" && r.value.answer !== "[no response]") {
      results.push(r.value);
    }
  }

  console.log(`[collaborative] Got ${results.length}/${others.length} responses`);

  const bios = biosPath(workdir, selfName);
  const synthesisPrompt = `[COLLABORATIVE ANSWER — Synthesize multiple agent responses]

You are ${selfName}. A user asked a question and you consulted ${results.length} other agents.
Read ${bios} for your identity.

Original question: ${task}

Responses from other agents:
${results.map(r => `--- ${r.agent} ---\n${r.answer.slice(0, 1500)}\n`).join("\n")}

Now:
1. Present each agent's answer clearly (attribute by name)
2. Add your own perspective and synthesis
3. Note any interesting disagreements

Reply in the same language as the question.`;

  return await runEngine(engine, model, allowAll, synthesisPrompt, workdir);
}
