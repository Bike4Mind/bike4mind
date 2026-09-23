import {
  findingSourceRef,
  type IDataLakeDocument,
  type IDataLakeFindingDocument,
  type LakeFindingTerminalStatus,
} from '@bike4mind/common';
import { adminSettingsRepository, apiKeyRepository } from '@bike4mind/database';
import { apiKeyService } from '@bike4mind/services';
import { getSettingsByNames } from '@bike4mind/utils';
import type { Logger } from '@bike4mind/observability';
import { createLedgerAppendSession } from '@server/memory/mementoLedgerMirror';
import { createMementoEmbedder, type MementoEmbedder } from '@server/memory/mementoEmbedder';

/**
 * Why a resolution did not become a belief. Every one of these is an ordinary outcome, not a fault -
 * the caller reports them and carries on.
 */
export type BeliefSkipReason =
  | 'no-resolution'
  | 'platform-disabled'
  | 'lake-disabled'
  | 'memory-gate-unreadable'
  | 'lake-has-no-memory-principal'
  | 'shred-fence';

export type RecordBeliefResult = { recorded: true } | { recorded: false; reason: BeliefSkipReason };

/**
 * How long the belief path waits for an embedding vector before writing the belief without one.
 *
 * The resolve route awaits this AFTER the ruling is already committed, inside a 60 s server Lambda
 * (`infra/web.ts`), and `OpenAIEmbeddingService` sets no timeout of its own. Unbounded, a stalled
 * provider means no response on a request whose durable write already succeeded - and the client's
 * retry then 400s on the double-resolve guard the route is at pains to avoid.
 *
 * 10s is two orders of magnitude above a healthy embed and a small fraction of the budget, so it
 * fires only on a genuinely hung provider. It degrades to exactly the outcome a missing API key
 * already produces - a vectorless belief, still recallable on the lexical scorer - which is why
 * timing out is safe here: a belief that ranks on a weaker signal beats a lost response.
 */
const EMBED_TIMEOUT_MS = 10_000;

/**
 * Resolve the fact's vector, or `undefined` if the provider fails or outruns `EMBED_TIMEOUT_MS`.
 * Never throws and never leaves a timer pending (which would hold the Lambda's event loop open past
 * the response).
 */
