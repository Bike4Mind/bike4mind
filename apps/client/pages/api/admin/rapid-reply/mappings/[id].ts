import { rapidReplyMappingRepository } from '@bike4mind/database/ai';
import { rapidReplyAuditLogRepository } from '@bike4mind/database/ai';
import { baseApi } from '@server/middlewares/baseApi';
import { BadRequestError, NotFoundError, ForbiddenError } from '@server/utils/errors';

const handler = baseApi()
  .get(async (req, res) => {
    if (!req.user?.isAdmin) {
      throw new ForbiddenError('Unauthorized. Admin access required.');
    }

    const { id } = req.query as { id: string };

    if (!id || typeof id !== 'string') {
      throw new BadRequestError('Mapping ID is required');
    }

    const mapping = await rapidReplyMappingRepository.findById(id);

    if (!mapping) {
      throw new NotFoundError('Rapid reply mapping not found');
    }

    return res.json(mapping);
  })
  .put(async (req, res) => {
    if (!req.user?.isAdmin) {
      throw new ForbiddenError('Unauthorized. Admin access required.');
    }

    const { id } = req.query as { id: string };

    if (!id || typeof id !== 'string') {
      throw new BadRequestError('Mapping ID is required');
    }

    const { mainModelId, rapidModelId, enabled, priority, systemPrompt, maxTokens, responseStyle, maxLatency } =
      req.body as {
        mainModelId?: string;
        rapidModelId?: string;
        enabled?: boolean;
        priority?: number;
        systemPrompt?: string;
        maxTokens?: number;
        responseStyle?: 'auto' | 'creative' | 'balanced' | 'precise';
        maxLatency?: number;
      };

    // Get current mapping for audit log
    const currentMapping = await rapidReplyMappingRepository.findById(id);
    if (!currentMapping) {
      throw new NotFoundError('Rapid reply mapping not found');
    }

    // Check if mainModelId change conflicts with existing mapping
    if (mainModelId && mainModelId !== currentMapping.mainModelId) {
      const existingMapping = await rapidReplyMappingRepository.findByMainModel(mainModelId);
      if (existingMapping && existingMapping.id !== id) {
        throw new BadRequestError('A mapping already exists for this main model');
      }
    }

    const updateData: any = {};
    const changes: any = {};

    // Track changes for audit log
    if (mainModelId !== undefined && mainModelId !== currentMapping.mainModelId) {
      updateData.mainModelId = mainModelId;
      changes.mainModelId = { before: currentMapping.mainModelId, after: mainModelId };
    }
    if (rapidModelId !== undefined && rapidModelId !== currentMapping.rapidModelId) {
      updateData.rapidModelId = rapidModelId;
      changes.rapidModelId = { before: currentMapping.rapidModelId, after: rapidModelId };
    }
    if (enabled !== undefined && enabled !== currentMapping.enabled) {
      updateData.enabled = enabled;
      changes.enabled = { before: currentMapping.enabled, after: enabled };
    }
    if (priority !== undefined && priority !== currentMapping.priority) {
      updateData.priority = priority;
      changes.priority = { before: currentMapping.priority, after: priority };
    }
    if (systemPrompt !== undefined && systemPrompt !== currentMapping.systemPrompt) {
      updateData.systemPrompt = systemPrompt;
      changes.systemPrompt = { before: currentMapping.systemPrompt, after: systemPrompt };
    }
    if (maxTokens !== undefined && maxTokens !== currentMapping.maxTokens) {
      updateData.maxTokens = maxTokens;
      changes.maxTokens = { before: currentMapping.maxTokens, after: maxTokens };
    }
    if (responseStyle !== undefined && responseStyle !== currentMapping.responseStyle) {
      updateData.responseStyle = responseStyle;
      changes.responseStyle = { before: currentMapping.responseStyle, after: responseStyle };
    }
    if (maxLatency !== undefined && maxLatency !== currentMapping.maxLatency) {
      updateData.maxLatency = maxLatency;
      changes.maxLatency = { before: currentMapping.maxLatency, after: maxLatency };
    }

    const updatedMapping = await rapidReplyMappingRepository.updateMapping(id, updateData);

    if (!updatedMapping) {
      throw new NotFoundError('Rapid reply mapping not found');
    }

    // Create audit log if there were changes
    if (Object.keys(changes).length > 0) {
      await rapidReplyAuditLogRepository.createLog({
        entityType: 'mapping',
        entityId: id,
        action: 'update',
        changes,
        userId: req.user!.id,
        userEmail: req.user!.email || undefined,
        ipAddress: req.ip,
        userAgent: req.headers['user-agent'],
      });
    }

    return res.json(updatedMapping);
  })
  .delete(async (req, res) => {
    if (!req.user?.isAdmin) {
      throw new ForbiddenError('Unauthorized. Admin access required.');
    }

    const { id } = req.query as { id: string };

    if (!id || typeof id !== 'string') {
      throw new BadRequestError('Mapping ID is required');
    }

    // Get current mapping for audit log
    const currentMapping = await rapidReplyMappingRepository.findById(id);
    if (!currentMapping) {
      throw new NotFoundError('Rapid reply mapping not found');
    }

    const deleted = await rapidReplyMappingRepository.deleteMapping(id);

    if (!deleted) {
      throw new NotFoundError('Rapid reply mapping not found');
    }

    await rapidReplyAuditLogRepository.createLog({
      entityType: 'mapping',
      entityId: id,
      action: 'delete',
      changes: {
        mapping: { before: currentMapping },
      },
      userId: req.user!.id,
      userEmail: req.user!.email || undefined,
      ipAddress: req.ip,
      userAgent: req.headers['user-agent'],
    });

    return res.json({ success: true, message: 'Rapid reply mapping deleted successfully' });
  });

export const config = {
  api: {
    externalResolver: true,
  },
};

export default handler;
