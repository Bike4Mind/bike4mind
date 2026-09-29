import { baseApi } from '@server/middlewares/baseApi';
import { asyncHandler } from '@server/middlewares/asyncHandler';
import { GEAR_PRESENTATION } from '@client/lib/gears/presentation';
import { evaluateGears, type GearKey, type GearKind } from '@server/services/gears/catalog';

/**
 * GET /api/gears/status - each gear's unlock and reward state for the Gears page.
 *
 * Two kinds of gear: destination (a feature with a sidenav row of its own) and
 * skill (something done inside other features). Both pay a one-time reward.
 *
 * This endpoint only reads. The reward is paid by POST /api/gears/claim when
 * the user asks for it, so the status can be polled from anywhere in the app
 * without moving anyone's balance.
 *
 * The catalog and the unlock checks live in server/services/gears/catalog.ts.
 */

export interface GearStatus {
  key: GearKey;
  kind: GearKind;
  unlocked: boolean;
  credits: number;
  /** Presentation, admin-override-merged over the code defaults. */
  title: string;
  tagline: string;
  intro: string;
  cta: string;
  ctaAction: string;
  /** Unlocked and paid-for conditions met, but the reward is not claimed yet. */
  claimable?: boolean;
  /** The ledger has paid this gear. Independent of `unlocked`, which follows live
   *  data: deleting your only agent re-locks the gear, but the reward stays spent. */
  claimed?: boolean;
  /** Unlocked, but the payout's stricter condition isn't met yet (e.g.
   *  Published: waiting for a non-owner view). */
  rewardPending?: boolean;
}

const handler = baseApi().get(
  asyncHandler(async (req, res) => {
    const userId = req.user?.id;
    if (!userId) return res.status(401).json({ error: 'Authentication required' });

    const { evaluations, overrides } = await evaluateGears(String(userId));
    const gears: GearStatus[] = evaluations.map(({ def, unlocked, credits, rewardEligible, alreadyRewarded }) => {
      const o = overrides.get(def.key);
      const base = GEAR_PRESENTATION[def.key];
      const gear: GearStatus = {
        key: def.key,
        kind: def.kind,
        unlocked,
        credits,
        title: o?.title ?? base.title,
        tagline: o?.tagline ?? base.tagline,
        intro: o?.intro ?? base.intro,
        cta: o?.cta ?? base.cta,
        ctaAction: o?.ctaAction ?? base.ctaAction,
      };
      if (unlocked && !rewardEligible && !alreadyRewarded) gear.rewardPending = true;
      if (rewardEligible && credits > 0 && !alreadyRewarded) gear.claimable = true;
      if (alreadyRewarded) gear.claimed = true;
      return gear;
    });

    return res.status(200).json({
      gears,
      totalUnlocked: gears.filter(g => g.unlocked).length,
    });
  })
);

export const config = {
  api: { externalResolver: true },
};

export default handler;
