import { describe, expect, it } from 'vitest';
import { AdminSearchQuerySchema } from '@client/app/utils/adminEntitySearch';
import { classifyAdminQuery } from './classifyQuery';

describe('admin query classification', () => {
  it.each([
    ['support@example.com', 'email'],
    ['ABCDEF0123456789ABCDEF01', 'id'],
    ['b4m_live_abc', 'keyPrefix'],
    ['b4m_live_abcd', 'keyPrefix'],
    ['b4m_live_abcdef1', 'keyPrefix'],
    ['192.0.2.4', 'ip'],
    ['2001:db8::1', 'ip'],
    ['cus_abc123', 'stripe'],
    ['Example organization', 'name'],
    ['192.0.2.999', 'name'],
  ])('classifies %s as %s', (query, expected) => {
    expect(classifyAdminQuery(query)).toBe(expected);
  });
  it.each(['b4m_live_' + 'a'.repeat(32), 'b4m_live_ab', 'b4m_test_secret', '', 'x', 'x'.repeat(121)])(
    'rejects unsafe or invalid input %s',
    q => {
      expect(AdminSearchQuerySchema.safeParse({ q }).success).toBe(false);
    }
  );
});
