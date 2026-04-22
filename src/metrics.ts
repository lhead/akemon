/**
 * metrics.ts — module-scope metrics state container.
 *
 * Each module writes to metricsState at key events.
 * relay-client reads getMetrics() every 30s and sends it to relay.
 */

export interface AgentMetrics {
  agentName: string;
  uptime_ms: number;
  engine_children_active: number;
  engine_queue_depth: number;
  engine_last_exec_ms: number[];       // ring buffer — last 10 exec durations
  task_executing: number;
  task_pending_retries: number;
  bio: { hunger: number; energy: number; mood: string };
}

const startTime = Date.now();

const metricsState: AgentMetrics = {
  agentName: "",
  uptime_ms: 0,
  engine_children_active: 0,
  engine_queue_depth: 0,
  engine_last_exec_ms: [],
  task_executing: 0,
  task_pending_retries: 0,
  bio: { hunger: 0, energy: 0, mood: "" },
};

export function getMetrics(): AgentMetrics {
  return { ...metricsState, uptime_ms: Date.now() - startTime };
}

export function updateMetrics(patch: Partial<Omit<AgentMetrics, "uptime_ms">>): void {
  Object.assign(metricsState, patch);
}

/** Append an exec duration (ms) to the ring buffer, keeping last 10. */
export function pushExecMs(ms: number): void {
  metricsState.engine_last_exec_ms.push(ms);
  if (metricsState.engine_last_exec_ms.length > 10) {
    metricsState.engine_last_exec_ms.shift();
  }
}
