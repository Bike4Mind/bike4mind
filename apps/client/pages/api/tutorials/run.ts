import { baseApi } from '@server/middlewares/baseApi';
import { requireFeatureEnabled } from '@bike4mind/server-utils/middlewares/featureFlag';
import { CORE_TUTORIAL_SETTING, coreServiceFor } from '@server/tutorials/core';
import { runRoute } from '@server/tutorials/routes';

// jwtOnly: core tutorials are for signed-in browser sessions, never an API key.
const handler = runRoute({
  api: () => baseApi({ auth: 'jwtOnly' }),
  gates: [requireFeatureEnabled(CORE_TUTORIAL_SETTING)],
  bucket: 'tutorials/run',
  serviceFor: coreServiceFor,
});

export const config = {
  api: {
    externalResolver: true,
  },
};

export default handler;
