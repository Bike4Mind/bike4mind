import {
  dataLakeAccessGrantRepository,
  dataLakeOwnershipOfferRepository,
  dataLakeRepository,
  organizationRepository,
  userRepository,
} from '@bike4mind/database';
import { lakeConfigAuditDb } from './lakeConfigAuditDb';

/**
 * The `db` half of every lake ownership-offer service's adapters, in one place so the three routes
 * that drive offer/accept/cancel cannot drift - a route that wired the offer repo but not the audit
 * repos would still compile (they are optional on the adapter shape's base) while quietly recording
 * no config change for the transfer it applied.
 *
 * Spread it into a service's adapters, e.g.
 *   { db: lakeOwnershipOfferDb, logger: req.logger }
 *
 * Frozen: module-level shared state spread into every offer write path.
 */
export const lakeOwnershipOfferDb = Object.freeze({
  dataLakes: dataLakeRepository,
  dataLakeAccessGrants: dataLakeAccessGrantRepository,
  users: userRepository,
  organizations: organizationRepository,
  ownershipOffers: dataLakeOwnershipOfferRepository,
  ...lakeConfigAuditDb,
});
