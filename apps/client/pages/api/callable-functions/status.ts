import { baseApi } from '@server/middlewares/baseApi';
import { perUserRateLimit } from '@server/middlewares/perUserRateLimit';
import { resolveCallableFunctionsEnabled } from '@bike4mind/server-utils/callableFunctions/access';
import { callableFunctionRuntimeConfigured } from '@bike4mind/server-utils/callableFunctions/runtimeRunner';

/** `serverRuntime`: whether this stage can run functions on the server, so the panel can hold its server button. */
export type CallableFunctionsStatus = { enabled: boolean; serverRuntime: boolean };

// Session-only (`jwtOnly`): the browser asks whether to show the Function tab; no API key needs it.
const handler = baseApi({ auth: 'jwtOnly' }).get(
  perUserRateLimit('GET /api/callable-functions/status'),
  async (req, res) => {
    if (!req.user) return res.status(401).json({ error: 'Unauthorized' });
    const status: CallableFunctionsStatus = {
      enabled: await resolveCallableFunctionsEnabled(req.user),
      serverRuntime: callableFunctionRuntimeConfigured(),
    };
    res.json(status);
  }
);

export default handler;
