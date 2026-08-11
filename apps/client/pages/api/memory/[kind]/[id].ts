import { baseApi } from '@server/middlewares/baseApi';
import {
  agentRepository,
  dataLakeRepository,
  deepAgentCharterRepository,
  memoryLedgerRepository,
  memoryPrincipalKeyRepository,
  mementoRepository,
} from '@bike4mind/database';
import {
  firstMatchStore,
  mergeStores,
  readPrincipalMemory,
  recall,
  REDACTED_FACT,
  subjectKey,
  type MemoryStore,
  type Principal,
  type PrincipalKind,
} from '@bike4mind/memory';
import { dataLakeService } from '@bike4mind/services';
import { createDeepAgentMemoryStore } from '@server/memory/deepAgentMemoryStore';
import {
  createLedgerMemoryStore,
  purgeUserMemory,
  shredBelief,
  shredPrincipalMemory,
} from '@server/memory/ledgerMemoryStore';
import { createKeyProvider } from '@server/memory/factCipher';
import { createPersonaAgentMemoryStore } from '@server/memory/personaAgentMemoryStore';
import { createUserMementoMemoryStore } from '@server/memory/userMementoMemoryStore';
import { toAccessContext } from '@server/dataLakes/toAccessContext';
import type { EntitlementRequest } from '@server/entitlements';

// The kinds this endpoint reads/deletes. `lake` differs from the owner-scoped kinds: a lake is
// org-shared, so its READ authz is entitlement/tag/org access (assertLakeAccess) and its DELETE is a
// MANAGE action (creator/admin) - not the "is this mine" rule the other kinds use. Static-registry
// (fallback) lakes have no creator and no keyed memory ledger, so they resolve to a 404 here.
// (Lake retention is also handled OUT of band: lake deletion crypto-shreds the ledger in
// cleanupDeletedDataLake, so this surface is for the in-app read/manage flows, not retention.)
const SUPPORTED_PRINCIPAL_KINDS: readonly PrincipalKind[] = ['user', 'agent', 'org', 'system', 'lake'];

/**
 * Resolve a lake to its memory ledger principal, enforcing the org-shared READ gate. `assertLakeAccess`
 * denies with a NotFoundError (-> 404 via baseApi) so a caller can't probe for a lake they can't see.
 * The ledger lives under the lake CREATOR's DEK and is keyed by `datalakeTag`, NOT the URL id (mirrors
 * recallLakeMemoryForSession). Returns null for a static-registry (fallback) lake, whose synthetic doc
 * carries an empty `createdByUserId` and has no keyed ledger to read or delete.
 */
async function resolveLakeMemoryTarget(
  req: EntitlementRequest,
  id: string
): Promise<{ principal: Principal; ownerUserId: string } | null> {
  const ctx = await toAccessContext(req);
  const lake = await dataLakeService.assertLakeAccess(id, ctx, { db: { dataLakes: dataLakeRepository } });
  if (!lake.createdByUserId) return null;
  return { principal: { kind: 'lake', id: lake.datalakeTag }, ownerUserId: lake.createdByUserId };
}

type ReadStore = { principal: Principal; store: MemoryStore } | { status: number; error: string };

/**
 * Build the read store + principal for a kind, applying that kind's read authz. Returns a
 * `{ status, error }` sentinel for an authz/absence failure the caller turns into a response
 * (assertLakeAccess denials instead throw and are handled by baseApi's onError as a 404).
 */
async function resolveReadStore(
  req: EntitlementRequest,
  kind: PrincipalKind,
  id: string,
  ownerUserId: string
): Promise<ReadStore> {
  const keys = createKeyProvider(memoryPrincipalKeyRepository);

  // A lake reads under its creator's key, not the caller's: org-shared, so access is by entitlement,
  // not ownership. The ledger store alone - no memento/charter union, which are user/agent concepts.
  if (kind === 'lake') {
    const target = await resolveLakeMemoryTarget(req, id);
    if (!target) return { status: 404, error: 'No memory found for this principal.' };
    return {
      principal: target.principal,
      store: createLedgerMemoryStore({ ledger: memoryLedgerRepository, keys, ownerUserId: target.ownerUserId }),
    };
  }

  // Defense-in-depth: a user may only read their OWN user-memory. Each store already owner-scopes its
  // reads (a cross-user principal returns null -> 404), but this makes the ownership boundary explicit
  // and independent of every store re-checking it. Agent/org/system kinds are owner-scoped by the
  // stores below (charter/persona reads are filtered to ownerUserId).
  if (kind === 'user' && id !== ownerUserId) {
    return { status: 403, error: 'You can only read your own user memory.' };
  }

  const ledgerStore = createLedgerMemoryStore({ ledger: memoryLedgerRepository, keys, ownerUserId });

  // A user's memory is the UNION of their V2 ledger and their legacy V1 mementos, so V2 surfaces
  // everything they have with no backfill (and a V1-only user, with no ledger, just sees mementos).
  // An agent principal first-matches the ledger, then its DeepAgent charter / persona journal.
  const store =
    kind === 'user'
      ? mergeStores([ledgerStore, createUserMementoMemoryStore({ mementos: mementoRepository, ownerUserId })])
      : firstMatchStore([
          ledgerStore,
          createDeepAgentMemoryStore({ charters: deepAgentCharterRepository, ownerUserId }),
          createPersonaAgentMemoryStore({ agents: agentRepository, ownerUserId }),
        ]);
  return { principal: { kind, id }, store };
}

