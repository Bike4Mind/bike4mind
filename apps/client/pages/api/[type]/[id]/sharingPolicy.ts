import { z } from 'zod';
import { baseApi } from '@server/middlewares/baseApi';
import { asyncHandler } from '@server/middlewares/asyncHandler';
import { sessionRepository, projectRepository, fabFileRepository, organizationRepository } from '@bike4mind/database';
import { NotFoundError, organizationSharingPolicy } from '@bike4mind/common';

export default baseApi({ auth: 'jwtOnly' }).get(
  asyncHandler(async (req, res) => {
    const { type, id } = z.object({ type: z.enum(['sessions', 'projects', 'files']), id: z.string() }).parse(req.query);
    const repository =
      type === 'sessions' ? sessionRepository : type === 'projects' ? projectRepository : fabFileRepository;
    const content = await repository.shareable.findShareAccessById(req.user, id);
    if (!content) throw new NotFoundError('Content not found');
    if (!content.organizationId) return res.json({ policy: null });
    const organization = await organizationRepository.findById(content.organizationId);
    if (!organization) throw new NotFoundError('Organization not found');
    return res.json({ policy: organizationSharingPolicy(organization) });
  })
);

export const config = { api: { externalResolver: true } };
