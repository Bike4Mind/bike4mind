/**
 * One-shot, in-memory handoff for the "create a quest from the dashboard"
 * flow (/quests -> /new -> auto-submit).
 *
 * The /new route records the intent; useSendMessage consumes it exactly once
 * when the chat input mounts. In-memory by design: unlike the previous
 * localStorage bus, the intent cannot leak into a second tab, survive a
 * refresh (which would re-submit the goal), or strand a half-consumed flow.
 */
export interface QuestLaunchIntent {
  goal: string;
  autoSubmit: boolean;
  enableQuestMaster: boolean;
}

let pendingIntent: QuestLaunchIntent | null = null;

export function setQuestLaunchIntent(intent: QuestLaunchIntent): void {
  pendingIntent = intent;
}

/** Returns the pending intent and clears it (consume-once semantics). */
export function consumeQuestLaunchIntent(): QuestLaunchIntent | null {
  const intent = pendingIntent;
  pendingIntent = null;
  return intent;
}
