import { AUDIT_SUMMARY_WINDOWS, type AuditSummaryWindow } from '@bike4mind/common';
import { toNumber } from '../adminSearchValues';

/**
 * The Audit Log summary window's `/admin` search param. Pure and React-free: adminTabParams.ts reads
 * it. The filter keys and entry id are owned by useAuditLogSearchParams.ts.
 */

export const AUDIT_SUMMARY_WINDOW_PARAM = 'auditWindow';
export const DEFAULT_AUDIT_SUMMARY_WINDOW: AuditSummaryWindow = 30;

// TanStack's JSON search parser hands `?auditWindow=7` back as a number; validateSearch turns it into '7'.
export const readAuditSummaryWindow = (value: unknown): AuditSummaryWindow => {
  const days = toNumber(value);
  return AUDIT_SUMMARY_WINDOWS.find(window => window === days) ?? DEFAULT_AUDIT_SUMMARY_WINDOW;
};

export const auditSummaryWindowSearchValue = (windowDays: AuditSummaryWindow): AuditSummaryWindow | undefined =>
  windowDays === DEFAULT_AUDIT_SUMMARY_WINDOW ? undefined : windowDays;
