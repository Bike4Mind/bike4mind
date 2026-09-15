import type { Charter, Episode, WakeOutcome } from '@bike4mind/agents';
import { deepAgentCharterRepository, sessionRepository, Quest } from '@bike4mind/database';
import type { Logger } from '@bike4mind/observability';
import type { ReviewOutcome } from './reviewWake';

/**
 * Mission session bridge - wake outputs join the B4M fabric.
 *
 * Every mission gets a lazily-created session (its "mission log"); each wake
 * appends a summary + any deliverable as chat history, and review verdicts
 * land alongside. The user reads mission output where they already read
 * everything else, with the dossier one click away for provenance.
 *
 * Mirrors the premium agent sessionBridge pattern (the autonomy precedent). All
 * bridging is fire-and-forget: a logging failure must never fail a wake.
 */

const MAX_TITLE_GOAL = 64;

export interface MissionBridgeDeps {
  ensureSession: (charter: Charter) => Promise<string>;
  appendEntry: (sessionId: string, prompt: string, reply: string) => Promise<void>;
}

/** Production deps: sessionRepository + Quest, session id persisted write-once. */
export function defaultBridgeDeps(logger: Logger): MissionBridgeDeps {
  return {
    async ensureSession(charter) {
      if (charter.sessionId) {
        const existing = await sessionRepository.findById(charter.sessionId);
        if (existing) return charter.sessionId;
        logger.warn(`[MISSION_BRIDGE] session ${charter.sessionId} missing for ${charter.identity.agentId}`);
      }
      const now = new Date();
      const goalPreview =
        charter.goal.description.length > MAX_TITLE_GOAL
          ? `${charter.goal.description.slice(0, MAX_TITLE_GOAL)}…`
          : charter.goal.description;
      const session = await sessionRepository.create({
        name: `${charter.identity.name} — Mission: ${goalPreview}`,
        userId: charter.identity.ownerUserId,
        knowledgeIds: [],
        artifactIds: [],
        agentIds: charter.identity.linkedAgentId ? [charter.identity.linkedAgentId] : [],
        firstCreated: now,
        lastUpdated: now,
        groups: [],
        users: [],
        isGlobalRead: false,
        isGlobalWrite: false,
        clonedSourceId: null,
        forkedSourceId: null,
        lastUsedModel: null,
      } as Parameters<typeof sessionRepository.create>[0]);
      if (charter.sessionId) {
        // The stored session was missing (deleted notebook) - re-point off the
        // dead id so we don't spawn a fresh log on every subsequent wake.
        await deepAgentCharterRepository.repointSessionId(charter.identity.agentId, charter.sessionId, session.id);
      } else {
        // Write-once: a racing wake's bridge can't re-point a live log.
        await deepAgentCharterRepository.setSessionId(charter.identity.agentId, session.id);
      }
      logger.info(`[MISSION_BRIDGE] created mission log ${session.id} for ${charter.identity.agentId}`);
      return session.id;
    },
    async appendEntry(sessionId, prompt, reply) {
      await Quest.create({
        sessionId,
        timestamp: new Date(),
        type: 'system',
        prompt,
        reply,
        deletedAt: null,
      });
    },
  };
}

/** Compose the human-readable log entry for one wake. */
export function formatWakeLogEntry(outcome: WakeOutcome): { prompt: string; reply: string } {
  const { episode, handoff, charter } = outcome;
  const deliverable = episode.observations.find(o => o.kind === 'final_answer')?.summary;
  const reply = [
    `**Wake ${handoff.wakeCount}** — \`${episode.policyDecision.actionKind}\` (${episode.evidenceTier}${
      episode.tokensSpent > 0 ? ` · ${episode.tokensSpent.toLocaleString()} tok` : ''
    })`,
    '',
    handoff.lastActionSummary,
    ...(deliverable ? ['', '---', '', deliverable] : []),
    '',
    `_Next: ${handoff.nextIntendedAction || '(undecided)'}_`,
  ].join('\n');
  return {
    prompt: `[WAKE ${handoff.wakeCount}] ${charter.identity.name}: ${episode.policyDecision.actionKind}`,
    reply,
  };
}

/** Compose the log entry for an adversarial review verdict. */
export function formatReviewLogEntry(
  charter: Charter,
  review: ReviewOutcome,
  target: Pick<Episode, 'id'>
): { prompt: string; reply: string } {
  const v = review.verdict;
  const reply = [
    `**⚖️ Adversarial review** of episode \`${target.id.slice(0, 8)}…\` — **${v.verdict}**${
      v.tierGranted ? ` (tier granted: ${v.tierGranted})` : ''
    }${review.tierAdvanced ? ` · tier advanced ${review.tierAdvanced.from} → ${review.tierAdvanced.to}` : ''}`,
    '',
    v.summary,
    ...(v.issues.length ? ['', ...v.issues.map(i => `- ⚠️ ${i}`)] : []),
  ].join('\n');
  return { prompt: `[REVIEW] ${charter.identity.name}: ${v.verdict}`, reply };
}

/**
 * Bridge one wake into the mission log. Fire-and-forget: call WITHOUT awaiting
 * in hot paths, or await behind a try in inline routes - never let it fail a wake.
 */
export async function bridgeWakeToSession(
  outcome: WakeOutcome,
  logger: Logger,
  deps?: MissionBridgeDeps
): Promise<void> {
  // Only true missions log - standalone deep agents (spin harness, /deep-agents)
  // would otherwise spam the owner's session list.
  if (!outcome.charter.identity.linkedAgentId) return;
  try {
    const d = deps ?? defaultBridgeDeps(logger);
    const sessionId = await d.ensureSession(outcome.charter);
    const { prompt, reply } = formatWakeLogEntry(outcome);
    await d.appendEntry(sessionId, prompt, reply);
    logger.info(`[MISSION_BRIDGE] wake ${outcome.handoff.wakeCount} bridged to ${sessionId}`);
  } catch (err) {
    logger.warn(
      `[MISSION_BRIDGE] wake bridge failed (non-fatal): ${err instanceof Error ? (err.stack ?? err.message) : String(err)}`
    );
  }
}

/** Bridge a review verdict into the mission log. Fire-and-forget. */
export async function bridgeReviewToSession(
  charter: Charter,
  review: ReviewOutcome,
  targetEpisodeId: string,
  logger: Logger,
  deps?: MissionBridgeDeps
): Promise<void> {
  if (!charter.identity.linkedAgentId) return;
  try {
    const d = deps ?? defaultBridgeDeps(logger);
    const sessionId = await d.ensureSession(charter);
    const { prompt, reply } = formatReviewLogEntry(charter, review, { id: targetEpisodeId });
    await d.appendEntry(sessionId, prompt, reply);
  } catch (err) {
    logger.warn(
      `[MISSION_BRIDGE] review bridge failed (non-fatal): ${err instanceof Error ? (err.stack ?? err.message) : String(err)}`
    );
  }
}
