import { loopRunModel, nextUtcMidnight, type ILoop, type ILoopStageConfig } from '../types/entities/LoopTypes';

/** Below this headroom a new run takes the loop's cheaper fallback model, when it has one. */
export const TIGHT_HEADROOM = 0.5;

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * How far a daily budget is ahead of the clock: the share of the budget left over the share of the UTC day left,
 * clamped to [0, 1]. 1 with no budget. Spending evenly keeps it at 1; running ahead drops it toward 0.
 */
export function budgetHeadroom(budget: number | undefined, spent: number, now: Date): number {
  if (!budget) return 1;
  const budgetLeft = Math.max(0, budget - spent) / budget;
  const dayLeft = (nextUtcMidnight(now).getTime() - now.getTime()) / DAY_MS;
  return Math.min(1, Math.max(0, dayLeft > 0 ? budgetLeft / dayLeft : budgetLeft > 0 ? 1 : 0));
}

/**
 * Lanes a loop may hold at `headroom`: its `max` scaled down, rounded up so a one-lane loop still runs while any
 * headroom is left (admission still holds a run the paced allowance cannot cover). Never below `running`: pacing
 * never stops a lane that is already working.
 */
export const pacedLanes = (max: number, headroom: number, running: number): number =>
  headroom <= 0 ? running : Math.max(running, Math.min(max, Math.ceil(max * headroom)));

/**
 * The model a Desktop loop run uses. The last allowed run escalates (`loopRunModel`); a ticket whose last run was on
 * the fallback and did not advance goes back to the stage model; tight headroom takes the fallback; else the stage
 * model.
 */
export function chooseRunModel(
  loop: Pick<ILoop, 'model' | 'escalationModel'> & { fallbackModel?: string },
  stage: Pick<ILoopStageConfig, 'model' | 'escalationModel'>,
  ticket: { runsAfterClaim: number; lastRunFallback?: boolean; lastRunAdvanced?: boolean },
  limit: number,
  headroom: number
): { model: string; fallback: boolean; escalated: boolean } {
  const chosen = loopRunModel(loop, stage, ticket.runsAfterClaim, limit);
  if (chosen.escalated) return { ...chosen, fallback: false };
  const retryUp = ticket.lastRunFallback && !ticket.lastRunAdvanced;
  if (!retryUp && headroom < TIGHT_HEADROOM && loop.fallbackModel && loop.fallbackModel !== chosen.model) {
    return { model: loop.fallbackModel, fallback: true, escalated: false };
  }
  return { ...chosen, fallback: false };
}