async function embedWithinBudget(embed: MementoEmbedder, fact: string, logger: Logger): Promise<number[] | undefined> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      embed(fact),
      new Promise<undefined>(resolve => {
        timer = setTimeout(() => {
          logger.warn(
            `[lakeMemory] embedding a curator resolution exceeded ${EMBED_TIMEOUT_MS}ms; writing it without a vector`
          );
          resolve(undefined);
        }, EMBED_TIMEOUT_MS);
      }),
    ]);
  } catch (err: unknown) {
    // Logged rather than swallowed: nothing backfills a vector onto an event written without one
    // (`reembedMementos.ts:180` skips them), so a belief that misses its vector here misses it
    // permanently and ranks on lexical overlap forever. Still best-effort - a weaker belief beats
    // losing the curator's decision.
    logger.warn(
      `[lakeMemory] could not embed a curator resolution; writing it without a vector: ${
        err instanceof Error ? err.message : String(err)
      }`
    );
    return undefined;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * The sentence a curator's ruling contributes to lake memory.
 *
 * Framed, not bare: recall injects only `fact` text into the turn (`buildLakeMemoryContext` never
 * passes `sources` through), so without the frame the model reads an authoritative human judgement
 * as just another extracted claim, with no way to tell it outranks the documents it contradicts.
 * The finding's `kind` is included because the ruling is only meaningful against the problem it
 * answers - "they cover different years" means nothing without "duplicate content".
 *
 * `subject` is deliberately NOT included even though the finding carries one: it is a normalized
 * grouping KEY (lowercased, punctuation stripped), not prose, and reads as mangled text in a prompt.
 *
 * Pure and total, and exported for its test - the wording is the product here, not an implementation
 * detail.
 */
export function composeFindingResolutionFact(
  finding: Pick<IDataLakeFindingDocument, 'kind'>,
  status: LakeFindingTerminalStatus,
  resolution: string
): string {
  const verdict = status === 'dismissed' ? 'reviewed and dismissed' : 'reviewed and resolved';
  return `A curator ${verdict} a ${finding.kind} finding in this data lake, and recorded: ${resolution}`;
}

/**
 * Persist a curator's ruling on a finding as a lake-memory belief (#3049).
 *
 * A resolution used to live on the finding row and nowhere else, so the corpus problem a human had
 * already settled came back unsettled on the next turn. This writes the ruling into the lake's own
 * ledger chain, where recall can reach it, with provenance naming both the documents involved and
 * the finding it was decided on.
 *
 * A BELIEF HERE MEANS A HUMAN DECIDED. Nothing derives one from a detection: an empty resolution
 * note is skipped rather than synthesized into a sentence no curator wrote (`no-resolution`), which
 * keeps the `human-reviewed` tier honest - it is the top of the evidence ladder and outranks every
 * extracted fact it sits beside.
 *
 * EVERY ORDINARY REFUSAL IS A RETURN VALUE, not a throw: memory switched off, no note to record, a
 * lake with no principal, a missing embedding, the shred fence. A genuine subsystem fault (the key
 * service, the ledger itself) does still propagate, which is why the resolve route wraps the call
 * and this one does not pretend otherwise - a caller that must not fail has to catch. The ruling is
 * already committed to the finding row by the time this runs, and losing the durable record of a
 * human's decision to recover from a degraded ledger would be the worse of the two failures by a
 * wide margin.
 *
 * Writes under the LAKE principal - `{ kind: 'lake', id: lake.datalakeTag }`, encrypted to
 * `lake.createdByUserId` - and NOT under the curator's own principal. That pair is what
 * `recallLakeMemory` reads; a belief written under the curator would be invisible to every other
 * member of the lake, including the next session that hits the same confusion.
 */
export async function recordFindingResolutionBelief(
  params: {
    lake: IDataLakeDocument;
    finding: IDataLakeFindingDocument;
    status: LakeFindingTerminalStatus;
    resolution: string | null | undefined;
    /**
     * When the REQUEST arrived - not when this function runs, and not when it reaches the append.
     *
     * The crypto-shred fence refuses a write only when `destroyedAt >= startedAt`, and LIFTS the
     * tombstone when `destroyedAt < startedAt` (`MemoryPrincipalKeyModel`). So a value stamped after
     * this function's own awaits - the settings read, the key table, the embedding call - would be
     * later than a purge landing in that window: the fence would mint a fresh DEK and append a
     * `human-reviewed` belief AFTER the erase that was meant to take it. `DELETE /api/memory/lake/:id`
     * destroys exactly this principal while leaving the lake active, so a resolve click racing a
     * purge is a real interleaving, and nothing downstream refuses the write.
     *
     * Required with no default, for the reason `createLedgerAppendSession` gives: a default would
     * silently disable the fence for every caller whose work began earlier, which is all of them.
     */
    startedAt: Date;
  },
  deps: { logger: Logger }
): Promise<RecordBeliefResult> {
  const { lake, finding, status, startedAt } = params;
  const { logger } = deps;

  const resolution = params.resolution?.trim();
  if (!resolution) return { recorded: false, reason: 'no-resolution' };

  // Both gates, for the reason the extraction queue handler checks them: a belief written into a
  // lake whose memory is off is never read back, so it is invisible storage of a human's words
  // rather than a feature. The per-lake flag goes FIRST here, unlike that handler - it is already in
  // hand, so checking it first skips a settings read the answer cannot depend on.
  if (!lake.lakeMemoryEnabled) return { recorded: false, reason: 'lake-disabled' };

  // A FAILED LOOKUP IS NOT A RESOLVED FALSE. The queue handler lets this throw so SQS retries; there
  // is no retry behind a curator's click and the resolution is already committed, so this degrades
  // instead - but it degrades to its OWN reason and a log, never to `platform-disabled`. Reporting a
  // Mongo blip as "an operator turned this off" is what sends someone hunting a setting nobody
  // changed, and it is the only way this function fails without leaving a trace.
  let platformEnabled: unknown;
  try {
    platformEnabled = await adminSettingsRepository.getSettingsValue('EnableLakeMemory');
  } catch (err: unknown) {
    logger.warn('[lakeMemory] could not read EnableLakeMemory; not recording the curator resolution as a belief', {
      dataLakeId: lake.id,
      findingId: finding.id,
      error: err instanceof Error ? err.message : String(err),
    });
    return { recorded: false, reason: 'memory-gate-unreadable' };
  }
  if (!platformEnabled) return { recorded: false, reason: 'platform-disabled' };

  // Same prerequisite `extractLakeMemory` checks: without both there is no principal to write under
  // and no key owner to encrypt to.
  if (!lake.createdByUserId || !lake.datalakeTag) {
    logger.warn('[lakeMemory] lake missing owner or tag; not recording the curator resolution as a belief', {
      dataLakeId: lake.id,
      findingId: finding.id,
    });
    return { recorded: false, reason: 'lake-has-no-memory-principal' };
  }

  const ownerUserId = lake.createdByUserId;
  const fact = composeFindingResolutionFact(finding, status, resolution);

  // PROVENANCE, and both halves earn their place. The finding's documents keep the belief citable:
  // `recallLakeMemory` drops any belief whose sources are all unreachable, so a ruling carrying only
  // the finding ref would be written and then never recalled. The finding ref itself is what ties
  // the belief back to the problem it answers, and doubles as the shred key that retracts it if the
  // finding is ever purged.
  const sources = [...new Set(finding.sources.map(source => source.fabFileId))];
  sources.push(findingSourceRef(finding.id));

  const apiKeyTable = await apiKeyService.getEffectiveLLMApiKeys(
    ownerUserId,
    { db: { apiKeys: apiKeyRepository, adminSettings: adminSettingsRepository }, getSettingsByNames },
    { logger }
  );
  const embed = createMementoEmbedder(apiKeyTable, logger);
  const embedding = await embedWithinBudget(embed, fact, logger);

  const session = await createLedgerAppendSession({
    principal: { kind: 'lake', id: lake.datalakeTag },
    ownerUserId,
    startedAt,
  });

  const written = await session.append({
    summary: fact,
    // The top of the ladder, and the only writer that may claim it outright. `extractLakeMemory`
    // reaches it only by INFERENCE, from a curator tag on the source document; here a curator
    // literally typed the sentence.
    evidenceTier: 'human-reviewed',
    sources,
    embedding,
    // KEYED ON THE FINDING, not on the sentence. The default subject is a token bag derived from
    // `summary`, and an assert REPLACES the belief it lands on - so two findings of the same kind
    // ruled with the same note would fold into one, the second silently taking the first's fact and
    // provenance. Keying on the finding makes the identity match what a belief here actually IS: one
    // finding's ruling. Re-ruling one finding still coalesces (the curator's latest word wins, which
    // is what the replay route is for), and distinct findings never can.
    subject: findingSourceRef(finding.id),
  });

  // False, not an error: the lake's key was destroyed while this was in flight, so there is nothing
  // left to write the belief into. The finding still carries the resolution.
  if (!written) return { recorded: false, reason: 'shred-fence' };

  logger.info('[lakeMemory] recorded a curator resolution as a belief', {
    dataLakeId: lake.id,
    findingId: finding.id,
    status,
    embedded: Boolean(embedding?.length),
  });
  return { recorded: true };
}
