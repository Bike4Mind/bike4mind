import { describe, it, expect } from 'vitest';
import { pickOwnerOrganizationId } from './resolveOwnerOrganization';

const lake = (id: string, organizationId: string | undefined, createdAt: string) => ({
  id,
  organizationId,
  createdAt: new Date(createdAt),
});

describe('pickOwnerOrganizationId', () => {
  it('leaves a file with no org-owned lake personal', () => {
    expect(pickOwnerOrganizationId([])).toBeUndefined();
    expect(pickOwnerOrganizationId([lake('l1', undefined, '2026-01-01')])).toBeUndefined();
  });

  it('gives a file in a personal lake and an org lake to the org', () => {
    expect(pickOwnerOrganizationId([lake('l1', undefined, '2025-01-01'), lake('l2', 'org-b', '2026-01-01')])).toBe(
      'org-b'
    );
  });

  it('prefers the org of the lake that ingested the file', () => {
    const lakes = [lake('old', 'org-a', '2025-01-01'), lake('src', 'org-b', '2026-01-01')];
    expect(pickOwnerOrganizationId(lakes, 'src')).toBe('org-b');
  });

  it('falls back to the oldest org lake when sourceLakeId is absent or not an org lake', () => {
    const lakes = [
      lake('new', 'org-b', '2026-01-01'),
      lake('old', 'org-a', '2025-01-01'),
      lake('mine', undefined, '2024-01-01'),
    ];
    expect(pickOwnerOrganizationId(lakes)).toBe('org-a');
    expect(pickOwnerOrganizationId(lakes, 'mine')).toBe('org-a');
  });

  it('breaks a createdAt tie by lake id, independent of input order', () => {
    const a = lake('lake-a', 'org-a', '2026-01-01');
    const b = lake('lake-b', 'org-b', '2026-01-01');
    expect(pickOwnerOrganizationId([b, a])).toBe('org-a');
    expect(pickOwnerOrganizationId([a, b])).toBe('org-a');
  });
});
