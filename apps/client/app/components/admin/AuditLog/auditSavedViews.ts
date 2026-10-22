import type { AuditLogFilters } from '@bike4mind/common';

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

const sameFilters = (a: AuditLogFilters, b: AuditLogFilters): boolean => {
  const keys = new Set([...Object.keys(a), ...Object.keys(b)]) as Set<keyof AuditLogFilters>;
  return [...keys].every(key => a[key] === b[key]);
};

export const activeSavedViewKey = (filters: AuditLogFilters): string | null =>
  AUDIT_SAVED_VIEWS.find(view => sameFilters(view.filters, filters))?.key ?? null;
