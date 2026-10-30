import { baseApi } from '@server/middlewares/baseApi';
import { rateLimit } from '@bike4mind/server-utils/middlewares/rateLimit';
import {
  adminSettingsRepository,
  agentExecutionRepository,
  loopRepository,
  workItemRepository,
} from '@bike4mind/database';
import { getSettingsMap, getSettingsValue } from '@bike4mind/utils';
import { ILoop, ILoopWithUsage } from '@bike4mind/common';
import { verifyOrgAccess } from '@bike4mind/server-utils/utils/orgAccess';
import { resolveDefaultChatModel } from '@server/utils/chatCompletionDefaults';
import { getOrCreateSession } from '@server/managers/sessionCrud';
import {
  assertLoopsEnabled,
  LOOP_RATE_LIMIT,
  LOOP_RATE_WINDOW_MS,
  validateLoopAgentId,
  validateLoopBudget,
  validateLoopGoal,
  validateLoopInterval,
  validateLoopModel,
  validateLoopName,
  validateLoopOrganizationId,
  validateLoopOversees,
  validateLoopStages,
  validateLoopTools,
} from '@server/utils/loopValidation';

const handler = baseApi({ auth: 'jwtOnly' })
  .use(rateLimit({ limit: LOOP_RATE_LIMIT, windowMs: LOOP_RATE_WINDOW_MS, bucket: 'loops-collection' }))
  .get(async (req, res) => {
    await assertLoopsEnabled();
    const loops = await loopRepository.listForUser(req.user!.id);
    const ids = loops.map(loop => loop.id);
    const [credits, blocked] = await Promise.all([
      agentExecutionRepository.sumCreditsByLoop(
        ids,
        loops.map(loop => loop.sessionId)
      ),
      workItemRepository.countBlockedByLoop(req.user!.id, ids),
    ]);
    res.json(
      loops.map((loop): ILoopWithUsage => ({
        ...loop,
        creditsUsed: credits[loop.id] ?? 0,
        blockedTickets: blocked[loop.id] ?? 0,
      }))
    );
  })
  .post(async (req, res) => {
    await assertLoopsEnabled();
    const body = req.body as Partial<ILoop>;

    const name = validateLoopName(body.name);
    const goal = validateLoopGoal(body.goal);
    const intervalMinutes = validateLoopInterval(body.intervalMinutes);
    const tools = body.tools === undefined ? [] : validateLoopTools(body.tools);
    const stages = body.stages === undefined ? undefined : validateLoopStages(body.stages);
    const agentId = body.agentId === undefined ? undefined : validateLoopAgentId(body.agentId);
    const budgetCreditsPerDay =
      body.budgetCreditsPerDay === undefined ? undefined : validateLoopBudget(body.budgetCreditsPerDay);
    const oversees =
      body.oversees === undefined ? null : await validateLoopOversees(body.oversees, undefined, req.user!.id);

    const organizationId =
      body.organizationId === undefined ? undefined : validateLoopOrganizationId(body.organizationId);
    if (organizationId) {
      await verifyOrgAccess({ id: req.user!.id, isAdmin: Boolean(req.user!.isAdmin) }, organizationId);
    }

    // Same default as POST /api/v1/agent-executions, resolved once so every run uses the same model.
    let model = body.model === undefined ? undefined : validateLoopModel(body.model);
    if (!model) {
      const settings = await getSettingsMap({ adminSettings: adminSettingsRepository });
      const resolved = await resolveDefaultChatModel({
        configuredModel: getSettingsValue('DefaultAPIModel', settings),
        userId: req.user!.id,
        logger: req.logger,
      });
      model = resolved.model;
    }

    const { sessionId } = await getOrCreateSession({ sessionName: name, user: req.user!, logger: req.logger });

    const created = await loopRepository.create({
      userId: req.user!.id,
      ...(organizationId && { organizationId }),
      name,
      goal,
      model,
      sessionId,
      intervalMinutes,
      tools,
      ...(stages && { stages }),
      ...(agentId && { agentId }),
      ...(budgetCreditsPerDay !== undefined && { budgetCreditsPerDay }),
      ...(oversees && { oversees }),
      status: 'draft',
    } as Omit<ILoop, 'id' | 'createdAt' | 'updatedAt'>);

    res.status(201).json(created);
  });

export default handler;
