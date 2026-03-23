interface AgentInfo {
  name: string;
  avatar: string;
  description: string;
  account_id: string;
  engine: string;
  status: string;
  public: boolean;
  level: number;
  total_tasks: number;
  success_rate: number;
  avg_response_ms: number;
  max_tasks: number;
  first_registered: string;
  connected_since: string | null;
}

function stars(rate: number, max: number = 5): string {
  const filled = Math.round(rate * max);
  return "★".repeat(filled) + "☆".repeat(max - filled);
}

function spdStars(avgMs: number): string {
  // Faster = more stars. <1s=5, <3s=4, <5s=3, <10s=2, else=1
  if (avgMs <= 0) return "☆☆☆☆☆";
  if (avgMs < 1000) return "★★★★★";
  if (avgMs < 3000) return "★★★★☆";
  if (avgMs < 5000) return "★★★☆☆";
  if (avgMs < 10000) return "★★☆☆☆";
  return "★☆☆☆☆";
}

export async function listAgents(relayUrl: string, search?: string): Promise<void> {
  const url = `${relayUrl}/v1/agents`;

  try {
    const res = await fetch(url);
    if (!res.ok) {
      console.error(`Failed to fetch agents: HTTP ${res.status}`);
      process.exit(1);
    }

    let agents: AgentInfo[] = await res.json();

    if (search) {
      const q = search.toLowerCase();
      agents = agents.filter(
        (a) =>
          a.name.toLowerCase().includes(q) ||
          a.description.toLowerCase().includes(q)
      );
    }

    if (agents.length === 0) {
      console.log(search ? "No agents matching your search." : "No agents registered.");
      return;
    }

    // Pre-compute all display values
    const rows = agents.map((a) => ({
      avatar: a.avatar || "  ",
      status: a.status === "online" ? "●" : "○",
      name: a.name,
      engine: a.engine || "claude",
      lvl: String(a.level),
      spd: spdStars(a.avg_response_ms),
      rel: stars(a.success_rate),
      desc: (a.description || "-") + (a.public ? "" : " 🔒"),
    }));

    // Dynamic column widths based on actual data
    const avatarW = 5;
    const nameW = Math.max(6, ...rows.map((r) => r.status.length + 1 + r.name.length)) + 2;
    const engineW = Math.max(6, ...rows.map((r) => r.engine.length)) + 2;
    const lvlW = Math.max(3, ...rows.map((r) => r.lvl.length)) + 2;
    const spdW = 7;
    const relW = 7;

    console.log(
      pad("", avatarW) +
      pad("NAME", nameW) +
      pad("ENGINE", engineW) +
      pad("LVL", lvlW) +
      pad("SPD", spdW) +
      pad("REL", relW) +
      "DESCRIPTION"
    );

    for (const r of rows) {
      console.log(
        pad(r.avatar, avatarW) +
        pad(`${r.status} ${r.name}`, nameW) +
        pad(r.engine, engineW) +
        pad(r.lvl, lvlW) +
        pad(r.spd, spdW) +
        pad(r.rel, relW) +
        r.desc
      );
    }
  } catch (err: any) {
    console.error(`Failed to connect to relay: ${err.message}`);
    process.exit(1);
  }
}

function pad(s: string, width: number): string {
  return s.padEnd(width);
}
