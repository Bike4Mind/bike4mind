import type { IChatHistoryItemDocument, IChatHistoryItemRepository } from '@bike4mind/common';
import type { Logger } from '@bike4mind/observability';

// Cadence for the running-status DB heartbeat during a long render/edit. Matches the
// chat path's streaming heartbeat and stays well under the check-timeout endpoint's 120s
// stuck-quest threshold, so a live job always looks "fresh" and only a genuinely stalled one (Lambda
// hung/killed, or terminal WebSocket frame lost) ages past the threshold and is recovered.
export const QUEST_HEARTBEAT_INTERVAL_MS = 10_000;

// After this many CONSECUTIVE failed heartbeat writes (~30s with no updatedAt bump) the failure is no
// longer a transient blip, so escalate warn -> error once. SRE alerting typically fires on error logs,
// not warns, so this surfaces a sustained DB problem without standing up new metric infra. The
// counter resets on the next successful write.
const HEARTBEAT_FAILURE_ESCALATE_AFTER = 3;

type QuestHeartbeatDb = { quests: Pick<IChatHistoryItemRepository, 'update' | 'updateMany'> };
type QuestHeartbeatQuest = Pick<IChatHistoryItemDocument, 'id' | 'status'>;

/**
 * Persist status='running' immediately, then keep the quest "warm" with a lightweight DB heartbeat
 * while a (potentially multi-minute) render/edit runs. Returns a disposer that stops the heartbeat;
 * ALWAYS call it in a `finally` so the terminal write owns the final status.
 *
 * Historically these paths held status='running' only in memory, so a hung/killed Lambda (or a lost
 * terminal WebSocket frame) left the DB without 'running' and the check-timeout recovery endpoint
 * refused to fail the stuck quest, stranding the client on an eternal "Running..." spinner.
 * Persisting 'running' + bumping updatedAt lets check-timeout detect a genuinely
 * stalled job past its 120s threshold, while a live job keeps updatedAt fresh and is left alone.
 *
 * The heartbeat write is CONDITIONAL (filtered on status:'running'), so it can never resurrect
 * 'running' over a terminal 'done'/'error' write - it becomes a no-op the moment the terminal write
 * commits, race-free regardless of ordering. The in-memory `quest.status` check is a fast path in
 * front of it. Backed by the { _id: 1, status: 1 } id_status index on the Quest schema.
 *
 * @param tag short label for heartbeat log lines, e.g. 'image-edit-heartbeat'
 */
export async function startQuestHeartbeat(
  db: QuestHeartbeatDb,
  quest: QuestHeartbeatQuest,
  logger: Pick<Logger, 'warn' | 'error'>,
  tag: string
): Promise<() => void> {
  await db.quests.update({ id: quest.id, status: 'running' });

  let consecutiveFailures = 0;
  const interval = setInterval(() => {
    // In-memory guard is a fast path; the conditional write below is the real safety net.
    if (quest.status !== 'running') return;
    void db.quests
      .updateMany({ _id: quest.id, status: 'running' }, { status: 'running' })
      .then(() => {
        consecutiveFailures = 0;
      })
      .catch((err: unknown) => {
        consecutiveFailures += 1;
        const message = `[${tag}] Failed to persist running status for quest ${quest.id} (${consecutiveFailures} consecutive):`;
        // A single blip just doubles the effective cadence and stays well under 120s; only a
        // SUSTAINED run of failures is alert-worthy, so escalate once past the threshold.
        if (consecutiveFailures >= HEARTBEAT_FAILURE_ESCALATE_AFTER) {
          logger.error(message, err);
        } else {
          logger.warn(message, err);
        }
      });
  }, QUEST_HEARTBEAT_INTERVAL_MS);

  return () => clearInterval(interval);
}