/**
 * GET /api/memory/:kind/:id - read a principal's unified memory profile (Mementos 2.0).
 *
 * The unified surface over the principal-scoped memory core. An agent principal folds that agent's
 * DeepAgent charter (or, failing that, its persona-agent journal); a user principal folds that
 * user's own mementos; a lake principal folds that lake's extracted-belief ledger. User/agent are
 * owner-scoped (spec L6): you only see agents you own and only your own user memory, and a
 * not-found / not-owned principal returns 404 so the endpoint never reveals another principal's
 * existence. A lake is org-shared, so it is gated by lake access (entitlement/tag/org), not ownership.
 *
 * With `?q=<query>` the response also carries `recalled`: the beliefs ranked for that query by the
 * ACT-R retrieval score (activation + relevance), the read-time pull that a chat preamble would use.
 */
const handler = baseApi();

/**
 * DELETE /api/memory/:kind/:id - delete a principal's memory, for real (delete my data).
 *
 * USER: BOTH halves of what the unified read serves, because either alone is a false promise:
 * - the LEDGER is crypto-shredded: destroy the principal's data-encryption key, so every fact -
 *   including any sitting in a DB backup - becomes permanently unreadable, then clear and flag the
 *   chain. The hash chain still verifies and the beliefs fold to redactions.
 * - the V1 MEMENTOS are hard-deleted: they carry summary, full prompt and a plaintext embedding with
 *   no key to destroy, and the read UNIONS them with the ledger - so leaving them behind would hand
 *   the user's "deleted" memories straight back into the next chat prompt.
 * Owner-scoped: a caller may delete only their own user memory (agent/org deletion follows the
 * write path).
 *
 * LAKE: a manage action (creator/admin), because a lake's memory is org-shared - only the owner may
 * shred what the whole org reads. Pure ledger (no V1 memento twin, which is user-scoped), so a shred
 * never has to reach the memento store the user path reconciles against.
 *
 * Irreversible.
 */
