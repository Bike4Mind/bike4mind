/**
 * Review and revoke the agent-mode tool decisions a user asked this notebook to remember
 * ("Allow for Session" / "Deny for Session" on the permission card).
 *
 * Rows are keyed by user AND session, and every handler here keys on `req.user.id`, so a
 * caller can only ever see or clear their own decisions - a shared notebook does not expose
 * one collaborator's approvals to another.
 */
import { baseApi } from '@server/middlewares/baseApi';
import { sessionToolApprovalRepository } from '@bike4mind/database';

const handler = baseApi()
  .get(async (req, res) => {
    const sessionId = req.query.id as string;
    const remembered = await sessionToolApprovalRepository.findByUserAndSession(req.user.id, sessionId);
    return res.json({
      approvedTools: remembered?.approvedTools ?? [],
      deniedTools: remembered?.deniedTools ?? [],
    });
  })
  .delete(async (req, res) => {
    const sessionId = req.query.id as string;
    const { tool } = req.query;

    // `?tool=a&tool=b` parses to an array; revoke each named tool rather than
    // falling through to forgetAll, which would silently revoke everything.
    if (Array.isArray(tool)) {
      let remaining;
      for (const toolName of tool) {
        remaining = await sessionToolApprovalRepository.forgetTool(req.user.id, sessionId, String(toolName));
      }
      return res.json({
        approvedTools: remaining?.approvedTools ?? [],
        deniedTools: remaining?.deniedTools ?? [],
      });
    }

    const toolName = tool === undefined ? undefined : String(tool);
    if (toolName === '') {
      return res.status(400).json({ error: 'tool must not be empty' });
    }
    if (toolName === undefined) {
      await sessionToolApprovalRepository.forgetAll(req.user.id, sessionId);
      return res.json({ approvedTools: [], deniedTools: [] });
    }

    const remaining = await sessionToolApprovalRepository.forgetTool(req.user.id, sessionId, toolName);
    return res.json({
      approvedTools: remaining?.approvedTools ?? [],
      deniedTools: remaining?.deniedTools ?? [],
    });
  });

export const config = {
  api: {
    externalResolver: true,
  },
};

export default handler;
