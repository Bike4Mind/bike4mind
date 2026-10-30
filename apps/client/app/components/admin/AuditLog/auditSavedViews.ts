import type { AuditLogFilters } from '@bike4mind/common';
import { matchSavedView } from '../shared/matchSavedView';

export type AuditSavedView = { key: string; label: string; filters: AuditLogFilters };

export const AUDIT_SAVED_VIEWS: ReadonlyArray<AuditSavedView> = [
  { key: 'all', label: 'All', filters: {} },
  { key: 'credits', label: 'Credit grants', filters: { category: 'credits' } },
  { key: 'access', label: 'Permission changes', filters: { category: 'access' } },
  { key: 'impersonation', label: 'Impersonation', filters: { action: 'user.impersonation.started' } },
  { key: 'deletions', label: 'Deletions', filters: { verb: 'deleted' } },
  { key: 'settings', label: 'Settings', filters: { category: 'settings' } },
];

export const DENIED_FILTERS: AuditLogFilters = { verb: 'denied' };

export const activeSavedViewKey = (filters: AuditLogFilters): string | null =>
  matchSavedView(AUDIT_SAVED_VIEWS, filters, view => view.filters)?.key ?? null;
