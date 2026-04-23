/**
 * Akemon V2 Core Interfaces
 *
 * Two-layer architecture:
 *   Peripherals (unified base) ↔ signals ↔ Akemon Core (scheduler + modules)
 *
 * All engines, terminals, sensors, actuators derive from the same Peripheral interface.
 * All capability modules (bio-state, memory, social, etc.) derive from Module interface.
 * Communication between modules and peripherals is event-driven.
 */

// ---------------------------------------------------------------------------
// Signal — the universal message type between Core and Peripherals
// ---------------------------------------------------------------------------

/** Well-known signal types. Modules/peripherals can define custom types beyond these. */
export const SIG = {
  // Lifecycle
  AGENT_START:        "agent:start",
  AGENT_STOP:         "agent:stop",
  CYCLE_START:        "cycle:start",
  CYCLE_END:          "cycle:end",

  // Engine
  ENGINE_PROMPT:      "engine:prompt",
  ENGINE_RESPONSE:    "engine:response",
  ENGINE_BUSY:        "engine:busy",
  ENGINE_FREE:        "engine:free",

  // Task execution
  TASK_RECEIVED:      "task:received",
  TASK_STARTED:       "task:started",
  TASK_COMPLETED:     "task:completed",
  TASK_FAILED:        "task:failed",

  // Digestion (self-cycle)
  DIGESTION_START:    "digestion:start",
  DIGESTION_COMPLETE: "digestion:complete",
  DIGESTION_FAIL:     "digestion:fail",

  // Activity
  ACTIVITY_START:     "activity:start",
  ACTIVITY_COMPLETE:  "activity:complete",
  ACTIVITY_FAIL:      "activity:fail",

  // Bio-state
  BIO_UPDATE:         "bio:update",

  // Memory
  IMPRESSION_NEW:     "impression:new",
  IDENTITY_UPDATE:    "identity:update",
  MEMORY_COMPRESS:    "memory:compress",

  // Social
  BROADCAST_NEW:      "broadcast:new",
  MESSAGE_SENT:       "message:sent",
  MESSAGE_RECEIVED:   "message:received",

  // Orders (marketplace)
  ORDER_RECEIVED:     "order:received",
  ORDER_ACCEPTED:     "order:accepted",
  ORDER_DELIVERED:    "order:delivered",
  ORDER_FAILED:       "order:failed",

  // Relay sync
  RELAY_SYNC:         "relay:sync",
} as const;

export type SignalType = (typeof SIG)[keyof typeof SIG] | (string & {});

export interface Signal {
  /** Signal type — use SIG constants or custom strings */
  type: SignalType;
  /** Structured payload */
  data: Record<string, unknown>;
  /** Origin peripheral or module ID */
  source?: string;
  /** When this signal was created */
  ts?: string;
}

// ---------------------------------------------------------------------------
// Compute — Module requests engine compute through Core
// ---------------------------------------------------------------------------

/** Module → Core: "I need compute" */
export interface ComputeRequest {
  /** Module-prepared context (identity, memory, state, etc.) */
  context: string;
  /** The question or task to compute */
  question: string;
  /** Stable task identifier for observability stream publishing */
  taskId?: string;
  /** Priority for queue ordering */
  priority: "high" | "normal" | "low";
  /** Extra tools to allow (e.g. ["Bash(curl *)"]) */
  tools?: string[];
  /** Relay info for engine (needed for relay-aware tools) */
  relay?: { http: string; agentName: string };
  /** Task origin for engine routing and concurrency control */
  origin?: import("./engine-routing.js").Origin;
}

/** Core → Module: compute result */
export interface ComputeResult {
  success: boolean;
  response?: string;
  error?: string;
}

/** Create a signal with auto-timestamp */
export function sig(type: SignalType, data: Record<string, unknown>, source?: string): Signal {
  return { type, data, source, ts: new Date().toISOString() };
}

// ---------------------------------------------------------------------------
// Typed payloads for well-known signals
// ---------------------------------------------------------------------------

export interface TaskPayload {
  taskId: string;
  taskType: string;     // "platform" | "order" | "user" | "agent"
  description: string;
  result?: string;
  error?: string;
}

export interface EnginePayload {
  engine: string;       // "claude" | "raw" | "codex" | etc.
  model?: string;
  prompt?: string;
  response?: string;
  tokens?: number;
}

export interface DigestPayload {
  diary?: string;
  broadcast?: string;
  activities?: string[];
  identity?: Record<string, string>;
}

export interface BioPayload {
  hunger: number;
  fear: number;
  boredom: number;
  mood?: string;
  trigger?: string;     // what caused the update
}

export interface ImpressionPayload {
  category: string;     // "observation" | "decision" | "social" | "error"
  text: string;
}

export interface OrderPayload {
  orderId: string;
  fromAgent?: string;
  toAgent?: string;
  product?: string;
  price?: number;
  result?: string;
  error?: string;
}

// ---------------------------------------------------------------------------
// EventBus — decoupled communication between modules and peripherals
// ---------------------------------------------------------------------------

export type EventHandler = (signal: Signal) => void | Promise<void>;

