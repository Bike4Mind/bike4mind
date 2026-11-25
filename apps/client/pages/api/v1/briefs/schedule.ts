/**
 * GET /api/v1/briefs/schedule - the caller's brief schedule and next due time.
 * PUT /api/v1/briefs/schedule - replace it; recomputes `nextBriefAt` in the schedule's own time zone, kept no later
 *   than the earliest approved reminder still waiting to be listed.
 * JWT only; reads and writes only `req.user`.
 */
import { getBriefScheduleContract, putBriefScheduleContract } from '@bike4mind/common';
import { assistantBriefRepository, userRepository } from '@bike4mind/database';
import { computeNextBriefAt, SCHEDULED_BRIEF_MIN_GAP_MS } from '@bike4mind/server-utils/briefs/briefSchedule';
import { nextRouteForContract } from '@server/middlewares/defineNextRoute';
import { dispatchByMethod } from '@server/middlewares/dispatchByMethod';
import { perUserRateLimit } from '@server/middlewares/perUserRateLimit';

const getRoute = nextRouteForContract(getBriefScheduleContract, {
  rateLimit: perUserRateLimit('GET /api/v1/briefs/schedule'),
  recordsActivity: false,
}).get(async (req, res) => {
  const { schedule, nextBriefAt } = await userRepository.getBriefSchedule(req.user.id);
  // A general preferences write can drop or revert the schedule without touching `nextBriefAt`; the
  // reconciler clears the stale due time when it comes up, so report it only for an enabled schedule.
  const due = schedule?.enabled ? (nextBriefAt?.toISOString() ?? null) : null;
  return res.json({ schedule, nextBriefAt: due });
});

const putRoute = nextRouteForContract(putBriefScheduleContract, {
  rateLimit: perUserRateLimit('PUT /api/v1/briefs/schedule'),
}).put(async (req, res) => {
  const schedule = req.validated;
  const now = new Date();
  const nextSlot = computeNextBriefAt(schedule, now);
  const knownReminder = nextSlot ? await assistantBriefRepository.findEarliestPendingReminderAt(req.user.id) : null;
  const next = nextSlot && knownReminder && knownReminder < nextSlot ? knownReminder : nextSlot;
  await userRepository.setBriefSchedule(req.user.id, schedule, next);
  // Re-read after the replacement so an approval racing that write cannot lose its wake-up.
  if (nextSlot) {
    try {
      const reminderAt = await assistantBriefRepository.findEarliestPendingReminderAt(req.user.id);
      if (reminderAt) await userRepository.pullNextBriefAtForward(req.user.id, reminderAt);
    } catch (error) {
      const retryAt = new Date(now.getTime() + SCHEDULED_BRIEF_MIN_GAP_MS);
      try {
        await userRepository.pullNextBriefAtForward(req.user.id, next && next < retryAt ? next : retryAt);
      } catch (retryError) {
        throw new AggregateError([error, retryError], 'Failed to reconcile the saved brief schedule');
      }
      throw error;
    }
  }
  const stored = await userRepository.getBriefSchedule(req.user.id);
  return res.json({
    schedule: stored.schedule,
    nextBriefAt: stored.schedule?.enabled ? (stored.nextBriefAt?.toISOString() ?? null) : null,
  });
});

export const config = {
  api: { externalResolver: true },
};

export default dispatchByMethod({ GET: getRoute, PUT: putRoute });
