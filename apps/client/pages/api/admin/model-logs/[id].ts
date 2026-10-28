import { ApiKeyScope, type PromptMeta, redactPromptMetaForViewer } from '@bike4mind/common';
import type { Types } from 'mongoose';
import { adminApi } from '@server/middlewares/adminApi';
import { asyncHandler } from '@server/middlewares/asyncHandler';
import { Quest } from '@bike4mind/database';
import { z } from 'zod';
import { NotFoundError } from '@bike4mind/server-utils/utils/errors';
import { isValidObjectId } from '@bike4mind/server-utils/utils/objectId';

const paramsSchema = z.object({
  id: z.string().min(1),
});

// GET /api/admin/model-logs/[id] - the full promptMeta of one log, which the list route leaves out.
const handler = adminApi({
  adminPermissions: { GET: 'support:read' },
  auth: 'jwtOnly',
  requiredScopes: [ApiKeyScope.ADMIN],
}).get(
  asyncHandler(async (req, res) => {
    const { id } = paramsSchema.parse(req.query);

    const quest = isValidObjectId(id)
      ? await Quest.findById(id)
          .select('promptMeta timestamp')
          .lean<{ _id: Types.ObjectId; timestamp?: Date; promptMeta?: PromptMeta }>()
      : null;

    if (!quest) {
      throw new NotFoundError(`Model log not found: ${id}`);
    }

    // Serves any user's log to any admin: redact owner-only fields like every cross-user read.
    res.json({
      id: quest._id.toString(),
      timestamp: quest.timestamp?.toISOString(),
      ...redactPromptMetaForViewer(quest.promptMeta, false),
    });
  })
);

export const config = {
  api: {
    externalResolver: true,
  },
};

export default handler;
