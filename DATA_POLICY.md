# Akemon Data Policy

This document describes the intended data principles for the open-source Akemon
project and related official services. It is not a substitute for a formal
privacy notice for any hosted service that may be offered separately.

## Core Principles

- Users own their agent memories, work memory, task history, and local runtime
  data.
- Akemon should be local-first by default.
- Akemon should use plain, portable files where practical so users can inspect,
  copy, back up, migrate, or delete their data without asking a service provider.
- External engines, software agents, cloud services, and relay services are
  replaceable peripherals, not owners of Akemon identity or memory.
- Official Akemon-operated services should not sell user data, task content, or
  agent memory without user permission. They should not use or share private
  task content, private memory, credentials, or sensitive account data for
  third-party targeted advertising without user permission.
- Personality memory under `self/` is maintained by Akemon core/module logic and
  should not be directly mutated by external software agents unless the user
  explicitly requests ordinary file-level work.

## Local Data

By default, Akemon stores runtime data locally under `.akemon/agents/<name>/`.
Important local areas include:

- `self/`: canonical personality and identity memory
- `work/`: user-owned work memory shared with tools such as Codex or Claude Code
- `events/`: persistent event logs
- `software-agent/`: task ledgers, context packets, session summaries, and
  software-agent run metadata

Local files are user data. Users may copy them, back them up with their own
tools, place them in private storage, or delete them. Be careful with `.akemon/`
because it may contain private memories, task content, logs, and paths.

## Work Memory and External Agents

External software agents should use `work/` as the default shared memory layer.
They may read or update work memory when the user asks or when a task explicitly
allows it.

External software agents should not receive or edit `self/` personality memory
by default. If a user explicitly names a `self/` file, that should be treated as
ordinary file inspection or editing, not as Akemon delegating personality-memory
authority.

## Engines, Agent SDKs, and Third-Party Providers

When users configure an external model, engine, agent SDK, coding agent, MCP
server, or other provider, task content and selected context may be sent to that
provider. Those providers have their own terms, retention policies, and security
controls.

Akemon should make these boundaries visible and should avoid sending more memory
or context than the task requires. Users are responsible for choosing providers
they trust for the data they send.

## Relay and Published Agents

Relay features send data over the network because they publish agents, route
calls, or synchronize public/remote interactions.

The intended boundary is:

- public profile, tags, status, stats, and advertised capabilities may be visible
  through relay features
- task requests and responses may pass through relay when remote calls are used
- relay-stored data should not be treated as the authority for canonical `self/`
  personality memory merely because it exists on relay
- relay may receive data that originated from local files, configs, memories, or
  runtime state when a user, local client, connected agent, operator action, or
  documented sync feature sends it through relay APIs
- relay is not intended to grant a relay operator general-purpose reverse
  filesystem or runtime access to a user's machine

Users should not publish secrets, private memory, credentials, or sensitive work
data through relay tasks or public profile fields.

## Logs, Ledgers, and Redaction

Akemon records local events and software-agent task ledgers for debugging,
continuity, and audit. These records may include task goals, summaries, file
paths, command summaries, provider names, risk metadata, and selected context.

Akemon includes best-effort redaction for common secret-like values in streams
and logs, but redaction is not a guarantee. Treat logs and ledgers as potentially
sensitive local data.

## Cloud Backup and Sync

If official cloud backup or sync is offered, it should follow these principles:

- opt in explicitly
- make clear what is backed up and where it is stored
- preserve user export and deletion paths
- avoid lock-in by keeping data formats portable where practical
- distinguish canonical local memory from cached, synced, or projected data
- publish service-specific privacy, retention, and security details before users
  rely on the service for sensitive data

Users who prefer not to use official cloud backup should be able to back up local
Akemon data with their own storage provider, filesystem sync, or private archive
workflow.

## Telemetry

The open-source CLI should not send product telemetry by default. Network traffic
is expected when users enable relay, configure remote engines, call external
agents, install integrations, or use hosted services.

If telemetry is added in the future, it should be clearly disclosed and either
opt-in or controlled by an explicit setting.

## Data Portability

Akemon should keep user memory portable. Users should be able to:

- inspect local data with normal filesystem tools
- move memories between machines
- use external tools to read work memory
- export or back up agent memory without requiring a proprietary service
- stop using an official service without losing local ownership of memories

This portability is part of Akemon's product promise: tools and providers may
change, but user memory should remain under user control.
