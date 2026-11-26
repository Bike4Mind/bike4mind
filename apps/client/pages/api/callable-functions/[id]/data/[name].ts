import { UnauthorizedError } from '@bike4mind/utils';
import { baseApi } from '@server/middlewares/baseApi';
import { perUserRateLimit } from '@server/middlewares/perUserRateLimit';
import { assertCallableFunctionsEnabled } from '@bike4mind/server-utils/callableFunctions/access';
import {
  linkCallableFunctionDataForBrowser,
  readCallableFunctionData,
  unpinCallableFunctionData,
} from '@bike4mind/server-utils/callableFunctions/dataPins';

const param = (value: unknown): string => (typeof value === 'string' ? value : '');

const handler = baseApi({ auth: 'jwtOnly' })
  // The owner's browser reads `/data/<name>` from the signed link this answers with. `?bytes=1` streams the bytes
  // here instead, for storage that cannot sign a browser link (self-host, where no Lambda response cap applies).
  .get(perUserRateLimit('GET /api/callable-functions/[id]/data/[name]'), async (req, res) => {
    if (!req.user) throw new UnauthorizedError('Sign in to use callable functions.');
    await assertCallableFunctionsEnabled(req.user);
    res.setHeader('Cache-Control', 'private, no-store');
    if (req.query.bytes !== '1') {
      res.json(await linkCallableFunctionDataForBrowser(req.user, param(req.query.id), param(req.query.name)));
      return;
    }
    const { bytes } = await readCallableFunctionData(req.user, param(req.query.id), param(req.query.name));
    res.setHeader('Content-Type', 'application/octet-stream');
    res.setHeader('Content-Disposition', 'attachment');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.status(200).send(bytes);
  })
  .delete(perUserRateLimit('DELETE /api/callable-functions/[id]/data/[name]'), async (req, res) => {
    if (!req.user) throw new UnauthorizedError('Sign in to use callable functions.');
    await assertCallableFunctionsEnabled(req.user);
    res.json(await unpinCallableFunctionData(req.user, param(req.query.id), param(req.query.name)));
  });

export const config = { api: { responseLimit: false } };

export default handler;
