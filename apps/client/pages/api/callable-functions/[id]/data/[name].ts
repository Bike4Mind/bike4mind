import { UnauthorizedError } from '@bike4mind/utils';
import { baseApi } from '@server/middlewares/baseApi';
import { perUserRateLimit } from '@server/middlewares/perUserRateLimit';
import { assertCallableFunctionsEnabled } from '@bike4mind/server-utils/callableFunctions/access';
import {
  readCallableFunctionData,
  unpinCallableFunctionData,
} from '@bike4mind/server-utils/callableFunctions/dataPins';

const param = (value: unknown): string => (typeof value === 'string' ? value : '');

const handler = baseApi({ auth: 'jwtOnly' })
  // The owner's browser reads the bytes here for `/data/<name>`; never cached, never rendered.
  .get(perUserRateLimit('GET /api/callable-functions/[id]/data/[name]'), async (req, res) => {
    if (!req.user) throw new UnauthorizedError('Sign in to use callable functions.');
    await assertCallableFunctionsEnabled(req.user);
    const { pin, bytes } = await readCallableFunctionData(req.user, param(req.query.id), param(req.query.name));
    res.setHeader('Content-Type', 'application/octet-stream');
    res.setHeader('Content-Disposition', 'attachment');
    res.setHeader('Cache-Control', 'private, no-store');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('X-Data-Sha256', pin.sha256);
    res.status(200).send(bytes);
  })
  .delete(perUserRateLimit('DELETE /api/callable-functions/[id]/data/[name]'), async (req, res) => {
    if (!req.user) throw new UnauthorizedError('Sign in to use callable functions.');
    await assertCallableFunctionsEnabled(req.user);
    res.json(await unpinCallableFunctionData(req.user, param(req.query.id), param(req.query.name)));
  });

export const config = { api: { responseLimit: false } };

export default handler;
