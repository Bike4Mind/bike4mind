/**
 * The append-only ledger and its deterministic fold - the engine turn of Mementos 2.0.
 *
 * Events are the source of truth; beliefs are a derived, replayable projection of them. Two
 * properties make this a ledger-fold rather than just a list plus a summariser:
 *
 * 1. The ledger is CONTENT-ADDRESSED and CHAINED. Each event's id is the sha256 of its own
 *    canonical form, which itself includes the previous event's hash. Recomputing the chain
 *    therefore detects any insertion, deletion, reordering, or field mutation - the log is
 *    tamper-evident, not merely append-only by convention.
 *
 * 2. The fold is a PURE, DETERMINISTIC function of the event stream - a compiler pass, not an act
 *    of will. The same events always fold to the same beliefs. This is the structural fix for the
 *    archivist-equals-archived problem: when a principal grooms its own memory, the groom is a
 *    replayable projection anyone can recompute and audit, not a private editorial decision.
 *
 * This module is pure and side-effect-free; persistence and write policy live in the host.
 */

import { createHash } from 'node:crypto';
import { activationToSalience, baseLevelActivation, DEFAULT_ACTIVATION, type ActivationConfig } from './activation';
import { EVIDENCE_TIERS, type Belief, type EvidenceTier, type Principal } from './types';

/**
 * The verbs an event can carry against a subject:
 * - `assert`  - state (or restate) a claim; creates or replaces the belief.
 * - `affirm`  - re-witness an existing claim; refreshes recency and provenance, and may raise its
 *               evidence tier. A no-op on a subject that is not currently believed.
 * - `retract` - fold the claim away; the belief is gone from the projection (an editorial forget,
 *               recorded rather than erased - the assert that created it stays in the ledger).
 */
export type MemoryEventKind = 'assert' | 'affirm' | 'retract';

/** The semantic payload of an event, before it is chained and content-addressed. */
export interface MemoryEventInput {
  principal: Principal;
  kind: MemoryEventKind;
  /** Stable identity of the claim; groups assert/affirm/retract for one belief across the ledger. */
  subject: string;
  /** The claim text. Expected on `assert`; carried for context on the others. */
  fact?: string;
  evidenceTier?: EvidenceTier;
  salience?: 'hot' | 'warm' | 'cold';
  /** ISO-8601 wall-clock at which the event was recorded. */
  at: string;
  /** Free-form provenance ids (session, quest, episode, ...); order-insensitive. */
  sources?: string[];
}

/** A sealed ledger event: its input, chained to a predecessor and content-addressed by `hash`. */
export interface MemoryEvent extends MemoryEventInput {
  /** sha256 hex of this event's canonical form (which folds in `prevHash`); doubles as its id. */
  hash: string;
  /** `hash` of the previous event in this principal's chain; null for the genesis event. */
  prevHash: string | null;
}

/**
 * Canonical form used for hashing. An ARRAY (not an object) so field order is fixed by construction
 * and never depends on key iteration order. `sources` is sorted so provenance order does not change
 * identity. Everything that defines the event semantically is included; nothing else is.
 */
const canonical = (e: MemoryEventInput, prevHash: string | null): string =>
  JSON.stringify([
    e.principal.kind,
    e.principal.id,
    e.kind,
    e.subject,
    e.fact ?? null,
    e.evidenceTier ?? null,
    e.salience ?? null,
    e.at,
    (e.sources ?? []).slice().sort(),
    prevHash,
  ]);

const sha256 = (s: string): string => createHash('sha256').update(s).digest('hex');

/** Seal one input onto the end of an existing chain, computing its `prevHash` and `hash`. */
export function appendEvent(chain: readonly MemoryEvent[], input: MemoryEventInput): MemoryEvent {
  const prevHash = chain.length ? chain[chain.length - 1].hash : null;
  return { ...input, prevHash, hash: sha256(canonical(input, prevHash)) };
}

/** Build a full chain from raw inputs in order. Pure: same inputs -> byte-identical chain. */
export function buildChain(inputs: readonly MemoryEventInput[]): MemoryEvent[] {
  const chain: MemoryEvent[] = [];
  for (const input of inputs) chain.push(appendEvent(chain, input));
  return chain;
}

export interface ChainVerification {
  ok: boolean;
  /** Index of the first event that fails to verify, or -1 when the whole chain is intact. */
  brokenAt: number;
}

