import { adminApi } from '@server/middlewares/adminApi';
import { Resource } from 'sst';

/** GET /api/admin/deployment-info: the stage this deployment runs on, and whether it is a fork's production stage. */
const handler = adminApi({
  adminPermissions: { GET: 'settings:manage' },
  // Read by the admin UI only; API keys have no use for it.
  auth: 'jwtOnly',
}).get(async (_req, res) => {
  const stage = Resource.App.stage;

  // The Resource proxy throws when the secret is not linked.
  let isSourceDeployment = false;
  try {
    const resource = Resource as unknown as Record<string, { value?: string } | undefined>;
    isSourceDeployment = resource.IS_SOURCE_DEPLOYMENT?.value === 'true';
  } catch {
    // Secret not linked: not a source deployment.
  }

  return res.json({ stage, isForkProduction: stage === 'production' && !isSourceDeployment });
});

export default handler;

export const config = {
  api: {
    externalResolver: true,
  },
};
