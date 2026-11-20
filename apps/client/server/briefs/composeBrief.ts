import { assistantBriefRepository, type IAssistantBrief } from '@bike4mind/database';
import { BriefEvents } from '@bike4mind/server-utils/utils/eventBus';

const DEFAULT_WINDOW_MS = 24 * 60 * 60 * 1000;
const MAX_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;

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

  const periodEnd = deps.now();
  const latest = await deps.briefs.findLatestReady(userId);
  const earliest = new Date(periodEnd.getTime() - MAX_WINDOW_MS);
  const defaultStart = new Date(periodEnd.getTime() - DEFAULT_WINDOW_MS);
  const periodStart = latest ? new Date(Math.max(latest.periodEnd.getTime(), earliest.getTime())) : defaultStart;

  const brief = await deps.briefs.createComposing({ userId, periodStart, periodEnd });
  await deps.publishCompose({ briefId: brief._id.toString(), userId });
  return brief;
}
