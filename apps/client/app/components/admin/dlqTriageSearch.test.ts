import { describe, expect, it } from 'vitest';
import { adminSearchForTab, parseAdminSearch } from './adminTabParams';

describe('DLQ triage console links', () => {
  it('preserves queue and message through validation and tab synchronization', () => {
    const search = { tab: 'dlq-replay', dlqQueue: 'fixture', dlqMessage: 'message-1' };
    expect(parseAdminSearch(search)).toMatchObject(search);
    expect(adminSearchForTab(search, 'dlq-replay')).toMatchObject(search);
    expect(adminSearchForTab(search, 'users')).toMatchObject({ dlqQueue: undefined, dlqMessage: undefined });
  });
});
