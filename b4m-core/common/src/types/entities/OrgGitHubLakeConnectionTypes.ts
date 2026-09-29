import { IBaseRepository } from './BaseTypes';
import { IMongoDocument } from './common';

/**
 * A single GitHub repository bound to a single org data lake through the read-only data-lake
 * GitHub App (contents:read + metadata:read, "Only select repositories").
 *
 * Deliberately separate from OrgGitHubConnection (internal issue/PR automation) and from the chat
 * MCP OAuth grant (read/write on every repo the user can reach): neither may feed a lake.
 *
 * A GitHub App has ONE installation per GitHub account, so several connections can share an
 * installationId (two lakes fed by two repos of the same org). The binding is therefore
 * (installationId, repositoryId); the installation itself is only removed with its last binding.
 */
export interface IOrgGitHubLakeConnection {
  organizationId: string;
  targetDataLakeId: string;
  /** GitHub App installation id (numeric on GitHub). Shared across connections from one account. */
  installationId: number;
  /** Login of the GitHub user/org account the App is installed on. */
  accountLogin: string;
  /** GitHub's immutable numeric repository id - survives renames and transfers, unlike the name. */
  repositoryId: number;
  /** `owner/name` at connect time; display only, may go stale after a rename. */
  repositoryFullName: string;
  /** The Bike4Mind user who completed the connection. */
  connectedBy: string;
  connectedAt: Date;
}

export interface IOrgGitHubLakeConnectionDocument extends IOrgGitHubLakeConnection, IMongoDocument {}

/** API response shape for the lake manager. */
export interface IOrgGitHubLakeConnectionResponse {
  id: string;
  accountLogin: string;
  repositoryId: number;
  repositoryFullName: string;
  connectedBy: string;
  connectedAt: Date;
}

export interface IOrgGitHubLakeConnectionRepository extends IBaseRepository<IOrgGitHubLakeConnectionDocument> {
  /**
   * The connection feeding a lake, deliberately GLOBAL (no org filter) so a teardown that runs after
   * the lake's org is unresolvable can still release it. SECURITY: server-side only; a route must
   * verify org access to the lake before trusting the result.
   */
  findByDataLakeIdAny(targetDataLakeId: string): Promise<IOrgGitHubLakeConnectionDocument | null>;

  /** Every connection bound through an installation, across orgs (the installation is account-wide). */
  findByInstallationId(installationId: number): Promise<IOrgGitHubLakeConnectionDocument[]>;

  /** Hard-deletes the row so the unique repositoryId / targetDataLakeId claims are freed. */
  release(id: string, organizationId: string): Promise<boolean>;
}
