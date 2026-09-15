import { rapidReplyMappingRepository } from '@bike4mind/database/ai';
import { rapidReplyAuditLogRepository } from '@bike4mind/database/ai';
import { baseApi } from '@server/middlewares/baseApi';
import { BadRequestError, ForbiddenError } from '@server/utils/errors';

interface BulkOperation {
  id: string;
  action: 'update' | 'delete' | 'enable' | 'disable';
  data?: any;
}

const handler = baseApi().post(async (req, res) => {
  if (!req.user?.isAdmin) {
    throw new ForbiddenError('Unauthorized. Admin access required.');
  }

  const { operations } = req.body as { operations: BulkOperation[] };

  if (!Array.isArray(operations) || operations.length === 0) {
    throw new BadRequestError('Operations array is required and cannot be empty');
  }

  const results = [];
  const auditLogs = [];

  for (const operation of operations) {
    const { id, action, data } = operation as BulkOperation;

    if (!id || !action) {
      results.push({
        id,
        success: false,
        error: 'ID and action are required',
      });
      continue;
    }

    try {
      let result;
      const auditChanges: any = {};

      switch (action) {
        case 'update': {
          if (!data) {
            throw new BadRequestError('Data is required for update operations');
          }

          // Get current state for audit
          const currentMapping = await rapidReplyMappingRepository.findById(id);
          if (currentMapping) {
            Object.keys(data).forEach(key => {
              if (data[key] !== (currentMapping as any)[key]) {
                auditChanges[key] = {
                  before: (currentMapping as any)[key],
                  after: data[key],
                };
              }
            });
          }

          result = await rapidReplyMappingRepository.updateMapping(id, data);
          break;
        }

        case 'delete': {
          const mappingToDelete = await rapidReplyMappingRepository.findById(id);
          if (mappingToDelete) {
            auditChanges.mapping = { before: mappingToDelete };
          }

          const deleted = await rapidReplyMappingRepository.deleteMapping(id);
          result = { id, deleted };
          break;
        }

        case 'enable': {
          const currentEnabledMapping = await rapidReplyMappingRepository.findById(id);
          if (currentEnabledMapping && !currentEnabledMapping.enabled) {
            auditChanges.enabled = { before: false, after: true };
          }

          result = await rapidReplyMappingRepository.updateMapping(id, { enabled: true });
          break;
        }

        case 'disable': {
          const currentDisabledMapping = await rapidReplyMappingRepository.findById(id);
          if (currentDisabledMapping && currentDisabledMapping.enabled) {
            auditChanges.enabled = { before: true, after: false };
          }

          result = await rapidReplyMappingRepository.updateMapping(id, { enabled: false });
          break;
        }

        default:
          throw new BadRequestError(`Unknown action: ${action}`);
      }

      results.push({
        id,
        action,
        success: true,
        result,
      });

      // Add to audit log if there were changes
      if (Object.keys(auditChanges).length > 0) {
        auditLogs.push({
          entityType: 'mapping' as const,
          entityId: id,
          action: (action === 'enable' || action === 'disable' ? 'update' : action) as 'create' | 'update' | 'delete',
          changes: auditChanges,
          userId: req.user!.id,
          userEmail: req.user!.email || undefined,
          ipAddress: req.ip,
          userAgent: req.headers['user-agent'],
          metadata: {
            bulkOperation: true,
            totalOperations: operations.length,
          },
        });
      }
    } catch (operationError) {
      console.error(`Error processing bulk operation ${action} for ${id}:`, operationError);
      results.push({
        id,
        action,
        success: false,
        error: operationError instanceof Error ? operationError.message : 'Unknown error',
      });
    }
  }

  if (auditLogs.length > 0) {
    try {
      for (const log of auditLogs) {
        await rapidReplyAuditLogRepository.createLog(log);
      }
    } catch (auditError) {
      console.error('Error creating audit logs for bulk operation:', auditError);
    }
  }

  const successCount = results.filter(r => r.success).length;
  const failureCount = results.length - successCount;

  return res.json({
    success: true,
    summary: {
      total: results.length,
      successful: successCount,
      failed: failureCount,
    },
    results,
  });
});

export const config = {
  api: {
    externalResolver: true,
  },
};

export default handler;
