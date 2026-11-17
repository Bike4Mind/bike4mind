import { describe, expect, it } from 'vitest';
import { AUDIT_SUMMARY_WINDOWS } from '@bike4mind/common';
import {
  DEFAULT_AUDIT_SUMMARY_WINDOW,
  auditSummaryWindowSearchValue,
  readAuditSummaryWindow,
} from './auditLogTabSearch';

describe('audit summary window search param', () => {
  it.each(AUDIT_SUMMARY_WINDOWS)('round-trips %s days', days => {
    expect(readAuditSummaryWindow(auditSummaryWindowSearchValue(days))).toBe(days);
  });

  it('reads the string form validateSearch produces', () => {
    expect(readAuditSummaryWindow('7')).toBe(7);
  });

  it.each([undefined, '', '14', 'abc', -7, '7.5', ['7']])('falls back to the default for %j', value => {
    expect(readAuditSummaryWindow(value)).toBe(DEFAULT_AUDIT_SUMMARY_WINDOW);
  });

  it('leaves the default out of the URL', () => {
    expect(auditSummaryWindowSearchValue(DEFAULT_AUDIT_SUMMARY_WINDOW)).toBeUndefined();
  });
});
