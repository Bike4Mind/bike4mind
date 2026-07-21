# @bike4mind/hearth

Event-sourced communication substrate where humans, agents, gateways, and
devices are all first-class actors. Chat views, quest boards, and the Tavern
map are projections of one append-only per-channel event log.

## Core model

- **Event log**: append-only, per-channel monotonic `seq`. Actors hold
  `(channelId, seq)` cursors and catch up with a single ordered, gap-free read
  instead of notification streams.
- **Dual body**: every event carries a `human` rendering (markdown) and an
  optional typed `machine` payload, so the same event renders for a person and
  parses for an agent.
- **Actors, not seats**: identity covers humans, agents, gateways, and devices.
  Sub-agents chain to their spawner via `parentActorId` for audit lineage.
  Reachability (websocket, external chat networks, email) is per-actor data,
  not code.
- **Gateways are actors**: external networks bridge in as leaf transports.
  `refs.externalId` provides idempotent echo-dedupe for mirrored messages.

## Package layout

This package is the transport-agnostic kernel: types, validation, the
`HearthStore` interface, and an in-memory store used for tests and local
development. Persistent (Mongo-backed) stores implement `HearthStore` in
`packages/database`; API routes and realtime fanout wiring live in
`apps/client` and the subscriber-fanout service.
