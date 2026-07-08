import { Resource } from 'sst';
import { baseApi } from '@server/middlewares/baseApi';
import { rateLimit } from '@server/middlewares/rateLimit';

/**
 * GET /api/chat-completion-status - connectivity probe for the always-on ChatCompletion.
 *
 * The service sits behind a VPC-internal ALB, so the browser cannot reach its /health endpoint
 * directly. This route runs in the frontend Lambda (same VPC) and proxies the check, returning a
 * simple `{ connected }` flag for the side-nav status indicator. The service's /health needs no
 * auth, but this route is authed (baseApi default) so internal infra status isn't exposed to
 * anonymous callers.
 *
 * Always responds 200: a healthy upstream -> `{ connected: true }`, an unreachable/unhealthy one ->
 * `{ connected: false }`. Reporting "not connected" as a 200 (rather than a 5xx) keeps the client
 * query resolved so the indicator simply shows disconnected instead of erroring.
 */
const HEALTH_TIMEOUT_MS = 4000;

const handler = baseApi()
  .use(
    rateLimit({
      limit: 60,
      windowMs: 60 * 1000,
    })
  )
  .get(async (_req, res) => {
    // Self-host processes quests in-process (no separate service): if this
    // route is answering, the processor is up.
    if (process.env.B4M_SELF_HOST === 'true') {
      return res.status(200).json({ connected: true });
    }
    const url = `${Resource.ChatCompletion.url}/health`;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), HEALTH_TIMEOUT_MS);
    try {
      const upstream = await fetch(url, { signal: controller.signal });
      // The service returns 200 { ok: true, readyState: 1 } once Mongo is connected, 503 until then.
      const body = (await upstream.json().catch(() => ({}))) as { ok?: boolean; readyState?: number };
      return res.status(200).json({
        connected: upstream.status === 200 && body?.ok === true,
        readyState: body?.readyState,
      });
    } catch {
      // Unreachable / timed out / aborted -> not connected.
      return res.status(200).json({ connected: false });
    } finally {
      clearTimeout(timer);
    }
  });

export default handler;
