import { describe, it, expect } from 'vitest';
import { DATA_LAKES } from '@bike4mind/common';
import { isBuiltInLake, lakeVisibilityLabel, lakeVisibilityLabelShort } from './lakeVisibility';

/** A real registry id, so the test cannot drift from the registry it is asserting about. */
const builtInId = DATA_LAKES[0]?.id;

describe('lakeVisibilityLabel', () => {
  it('labels a personal lake Private', () => {
    expect(lakeVisibilityLabel({ id: 'own-lake' })).toBe('Private');
  });

  it('labels an org lake Organization, abbreviated in the compact form', () => {
    expect(lakeVisibilityLabel({ id: 'x', organizationId: 'org1' })).toBe('Organization');
    expect(lakeVisibilityLabelShort({ id: 'x', organizationId: 'org1' })).toBe('Org');
  });

  it('lets public win over org', () => {
    expect(lakeVisibilityLabel({ id: 'x', organizationId: 'org1', isPublic: true })).toBe('Public');
  });

  it('labels a static registry lake Built-in, not Private', () => {
    // The registry lake has no owner, no org and is not a public opt-in, so every other arm would
    // call it "Private" - which is wrong: nobody owns it and it is not the viewer's own lake.
    expect(builtInId).toBeTruthy();
    expect(lakeVisibilityLabel({ id: builtInId })).toBe('Built-in');
    expect(lakeVisibilityLabelShort({ id: builtInId })).toBe('Built-in');
  });

  it('does NOT mistake a stranger private lake for a built-in one', () => {
    // Same field shape as a registry lake (no org, not public) - the distinction is registry
    // membership, which is why the label cannot be inferred from isOwn/organizationId alone.
    expect(isBuiltInLake({ id: 'someone-elses-private-lake' })).toBe(false);
    expect(lakeVisibilityLabel({ id: 'someone-elses-private-lake' })).toBe('Private');
  });

  it('treats a missing id as not built-in rather than throwing', () => {
    expect(isBuiltInLake({})).toBe(false);
    expect(lakeVisibilityLabel({})).toBe('Private');
  });
});
