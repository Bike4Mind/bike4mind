import { describe, expect, it } from 'vitest';
import { authorizeFleetUsageExport } from './fleetUsageExport';

const token = 'test-export-credential-with-at-least-32-characters';
const scope = { userIds: ['actor'], owners: [{ ownerId: 'billing-owner', ownerType: 'Organization' }] };
const configured = { FLEET_USAGE_EXPORT_TOKEN: token, FLEET_USAGE_EXPORT_SCOPE: JSON.stringify(scope) };

describe('Fleet export dedicated authorization', () => {
  it('accepts only the dedicated bearer with both configured scopes', () => {
    expect(authorizeFleetUsageExport(`Bearer ${token}`, configured)).toEqual({ status: 'authorized', scope });
  });

  it('refuses missing, wrong, cookie/JWT-like, and ordinary API-key credentials', () => {
    for (const header of [undefined, '', 'Bearer jwt', 'ApiKey ordinary-key', 'Bearer wrong']) {
      expect(authorizeFleetUsageExport(header, configured)).toEqual({ status: 'denied' });
    }
  });

  it('reports the route disabled for every unset, empty, malformed, or incomplete configuration', () => {
    for (const env of [
      {},
      { ...configured, FLEET_USAGE_EXPORT_TOKEN: '' },
      { ...configured, FLEET_USAGE_EXPORT_TOKEN: 'short' },
      { ...configured, FLEET_USAGE_EXPORT_SCOPE: '' },
      { ...configured, FLEET_USAGE_EXPORT_SCOPE: 'null' },
      { ...configured, FLEET_USAGE_EXPORT_SCOPE: '{}' },
      ...[
        { ...scope, userIds: [] },
        { ...scope, owners: [] },
        { ...scope, owners: [{ ownerId: '', ownerType: 'User' }] },
        { ...scope, owners: [{ ownerId: 'owner', ownerType: 'Other' }] },
      ].map(value => ({ ...configured, FLEET_USAGE_EXPORT_SCOPE: JSON.stringify(value) })),
    ]) {
      expect(authorizeFleetUsageExport(`Bearer ${token}`, env)).toEqual({ status: 'disabled' });
      expect(authorizeFleetUsageExport(undefined, env)).toEqual({ status: 'disabled' });
    }
  });
});
