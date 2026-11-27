import { z } from 'zod';
import { BadRequestError } from '@bike4mind/common';
import { organizationService } from '@bike4mind/services';
import { baseApi } from '@server/middlewares/baseApi';
import {
  agentRepository,
  artifactRepository,
  fabFileRepository,
  projectRepository,
  sessionRepository,
} from '@bike4mind/database';
import { organizationRepository } from '@bike4mind/database/infra';
import { userApiKeyRepository } from '@bike4mind/database/auth';
import { groupRepository } from '@bike4mind/database/social';

const QuerySchema = z.object({ id: z.string().min(1), userId: z.string().min(1) });

// Session-only: this lists another member's content to an org admin ahead of removing them, which
// is not part of the API-key surface.
const handler = baseApi({ auth: 'jwtOnly' }).get(async (req, res) => {
  const parsed = QuerySchema.safeParse(req.query);
  if (!parsed.success) throw new BadRequestError('Organization and user id required');

  const inventory = await organizationService.getMemberOffboardingInventory(req.user, parsed.data, {
    db: {
      organizations: organizationRepository,
      groups: groupRepository,
      fabFiles: fabFileRepository,
      artifacts: artifactRepository,
      projects: projectRepository,
      sessions: sessionRepository,
      agents: agentRepository,
      userApiKeys: userApiKeyRepository,
    },
  });

  return res.json(inventory);
});

export default handler;
