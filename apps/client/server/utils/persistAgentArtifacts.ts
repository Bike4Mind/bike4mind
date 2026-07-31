/**
 * Durable artifact rows for agent-mode runs.
 *
 * Agent replies carry `<artifact>` blocks as inline text; the cards render
 * straight from that text, but nothing ever wrote a row to the `artifacts`
 * collection. Chat mode persists client-side off its own WebSocket action
 * (`useSubscribeChatCompletion` -> `persistArtifactsFromQuest`), which the agent
 * path cannot reuse: the quests change-stream never reaches the browser for
 * agent quests, and the agent WS `completed` payload carries the PRE-bubble
 * answer. So the agent path persists server-side instead, which also works with
 * the tab closed and covers non-browser dispatch (Slack, API).
 *
 * Called from `persistRunAsQuest`, the single funnel for every agent terminal
 * write, so natural completion, in-loop abort and confidence-gate stop are all
 * covered by one insertion point. The failure path passes only
 * `toUserFacingFailureMessage(...)` - a sanitized generic string with no model
 * output - so it parses to zero artifacts and is a structural no-op; it needs no
 * guard of its own.
 */
import type { ArtifactType } from '@bike4mind/common';
import type { Logger } from '@bike4mind/observability';
// Deliberately the CLIENT parser, not `@bike4mind/utils` (which the other server
// callers use). Only this one exports `generateCompleteArtifactId`, and its exact
// `artifact_{type}_{identifier}_{timestamp}_{index}` shape is what
// `findExistingArtifactId` (app/utils/artifactPersistence.ts) matches positionally
// so the rendered card adopts this row instead of minting a fresh id. The two
// parsers are a known fork; consolidating them is a separate change.
import {
  checkHasDefaultExport,
  extractReactDependencies,
  generateCompleteArtifactId,
  parseArtifactsWithFallback,
} from '@client/app/utils/artifactParser';

/** Upper bound on rows written per run; excess is dropped and logged, never silent. */
export const MAX_AGENT_ARTIFACTS_PER_RUN = 25;

export interface AgentArtifactPayload {
  id: string;
  type: ArtifactType;
  title: string;
  description: string;
  content: string;
  visibility: 'private';
  tags: string[];
  sessionId: string;
  sourceQuestId: string;
  metadata: Record<string, unknown>;
}

/**
 * Parse a persisted agent reply into artifact create payloads. No I/O, and no
 * clock in the id, which is what makes a repeated terminal write idempotent.
 *
 * `questCreatedAtMs` must be a Quest-derived value, never `getArtifactTimestamp`
 * (artifactParser.ts) - that is a module-level `Date.now()` memo, so a cold
 * Lambda mints a different id on every invocation.
 */
export function buildAgentArtifactPayloads(args: {
  replyText: string;
  questId: string;
  questCreatedAtMs: number;
  sessionId: string;
}): AgentArtifactPayload[] {
  const { artifacts } = parseArtifactsWithFallback(args.replyText);

  // `parseArtifacts` sorts its result array in place by DESCENDING startIndex, so
  // this list runs last-to-first through the reply. That order is load-bearing only
  // because `_{index}` must be STABLE across re-parses of the same reply for the
  // idempotency pre-check to recognize an already-written row. Reordering here would
  // remint every id and orphan the rows already persisted. (Adoption by the rendered
  // card does not depend on it - `findExistingArtifactId` compares only the
  // identifier segment, never the timestamp or index.)
  return (
    artifacts
      .map((artifact, index) => ({
        id: generateCompleteArtifactId(artifact.type, artifact.identifier || '', args.questCreatedAtMs, index),
        type: artifact.type,
        // The create schema caps title at 255.
        title: (artifact.title || artifact.type).slice(0, 255),
        description: `AI-generated ${artifact.type} component`,
        content: artifact.content,
        visibility: 'private' as const,
        tags: ['ai-generated'],
        sessionId: args.sessionId,
        sourceQuestId: args.questId,
        metadata: {
          operation: artifact.operation,
          language: artifact.language,
          questId: args.questId,
          originalIdentifier: artifact.identifier,
          createdAt: new Date().toISOString(),
          ...(artifact.type === 'react'
            ? {
                dependencies: extractReactDependencies(artifact.content),
                hasDefaultExport: checkHasDefaultExport(artifact.content),
                errorBoundary: true,
              }
            : {}),
          aiGenerated: true,
          createdFrom: 'agent',
        },
      }))
      // After mapping, so a dropped entry doesn't shift the `_{index}` suffix of
      // the ones that follow. Empty content would fail the create schema's min(1).
      .filter(payload => payload.content.trim().length > 0)
  );
}

