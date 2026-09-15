import { baseApi } from '@server/middlewares/baseApi';
import { rateLimit } from '@server/middlewares/rateLimit';
import { Config } from '@server/utils/config';

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
    return res.status(200).json({
      status: 'ok',
      stage: Config.STAGE,
      timestamp: new Date().toISOString(),
      uptimeSeconds: Math.round(process.uptime()),
    });
  });

export default handler;
