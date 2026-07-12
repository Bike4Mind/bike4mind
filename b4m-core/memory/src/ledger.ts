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

import { createHash, randomBytes } from 'node:crypto';
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

/** Placeholder shown for a fact that has been shredded (its plaintext removed). */
export const REDACTED_FACT = '[shredded]';

/** The semantic payload of an event, before it is chained and content-addressed. */
export interface MemoryEventInput {
  principal: Principal;
  kind: MemoryEventKind;
  /** Stable identity of the claim; groups assert/affirm/retract for one belief across the ledger. */
  subject: string;
  /** The claim text - the shreddable payload. Expected on `assert`; carried for context otherwise. */
  fact?: string;
  evidenceTier?: EvidenceTier;
  salience?: 'hot' | 'warm' | 'cold';
  /** ISO-8601 wall-clock at which the event was recorded. */
  at: string;
  /** Free-form provenance ids (session, quest, episode, ...); order-insensitive. */
  sources?: string[];
  /**
   * Semantic embedding of `fact`, carried so the folded belief can be recalled by cosine similarity
   * without depending on a V1 memento twin to supply the vector.
   *
   * DELIBERATELY NOT part of the chain hash (see `chainCanonical`): it is DERIVED from the fact -
   * recomputable at any time, and not itself a claim - so the chain binds the fact's commitment and
   * stays authoritative over what was asserted. Keeping it out also means it can be dropped on shred
   * without breaking `verifyChain`, exactly as the plaintext fact can. The host encrypts it at rest
   * under the same key as the fact; the core stays plaintext-only.
   */
  embedding?: number[];
  /**
   * Per-event random salt binding the fact into its `commitment`. Generated at seal time when
   * omitted; accept it here only to make sealing reproducible in tests. Not secret.
   */
  salt?: string;
}

/**
 * A sealed ledger event, chained to a predecessor and content-addressed by `hash`.
 *
 * Shred-safety: the chain hashes over `commitment` (a salted hash of the fact), NOT the fact itself.
 * So the plaintext `fact` can be removed later - by dropping it, or in production by destroying its
 * encryption key - and the chain still VERIFIES (the commitment persists) while the content becomes
 * unreadable. This is what lets a principal's memory honor deletion without breaking the append-only
 * tamper-evident log.
 */
export interface MemoryEvent extends MemoryEventInput {
  salt: string;
  /** Salted hash of the fact; this (not the fact) is what the chain hash binds to. */
  commitment: string;
  /** True once the plaintext `fact` has been shredded; the commitment and chain stay intact. */
  shredded?: boolean;
  /** sha256 hex of this event's canonical form (which folds in `prevHash`); doubles as its id. */
  hash: string;
  /** `hash` of the previous event in this principal's chain; null for the genesis event. */
  prevHash: string | null;
}

const sha256 = (s: string): string => createHash('sha256').update(s).digest('hex');

/** Salted commitment to the fact - binds the (shreddable) plaintext into the chain via a hash. */
const commit = (salt: string, fact?: string): string => sha256(`${salt} ${JSON.stringify(fact ?? null)}`);

/**
 * Canonical form used for the chain hash. An ARRAY (not an object) so field order is fixed by
 * construction. `commitment` stands in for the fact, so the hash survives shredding; `sources` is
 * sorted so provenance order does not change identity.
 */
const chainCanonical = (e: MemoryEventInput, commitment: string, prevHash: string | null): string =>
  JSON.stringify([
    e.principal.kind,
    e.principal.id,
    e.kind,
    e.subject,
    commitment,
    e.evidenceTier ?? null,
    e.salience ?? null,
    e.at,
    (e.sources ?? []).slice().sort(),
    prevHash,
  ]);

/**
 * Seal an input onto a known predecessor hash (null for the genesis event): mint a salt, commit the
 * fact, and hash over the commitment. The persistence-friendly core of the append - a store can
 * chain onto its stored head hash without materialising the whole chain in memory.
 */
export function sealEvent(prevHash: string | null, input: MemoryEventInput): MemoryEvent {
  const salt = input.salt ?? randomBytes(16).toString('hex');
  const commitment = commit(salt, input.fact);
  return {
    ...input,
    salt,
    commitment,
    prevHash,
    hash: sha256(chainCanonical(input, commitment, prevHash)),
  };
}

/**
 * Shred an event's plaintext: remove `fact` while keeping the salt, commitment, hash, and links. The
 * chain still verifies afterwards and the fold redacts the belief. In production the same effect
 * comes from destroying the fact's encryption key; this models it for a plaintext ledger.
 */
export function shredEvent(event: MemoryEvent): MemoryEvent {
  const { fact: _fact, ...rest } = event;
  return { ...rest, shredded: true };
}

/** Seal one input onto the end of an in-memory chain, computing its `prevHash` and `hash`. */
export function appendEvent(chain: readonly MemoryEvent[], input: MemoryEventInput): MemoryEvent {
  return sealEvent(chain.length ? chain[chain.length - 1].hash : null, input);
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

/**
 * Recompute the chain and confirm every link and hash. Keyless and shred-safe: it hashes over the
 * stored `commitment`, so it passes on shredded events too (the fact is gone but the commitment
 * remains). While a fact IS present, it also checks the fact still matches its commitment, so a
 * tampered plaintext is caught; a shredded event skips that check (nothing to recompute). O(n), pure.
 */
export function verifyChain(chain: readonly MemoryEvent[]): ChainVerification {
  let prevHash: string | null = null;
  for (let i = 0; i < chain.length; i++) {
    const e = chain[i];
    if (e.prevHash !== prevHash) return { ok: false, brokenAt: i };
    if (e.hash !== sha256(chainCanonical(e, e.commitment, prevHash))) return { ok: false, brokenAt: i };
    if (!e.shredded && e.fact !== undefined && e.commitment !== commit(e.salt, e.fact)) {
      return { ok: false, brokenAt: i };
    }
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
        fact: e.shredded ? REDACTED_FACT : (e.fact ?? existing?.fact ?? e.subject),
        ...(e.shredded ? { shredded: true } : {}),
        // A shredded event has no readable fact, so any embedding it carried is meaningless (and is
        // dropped at rest anyway) - never surface one for a redacted belief.
        ...(!e.shredded && e.embedding?.length ? { embedding: e.embedding } : {}),
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
        // An affirm re-witnesses the SAME claim, so it does not replace an embedding the belief
        // already has - but it does backfill one for a belief asserted before embeddings were carried.
        ...(!existing.embedding?.length && e.embedding?.length ? { embedding: e.embedding } : {}),
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
