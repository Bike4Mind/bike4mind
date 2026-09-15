import { Logger } from '@bike4mind/observability';
import { ISessionAgentConfigDocument, ISessionAgentConfigRepository, ISessionRepository } from '@bike4mind/common';

interface GetEligibleConfigsAdapters {
  db: {
    sessionAgentConfigs: ISessionAgentConfigRepository;
    sessions: ISessionRepository;
  };
  logger: Logger;
}

/**
 * Checks if the current time is within the active hours for proactive messaging
 */
function checkActiveHours(activeHours: { startHour: number; endHour: number; timezone?: string }, now: Date): boolean {
  const { startHour, endHour, timezone } = activeHours;

  // Convert to user's timezone if provided
  let currentHour: number;
  if (timezone) {
    // Use Intl.DateTimeFormat to get hour in user's timezone
    const formatter = new Intl.DateTimeFormat('en-US', {
      timeZone: timezone,
      hour: 'numeric',
      hour12: false,
    });
    const parts = formatter.formatToParts(now);
    const hourPart = parts.find(part => part.type === 'hour');
    currentHour = hourPart ? parseInt(hourPart.value, 10) : now.getUTCHours();
  } else {
    // Default to UTC
    currentHour = now.getUTCHours();
  }

  // Handle overnight ranges (e.g., 22-6 means 10pm to 6am)
  if (endHour < startHour) {
    return currentHour >= startHour || currentHour < endHour;
  } else {
    return currentHour >= startHour && currentHour < endHour;
  }
}

/**
 * Gets all configs eligible for proactive messaging based on:
 * - Proactive messaging is enabled
 * - Session still exists and is not deleted
 * - Agent is still attached to session
 * - Within active hours
 * - Minimum interval has passed since last message
 */
export async function getEligibleConfigs({
  db,
  logger,
}: GetEligibleConfigsAdapters): Promise<ISessionAgentConfigDocument[]> {
  try {
    logger.info('Getting eligible configs for proactive messaging');

    const configs = await db.sessionAgentConfigs.findAllWithProactiveMessagingEnabled();

    logger.info(`Found ${configs.length} configs with proactive messaging enabled`);

    const now = new Date();
    const eligibleConfigs: ISessionAgentConfigDocument[] = [];

    // Check each config to see if it's eligible for proactive messaging
    for (const config of configs) {
      try {
        // Verify session still exists and is not deleted
        const session = await db.sessions.findById(config.sessionId);
        if (!session || session.deletedAt) {
          logger.info(`Skipping config ${config.id}: session not found or deleted`);
          continue;
        }

        // Verify agent still exists and is attached to session
        const agentIds = await db.sessions.getAttachedAgents(config.sessionId);
        if (!agentIds.includes(config.agentId)) {
          logger.info(`Skipping config ${config.id}: agent not attached to session`);
          continue;
        }

        // Check if we're within active hours
        const isWithinActiveHours = checkActiveHours(config.proactiveMessaging.activeHours, now);
        if (!isWithinActiveHours) {
          continue; // Skip if not within active hours
        }

        // Check if minimum interval has passed
        const lastMessageAt = config.proactiveMessaging.lastProactiveMessageAt;
        const minIntervalHours = config.proactiveMessaging.minIntervalHours || 24;
        const minIntervalMs = minIntervalHours * 60 * 60 * 1000;

        if (lastMessageAt) {
          const timeSinceLastMessage = now.getTime() - new Date(lastMessageAt).getTime();
          if (timeSinceLastMessage < minIntervalMs) {
            continue; // Skip if minimum interval hasn't passed
          }
        }

        // Config is eligible - add to list
        eligibleConfigs.push(config);
      } catch (error) {
        logger.error(`Error checking config ${config.id}:`, error as Error);
        continue;
      }
    }

    logger.info(`Found ${eligibleConfigs.length} eligible configs for proactive messaging`);

    return eligibleConfigs;
  } catch (error) {
    logger.error('Error in getEligibleConfigs:', error as Error);
    throw error;
  }
}
