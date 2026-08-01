import { IMongoDocument } from '.';
import { IBaseRepository } from './BaseTypes';

export interface IGroup {
  name: string;
  description: string;

  /**
   * The GroupType key this instance is an instance of (see GROUP_TYPE_CATALOG). Required -
   * groups are provisioned as a side effect of granting a type to an org, never untyped.
   */
  type: string;

  // Which organization this group belongs to:
  organizationId: string;

  // TODO: Flags controlling visibility of the group, whether
  //   it's open to join, join requirements, any runtime filters
  //   (such as geo/IP), etc.
}

// While a Group is manageable by users, it will be in the context of
// the organization, and the Group documents don't extend from IShareableDocument.
export interface IGroupDocument extends IGroup, IMongoDocument {}

export interface IGroupRepository extends IBaseRepository<IGroupDocument> {
  /**
   * Group instances owned by an organization. Live-only by default; `includeDeleted` also returns
   * soft-deleted rows (org deletion must purge membership for every group the org EVER owned - a
   * stale id can still linger in `user.groups` from a lost prior revoke; org-groups #1230).
   */
  findByOrganization(organizationId: string, options?: { includeDeleted?: boolean }): Promise<IGroupDocument[]>;
  /**
   * Provision a group instance, treating a concurrent create for the same (organizationId, type)
   * as success rather than a 500 (org-groups #1222). Two overlapping grant PUTs can both pass the
   * caller's "does a live instance already exist" check and both call this; only one wins the
   * `group_org_type_live` unique index - the loser gets back the winner's document instead of an
   * E11000 propagating to a 500.
   */
  createIfMissing(data: Pick<IGroup, 'name' | 'description' | 'type' | 'organizationId'>): Promise<IGroupDocument>;
}
