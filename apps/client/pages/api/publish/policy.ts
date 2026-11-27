import { z } from 'zod';
import { baseApi } from '@server/middlewares/baseApi';
import { artifactRepository, sessionRepository, organizationRepository } from '@bike4mind/database';
import {
  NotFoundError,
  organizationSharingPolicy,
  PUBLIC_SHARING_BLOCKED,
  EXTERNAL_SHARING_BLOCKED,
} from '@bike4mind/common';

export default baseApi({ auth: 'jwtOnly' }).get(async (req, res) => {
  const query = z.object({ artifactId: z.string().optional(), sessionId: z.string().optional() }).parse(req.query);
  const content = query.artifactId
    ? await artifactRepository.findOne({ id: query.artifactId, userId: req.user.id, deletedAt: null })
    : query.sessionId
      ? await sessionRepository.findByIdAndUserId(query.sessionId, req.user.id)
      : null;
  if (!content) throw new NotFoundError('Content not found');
  if (!content.organizationId) return res.json({ publicLinkBlockedReason: null });
  const org = await organizationRepository.findById(content.organizationId);
  if (!org) throw new NotFoundError('Organization not found');
  const policy = organizationSharingPolicy(org);
  return res.json({
    publicLinkBlockedReason: !policy.allowPublicLinks
      ? PUBLIC_SHARING_BLOCKED
      : !policy.allowExternalSharing
        ? EXTERNAL_SHARING_BLOCKED
        : null,
  });
});

export const config = { api: { externalResolver: true } };
