/**
 * Keep Command REST Endpoint (Local Dev Testing)
 *
 * Sends a Keep command to the user's CLI via WebSocket relay, bypassing
 * the WebSocket route chain for faster iteration. Useful for curl-based testing.
 *
 * DEV ONLY - no auth required when APP_URL includes 'localhost'.
 * In dev mode, resolves the user from the first available WebSocket connection.
 *
 * POST /api/keep/command
 *   Body: { commandType: 'read_file' | 'list_directory', params: { path: string } }
 *   Returns: { requestId, sent, connections }
 *
 * GET /api/keep/command
 *   Returns: { connections } - all active WebSocket connections
 *
 * Example:
 *   curl http://localhost:3001/api/keep/command
 *   curl -X POST http://localhost:3001/api/keep/command \
 *     -H "Content-Type: application/json" \
 *     -d '{"commandType":"read_file","params":{"path":"/tmp/test.txt"}}'
 */
import { baseApi } from '@server/middlewares/baseApi';
import { Resource } from 'sst';
import { sendToClient } from '@server/websocket/utils';
import { Connection } from '@bike4mind/database/social';
import { randomUUID } from 'crypto';
import { z } from 'zod';

const CommandBody = z.object({
  commandType: z.enum(['read_file', 'list_directory', 'run_tool']),
  params: z.record(z.string(), z.unknown()),
});

const isDev = process.env.NODE_ENV === 'development';

const handler = baseApi({ auth: !isDev })
  // In dev mode, restrict to localhost only - prevents LAN/SSRF/rogue-process access
  .use((req, res, next) => {
    if (!req.user) {
      const ip = req.ip || req.connection.remoteAddress;
      if (ip !== '127.0.0.1' && ip !== '::1' && ip !== '::ffff:127.0.0.1') {
        return res.status(403).json({ error: 'Dev endpoint only accepts localhost connections' });
      }
    }
    next();
  })
  .get(async (req, res) => {
    const userId = req.user?.id;
    const query = userId ? { userId } : {};
    const connections = await Connection.find(query).limit(50);

    // In dev without auth, return counts only - don't expose user IDs and connection details
    if (!req.user) {
      const userCount = new Set(connections.map(c => c.userId)).size;
      return res.json({
        dev: isDev,
        connectedUsers: userCount,
        totalConnections: connections.length,
        hint: 'POST to this endpoint with { commandType, params } to send a Keep command',
      });
    }

    // Authenticated: full details for the current user only
    const grouped: Record<string, { connectionId: string; connectedAt: unknown }[]> = {};
    for (const c of connections) {
      const uid = c.userId || 'unknown';
      if (!grouped[uid]) grouped[uid] = [];
      grouped[uid].push({ connectionId: c.connectionId, connectedAt: c.createdAt });
    }

    res.json({
      dev: isDev,
      users: grouped,
      total: connections.length,
      hint: 'POST to this endpoint with { commandType, params } to send a Keep command',
    });
  })
  .post(async (req, res) => {
    const parsed = CommandBody.safeParse(req.body);

    if (!parsed.success) {
      return res.status(400).json({
        error: 'Invalid request body',
        details: parsed.error.flatten(),
        expected: '{ commandType: "read_file" | "list_directory", params: { path: "/some/path" } }',
      });
    }

    const { commandType, params } = parsed.data;
    const requestId = randomUUID();

    // Resolve userId: from auth if available, otherwise from first connection (dev only)
    let userId = req.user?.id;
    if (!userId && isDev) {
      const anyConnection = await Connection.findOne();
      if (!anyConnection) {
        return res.status(404).json({
          error: 'No WebSocket connections found at all',
          hint: 'Open the app at http://localhost:3001 and log in, or start the CLI',
        });
      }
      userId = anyConnection.userId;
    }
    if (!userId) {
      return res.status(401).json({ error: 'Unauthorized' });
    }

    const connections = await Connection.find({ userId });
    if (connections.length === 0) {
      return res.status(404).json({
        error: `No WebSocket connections found for user ${userId}`,
        hint: 'Start the CLI with: b4m → /set-api http://localhost:3001 → /login',
      });
    }

    const endpoint = Resource.websocket.managementEndpoint;

    try {
      await sendToClient(userId, endpoint, {
        action: 'keep_command' as const,
        commandType,
        params,
        requestId,
        originConnectionId: 'rest-test',
      });
    } catch (err) {
      return res.status(502).json({
        error: 'Failed to relay command via WebSocket',
        details: err instanceof Error ? err.message : String(err),
      });
    }

    console.log(`[Keep REST] Sent ${commandType} to ${connections.length} connections for user ${userId}`);

    res.json({
      requestId,
      sent: true,
      userId,
      commandType,
      params,
      connections: connections.length,
      note: 'Command sent to CLI via WebSocket. Check CLI terminal for the permission prompt and response.',
    });
  });

export const config = {
  api: {
    externalResolver: true,
  },
};

export default handler;
