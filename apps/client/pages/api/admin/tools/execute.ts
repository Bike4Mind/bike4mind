import { adminApi } from '@server/middlewares/adminApi';
import { asyncHandler } from '@server/middlewares/asyncHandler';
import { initializeServerAdminTools, getServerAdminToolService } from '@client/server/tools/adminToolsServer';
import { collectModalChanges } from '@client/server/tools/modalOperations';
import { recordModalChanges } from '@client/server/tools/recordModalChanges';
import { AdminToolContext, AdminToolParams, ApiKeyScope } from '@bike4mind/common';

const handler = adminApi({
  adminPermissions: { POST: 'settings:manage' },
  requiredScopes: [ApiKeyScope.ADMIN],
}).post(
  asyncHandler(async (req: any, res: any) => {
    const { tool, params, context: clientContext } = req.body;

    // Initialize and get server-side admin tool service
    initializeServerAdminTools();
    const adminToolService = getServerAdminToolService();

    // Build context with authenticated user from server
    const context: AdminToolContext = {
      user: req.user, // Use authenticated user from server, not from client
      chatHistory: clientContext?.chatHistory || [],
      attachments: clientContext?.attachments || [],
      sessionId: clientContext?.sessionId,
    };

    // Parse params
    const toolParams: AdminToolParams = {
      action: params?.action,
      query: params?.query,
      data: params?.data,
      options: params?.options || {},
    };

    // Execute the tool
    const { result, changes } = await collectModalChanges(
      () => adminToolService.execute(tool, context, toolParams),
      partial => recordModalChanges(req, partial, 'admin-tool')
    );

    await recordModalChanges(req, changes, 'admin-tool');

    return res.json(result);
  })
);

export default handler;
