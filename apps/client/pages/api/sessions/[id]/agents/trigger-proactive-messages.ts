import { baseApi } from '@server/middlewares/baseApi';
import { sessionAgentConfigRepository } from '@bike4mind/database';
import { BadRequestError } from '@bike4mind/utils';
import { sendToQueue } from '@server/utils/sqs';
import { getSourceQueueUrl } from '@server/utils/dlqRegistry';
import { assertSessionAccess } from '@server/utils/sessionAccess';

const handler = baseApi().post(async (req, res) => {
  const { id: sessionId } = req.query;
  const logger = req.logger;

  if (typeof sessionId !== 'string') {
    throw new BadRequestError('Invalid session ID');
  }

  // Write-level: this queues real side effects (proactive-message sends), not a read.
  await assertSessionAccess(sessionId, req.user!.id, 'write', req.user!.groups ?? []);

  // Get all configs for this session with proactive messaging enabled, scoped to the caller's
  // own configs: this bypasses the eligibility gates (activeHours/minIntervalHours) the cron
  // path enforces, so it must never let a session write-sharee force ANOTHER user's config to
  // fire and spend that user's LLM keys/credits on demand - only your own can be triggered here.
  const allConfigs = await sessionAgentConfigRepository.findBySessionId(sessionId);
  const enabledConfigs = allConfigs.filter(
    config => config.proactiveMessaging.enabled && config.userId === req.user!.id
  );

  if (enabledConfigs.length === 0) {
    return res.json({
      success: true,
      message: 'No agents with proactive messaging enabled',
      triggeredCount: 0,
      totalEnabledAgents: 0,
      results: [],
    });
  }

  logger.info(`Triggering proactive messages for ${enabledConfigs.length} agents in session ${sessionId}`);

  const results: Array<{ agentId: string; agentName: string; success: boolean; error?: string }> = [];

  for (const config of enabledConfigs) {
    try {
      await sendToQueue(getSourceQueueUrl('agentProactiveMessageQueue'), {
        sessionAgentConfigId: config.id,
      });

      results.push({
        agentId: config.agentId,
        agentName: config.agentId,
        success: true,
      });

      logger.info(`Successfully queued proactive message for agent ${config.agentId}`);
    } catch (error) {
      logger.error(`Error queueing proactive message for agent ${config.agentId}:`, error as Error);
      results.push({
        agentId: config.agentId,
        agentName: config.agentId,
        success: false,
        error: (error as Error).message,
      });
    }
  }

  const successCount = results.filter(r => r.success).length;

  res.json({
    success: true,
    message: `Queued ${successCount} of ${enabledConfigs.length} proactive messages`,
    triggeredCount: successCount,
    totalEnabledAgents: enabledConfigs.length,
    results,
  });
});

export default handler;
