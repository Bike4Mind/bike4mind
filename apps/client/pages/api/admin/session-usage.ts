import { baseApi } from '@server/middlewares/baseApi';
import { usageEventRepository, agentExecutionRepository } from '@bike4mind/database';
import {
  CreditHolderType,
  type ISessionAgentExecution,
  type ISessionAgentModelUsage,
  type ISessionUsageResponse,
} from '@bike4mind/common';
import { ForbiddenError } from '@server/utils/errors';
import { NotFoundError } from '@bike4mind/utils';
import { verifyOrgAccess } from '@server/utils/orgAccess';
import { z } from 'zod';

const QuerySchema = z.object({
  sessionId: z.string().min(1),
  // Required for non-admins: the org the session's spend was billed to. Admins
  // read any session cross-org and may omit it.
  organizationId: z.string().min(1).optional(),
});

/**
 * One session's usage detail - spend rolled up by quest and by model (from
 * UsageEventModel, which carries frozen COGS), plus each agent execution that
 * ran in the session with its per-model iteration billing. Answers "why did
 * this session cost what it did?".
 *
 * Access: platform admins read any session, cross-org. A non-admin must pass
 * the org they can access (verifyOrgAccess) AND the session's spend must be
 * billed to that org - sessions carry no org of their own, so ownership is
 * proven off the usage events. Mismatches 404 (same as no access, to avoid
 * enumeration).
 *
 * A single session can carry spend billed to more than one owner (the billing
 * owner is resolved per-request, not pinned to the session - e.g. a session
 * that starts personal and later runs under an org). So a non-admin's view is
 * scoped to their org: they see only their org's slice, never another owner's.
 * Admins keep the full cross-org rollup.
 */
const handler = baseApi().get(async (req, res) => {
  if (!req.user) {
    throw new ForbiddenError('Authentication required');
  }

  const { sessionId, organizationId } = QuerySchema.parse(req.query);

  // Undefined for admins (whole session, cross-org); set for a non-admin so
  // both the usage rollup and the execution list return only their org's slice.
  let orgScope: string | undefined;
  if (!req.user.isAdmin) {
    if (!organizationId) {
      throw new ForbiddenError('Admin access required');
    }
    await verifyOrgAccess(req.user, organizationId);
    const belongsToOrg = await usageEventRepository.sessionBelongsToOwner(
      sessionId,
      organizationId,
      CreditHolderType.Organization
    );
    if (!belongsToOrg) {
      throw new NotFoundError('Session not found');
    }
    orgScope = organizationId;
  }

  const [usage, execDocs] = await Promise.all([
    usageEventRepository.sessionUsageSummary(
      sessionId,
      orgScope ? { ownerId: orgScope, ownerType: CreditHolderType.Organization } : undefined
    ),
    agentExecutionRepository.findBillingBySessionId(sessionId, orgScope),
  ]);

  const executions: ISessionAgentExecution[] = execDocs.map(exec => {
    const byModel = new Map<string, ISessionAgentModelUsage>();
    for (const ib of exec.iterationBilling ?? []) {
      const row = byModel.get(ib.model) ?? {
        model: ib.model,
        iterations: 0,
        credits: 0,
        inputTokens: 0,
        outputTokens: 0,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
      };
      row.iterations += 1;
      // `credits` is the full agent + tool-internal charge, but the token counts are
      // AGENT-ONLY by design (tool tokens are priced at a different model and never
      // persisted to iterationBilling - see agentExecutor.billing.ts #630).
      // So a row's credits can exceed what its tokens alone imply; that's expected.
      row.credits += ib.credits;
      row.inputTokens += ib.inputTokens;
      row.outputTokens += ib.outputTokens;
      row.cacheReadTokens += ib.cacheReadTokens;
      row.cacheWriteTokens += ib.cacheWriteTokens;
      byModel.set(ib.model, row);
    }
    return {
      executionId: String(exec.id),
      status: exec.status,
      parentExecutionId: exec.parentExecutionId,
      totalCreditsUsed: exec.totalCreditsUsed ?? 0,
      iterationCount: exec.iterationBilling?.length ?? 0,
      byModel: [...byModel.values()].sort((a, b) => b.credits - a.credits),
    };
  });

  const response: ISessionUsageResponse = { sessionId, usage, executions };
  return res.json(response);
});

export default handler;
