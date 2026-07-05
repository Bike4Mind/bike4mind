import { Request, Response } from 'express';
import { Memento } from '@bike4mind/database';
import { baseApi } from '@server/middlewares/baseApi';
import {
  MementoGroomingService,
  MEMORY_LIMITS,
  calculateHotMementoSize,
} from '../../../services/MementoGroomingService';
import { CreateMementoSchema } from '@server/validators/mementoValidators';

const handler = baseApi().post(async (req: Request, res: Response) => {
  req.logger.updateMetadata({ endpoint: 'mementos/create-batch' });
  const groomingService = new MementoGroomingService(req.logger);

  try {
    const parsedArray = CreateMementoSchema.array().parse(req.body);

    const invalidMementos = parsedArray.filter(m => !m.sessionId);
    if (invalidMementos.length > 0) {
      return res.status(400).json({
        error: `Session ID is required for all mementos. Found ${invalidMementos.length} mementos without session ID.`,
      });
    }

    // Synchronous memory limit enforcement: check usage before creating new mementos
    const existingMementos = await Memento.findByUserId(req.user.id);
    const currentHotSize = calculateHotMementoSize(existingMementos);
    const maxTotalChars = MEMORY_LIMITS.DEFAULT_MAX_TOTAL_CHARS;

    const totalNewMementoSize = parsedArray.reduce((total, m) => {
      return total + (m.summary?.length || 0) + (m.fullContent?.length || 0) + (m.tags?.join('').length || 0);
    }, 0);

    const projectedHotSize = currentHotSize + totalNewMementoSize;
    const projectedUsagePercent = projectedHotSize / maxTotalChars;

    req.logger.info('Batch memory usage check before creation', {
      currentHotSize,
      batchCount: parsedArray.length,
      totalNewMementoSize,
      projectedHotSize,
      projectedUsagePercent: (projectedUsagePercent * 100).toFixed(1) + '%',
      maxTotalChars,
      userId: req.user.id,
    });

    // If projected usage would exceed 95%, trigger immediate synchronous grooming
    if (projectedUsagePercent > 0.95) {
      req.logger.warn('🚨 Projected batch memory usage exceeds 95%, forcing immediate grooming', {
        projectedUsagePercent: (projectedUsagePercent * 100).toFixed(1) + '%',
        batchSize: totalNewMementoSize,
        userId: req.user.id,
      });

      try {
        await groomingService.checkAndScheduleGrooming(req.user.id, maxTotalChars, true);

        const postGroomMementos = await Memento.findByUserId(req.user.id);
        const postGroomHotSize = calculateHotMementoSize(postGroomMementos);
        const postGroomProjectedSize = postGroomHotSize + totalNewMementoSize;
        const postGroomUsagePercent = postGroomProjectedSize / maxTotalChars;

        req.logger.info('Post-grooming batch memory check', {
          postGroomHotSize,
          postGroomProjectedSize,
          postGroomUsagePercent: (postGroomUsagePercent * 100).toFixed(1) + '%',
        });

        // If still over limit after grooming, reject the batch creation
        if (postGroomUsagePercent > 1.0) {
          return res.status(413).json({
            error:
              `Batch memory limit exceeded. Current usage: ${(postGroomUsagePercent * 100).toFixed(1)}% after grooming. ` +
              `Please reduce the batch size or delete existing mementos to stay within the ${maxTotalChars.toLocaleString()} character limit.`,
            currentUsage: Math.round(postGroomUsagePercent * 100),
            maxLimit: 100,
            currentSize: postGroomHotSize,
            batchSize: totalNewMementoSize,
            batchCount: parsedArray.length,
            maxTotalChars,
          });
        }
      } catch (groomError) {
        req.logger.error('Error during emergency batch grooming', groomError);
        // Continue with creation but log the error
      }
    }

    const processedMementos = parsedArray.map(m => ({
      userId: req.user.id,
      sessionId: m.sessionId,
      type: m.type,
      tier: m.tier,
      weight: m.weight / 1000,
      summary: m.summary.trim(),
      fullContent: m.fullContent?.trim() || '',
      tags: m.tags || [],
      metadata: m.metadata,
      questId: m.questId,
      lastAccessedAt: m.lastAccessedAt ?? new Date(),
      isArchived: m.isArchived ?? false,
    }));

    const createdMementos = await Promise.all(
      processedMementos.map(async mementoData => {
        return await Memento.create(mementoData);
      })
    );

    const finalMementos = await Memento.findByUserId(req.user.id);
    const finalHotSize = calculateHotMementoSize(finalMementos);
    const finalUsagePercent = finalHotSize / maxTotalChars;

    req.logger.info('Batch mementos created successfully', {
      batchCount: createdMementos.length,
      finalHotSize,
      finalUsagePercent: (finalUsagePercent * 100).toFixed(1) + '%',
      totalHotMementos: finalMementos.filter(m => m.tier === 'hot').length,
    });

    // Schedule background grooming if needed (non-blocking)
    if (finalUsagePercent > 0.75) {
      groomingService
        .checkAndScheduleGrooming(req.user.id)
        .catch(err => req.logger.error('Background batch grooming failed', err));
    }

    return res.status(201).json(createdMementos);
  } catch (error) {
    req.logger.error('Error creating mementos:', error);
    return res.status(500).json({ error: 'Failed to create mementos' });
  }
});

export default handler;
