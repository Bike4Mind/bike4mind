import { assistantBriefRepository, type IAssistantBrief } from '@bike4mind/database';
import { briefWindow } from '@bike4mind/server-utils/briefs/briefSchedule';
import { BriefEvents } from '@bike4mind/server-utils/utils/eventBus';

type Deps = {
  briefs: Pick<typeof assistantBriefRepository, 'findActiveComposing' | 'findLatestReady' | 'createComposing'>;
  publishCompose: (event: { briefId: string; userId: string }) => Promise<unknown>;
  now: () => Date;
};

const defaultDeps: Deps = {
  briefs: assistantBriefRepository,
  publishCompose: event => BriefEvents.Compose.publish(event),
  now: () => new Date(),
};

/**
 * Starts a brief for the user, or returns the one already composing so a double tap (or a retry) never
 * spends a second model call. The window runs from the end of the last ready brief, capped at a week.
 */
export async function startBriefComposition(userId: string, deps: Deps = defaultDeps): Promise<IAssistantBrief> {
  const inFlight = await deps.briefs.findActiveComposing(userId, deps.now());
  if (inFlight) return inFlight;

  const latest = await deps.briefs.findLatestReady(userId);
  const { periodStart, periodEnd } = briefWindow(latest?.periodEnd, deps.now());

  const brief = await deps.briefs.createComposing({ userId, periodStart, periodEnd });
  await deps.publishCompose({ briefId: brief._id.toString(), userId });
  return brief;
}