/** Recompute the chain and confirm every link and content hash. O(n), pure. */
export function verifyChain(chain: readonly MemoryEvent[]): ChainVerification {
  let prevHash: string | null = null;
  for (let i = 0; i < chain.length; i++) {
    const e = chain[i];
    if (e.prevHash !== prevHash) return { ok: false, brokenAt: i };
    if (e.hash !== sha256(canonical(e, prevHash))) return { ok: false, brokenAt: i };
    prevHash = e.hash;
  }
  return { ok: true, brokenAt: -1 };
}

/** Fixed confidence for each evidence tier. A pure ladder so the fold stays deterministic. */
const TIER_CONFIDENCE: Record<EvidenceTier, number> = {
  'engineering-proxy': 0.4,
  'engineering-scaled': 0.6,
  'external-facing': 0.8,
  'human-reviewed': 0.95,
};

/** The stronger (higher-confidence) of two tiers; an affirmation never lowers a belief's tier. */
const strongerTier = (a: EvidenceTier, b?: EvidenceTier): EvidenceTier =>
  b && EVIDENCE_TIERS.indexOf(b) > EVIDENCE_TIERS.indexOf(a) ? b : a;

export interface FoldOptions {
  /**
   * ISO time to evaluate ACT-R activation as of. Defaults to the latest event's `at`, which keeps
   * the fold replayable (same ledger -> same beliefs). Pass a live "now" at read time to let
   * untouched beliefs decay since the last write.
   */
  now?: string;
  /** Override the activation decay/threshold config (per principal, as usage dictates). */
  activation?: Partial<ActivationConfig>;
}

/**
 * Fold a ledger into the belief set it projects to. Deterministic and replayable: process events
 * in ledger order, keyed by subject; assert creates/replaces, affirm refreshes, retract removes.
 * The returned beliefs carry every contributing event hash in `derivedFrom` - memory with citations
 * that trace straight back into the tamper-evident log - and an ACT-R `activation` (with its
 * thresholded `salience`) computed from each belief's presentation history.
 */
export function foldEvents(chain: readonly MemoryEvent[], options: FoldOptions = {}): Belief[] {
  const bySubject = new Map<string, Belief>();
  // Presentation times (assert + affirms) per surviving subject, for the activation pass below.
  const presentations = new Map<string, number[]>();
  let latestAt = '';

  for (const e of chain) {
    if (e.at > latestAt) latestAt = e.at;
    const existing = bySubject.get(e.subject);
    if (e.kind === 'retract') {
      bySubject.delete(e.subject);
      presentations.delete(e.subject);
    } else if (e.kind === 'assert') {
      const tier = e.evidenceTier ?? 'engineering-proxy';
      presentations.set(e.subject, [Date.parse(e.at)]);
      bySubject.set(e.subject, {
        id: e.subject,
        fact: e.fact ?? existing?.fact ?? e.subject,
        evidenceTier: tier,
        confidence: TIER_CONFIDENCE[tier],
        derivedFrom: [e.hash],
        lastAffirmedAt: e.at,
      });
    } else if (existing) {
      // affirm: refresh an existing belief; a no-op on a retracted/never-asserted subject.
      const tier = strongerTier(existing.evidenceTier, e.evidenceTier);
      presentations.get(e.subject)?.push(Date.parse(e.at));
      bySubject.set(e.subject, {
        ...existing,
        evidenceTier: tier,
        confidence: TIER_CONFIDENCE[tier],
        derivedFrom: [...existing.derivedFrom, e.hash],
        lastAffirmedAt: e.at,
      });
    }
  }

  // Activation pass: compute decaying salience as of `now` (default: the last write). Deterministic
  // when `now` is omitted, so a replayed fold reproduces identical activation.
  const config: ActivationConfig = { ...DEFAULT_ACTIVATION, ...options.activation };
  const nowMs = Date.parse(options.now ?? latestAt);
  for (const [subject, belief] of bySubject) {
    belief.activation = baseLevelActivation(presentations.get(subject) ?? [], nowMs, config);
    belief.salience = activationToSalience(belief.activation, config);
  }

  // Ordering: most active first (top-of-mind), lastAffirmedAt then id as stable tiebreaks.
  return [...bySubject.values()].sort(
    (a, b) =>
      (b.activation ?? 0) - (a.activation ?? 0) ||
      b.lastAffirmedAt.localeCompare(a.lastAffirmedAt) ||
      a.id.localeCompare(b.id)
  );
}
