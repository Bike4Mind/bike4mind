import { rapidReplyPromptRepository } from '@bike4mind/database/ai';
import { rapidReplyAuditLogRepository } from '@bike4mind/database/ai';
import { ApiKeyScope } from '@bike4mind/common';
import { baseApi } from '@server/middlewares/baseApi';
import { recordAdminActionFromRequest } from '@server/utils/adminAudit';
import { BadRequestError, NotFoundError, ForbiddenError } from '@bike4mind/server-utils/utils/errors';

const handler = baseApi({ requiredScopes: [ApiKeyScope.ADMIN] })
  .get(async (req, res) => {
    if (!req.user?.isAdmin) {
      throw new ForbiddenError('Unauthorized. Admin access required.');
    }

    const { id } = req.query as { id: string };

    if (!id || typeof id !== 'string') {
      throw new BadRequestError('Prompt ID is required');
    }

    const prompt = await rapidReplyPromptRepository.findById(id);

    if (!prompt) {
      throw new NotFoundError('Rapid reply prompt not found');
    }

    // If this is a versioned prompt, also fetch all versions
    const parentId = prompt.parentId || prompt.id;
    const versions = await rapidReplyPromptRepository.findVersions(parentId);

    return res.json({
      prompt,
      versions: versions.length > 1 ? versions : undefined,
    });
  })
  .put(async (req, res) => {
    if (!req.user?.isAdmin) {
      throw new ForbiddenError('Unauthorized. Admin access required.');
    }

    const { id } = req.query as { id: string };

    if (!id || typeof id !== 'string') {
      throw new BadRequestError('Prompt ID is required');
    }

    const { name, description, content, modelPairIds, domains, isActive, parameters, variables, createNewVersion } =
      req.body as {
        name?: string;
        description?: string;
        content?: string;
        modelPairIds?: string[];
        domains?: string[];
        isActive?: boolean;
        parameters?: any;
        variables?: any;
        createNewVersion?: boolean;
      };

    // Get current prompt for audit log
    const currentPrompt = await rapidReplyPromptRepository.findById(id);
    if (!currentPrompt) {
      throw new NotFoundError('Rapid reply prompt not found');
    }

    let updatedPrompt;
    let auditAction: 'create' | 'update' = 'update';
    let auditSummary = `updated rapid reply prompt ${currentPrompt.name}`;
    let auditChangedFields: string[] = [];
    const parentId = currentPrompt.parentId || currentPrompt.id;
    const renamed = name !== undefined && name !== currentPrompt.name;

    if (createNewVersion && (content !== currentPrompt.content || name !== currentPrompt.name)) {
      // Create a new version instead of updating
      updatedPrompt = await rapidReplyPromptRepository.createVersion(parentId, {
        name: name || currentPrompt.name,
        description: description || currentPrompt.description,
        content: content || currentPrompt.content,
        modelPairIds: modelPairIds || currentPrompt.modelPairIds,
        domains: domains || currentPrompt.domains,
        isActive: false, // New versions start inactive
        parameters: parameters || currentPrompt.parameters,
        variables: variables || currentPrompt.variables,
        createdBy: req.user!.id,
      });
      auditAction = 'create';
      auditSummary = `created new version of rapid reply prompt ${currentPrompt.name}`;
      auditChangedFields = ['version'];
    } else {
      // Regular update
      const updateData: any = {};
      const changes: any = {};

      // Track changes for audit log
      if (name !== undefined && name !== currentPrompt.name) {
        updateData.name = name;
        changes.name = { before: currentPrompt.name, after: name };
      }
      if (description !== undefined && description !== currentPrompt.description) {
        updateData.description = description;
        changes.description = { before: currentPrompt.description, after: description };
      }
      if (content !== undefined && content !== currentPrompt.content) {
        updateData.content = content;
        changes.content = { before: currentPrompt.content, after: content };
      }
      if (modelPairIds !== undefined && JSON.stringify(modelPairIds) !== JSON.stringify(currentPrompt.modelPairIds)) {
        updateData.modelPairIds = modelPairIds;
        changes.modelPairIds = { before: currentPrompt.modelPairIds, after: modelPairIds };
      }
      if (domains !== undefined && JSON.stringify(domains) !== JSON.stringify(currentPrompt.domains)) {
        updateData.domains = domains;
        changes.domains = { before: currentPrompt.domains, after: domains };
      }
      if (isActive !== undefined && isActive !== currentPrompt.isActive) {
        updateData.isActive = isActive;
        changes.isActive = { before: currentPrompt.isActive, after: isActive };
      }
      if (parameters !== undefined && JSON.stringify(parameters) !== JSON.stringify(currentPrompt.parameters)) {
        updateData.parameters = parameters;
        changes.parameters = { before: currentPrompt.parameters, after: parameters };
      }
      if (variables !== undefined && JSON.stringify(variables) !== JSON.stringify(currentPrompt.variables)) {
        updateData.variables = variables;
        changes.variables = { before: currentPrompt.variables, after: variables };
      }

      updatedPrompt = await rapidReplyPromptRepository.updatePrompt(id, updateData);

      if (!updatedPrompt) {
        throw new NotFoundError('Rapid reply prompt not found');
      }

      // Create audit log if there were changes
      if (Object.keys(changes).length > 0) {
        await rapidReplyAuditLogRepository.createLog({
          entityType: 'prompt',
          entityId: id,
          action: auditAction,
          changes,
          userId: req.user!.id,
          userEmail: req.user!.email || undefined,
          ipAddress: req.ip,
          userAgent: req.headers['user-agent'],
          metadata: createNewVersion ? { newVersion: true } : undefined,
        });
      }
      auditChangedFields = Object.keys(changes);
    }

    // A new version is its own row; the parent's id keeps the whole version chain under one target.
    if (auditAction === 'create' || auditChangedFields.length > 0) {
      await recordAdminActionFromRequest(req, {
        action: 'settings.rapid_reply_prompt.updated',
        target: { kind: 'settings', id: parentId, displayName: `Rapid reply prompt ${currentPrompt.name}` },
        summary: auditSummary,
        details: {
          promptId: id,
          changedFields: auditChangedFields,
          newVersion: auditAction === 'create',
          ...(auditAction === 'create' && { newVersionId: updatedPrompt?.id }),
          ...(renamed && { name: { before: currentPrompt.name, after: name } }),
        },
      });
    }

    return res.json(updatedPrompt);
  })
  .delete(async (req, res) => {
    if (!req.user?.isAdmin) {
      throw new ForbiddenError('Unauthorized. Admin access required.');
    }

    const { id } = req.query as { id: string };

    if (!id || typeof id !== 'string') {
      throw new BadRequestError('Prompt ID is required');
    }

    // Get current prompt for audit log
    const currentPrompt = await rapidReplyPromptRepository.findById(id);
    if (!currentPrompt) {
      throw new NotFoundError('Rapid reply prompt not found');
    }

    const deleted = await rapidReplyPromptRepository.deletePrompt(id);

    if (!deleted) {
      throw new NotFoundError('Rapid reply prompt not found');
    }

    await rapidReplyAuditLogRepository.createLog({
      entityType: 'prompt',
      entityId: id,
      action: 'delete',
      changes: {
        prompt: { before: currentPrompt },
      },
      userId: req.user!.id,
      userEmail: req.user!.email || undefined,
      ipAddress: req.ip,
      userAgent: req.headers['user-agent'],
    });

    await recordAdminActionFromRequest(req, {
      action: 'settings.rapid_reply_prompt.deleted',
      target: {
        kind: 'settings',
        id: currentPrompt.parentId || currentPrompt.id,
        displayName: `Rapid reply prompt ${currentPrompt.name}`,
      },
      summary: `deleted rapid reply prompt ${currentPrompt.name}`,
      details: { promptId: id, name: currentPrompt.name, wasActive: currentPrompt.isActive },
    });

    return res.json({ success: true, message: 'Rapid reply prompt deleted successfully' });
  });

export const config = {
  api: {
    externalResolver: true,
  },
};

export default handler;
