import { baseApi } from '@server/middlewares/baseApi';
import { asyncHandler } from '@server/middlewares/asyncHandler';
import { ForbiddenError } from '@bike4mind/utils';
import { initializeServerAdminTools, getServerAdminToolService } from '@client/server/tools/adminToolsServer';
import { AdminToolContext, AdminToolParams } from '@bike4mind/common';

const handler = baseApi().post(
  asyncHandler(async (req: any, res: any) => {
    // Check if user is admin using server-side authentication
    if (!req.user?.isAdmin) {
      throw new ForbiddenError('Unauthorized. Admin access required.');
    }

    // 'Admin' is not in VALID_USER_TAGS; the isAdmin flag alone gates admin access.

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
    const result = await adminToolService.execute(tool, context, toolParams);

    return res.json(result);
  })
);

export default handler;
