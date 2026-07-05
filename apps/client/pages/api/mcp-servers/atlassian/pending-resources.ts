import { baseApi } from '@server/middlewares/baseApi';
import { BadRequestError } from '@server/utils/errors';
import { userRepository } from '@bike4mind/database';

/**
 * GET /api/mcp-servers/atlassian/pending-resources
 *
 * Securely fetches pending Atlassian resources from the server.
 * This endpoint prevents URL resource manipulation attacks by serving
 * resources directly from the database rather than trusting URL params.
 *
 * Prerequisites:
 * - User must be authenticated
 * - User must have atlassianConnect with status 'pending_site_selection'
 *
 * Response:
 * - 200: { resources: Array<{id, name, url, scopes}> }
 * - 400: No pending site selection exists or selection has expired
 */

interface PendingResource {
  id: string;
  name: string;
  url: string;
  scopes: string[];
}

const handler = baseApi().get(async (req, res) => {
  const userId = req.user.id;

  const user = await userRepository.findById(userId);

  if (!user) {
    throw new BadRequestError('User not found');
  }

  if (!user.atlassianConnect) {
    throw new BadRequestError(
      'No Atlassian connection found. Please start the connection process from the integrations page.'
    );
  }

  if (user.atlassianConnect.status !== 'pending_site_selection') {
    throw new BadRequestError(
      'No pending site selection. Current status: ' + (user.atlassianConnect.status || 'connected')
    );
  }

  if (user.atlassianConnect.pendingSelectionExpiresAt) {
    const expiresAt = new Date(user.atlassianConnect.pendingSelectionExpiresAt);
    if (expiresAt < new Date()) {
      console.log(`[Atlassian Pending Resources] Pending selection expired for user ${userId}`);
      await userRepository.update({
        id: userId,
        atlassianConnect: null,
      });
      throw new BadRequestError(
        'Your site selection has expired. Please start the connection process again from the integrations page.'
      );
    }
  }

  const resources: PendingResource[] = (user.atlassianConnect.resources ?? []).map(r => ({
    id: r.id,
    name: r.name,
    url: r.url,
    scopes: r.scopes,
  }));

  if (resources.length === 0) {
    throw new BadRequestError('No Atlassian resources available. Please reconnect your Atlassian account.');
  }

  console.log(`[Atlassian Pending Resources] Returning ${resources.length} resources for user ${userId}`);

  res.status(200).json({
    resources,
  });
});

export default handler;
