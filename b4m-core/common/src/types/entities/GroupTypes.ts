import { IMongoDocument } from '.';

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
