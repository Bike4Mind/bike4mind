/**
 * Keep Command REST Endpoint (Dev Testing)
 *
 * Sends a Keep command to the user's CLI via WebSocket relay, bypassing
 * the WebSocket route chain for faster iteration. Useful for curl-based testing.
 *
 * `jwtOnly`: a Keep command runs on the user's own machine, so only a signed-in
 * session may send one. Pass the session JWT as a bearer token when testing with curl.
 *
 * POST /api/keep/command
 *   Body: { commandType: 'read_file' | 'list_directory' | 'run_tool', params: Record<string, unknown> }
 *   Returns: { requestId, sent, connections }
 *
 * GET /api/keep/command
 *   Returns: { users, total } - the caller's active WebSocket connections
 *
 * Example:
 *   curl http://localhost:3001/api/keep/command -H "Authorization: Bearer $JWT"
 *   curl -X POST http://localhost:3001/api/keep/command \
 *     -H "Authorization: Bearer $JWT" \
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

const handler = baseApi({ auth: 'jwtOnly' })
  .get(async (req, res) => {
    const userId = req.user!.id;
    const connections = await Connection.find({ userId }).limit(50);

    res.json({
      users: {
        [userId]: connections.map(c => ({ connectionId: c.connectionId, connectedAt: c.createdAt })),
      },
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
    const userId = req.user!.id;
    const requestId = randomUUID();

    const connections = await Connection.find({ userId });
    if (connections.length === 0) {
      return res.status(404).json({
        error: `No WebSocket connections found for user ${userId}`,
        hint: 'Start the CLI with: b4m -> /set-api http://localhost:3001 -> /login',
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
      note: 'Command sent to CLI via WebSocket. Check the CLI terminal for the response.',
    });
  });

export const config = {
  api: {
    externalResolver: true,
  },
};

export default handler;