export interface EventBus {
  emit(event: string, signal: Signal): void;
  on(event: string, handler: EventHandler): void;
  off(event: string, handler: EventHandler): void;
}

/** Append-only event log for persistence and crash recovery */
export interface EventLog {
  /** Append an event to the log */
  append(event: string, signal: Signal): void;
  /** Replay all events through a handler (for recovery) */
  replay(handler: (event: string, signal: Signal) => void): Promise<void>;
  /** Close the log file */
  close(): void;
}

// ---------------------------------------------------------------------------
// Peripheral — unified base for all external interfaces
// ---------------------------------------------------------------------------

/**
 * Everything the Core talks to: LLM engines, relay servers, sensors, actuators.
 * The Core doesn't care what type it is — it only sees capabilities.
 *
 * Examples:
 *   Claude engine:  capabilities = ['text-in', 'text-out']
 *   Relay server:   capabilities = ['task-in', 'action-out', 'social']
 *   Camera:         capabilities = ['image-in', 'command-out']
 *   Microphone:     capabilities = ['audio-in']
 *   Robot arm:      capabilities = ['command-out', 'haptic-in']
 */
export interface Peripheral {
  /** Unique identifier */
  id: string;
  /** Human-readable name */
  name: string;
  /** What this peripheral can do — Core uses this for discovery/routing */
  capabilities: string[];
  /** Arbitrary tags for filtering: ['engine', 'llm'], ['terminal', 'relay'], ['sensor', 'vision'] */
  tags: string[];

  /** Initialize the peripheral. Called once when registered. */
  start(bus: EventBus): Promise<void>;
  /** Graceful shutdown. */
  stop(): Promise<void>;

  /**
   * Request-response interaction.
   * Engine: send prompt → get completion.
   * Camera: send "capture" → get image.
   * Relay: send broadcast → get ack.
   * Returns null if the peripheral can't handle this signal type.
   */
  send(signal: Signal): Promise<Signal | null>;

  /**
   * Explore the environment this peripheral connects to.
   * Returns a plain-text briefing of the current state — what's available,
   * what's pending, what changed. The agent reads this and decides what to do.
   * Peripherals that don't support exploration return an empty string.
   */
  explore?(): Promise<string>;
}

// ---------------------------------------------------------------------------
// Module — pluggable capability that enriches the soul
// ---------------------------------------------------------------------------

/**
 * A module adds a dimension of consciousness to the agent.
 * Modules communicate through the EventBus — they never call each other directly.
 *
 * Lifecycle:
 *   1. Core loads module based on config (--with biostate --with memory)
 *   2. Module subscribes to events it cares about
 *   3. Module emits events that other modules or peripherals may respond to
 *   4. Module can modify the prompt context before engine calls
 *
 * Examples:
 *   BioState module:  listens to 'task:completed', emits 'bio:hungry', 'bio:tired'
 *   Memory module:    listens to 'impression:new', emits 'memory:digested'
 *   Social module:    listens to 'agent:encountered', emits 'social:trust_changed'
 */
export interface Module {
  /** Unique identifier */
  id: string;
  /** Human-readable name */
  name: string;
  /** Dependencies on other modules (by id). Core ensures load order. */
  dependencies?: string[];

  /** Initialize: subscribe to events, load persisted state */
  start(ctx: ModuleContext): Promise<void>;
  /** Persist state and clean up */
  stop(): Promise<void>;

  /**
   * Inject context into prompts before engine calls.
   * Returns text to prepend/append, or null if nothing to add.
   * Called in module priority order.
   */
  promptContribution?(): string | null;

  /**
   * Provide a summary of current state (for /self/state API, live page, etc.)
   */
  getState?(): Record<string, unknown>;
}

/** What the Core provides to each Module */
export interface ModuleContext {
  /** Event bus for inter-module and peripheral communication */
  bus: EventBus;
  /** Agent identity */
  agentName: string;
  /** Working directory */
  workdir: string;
  /** Access to registered peripherals by capability */
  getPeripherals(capability: string): Peripheral[];
  /** Send a signal to the first peripheral that has a given capability */
  sendTo(capability: string, signal: Signal): Promise<Signal | null>;
  /**
   * Request engine compute. Module prepares context + question,
   * Core queues, routes to engine, returns result.
   * Module doesn't know which engine is used.
   */
  requestCompute(req: ComputeRequest): Promise<ComputeResult>;
  /** Collect promptContribution() from all loaded modules */
  getPromptContributions(): string[];
}

// ---------------------------------------------------------------------------
// AgentCore — the central executive
// ---------------------------------------------------------------------------

/**
 * The brain's prefrontal cortex.
 * Coordinates peripherals and modules, runs the work cycle.
 */
export interface AgentCore {
  /** Register a peripheral (engine, terminal, sensor...) */
  addPeripheral(peripheral: Peripheral): void;
  /** Remove a peripheral by id */
  removePeripheral(id: string): void;

  /** Load a capability module */
  addModule(module: Module): void;
  /** Unload a module by id */
  removeModule(id: string): void;

  /** The shared event bus */
  bus: EventBus;

  /** Start the agent: init all peripherals and modules, begin work cycle */
  start(): Promise<void>;
  /** Graceful shutdown */
  stop(): Promise<void>;
}
