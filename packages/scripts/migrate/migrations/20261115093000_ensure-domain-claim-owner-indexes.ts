import { OrgDomainClaim } from '@bike4mind/database';
import type { MigrationFile } from './index';

const migration: MigrationFile = {
  id: 20261115093000,
  name: 'ensure domain claim owner indexes',
  up: async () => {
    await OrgDomainClaim.collection.createIndex(
      { domain: 1, organizationId: 1 },
      {
        name: 'org_domain_claim_org_domain',
        unique: true,
        partialFilterExpression: { organizationId: { $exists: true } },
      }
    );
    await OrgDomainClaim.collection.createIndex(
      { spaceId: 1, domain: 1 },
      { name: 'org_domain_claim_space_domain', unique: true, partialFilterExpression: { spaceId: { $exists: true } } }
    );
  },
  down: async () => {},
};
export default migration;
