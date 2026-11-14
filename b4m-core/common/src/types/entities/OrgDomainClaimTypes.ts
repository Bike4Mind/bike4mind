import { IBaseRepository, IMongoDocument } from '.';

export type OrgDomainClaimStatus = 'pending' | 'verified';

/** What a verified claim does for a verified-email user on the domain. */
export type OrgDomainJoinPolicy = 'off' | 'suggest' | 'auto-join';

/**
 * An organization's claim on an email domain. A claim is `pending` until the org proves DNS control
 * with a TXT record carrying `verificationToken`; at most one org holds a verified claim per domain
 * (enforced by a partial unique index in `OrgDomainClaimModel`).
 */
export interface IOrgDomainClaim {
  organizationId: string;
  /** Normalized lowercase bare domain. */
  domain: string;
  status: OrgDomainClaimStatus;
  /** Secret per-claim token; only org administrators may see it. */
  verificationToken: string;
  verifiedAt: Date | null;
  policy: OrgDomainJoinPolicy;
  createdBy: string | null;
  createdAt: Date;
}

export interface IOrgDomainClaimDocument extends IOrgDomainClaim, IMongoDocument {}

/**
 * A claim as the org-admin domain routes return it. A pending claim carries the TXT record to publish
 * (its value embeds the token); a verified claim carries neither.
 */
export interface IOrgDomainClaimView {
  id: string;
  domain: string;
  status: OrgDomainClaimStatus;
  verifiedAt: Date | string | null;
  policy: OrgDomainJoinPolicy;
  createdAt: Date | string;
  recordName: string | null;
  recordValue: string | null;
}

/** An org an existing user may join through their verified email's domain (GET /api/organizations/domain-suggestions). */
export interface OrgDomainJoinSuggestion {
  organizationId: string;
  organizationName: string;
  claimId: string;
}

export type MarkOrgDomainClaimVerifiedResult = IOrgDomainClaimDocument | 'conflict' | null;

export interface IOrgDomainClaimRepository extends IBaseRepository<IOrgDomainClaimDocument> {
  listByOrganization: (organizationId: string) => Promise<IOrgDomainClaimDocument[]>;
  countByOrganization: (organizationId: string) => Promise<number>;
  findByIdForOrg: (id: string, organizationId: string) => Promise<IOrgDomainClaimDocument | null>;
  findVerifiedByDomain: (domain: string) => Promise<IOrgDomainClaimDocument | null>;
  /** The verified claim for `domain` whose policy is not `off`, if any. */
  findVerifiedJoinableByDomain: (domain: string) => Promise<IOrgDomainClaimDocument | null>;
  /** `'conflict'` when another org already holds the verified claim; `null` when the claim is gone. */
  markVerified: (id: string, organizationId: string) => Promise<MarkOrgDomainClaimVerifiedResult>;
  updatePolicy: (
    id: string,
    organizationId: string,
    update: { policy: OrgDomainJoinPolicy }
  ) => Promise<IOrgDomainClaimDocument | null>;
  deleteForOrg: (id: string, organizationId: string) => Promise<boolean>;
  deleteByOrganization: (organizationId: string) => Promise<number>;
}
