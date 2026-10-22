import { baseApi } from '@server/middlewares/baseApi';
import { asyncHandler } from '@server/middlewares/asyncHandler';
import { ForbiddenError } from '@bike4mind/utils';
import { initializeServerAdminTools, getServerAdminToolService } from '@client/server/tools/adminToolsServer';
import { collectModalChanges } from '@client/server/tools/modalOperations';
import { recordModalChanges } from '@client/server/tools/recordModalChanges';
import { recordAdminActionFromRequest } from '@server/utils/adminAudit';
import { AdminToolContext, AdminToolParams, ApiKeyScope } from '@bike4mind/common';

const MODAL_TOOL_NAME = 'modal';
// Tools that never write; everything else is recorded as an admin tool run.
const READ_ONLY_TOOL_NAMES: ReadonlySet<string> = new Set(['help']);

const handler = baseApi({ requiredScopes: [ApiKeyScope.ADMIN] }).post(
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
    const { result, changes } = await collectModalChanges(() => adminToolService.execute(tool, context, toolParams));

    await recordModalChanges(req, changes, 'admin-tool');
    // A failed run (including an unregistered tool name) changed nothing worth auditing.
    if (result.success && tool !== MODAL_TOOL_NAME && !READ_ONLY_TOOL_NAMES.has(tool)) {
      await recordAdminActionFromRequest(req, {
        action: 'settings.admin_tool.executed',
        target: { kind: 'settings', id: String(tool), displayName: `admin tool ${String(tool)}` },
        summary: `ran admin tool ${String(tool)}`,
        details: { toolName: tool, toolAction: toolParams.action },
      });
    }

    return res.json(result);
  })
);

export default handler;
