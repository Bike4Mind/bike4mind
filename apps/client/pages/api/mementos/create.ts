import { Request, Response } from 'express';
import { Memento, apiKeyRepository, adminSettingsRepository } from '@bike4mind/database';
import { baseApi } from '@server/middlewares/baseApi';
import {
  MementoGroomingService,
  MEMORY_LIMITS,
  calculateHotMementoSize,
} from '../../../services/MementoGroomingService';
import { CreateMementoSchema } from '@server/validators/mementoValidators';
import { apiKeyService } from '@bike4mind/services';
import { getSettingsByNames } from '@bike4mind/utils';
import { generateMementoSummaryEmbedding } from '@server/utils/mementoEmbedding';

const handler = baseApi().post(async (req: Request, res: Response) => {
  req.logger.updateMetadata({ endpoint: 'mementos/create' });
  const groomingService = new MementoGroomingService(req.logger);

  try {
    const parsed = CreateMementoSchema.parse(req.body);
    const { type, tier, weight, sessionId, summary, fullContent, tags, metadata, lastAccessedAt, isArchived, questId } =
      parsed;

    if (!sessionId) {
      return res.status(400).json({
        error: 'Session ID is required. Please ensure you have an active session before creating mementos.',
      });
    }

    // Synchronous memory limit enforcement: check usage before creating the new memento
    const existingMementos = await Memento.findByUserId(req.user.id);
    const currentHotSize = calculateHotMementoSize(existingMementos);
    const maxTotalChars = MEMORY_LIMITS.DEFAULT_MAX_TOTAL_CHARS;

    const newMementoSize = (summary?.length || 0) + (fullContent?.length || 0) + (tags?.join('').length || 0);
    const projectedHotSize = currentHotSize + newMementoSize;
    const projectedUsagePercent = projectedHotSize / maxTotalChars;

    req.logger.info('Memory usage check before memento creation', {
      currentHotSize,
      newMementoSize,
      projectedHotSize,
      projectedUsagePercent: (projectedUsagePercent * 100).toFixed(1) + '%',
      maxTotalChars,
      userId: req.user.id,
    });

    // If projected usage would exceed 95%, trigger immediate synchronous grooming
    if (projectedUsagePercent > 0.95) {
      req.logger.warn('🚨 Projected memory usage exceeds 95%, forcing immediate grooming', {
        projectedUsagePercent: (projectedUsagePercent * 100).toFixed(1) + '%',
        userId: req.user.id,
      });

      try {
        await groomingService.checkAndScheduleGrooming(req.user.id, maxTotalChars, true);

        const postGroomMementos = await Memento.findByUserId(req.user.id);
        const postGroomHotSize = calculateHotMementoSize(postGroomMementos);
        const postGroomProjectedSize = postGroomHotSize + newMementoSize;
        const postGroomUsagePercent = postGroomProjectedSize / maxTotalChars;

        req.logger.info('Post-grooming memory check', {
          postGroomHotSize,
          postGroomProjectedSize,
          postGroomUsagePercent: (postGroomUsagePercent * 100).toFixed(1) + '%',
        });

        // If still over limit after grooming, reject the creation
        if (postGroomUsagePercent > 1.0) {
          return res.status(413).json({
            error:
              `Memory limit exceeded. Current usage: ${(postGroomUsagePercent * 100).toFixed(1)}% after grooming. ` +
              `Please delete some mementos or reduce the size of this memento to stay within the ${maxTotalChars.toLocaleString()} character limit.`,
            currentUsage: Math.round(postGroomUsagePercent * 100),
            maxLimit: 100,
            currentSize: postGroomHotSize,
            newMementoSize,
            maxTotalChars,
          });
        }
      } catch (groomError) {
        req.logger.error('Error during emergency grooming', groomError);
        // Continue with creation but log the error
      }
    }

    // Embed the summary so manually-created mementos are retrievable by semantic
    // similarity, matching the auto path (events/createMemento.ts). Graceful: a null
    // embedding (no provider configured) just stores the memento without a vector.
    const apiKeyTable = await apiKeyService.getEffectiveLLMApiKeys(
      req.user.id,
      { db: { apiKeys: apiKeyRepository, adminSettings: adminSettingsRepository }, getSettingsByNames },
      { logger: req.logger }
    );
    const embedding = await generateMementoSummaryEmbedding(summary.trim(), {
      adminSettings: adminSettingsRepository,
      apiKeyTable,
      logger: req.logger,
    });

    const memento = await Memento.create({
      userId: req.user.id,
      sessionId: sessionId,
      type,
      tier,
      weight: weight / 1000, // Convert to 0-1 range for storage
      summary: summary.trim(),
      fullContent: fullContent?.trim() || '',
      tags: tags || [],
      metadata,
      questId,
      lastAccessedAt: lastAccessedAt ?? new Date(),
      isArchived: isArchived ?? false,
      ...(embedding ? { embedding } : {}),
    });

    const finalMementos = await Memento.findByUserId(req.user.id);
    const finalHotSize = calculateHotMementoSize(finalMementos);
    const finalUsagePercent = finalHotSize / maxTotalChars;

    req.logger.info('Memento created successfully', {
      mementoId: memento.id,
      finalHotSize,
      finalUsagePercent: (finalUsagePercent * 100).toFixed(1) + '%',
      totalHotMementos: finalMementos.filter(m => m.tier === 'hot').length,
    });

    // Schedule background grooming if needed (non-blocking)
    if (finalUsagePercent > 0.75) {
      groomingService
        .checkAndScheduleGrooming(req.user.id)
        .catch(err => req.logger.error('Background grooming failed', err));
    }

    return res.status(201).json(memento);
  } catch (error) {
    req.logger.error('Error creating memento:', error);
    return res.status(500).json({ error: 'Failed to create memento' });
  }
});

export default handler;