handler.delete(async (req, res) => {
  const ownerUserId = req.user?.id;
  if (!ownerUserId) return res.status(401).json({ error: 'Authentication required' });

  const kind = String(req.query.kind);
  const id = String(req.query.id);
  if (!SUPPORTED_PRINCIPAL_KINDS.includes(kind as PrincipalKind)) {
    return res.status(400).json({ error: `Unsupported principal kind '${kind}'.` });
  }

  // ?subject=<beliefId> shreds ONE belief (the "delete this memory" action from the V2 dashboard); no
  // subject shreds the WHOLE principal ("delete all my memory").
  const subject = typeof req.query.subject === 'string' ? req.query.subject : undefined;

  if (kind === 'lake') {
    const target = await resolveLakeMemoryTarget(req, id);
    if (!target) return res.status(404).json({ error: 'No memory found for this principal.' });

    // Reading a lake is org-shared, but DELETING it is a MANAGE action: only the creator (or an
    // admin) may shred what the whole org reads. A reader who isn't the creator gets a 403, not a
    // 404 - assertLakeAccess already confirmed they can see the lake. Mirrors the lifecycle guards
    // (data-lakes/[id]/lifecycle.ts).
    if (!dataLakeService.canManageLake({ createdByUserId: target.ownerUserId }, { userId: ownerUserId, isAdmin: !!req.user?.isAdmin })) {
      return res.status(403).json({ error: 'Only the lake creator can delete its memory.' });
    }

    // A lake belief is pure LEDGER - no V1 memento twin (that union is user-scoped), so a single
    // shred is a straight ledger subject-shred under the creator's key.
    if (subject) {
      const shredded = await shredBelief(memoryLedgerRepository, target.principal, target.ownerUserId, subject);
      return res.status(200).json({ ok: true, shredded, deleted: shredded });
    }

    // Whole-lake purge: crypto-shred (destroy the DEK, mark the chain shredded) - the same operation
    // cleanupDeletedDataLake runs on lake deletion, but reachable while the lake is still active. It
    // resets what the lake has learned; a later extraction mints a fresh DEK and relearns from the
    // corpus.
    const shredded = await shredPrincipalMemory(
      memoryLedgerRepository,
      createKeyProvider(memoryPrincipalKeyRepository),
      target.principal,
      target.ownerUserId
    );
    return res.status(200).json({ ok: true, shredded });
  }

  if (kind !== 'user' || id !== ownerUserId) {
    return res.status(403).json({ error: 'You can only delete your own user memory for now.' });
  }

  // A belief in the unified view can be backed by the LEDGER (its id is a subject HMAC) or by a V1
  // MEMENTO (its id is a Mongo _id), and a ledger belief can ALSO have a V1 memento TWIN carrying the
  // same plaintext fact. So a real "delete forever" has to hit BOTH stores, exactly like the
  // whole-principal purge - otherwise the memento survives, reappears on refetch, and is re-injected
  // into the next chat prompt. `deleted === 0` means nothing matched (the caller surfaces that as a
  // failure rather than a false success).
  if (subject) {
    const ledgerStore = createLedgerMemoryStore({
      ledger: memoryLedgerRepository,
      keys: createKeyProvider(memoryPrincipalKeyRepository),
      ownerUserId: id,
    });
    // The belief's fact, read before the shred, is what identifies a V1 memento twin (same fact) that
    // has a different id from the ledger belief and would otherwise be missed. An ALREADY-shredded
    // belief (a retried delete after a partial failure) carries the redaction placeholder, not a fact -
    // deriving a factKey from '[shredded]' would match any memento normalizing to it and delete unrelated
    // content, so skip twin-matching in that case (id-match still applies).
    const profile = await ledgerStore.readProfile({ kind: 'user', id });
    const belief = profile?.beliefs.find(b => b.id === subject);
    const beliefFact = belief && !belief.shredded && belief.fact !== REDACTED_FACT ? belief.fact : undefined;
    const factKey = beliefFact ? subjectKey(beliefFact) : undefined;

    const shredded = await shredBelief(memoryLedgerRepository, { kind: 'user', id }, id, subject);

    const mementos = await mementoRepository.findByUserId(id, { select: 'summary' });
    const mementoIds = mementos
      .filter(m => String(m.id) === subject || (factKey && subjectKey(m.summary) === factKey))
      .map(m => String(m.id));
    const mementosDeleted = await mementoRepository.deleteByIdsForUser(mementoIds, id);

    return res.status(200).json({ ok: true, shredded, mementosDeleted, deleted: shredded + mementosDeleted });
  }

  // Both halves, or it is not deletion: the unified read serves the ledger UNIONED with the user's
  // V1 mementos, so shredding only the ledger left every memento readable - and re-injected into the
  // next chat prompt.
  const { eventsShredded, mementosDeleted } = await purgeUserMemory(
    memoryLedgerRepository,
    createKeyProvider(memoryPrincipalKeyRepository),
    mementoRepository,
    id
  );
  return res.status(200).json({ ok: true, shredded: eventsShredded, mementosDeleted });
});

handler.get(async (req, res) => {
  const ownerUserId = req.user?.id;
  if (!ownerUserId) return res.status(401).json({ error: 'Authentication required' });

  const kind = String(req.query.kind);
  const id = String(req.query.id);
  if (!SUPPORTED_PRINCIPAL_KINDS.includes(kind as PrincipalKind)) {
    return res.status(400).json({
      error: `Unsupported principal kind '${kind}'. Expected one of: ${SUPPORTED_PRINCIPAL_KINDS.join(', ')}.`,
    });
  }

  const resolution = await resolveReadStore(req, kind as PrincipalKind, id, ownerUserId);
  if ('status' in resolution) return res.status(resolution.status).json({ error: resolution.error });

  const profile = await readPrincipalMemory(resolution.principal, resolution.store);
  if (!profile) return res.status(404).json({ error: 'No memory found for this principal.' });

  // Strip the embedding from each belief before serializing. A vector is 512 floats (~1MB across a
  // real user's beliefs) that no reader of this endpoint needs - and, like the /api/mementos 502, an
  // unbounded vector payload is how this route would eventually blow the Lambda response limit.
  const lean = ({ embedding: _e, ...b }: (typeof profile.beliefs)[number]) => b;
  const leanProfile = { ...profile, beliefs: profile.beliefs.map(lean) };

  const query = typeof req.query.q === 'string' ? req.query.q : undefined;
  if (query !== undefined) {
    const recalled = recall(profile.beliefs, query).map(r => ({
      belief: lean(r.belief),
      relevance: r.relevance,
      score: r.score,
    }));
    return res.status(200).json({ profile: leanProfile, query, recalled });
  }

  return res.status(200).json({ profile: leanProfile });
});

export default handler;
