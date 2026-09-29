import { describe, it, expect } from 'vitest';
import { vetReaderConsentDatalakeTags } from './vetReaderConsentDatalakeTags';

describe('vetReaderConsentDatalakeTags', () => {
  it('passes the tags through when the acting user owns the session', () => {
    const session = { userId: 'owner-1', retrievalTags: ['datalake:lake1'] };

    expect(vetReaderConsentDatalakeTags(session, 'owner-1')).toEqual(['datalake:lake1']);
  });

  it('drops the tags when the acting user is not the session owner', () => {
    const session = { userId: 'owner-1', retrievalTags: ['datalake:lake1'] };

    expect(vetReaderConsentDatalakeTags(session, 'someone-else')).toBeUndefined();
  });

  it('is a no-op when the session carries no retrieval tags', () => {
    const session = { userId: 'owner-1' };

    expect(vetReaderConsentDatalakeTags(session, 'owner-1')).toBeUndefined();
  });
});
