import { baseApi } from '@server/middlewares/baseApi';
import { perUserRateLimit } from '@server/middlewares/perUserRateLimit';
import { resolveCallableFunctionsEnabled } from '@bike4mind/server-utils/callableFunctions/access';

export type CallableFunctionsStatus = { enabled: boolean };

// Session-only (`jwtOnly`): the browser asks whether to show the Function tab; no API key needs it.
const handler = baseApi({ auth: 'jwtOnly' }).get(
  perUserRateLimit('GET /api/callable-functions/status'),
  async (req, res) => {
    const status: CallableFunctionsStatus = { enabled: await resolveCallableFunctionsEnabled(req.user) };
    res.json(status);
  }
);

export default handler;
