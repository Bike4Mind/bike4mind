import { IModalDocument } from '@bike4mind/common';

/**
 * True if a modal is archived: disabled, or its endDate has passed.
 */
export function isModalArchived(modal: IModalDocument): boolean {
  if (!modal.enabled) {
    return true;
  }

  // Date comparison: 'now' is browser-local, endDate is treated as UTC (ISO from server).
  if (modal.endDate) {
    const now = new Date();
    const endDate = new Date(modal.endDate);
    if (endDate < now) {
      return true;
    }
  }

  return false;
}

/**
 * Split modals into active and archived arrays (see isModalArchived).
 */
export function partitionModals(modals: IModalDocument[]): {
  active: IModalDocument[];
  archived: IModalDocument[];
} {
  const active: IModalDocument[] = [];
  const archived: IModalDocument[] = [];

  for (const modal of modals) {
    if (isModalArchived(modal)) {
      archived.push(modal);
    } else {
      active.push(modal);
    }
  }

  return { active, archived };
}

/**
 * Priority status type for modal display
 */
export type ModalPriorityStatus = 'expired' | 'disabled' | 'expiring-soon' | 'active';

/**
 * Prioritized status. Priority order: Expired > Disabled > Expiring Soon > Active.
 */
export function getModalPriorityStatus(modal: IModalDocument): ModalPriorityStatus {
  // Expired takes highest priority. 'now' is browser-local; endDate treated as UTC.
  if (modal.endDate) {
    const now = new Date();
    const endDate = new Date(modal.endDate);
    const diffMs = endDate.getTime() - now.getTime();
    const daysRemaining = Math.ceil(diffMs / (1000 * 60 * 60 * 24));

    if (daysRemaining <= 0) {
      return 'expired';
    }

    // Expiring soon: within 7 days and still enabled.
    if (daysRemaining <= 7 && modal.enabled) {
      return 'expiring-soon';
    }
  }

  if (!modal.enabled) {
    return 'disabled';
  }

  return 'active';
}

/**
 * Get status chip color based on priority status
 */
export function getStatusChipColor(status: ModalPriorityStatus): 'danger' | 'warning' | 'success' | 'neutral' {
  switch (status) {
    case 'expired':
      return 'danger';
    case 'disabled':
      return 'neutral';
    case 'expiring-soon':
      return 'warning';
    case 'active':
      return 'success';
    default: {
      // Exhaustive check - TypeScript will error if a case is missed
      const _exhaustiveCheck: never = status;
      return _exhaustiveCheck;
    }
  }
}

/**
 * Get human-readable status label
 */
export function getStatusLabel(status: ModalPriorityStatus): string {
  switch (status) {
    case 'expired':
      return 'Expired';
    case 'disabled':
      return 'Disabled';
    case 'expiring-soon':
      return 'Expiring Soon';
    case 'active':
      return 'Active';
    default: {
      // Exhaustive check - TypeScript will error if a case is missed
      const _exhaustiveCheck: never = status;
      return _exhaustiveCheck;
    }
  }
}
