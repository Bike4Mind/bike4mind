import { baseApi } from '@server/middlewares/baseApi';
import { ForbiddenError } from '@server/utils/errors';
import { gearOverrideRepository, GearOverride } from '@bike4mind/database';
import { GEAR_PRESENTATION } from '@client/lib/gears/presentation';
import { GEAR_DEFAULTS } from '../../gears/status';
import { z } from 'zod';

/**
 * /api/admin/gears — Manage Gears (same defaults+overrides pattern as System
 * Prompts): code defines every gear's default credits/presentation; an admin
 * override is a sparse patch over the top, applied live with no deploy. The
 * ops story: a reward loophole in prod is one dashboard edit (credits -> 0 or
 * enabled -> off) instead of a P0 PR fire drill.
 *
 *   GET -> every gear: code defaults + current override
 *   PUT -> upsert one gear's override (only the provided fields)
 */

const PutSchema = z.object({
  key: z.string().min(1).max(64),
  enabled: z.boolean().nullable().optional(),
  credits: z.number().int().min(0).max(1_000_000).nullable().optional(),
  title: z.string().min(1).max(80).nullable().optional(),
  tagline: z.string().min(1).max(120).nullable().optional(),
  intro: z.string().min(1).max(500).nullable().optional(),
  cta: z.string().min(1).max(80).nullable().optional(),
  ctaAction: z
    .string()
    .max(300)
    .regex(/^(navigate:\/[^\s]*|external:https:\/\/[^\s]+|files)$/, 'Invalid ctaAction')
    .nullable()
    .optional(),
});

const handler = baseApi()
  .get(async (req, res) => {
    if (!req.user?.isAdmin) throw new ForbiddenError('Unauthorized. Admin access required.');
    const overrides = await gearOverrideRepository.byKey();
    const gears = GEAR_DEFAULTS.map(def => {
      const o = overrides.get(def.key);
      const presentation = GEAR_PRESENTATION[def.key];
      return {
        key: def.key,
        kind: def.kind,
        defaults: { credits: def.credits, enabled: true, ...presentation },
        override: o
          ? {
              enabled: o.enabled ?? null,
              credits: o.credits ?? null,
              title: o.title ?? null,
              tagline: o.tagline ?? null,
              intro: o.intro ?? null,
              cta: o.cta ?? null,
              ctaAction: o.ctaAction ?? null,
              updatedBy: o.updatedBy ?? null,
              updatedAt: o.updatedAt ?? null,
            }
          : null,
      };
    });
    return res.status(200).json({ gears });
  })
  .put(async (req, res) => {
    if (!req.user?.isAdmin) throw new ForbiddenError('Unauthorized. Admin access required.');
    const parsed = PutSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ error: 'Invalid request', details: parsed.error.issues });
    }
    const { key, ...fields } = parsed.data;
    if (!GEAR_DEFAULTS.some(d => d.key === key)) {
      return res.status(404).json({ error: `Unknown gear: ${key}` });
    }
    const updated = await GearOverride.findOneAndUpdate(
      { key },
      { $set: { ...fields, updatedBy: String(req.user.id) } },
      { upsert: true, new: true, setDefaultsOnInsert: true }
    ).lean();
    return res.status(200).json({ override: updated });
  });

export const config = {
  api: { externalResolver: true },
};

export default handler;
