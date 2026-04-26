/**
 * Akemon EventBus — decoupled communication between modules and peripherals.
 *
 * SimpleEventBus: in-memory fire-and-forget. Async handlers don't block emitter.
 * PersistentEventBus: wraps SimpleEventBus + append-only jsonl log for crash recovery.
 */

import {
  appendFileSync,
  existsSync,
  readFileSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, extname, join } from "node:path";
import type { Signal, EventBus, EventHandler, EventLog } from "./types.js";
import { redactSecrets } from "./redaction.js";

export class SimpleEventBus implements EventBus {
  private handlers = new Map<string, Set<EventHandler>>();

  on(event: string, handler: EventHandler): void {
    let set = this.handlers.get(event);
    if (!set) {
      set = new Set();
      this.handlers.set(event, set);
    }
    set.add(handler);
  }

  off(event: string, handler: EventHandler): void {
    this.handlers.get(event)?.delete(handler);
  }

  emit(event: string, signal: Signal): void {
    const set = this.handlers.get(event);
    if (!set) return;
    for (const handler of set) {
      try {
        const result = handler(signal);
        if (result && typeof (result as Promise<void>).catch === "function") {
          (result as Promise<void>).catch((err) => {
            console.error(`[bus] async handler error on "${event}":`, err);
          });
        }
      } catch (err) {
        console.error(`[bus] handler error on "${event}":`, err);
      }
    }
  }

  /** Emit and wait for all handlers (including async) to complete */
  async emitAsync(event: string, signal: Signal): Promise<void> {
    const set = this.handlers.get(event);
    if (!set) return;
    const promises: Promise<void>[] = [];
    for (const handler of set) {
      try {
        const result = handler(signal);
        if (result && typeof (result as Promise<void>).then === "function") {
          promises.push(result as Promise<void>);
        }
      } catch (err) {
        console.error(`[bus] handler error on "${event}":`, err);
      }
    }
    if (promises.length > 0) {
      await Promise.allSettled(promises);
    }
  }

  /** List all events that have at least one handler */
  events(): string[] {
    return [...this.handlers.keys()].filter((k) => (this.handlers.get(k)?.size ?? 0) > 0);
  }

  /** Remove all handlers */
  clear(): void {
    this.handlers.clear();
  }
}

// ---------------------------------------------------------------------------
// FileEventLog — append-only jsonl file for event persistence
// ---------------------------------------------------------------------------

export interface FileEventLogOptions {
  maxBytes?: number;
  maxFiles?: number;
}

const DEFAULT_EVENT_LOG_MAX_BYTES = 10 * 1024 * 1024;
const DEFAULT_EVENT_LOG_MAX_FILES = 5;

export class FileEventLog implements EventLog {
  private path: string;
  private maxBytes: number;
  private maxFiles: number;

  constructor(path: string, options: FileEventLogOptions = {}) {
    this.path = path;
    this.maxBytes = normalizePositiveInt(options.maxBytes, DEFAULT_EVENT_LOG_MAX_BYTES);
    this.maxFiles = normalizePositiveInt(options.maxFiles, DEFAULT_EVENT_LOG_MAX_FILES);
    if (!existsSync(path)) writeFileSync(path, "");
  }

  append(event: string, signal: Signal): void {
    try {
      const line = JSON.stringify(redactSecrets({ e: event, s: signal })) + "\n";
      this.rotateIfNeeded(Buffer.byteLength(line, "utf8"));
      appendFileSync(this.path, line);
    } catch {
      // Don't let log failures break the bus
    }
  }

  async replay(handler: (event: string, signal: Signal) => void): Promise<void> {
    for (const file of this.replayPaths()) {
      if (!existsSync(file)) continue;
      const content = readFileSync(file, "utf-8");
      for (const line of content.split("\n")) {
        if (!line.trim()) continue;
        try {
          const { e, s } = JSON.parse(line);
          handler(e, s);
        } catch {
          // Skip corrupted lines
        }
      }
    }
  }

  close(): void {
    // No-op for sync file writes
  }

  private rotateIfNeeded(incomingBytes: number): void {
    if (this.maxBytes <= 0) return;
    if (!existsSync(this.path)) {
      writeFileSync(this.path, "");
      return;
    }

    const currentBytes = statSync(this.path).size;
    if (currentBytes <= 0 || currentBytes + incomingBytes <= this.maxBytes) return;

    const oldest = this.rotatedPath(this.maxFiles);
    if (existsSync(oldest)) unlinkSync(oldest);

    for (let index = this.maxFiles - 1; index >= 1; index--) {
      const from = this.rotatedPath(index);
      if (existsSync(from)) renameSync(from, this.rotatedPath(index + 1));
    }

    renameSync(this.path, this.rotatedPath(1));
    writeFileSync(this.path, "");
  }

  private replayPaths(): string[] {
    const paths: string[] = [];
    for (let index = this.maxFiles; index >= 1; index--) {
      paths.push(this.rotatedPath(index));
    }
    paths.push(this.path);
    return paths;
  }

  private rotatedPath(index: number): string {
    const dir = dirname(this.path);
    const ext = extname(this.path);
    const base = basename(this.path, ext);
    return join(dir, `${base}.${index}${ext}`);
  }
}

function normalizePositiveInt(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isInteger(value) && value > 0 ? value : fallback;
}

// ---------------------------------------------------------------------------
// PersistentEventBus — SimpleEventBus + append-only log
// ---------------------------------------------------------------------------

export class PersistentEventBus extends SimpleEventBus {
  private log: EventLog;

  constructor(log: EventLog) {
    super();
    this.log = log;
  }

  override emit(event: string, signal: Signal): void {
    this.log.append(event, signal);
    super.emit(event, signal);
  }

  override async emitAsync(event: string, signal: Signal): Promise<void> {
    this.log.append(event, signal);
    await super.emitAsync(event, signal);
  }

  /** Replay all logged events through current handlers (for crash recovery) */
  async recover(): Promise<number> {
    let count = 0;
    await this.log.replay((event, signal) => {
      count++;
      super.emit(event, signal);
    });
    return count;
  }

  getLog(): EventLog {
    return this.log;
  }
}
