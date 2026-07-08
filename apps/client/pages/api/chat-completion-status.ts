import { Resource } from 'sst';
import { baseApi } from '@server/middlewares/baseApi';
import { rateLimit } from '@server/middlewares/rateLimit';

/**
 * GET /api/chat-completion-status - connectivity probe for the always-on ChatCompletion service.
 *
 * The browser can't reach the service's /health directly, so this route (running in the frontend:
 * a Lambda in hosted, the `app` container in self-host) proxies the check and returns a simple
 * `{ connected }` flag for the side-nav status indicator. The service's /health needs no auth, but
 * this route is authed (baseApi default) so internal infra status isn't exposed to anonymous callers.
 *
 * Single code path across every environment (matching dispatchQuest): probe
 * `Resource.ChatCompletion.url/health` - the hosted ALB, or `http://chatcompletion:8080` in
 * self-host (resolved from CHAT_COMPLETION via the @bike4mind/resource shim). No B4M_SELF_HOST
 * short-circuit: the indicator must reflect the real service, since a down/booting chatcompletion
 * container is exactly when the next chat message would fail.
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
