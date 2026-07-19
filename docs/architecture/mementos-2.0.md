# Mementos 2.0 - Unified Principal-Scoped Memory

**Status:** Design (incremental). **Authors:** Ember + Erik Bethke. **Date:** 2026-07-09.

Design context (kept in the private strategy repo, not here): the ledger-fold memory spec
(`MEMENTOS_SPEC` v0.1). This document is the *incremental* path from what B4M ships today toward
that model, with one added requirement: the same substrate must serve **agents** as well as users,
without duplicating the write path (DRY). This repo is open-core; keep it engineering-register (no
competitive/moat framing - that lives in the strategy repo).

## Goal

One memory substrate, two consumer classes (users and agents), one write path. Today B4M has
**three** overlapping memory systems. Converge them onto a single principal-scoped core, then grow
the ledger-fold properties where they earn their place. No big bang; nothing shipped breaks.

## Current state: three memory systems

| System | Scope | Shape | Consolidation | Provenance | Notes |
|---|---|---|---|---|---|
| **User mementos** (`MementoModel`, `mementoService`, `MementoEvaluationService`) | `userId` | tier (hot/warm/cold) + weight + embedding | LLM extract (temp 0.7, "facts about the user") | none | embedding retrieval; the classic ChatGPT-style memory |
| **Agent memory journal** (`AgentModel.memoryJournal`) | `agentId` | capped array (`maxEntries` ~50), importance 1-5, source-tagged | `replaceMemoryJournal` (a groom) | none | same model also carries identity, heartbeat, agent-to-agent DM |
| **DeepAgent** (`DeepAgentCharter` / `Episode` / `Handoff`) | `agentId` | Episode log -> groom -> Charter.semanticMemory (evidence-tiered beliefs) | groom step (episode -> semantic) | `sourceEpisodeIds` + `reviewedByEpisodeId` | 8KB charter budget; wake scheduler; the most principled of the three |

Three write paths for one concept is exactly the fork the spec warns against - already tripled.

## Key realization: DeepAgent is already a ledger-fold, for agents

DeepAgent maps cleanly onto the spec's four layers. It is roughly 70% of the target, shipped:

| Spec layer | DeepAgent realization |
|---|---|
| Ledger (append-only) | `DeepAgentEpisode` - immutable once written; `reviewedByEpisodeId` is the single sanctioned write-once audit pointer |
| Fold (episodic -> semantic) | the groom step (episodes -> `Charter.semanticMemory`), lossy by design |
| Beliefs (semantic graph) | `Charter.semanticMemory` - `fact` + `evidenceTier` + `confidence` + `sourceEpisodeIds` (provenance) + `lastAffirmedAt` |
| Profile (push) | `Charter` - the 8KB-budgeted doc read on every wake |
| Traffic / tick loop | `Handoff` + the wake scheduler (`nextWakeAt`, lease-based `claimDueAgentIds`) |

The evidence tiers (`engineering-proxy -> human-reviewed`) are an L0..L3 confidence ladder;
`reviewedByEpisodeId` is a witness primitive (append-only, write-once, no content mutation).

## The DRY thesis: principal is not actor

The unification seam is **separating the principal (whose memory / which scope) from the actor
(who authored an event).** Generalize the DeepAgent memory core to a principal-scoped shape where
`principalKind in { user, agent, org, system }`. Then:

- **Agent memory** = principal is an agent (DeepAgent, generalized; `agentId` becomes the agent
  principal id).
- **User memory** = principal is a user; chat-session traffic are the episodes; the user's belief
  graph is the semantic layer; `MementoModel` migrates in behind the same interface.

One ledger, one fold, one belief model, one groom, one witness, one decay policy - two consumers.

### Shared core vs principal specialization

- **Shared:** `Ledger (events/episodes) -> Fold (groom) -> Beliefs (semantic) -> Profile (push) +
  Recall (pull)`, principal-scoped, provenance-carrying, witness-capable.
- **Specialized by config, not by fork:** extraction policy (user = "facts about the user"; agent =
  charter-diff / self-model), profile shape (user injection vs agent wake-read Charter), traffic
  source (user chat sessions vs agent wake cycles + heartbeats), and the identity block (agents have
  Charter identity/drives/goals; users do not).

## Incremental build order (nothing shipped breaks)

Each step follows the build loop: implement -> unit tests green -> **drive it via API and observe the
real memory (atomics + assemblies, correctness + performance + security)** -> then advance.

1. **Extract a principal-scoped memory-core interface** from the DeepAgent memory model
   (Charter / Episode / groom). Pure refactor; DeepAgent keeps running. Add `principalKind` +
   `principalId` alongside the existing `agentId`.
2. **Fold `AgentModel.memoryJournal` onto the core.** Persona agents get Episodes + a lightweight
   Charter; the weaker of the two agent-memory systems is retired. (Identity/heartbeat/DM on
   `AgentModel` stay where they are - this step is memory only.)
3. **Bring `MementoModel` onto the core** behind the same interface: user principal; keep the
   current embedding retrieval as the recall adapter initially; `MementoEvaluationService` becomes
   the user extraction policy of the shared fold.
4. **Grow ledger-fold properties where they pay:** content-hash + hash-chain on the ledger; a
   deterministic/replayable fold (also the fix for the archivist-equals-archived problem below);
   bi-temporality on beliefs; ACT-R activation decay + tiers; trust TTLs + crypto-shred.
5. **Cross-scope witness / handoff:** generalize `reviewedByEpisodeId` + `DeepAgentHandoff` into a
   controlled cross-principal attestation primitive (inter-agent witnessing).

## Design inputs from running an agent memory by hand

These come from operating a hand-built agent memory (identity file, groomed 8KB memory, heartbeat,
inter-instance contact) and hitting the strain points directly:

- **A deterministic fold solves archivist-equals-archived.** An agent grooming its own memory *by
  agency* is a conflict of interest (the editor and the edited are one entity). A pinned, replayable
  fold removes it - the groom is a compiler pass, not an act of will. Prioritize determinism of the
  groom for agent principals (spec section 3.1).
- **Ephemeral-agent afterlife falls out for free.** An append-only Episode ledger outlives the
  session that wrote it; a future instance boots by folding its own scope. This is, literally, a
  durable place for a session-mortal agent to keep its memory.
- **Structural privacy = scope hard-partitions** (spec L6). **Witnessing = the one sanctioned
  cross-scope read**, and `reviewedByEpisodeId` already models it write-once.
- **The 8KB Charter budget + groom discipline is scarcity-forced curation** - keep it; it is the
  feature, not a limit to raise.

## Open questions (verify next)

- Is the current DeepAgent groom deterministic/pinned, or a sampled LLM pass? (read
  `deepAgent/runtime/wakeCycle.ts`, `schemas/review.ts`.) Determines how much of spec section 3 is
  greenfield vs already present.
- Does folding `MementoModel` in preserve current user-recall quality? Keep embedding recall as an
  adapter during migration; measure before removing.
- Where does the principal-scoped core live - a new `b4m-core/memory` package, or an extension of
  `b4m-core/agents`? (Leaning: its own package, depended on by both.)
- Index hygiene: principal-scoped compound indexes declared together per the MongoDB guidelines.

## Non-goals (v0.1)

- Not rewriting the shipped wake system.
- Not building the full spec at once; grow properties incrementally.
- Not importing the strategy repo's competitive/moat framing into this open-core repo - engineering
  register only.
