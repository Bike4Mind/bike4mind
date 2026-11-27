import { UnauthorizedError } from '@bike4mind/utils';
import { baseApi } from '@server/middlewares/baseApi';
import { perUserRateLimit } from '@server/middlewares/perUserRateLimit';
import { assertCallableFunctionsEnabled } from '@bike4mind/server-utils/callableFunctions/access';
import {
  linkCallableFunctionSourceForBrowser,
  readCallableFunctionSourceBytes,
} from '@bike4mind/server-utils/callableFunctions/sources';

const param = (value: unknown): string => (typeof value === 'string' ? value : '');

// The owner's browser reads a source for `/data/<name>`, fetched as a server call would fetch it: this answers with
// its stamp entry and a signed link. `?bytes=1` streams the stored bytes that link named instead, for storage that
// cannot sign a browser link (self-host, where no Lambda response cap applies).
const handler = baseApi({ auth: 'jwtOnly' }).get(
  perUserRateLimit('GET /api/callable-functions/[id]/sources/[name]'),
  async (req, res) => {
    if (!req.user) throw new UnauthorizedError('Sign in to use callable functions.');
    await assertCallableFunctionsEnabled(req.user);
    res.setHeader('Cache-Control', 'private, no-store');
    if (req.query.bytes !== '1') {
      res.json(await linkCallableFunctionSourceForBrowser(req.user, param(req.query.id), param(req.query.name)));
      return;
    }
    const bytes = await readCallableFunctionSourceBytes(
      req.user,
      param(req.query.id),
      param(req.query.name),
      param(req.query.sha256)
    );
    res.setHeader('Content-Type', 'application/octet-stream');
    res.setHeader('Content-Disposition', 'attachment');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.status(200).send(bytes);
  }
);

export const config = { api: { responseLimit: false } };

export default handler;
