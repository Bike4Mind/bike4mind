/**
 * GET /api/v1/briefs/schedule - the caller's brief schedule and next due time.
 * PUT /api/v1/briefs/schedule - replace it; recomputes `nextBriefAt` in the schedule's own time zone, kept no later
 *   than the earliest approved reminder still waiting to be listed.
 * JWT only; reads and writes only `req.user`.
 */
import { getBriefScheduleContract, putBriefScheduleContract } from '@bike4mind/common';
import { assistantBriefRepository, userRepository } from '@bike4mind/database';
import { computeNextBriefAt } from '@bike4mind/server-utils/briefs/briefSchedule';
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
  const nextSlot = computeNextBriefAt(schedule, new Date());
  const reminderAt = nextSlot ? await assistantBriefRepository.findEarliestPendingReminderAt(req.user.id) : null;
  const nextBriefAt = nextSlot && reminderAt && reminderAt < nextSlot ? reminderAt : nextSlot;
  await userRepository.setBriefSchedule(req.user.id, schedule, nextBriefAt);
  return res.json({ schedule, nextBriefAt: nextBriefAt?.toISOString() ?? null });
});

export const config = {
  api: { externalResolver: true },
};

export default dispatchByMethod({ GET: getRoute, PUT: putRoute });
