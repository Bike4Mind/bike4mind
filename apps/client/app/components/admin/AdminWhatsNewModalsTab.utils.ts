import { IModalDocument } from '@bike4mind/common';
import type { AdminStatusTone } from '@client/app/utils/themes/admin';

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

/** The `StatusChip` tone for a priority status (DESIGN_GUIDE.md, Status tones). */
export function getStatusTone(status: ModalPriorityStatus): AdminStatusTone {
  switch (status) {
    case 'expired':
      return 'bad';
    case 'disabled':
      return 'neutral';
    case 'expiring-soon':
      return 'warn';
    case 'active':
      return 'good';
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
      return 'Expiring soon';
    case 'active':
      return 'Active';
    default: {
      // Exhaustive check - TypeScript will error if a case is missed
      const _exhaustiveCheck: never = status;
      return _exhaustiveCheck;
    }
  }
}

/**
 * Weekly highlights are posted to a Slack channel, so the card is limited to the main
 * environments: the source deployment's production, dev, and PR preview stages. Staging,
 * shared-dev and personal stages are excluded, as is a fork's production.
 */
export function shouldShowWeeklyHighlights(env: { stage: string; isForkProduction: boolean } | undefined): boolean {
  if (!env || env.isForkProduction) return false;
  return env.stage === 'production' || env.stage === 'dev' || env.stage.startsWith('pr');
}