/** Injected so tests never load the heavy @bike4mind/services and @bike4mind/database barrels. */
export interface PersistAgentArtifactsDeps {
  isArtifactsEnabled: () => Promise<boolean>;
  artifactExists: (id: string) => Promise<boolean>;
  createArtifact: (userId: string, payload: AgentArtifactPayload) => Promise<void>;
  /**
   * How many rows an earlier terminal write already landed for this quest. A
   * count, not a boolean: a partially-successful first write must still be
   * completable by a later one (see the gate in `persistAgentArtifacts`).
   */
  countQuestArtifacts: (questId: string) => Promise<number>;
  /**
   * Remove the content/version rows left behind by a `create` that died partway.
   * Only ever called once the artifacts row has been confirmed ABSENT, so
   * nothing can reference what this deletes.
   */
  clearPartialArtifact: (artifactId: string) => Promise<void>;
}

function defaultDeps(): PersistAgentArtifactsDeps {
  // Dynamic imports (same reason as the eventBus import in persistRunAsQuest):
  // keep the barrels off this module's import graph so it stays cheap to load.
  return {
    isArtifactsEnabled: async () => {
      const { adminSettingsRepository } = await import('@bike4mind/database');
      return (await adminSettingsRepository.getSettingsValue('EnableArtifacts')) ?? true;
    },
    artifactExists: async id => {
      const { artifactRepository } = await import('@bike4mind/database');
      // findOne, not findById - findById queries Mongo `_id`, not our custom `id`.
      return Boolean(await artifactRepository.findOne({ id }));
    },
    createArtifact: async (userId, payload) => {
      const { artifactService } = await import('@bike4mind/services');
      const { artifactRepository, artifactContentRepository, artifactVersionRepository } =
        await import('@bike4mind/database');
      await artifactService.create(userId, payload, {
        db: {
          // any: mirrors pages/api/artifacts/index.ts - the concrete Mongoose
          // repositories are structurally compatible with the service's
          // IArtifact*Repository interfaces but not nominally assignable.
          artifacts: artifactRepository as any,
          artifactContents: artifactContentRepository as any,
          artifactVersions: artifactVersionRepository as any,
        },
      });
    },
    countQuestArtifacts: async questId => {
      const { artifactRepository } = await import('@bike4mind/database');
      // Deliberately NOT filtered on deletedAt: a row the user deleted still
      // means this quest was already processed, and a repeat terminal write
      // must not resurrect it.
      return artifactRepository.count({ sourceQuestId: questId });
    },
    clearPartialArtifact: async artifactId => {
      const { ArtifactContent, ArtifactVersion } = await import('@bike4mind/database');
      // Hard deletes: neither model carries softDeletePlugin, which matters -
      // a soft-deleted row would still occupy the { artifactId, version } unique
      // index and the retry would hit E11000 again forever.
      await ArtifactVersion.deleteMany({ artifactId });
      await ArtifactContent.deleteMany({ artifactId });
    },
  };
}

/**
 * E11000 off the `{ artifactId, version }` unique index on artifact_contents.
 *
 * This is NOT on its own a success signal. `artifactService.create` writes
 * artifact_contents -> artifact_versions -> artifacts with no transaction, so a
 * duplicate content row means either "already fully written" or "a previous
 * attempt died partway". Only the artifacts row distinguishes them - see the
 * caller. Both error shapes are checked because a wrapped or serialized error
 * may carry only the message.
 */
function isDuplicateKeyError(err: unknown): boolean {
  if (typeof err !== 'object' || err === null) return false;
  if ((err as { code?: unknown }).code === 11000) return true;
  // Read `message` off any object, not just an Error instance. A driver error
  // that crossed a serialization boundary arrives as a plain object carrying
  // only the text, and an `instanceof Error` check would miss it - which would
  // send a genuine duplicate down the generic failure path and leave an orphan
  // unrepaired, the exact outcome this module exists to prevent.
  const message = (err as { message?: unknown }).message;
  return typeof message === 'string' && message.includes('E11000');
}

/**
 * Total by contract: never throws, never blocks the Quest write that calls it.
 * An artifact-persistence failure must not fail a run whose answer the user has
 * already seen.
 *
 * Idempotency anchors on the QUEST, not on the artifact id. Two real
 * double-write vectors bypass the executor's `claimExecution` CAS - the
 * WebSocket `gate_response: stop` handler runs outside it entirely, and a `stop`
 * can race a `continue`-resumed executor - and crucially those two paths pass
 * DIFFERENT `replyText` (the executor sends the full post-DAG-bubble reply; the
 * gate-stop handler sends `finalAnswer ?? 'Agent stopped...'`). Because every
 * artifact id is derived from the parsed reply, an id-based check cannot see
 * that the second write is the same run: different text parses to different
 * identifiers, so the ids differ and both writes land. `questId` is the only
 * value stable across both, so it is what gates the whole run.
 *
 * The per-id existence check stays as a second line - it covers ids the parser
 * cannot make deterministic (`convertToolOutputsToArtifacts` embeds `Date.now()`
 * in the identifier of tool-output recharts/mermaid) within a single write.
 */
