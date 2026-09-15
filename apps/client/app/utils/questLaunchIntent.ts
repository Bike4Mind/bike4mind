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

/**
 * Same-tab, in-memory trust flag for an in-app quest launch (the /quests modal
 * arms it right before navigating to /new). /new consumes it once to decide
 * whether a `goal` may auto-submit. An external `/new?goal=...` link - or a
 * post-login `redirectTo` replay, which crosses a server round-trip - can never
 * set this, so such a goal only ever pre-fills the composer.
 */
let trustedLaunchArmed = false;

export function armTrustedQuestLaunch(): void {
  trustedLaunchArmed = true;
}

/** Returns whether an in-app launch was armed and clears it (consume-once). */
export function consumeTrustedQuestLaunch(): boolean {
  const armed = trustedLaunchArmed;
  trustedLaunchArmed = false;
  return armed;
}
