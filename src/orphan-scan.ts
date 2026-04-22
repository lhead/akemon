/**
 * Orphan process scanner — run at daemon startup to reclaim stale CLI children
 * left over from a previous crash.
 *
 * Only kills processes that satisfy ALL of:
 *   1. ppid === 1  (re-parented to init/launchd — genuinely orphaned)
 *   2. command matches a known akemon CLI agent pattern
 *
 * Never kills ppid != 1 processes, preventing accidental damage to unrelated
 * processes that happen to have a matching command name.
 */

import { execFile } from "child_process";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface OrphanInfo {
  pid: number;
  ppid: number;
  command: string;
}

// ---------------------------------------------------------------------------
// Patterns — agent-mode invocations only (not install/update/etc.)
// ---------------------------------------------------------------------------

const AGENT_PATTERNS: RegExp[] = [
  /\bopencode\s+run\b/,   // opencode in run mode
  /\bclaude\s+-p\b/,      // claude with -p (print) flag
  /\bcodex\s+exec\b/,     // codex exec mode
  /\bgemini\s+-p\b/,      // gemini with -p flag
];

// ---------------------------------------------------------------------------
// Pure function — parse `ps -eo pid,ppid,command` output
// ---------------------------------------------------------------------------

export function parseProcessList(psOutput: string): OrphanInfo[] {
  const result: OrphanInfo[] = [];
  for (const line of psOutput.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    // Header or non-numeric first token → skip
    const match = trimmed.match(/^(\d+)\s+(\d+)\s+(.+)$/);
    if (!match) continue;
    const pid = parseInt(match[1], 10);
    const ppid = parseInt(match[2], 10);
    const command = match[3].trim();
    // Must be orphaned (ppid=1) AND match a known agent pattern
    if (ppid !== 1) continue;
    if (!AGENT_PATTERNS.some(p => p.test(command))) continue;
    result.push({ pid, ppid, command });
  }
  return result;
}

// ---------------------------------------------------------------------------
// Runtime — scan ps output and kill matched orphans
// ---------------------------------------------------------------------------

export async function scanAndKillOrphans(): Promise<number> {
  return new Promise<number>((resolve) => {
    execFile("ps", ["-eo", "pid,ppid,command"], (err, stdout) => {
      if (err) {
        console.log(`[orphan] ps failed: ${err.message}`);
        resolve(0);
        return;
      }
      const orphans = parseProcessList(stdout);
      if (orphans.length === 0) {
        console.log("[orphan] none found");
        resolve(0);
        return;
      }
      let killed = 0;
      for (const { pid, command } of orphans) {
        console.log(`[orphan] killing pid=${pid} cmd="${command.slice(0, 80)}"`);
        try {
          process.kill(pid, "SIGKILL");
          killed++;
        } catch (e: any) {
          console.log(`[orphan] failed to kill pid=${pid}: ${e.message}`);
        }
      }
      console.log(`[orphan] killed ${killed} process${killed !== 1 ? "es" : ""}`);
      resolve(killed);
    });
  });
}