export async function persistAgentArtifacts(args: {
  replyText: string;
  questId: string;
  questCreatedAtMs: number;
  sessionId: string;
  userId: string;
  executionId: string;
  logger: Logger;
  deps?: PersistAgentArtifactsDeps;
}): Promise<void> {
  const { replyText, questId, questCreatedAtMs, sessionId, userId, executionId, logger } = args;
  const deps = args.deps ?? defaultDeps();

  try {
    const payloads = buildAgentArtifactPayloads({ replyText, questId, questCreatedAtMs, sessionId });
    // Parse before reading the setting so a run with no artifacts - the common
    // case - costs zero extra DB round-trips.
    if (payloads.length === 0) {
      return;
    }

    if (!(await deps.isArtifactsEnabled())) {
      logger.info('[Artifacts] EnableArtifacts is off - skipping agent artifact persistence', {
        executionId,
        questId,
        parsed: payloads.length,
      });
      return;
    }

    // Payloads run last-to-first through the reply (see buildAgentArtifactPayloads),
    // so this keeps the reply's LAST artifacts. Either end is arbitrary for what is
    // only a runaway-reply valve; taking the head keeps the surviving ids stable.
    const capped = payloads.slice(0, MAX_AGENT_ARTIFACTS_PER_RUN);
    if (payloads.length > capped.length) {
      logger.warn('[Artifacts] agent run exceeded the per-run artifact cap - dropping the excess', {
        executionId,
        questId,
        parsed: payloads.length,
        cap: MAX_AGENT_ARTIFACTS_PER_RUN,
        dropped: payloads.length - capped.length,
      });
    }

    // Quest-level gate. This, not the per-id check below, is what makes a second
    // terminal write for the same run a no-op - the two write paths pass
    // different reply text, so their parsed ids do not match and an id-based
    // check would let both through. See the docstring.
    //
    // A COUNT, not a boolean. Per-artifact failures below are swallowed so one
    // bad row cannot abort the rest, which means a first write can land some
    // rows and lose others. A boolean "this quest has artifacts" gate would
    // then treat that quest as finished forever and the missing rows could
    // never be retried - trading the duplicate-row bug for a silent-loss one.
    // Comparing against what this invocation would write lets an incomplete
    // quest be completed, while a complete one still short-circuits.
    const alreadyPersisted = await deps.countQuestArtifacts(questId);
    if (alreadyPersisted >= capped.length) {
      logger.info('[Artifacts] quest already fully persisted - skipping duplicate terminal write', {
        executionId,
        questId,
        parsed: payloads.length,
        alreadyPersisted,
      });
      return;
    }
    if (alreadyPersisted > 0) {
      // Ids are only stable across writes that parsed the same reply text, so
      // completing a partial write can duplicate a row when the two terminal
      // paths disagree. That is the deliberate trade: a visible duplicate beats
      // a row that silently never lands.
      logger.warn('[Artifacts] quest is partially persisted - completing the remaining rows', {
        executionId,
        questId,
        parsed: payloads.length,
        alreadyPersisted,
      });
    }

    let created = 0;
    let skipped = 0;
    let repaired = 0;
    // Sequential: one artifact's failure must not abort the rest, and the volume
    // is bounded by the cap anyway.
    for (const payload of capped) {
      try {
        if (await deps.artifactExists(payload.id)) {
          skipped++;
          continue;
        }
        await deps.createArtifact(userId, payload);
        created++;
      } catch (artifactErr) {
        if (isDuplicateKeyError(artifactErr)) {
          // A duplicate content row does NOT prove the artifact was written.
          // `artifactService.create` writes contents -> versions -> artifacts
          // untransacted, so a crash after the content write leaves a row that
          // makes every future attempt throw E11000. Swallowing that as success
          // would lose the artifact permanently and silently: the pre-check above
          // and the card's `findExistingArtifactId` both read the ARTIFACTS
          // collection, which would stay empty forever.
          //
          // So ask the collection that is actually authoritative.
          try {
            if (await deps.artifactExists(payload.id)) {
              skipped++; // genuinely already written by a concurrent writer
              continue;
            }
            // Orphaned content/version rows from a dead attempt. Nothing
            // references them (no artifacts row exists), so clearing them is
            // safe and makes the write retryable instead of permanently wedged.
            await deps.clearPartialArtifact(payload.id);
            await deps.createArtifact(userId, payload);
            repaired++;
            continue;
          } catch (repairErr) {
            logger.error('[Artifacts] could not repair a partially-written artifact - it will need manual cleanup', {
              executionId,
              questId,
              artifactId: payload.id,
              error: repairErr instanceof Error ? repairErr.message : String(repairErr),
            });
            continue;
          }
        }
        logger.warn('[Artifacts] failed to persist one agent artifact - continuing', {
          executionId,
          questId,
          artifactId: payload.id,
          error: artifactErr instanceof Error ? artifactErr.message : String(artifactErr),
        });
      }
    }

    logger.info('[Artifacts] Persisted agent artifacts', {
      executionId,
      questId,
      parsed: payloads.length,
      created,
      skipped,
      repaired,
    });
  } catch (err) {
    logger.error('[Artifacts] agent artifact persistence failed - continuing', {
      executionId,
      questId,
      error: err instanceof Error ? err.message : String(err),
    });
  }
}
