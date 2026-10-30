import { recordAdminActionFromRequest } from '@server/utils/adminAudit';
import type { ModalChange } from './modalOperations';

type ModalAuditAction = 'settings.modal.created' | 'settings.modal.updated' | 'settings.modal.deleted';

const MODAL_ACTIONS: Record<ModalChange['kind'], ModalAuditAction> = {
  created: 'settings.modal.created',
  updated: 'settings.modal.updated',
  deleted: 'settings.modal.deleted',
};

type ModalAuditRequest = Parameters<typeof recordAdminActionFromRequest>[0];

export const recordModalChanges = async (
  req: ModalAuditRequest,
  changes: ModalChange[],
  via: string
): Promise<void> => {
  for (const change of changes) {
    await recordAdminActionFromRequest(req, {
      action: MODAL_ACTIONS[change.kind],
      target: { kind: 'settings', id: change.id, displayName: change.title },
      summary: `${change.kind} modal ${change.title}`,
      details: { via, ...(change.fields !== undefined ? { fields: change.fields } : {}) },
    });
  }
};
