import { UnauthorizedError } from '@bike4mind/utils';
import { baseApi } from '@server/middlewares/baseApi';
import { perUserRateLimit } from '@server/middlewares/perUserRateLimit';
import { assertCallableFunctionsEnabled } from '@bike4mind/server-utils/callableFunctions/access';
import { readCallableFunctionSource } from '@bike4mind/server-utils/callableFunctions/sources';

const param = (value: unknown): string => (typeof value === 'string' ? value : '');

// The owner's browser reads a source here for `/data/<name>`, fetched as a server call would fetch it; the headers
// carry its stamp entry. Never cached, never rendered.
const handler = baseApi({ auth: 'jwtOnly' }).get(
  perUserRateLimit('GET /api/callable-functions/[id]/sources/[name]'),
  async (req, res) => {
    if (!req.user) throw new UnauthorizedError('Sign in to use callable functions.');
    await assertCallableFunctionsEnabled(req.user);
    const { entry, bytes } = await readCallableFunctionSource(req.user, param(req.query.id), param(req.query.name));
    res.setHeader('Content-Type', 'application/octet-stream');
    res.setHeader('Content-Disposition', 'attachment');
    res.setHeader('Cache-Control', 'private, no-store');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('X-Data-Sha256', entry.sha256);
    res.setHeader('X-Data-Mode', entry.mode);
    if (entry.fetched_at) res.setHeader('X-Data-Fetched-At', entry.fetched_at);
    res.status(200).send(bytes);
  }
);

export const config = { api: { responseLimit: false } };

export default handler;
