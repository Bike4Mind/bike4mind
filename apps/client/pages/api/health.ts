import { baseApi } from '@server/middlewares/baseApi';
import { rateLimit } from '@bike4mind/server-utils/middlewares/rateLimit';
import { Config } from '@bike4mind/server-utils/utils/config';

// Public health probe. No DB query of its own, but `baseApi` opens a Mongo
// connection in its middleware chain - so a hard DB outage will surface as a
// 5xx here. That makes this closer to a readiness probe than a true liveness
// probe; orchestrators using it to drive container restarts may over-react to
// transient DB blips. If a process-only liveness signal is needed, this route
// should be migrated off `baseApi` (or `baseApi` taught to skip `connectDB`).
// For an explicit DB-backed status signal, use /api/settings/serverStatus.
const handler = baseApi({ auth: false })
  .use(
    rateLimit({
      limit: 60,
      windowMs: 60 * 1000,
    })
  )
  .get((_req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    const revision = process.env.B4M_DEPLOYED_REVISION;
    const fingerprint = process.env.B4M_BUILD_FINGERPRINT;
    return res.status(200).json({
      status: 'ok',
      stage: Config.STAGE,
      ...(revision && /^[a-f0-9]{40}$/.test(revision) ? { deployedRevision: revision } : {}),
      ...(fingerprint && /^[a-f0-9]{64}$/.test(fingerprint) ? { buildFingerprint: fingerprint } : {}),
      timestamp: new Date().toISOString(),
      uptimeSeconds: Math.round(process.uptime()),
    });
  });

export default handler;
