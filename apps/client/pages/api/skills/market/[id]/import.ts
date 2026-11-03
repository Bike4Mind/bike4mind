// apps/client/pages/api/skills/market/[id]/import.ts
import { z } from 'zod';
import { baseApi } from '@client/server/middlewares/baseApi';
import { importRateLimit } from '@bike4mind/server-utils/skillMarket/market';
import { importListing } from '@server/skillMarket/importListing';

const bodySchema = z.object({
  token: z.string().max(64).optional(),
  /** New name for the copy, when the listing's name collides with one of the caller's skills. */
  name: z.string().optional(),
  /** Update this existing imported copy in place instead of creating a new one. */
  targetSkillId: z.string().optional(),
  /** Confirms overwriting a copy the importer has edited since importing. */
  overwrite: z.boolean().optional(),
  /** The version the caller reviewed (e.g. in the update diff); 409 if a newer one was approved since. */
  expectedVersionId: z.string().max(64).optional(),
});

/**
 * POST /api/skills/market/[id]/import - copy the listing's current APPROVED snapshot into a
 * user-scoped skill (see `importListing`). v1 twin: pages/api/v1/skills/market/listings/[id]/import.ts.
 */
const handler = baseApi({ auth: 'jwtOnly' })
  .use(importRateLimit())
  .post(async (req, res) => {
    const body = bodySchema.parse(req.body ?? {});
    const { skill, created } = await importListing(req.user!, String(req.query.id), body);
    res.status(created ? 201 : 200).json({ skill });
  });

export default handler;
