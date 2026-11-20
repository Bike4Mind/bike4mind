import { AdminSupportAccessAction, ApiKeyScope, type PromptMeta, redactPromptMetaForViewer } from '@bike4mind/common';
import type { Types } from 'mongoose';
import { adminApi } from '@server/middlewares/adminApi';
import { asyncHandler } from '@server/middlewares/asyncHandler';
import { Quest, sessionRepository } from '@bike4mind/database';
import { z } from 'zod';
import { NotFoundError } from '@bike4mind/server-utils/utils/errors';
import { isValidObjectId } from '@bike4mind/server-utils/utils/objectId';
import {
  assertOwnerNotPendingDeletion,
  authorizeSupportCase,
  recordSupportAccess,
} from '@server/utils/adminSupportAccess';

const paramsSchema = z.object({
  id: z.string().min(1),
  // Validated by authorizeSupportCase, after the permission check.
  supportCase: z.unknown().optional(),
});

/** Quests carry no owner field; promptMeta records it, and older logs fall back to the session. */
async function resolveLogOwner(quest: { promptMeta?: PromptMeta; sessionId: string }): Promise<string | undefined> {
  const recorded = quest.promptMeta?.session?.userId;
  if (recorded) return recorded;
  const session = isValidObjectId(quest.sessionId) ? await sessionRepository.findById(quest.sessionId) : null;
  return session?.userId;
}

// GET /api/admin/model-logs/[id]?supportCase=<ref> - the full promptMeta of one log, which the list
// route leaves out. That is the user's own prompt text and tool arguments, so it is a support read:
// a case is required and the read is recorded before it is served (see adminSupportAccess.ts).
const handler = adminApi({
  adminPermissions: { GET: 'support:read' },
  auth: 'jwtOnly',
  requiredScopes: [ApiKeyScope.ADMIN],
}).get(
  asyncHandler(async (req, res) => {
    const { id, supportCase } = paramsSchema.parse(req.query);
    const ctx = authorizeSupportCase(req, supportCase);

    const quest = isValidObjectId(id)
      ? await Quest.findById(id)
          .select('promptMeta timestamp sessionId')
          .lean<{ _id: Types.ObjectId; timestamp?: Date; promptMeta?: PromptMeta; sessionId: string }>()
      : null;

    if (!quest) {
      throw new NotFoundError(`Model log not found: ${id}`);
    }

    const ownerUserId = await resolveLogOwner(quest);
    // The same deletion-grace refusal the notebook read applies, so the owner's prompt text is not
    // served here while their notebook is refused.
    if (ownerUserId) await assertOwnerNotPendingDeletion(ownerUserId);

    // An owner that cannot be resolved (no recorded owner, session gone) still gets the read served
    // and recorded: the row keeps the session and quest, and `ownerUnresolved` marks why a query on
    // targetUserId will not find it.
    await recordSupportAccess(
      ctx,
      AdminSupportAccessAction.ModelLogRead,
      { targetUserId: ownerUserId, sessionId: quest.sessionId },
      { questId: quest._id.toString(), ...(ownerUserId ? {} : { ownerUnresolved: true }) }
    );

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
