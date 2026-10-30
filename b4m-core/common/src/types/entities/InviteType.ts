import { IBaseRepository, IMongoDocument, Permission } from '.';
import { PaginatedResponse } from '../common';

export interface IInviteModelAdapter {
  findAllByDocumentId: (documentId: string) => Promise<IInviteDocument[]>;
  update: (data: IInviteDocument) => Promise<unknown>;
  findAllByPendingUserId: (userId: string) => Promise<IInviteDocument[]>;
  searchInvites: (
    query: Record<string, unknown>,
    limit: number,
    page: number
  ) => Promise<PaginatedResponse<IInviteDocument>>;
}

export interface IInviteRepository extends IBaseRepository<IInviteDocument> {
  /** Resolve an invite by its bearer token. Null for an unknown token or a legacy, tokenless invite. */
  findByToken: (token: string) => Promise<IInviteDocument | null>;
  findAllByDocumentId: (documentId: string) => Promise<IInviteDocument[]>;
  findAllByPendingUserIdOrEmail: (
    userId: string,
    options?: { limit: number; page: number }
  ) => Promise<IInviteDocument[]>;
  countPendingByUserId: (userId: string) => Promise<number>;
  /**
   * Record `email` as accepted (leaving pending/refused) and spend one slot. Null when no slot is left,
   * the email (case-insensitive) already accepted, or a named invite (`isLinkOnly: false`) no longer has it pending.
   */
  acceptRecipient: (id: string, email: string) => Promise<IInviteDocument | null>;
  /** Move `email` (case-insensitive) from pending to refused and spend one slot; null when not pending. */
  refusePendingRecipient: (id: string, email: string) => Promise<IInviteDocument | null>;
  /** Drop `email` (case-insensitive) from pending, capping `remaining` at the pending left; null when not pending. */
  cancelPendingRecipient: (id: string, email: string) => Promise<IInviteDocument | null>;
  /** Spend every slot and clear pending, keeping accepted/refused. */
  closeInvite: (id: string) => Promise<IInviteDocument | null>;
  searchInvites: (
    query: Record<string, unknown>,
    limit: number,
    page: number
  ) => Promise<PaginatedResponse<IInviteDocument>>;
}

export enum InviteType {
  Group = 'Group',
  Session = 'Session',
  Tool = 'Tool',
  FabFile = 'FabFile',
  Organization = 'Organization',
  Project = 'Project',
}

export type IBaseInvite = {
  id: string;
  // Which group/session/etc. to invite to:
  type: InviteType;
  documentId: string;
  description?: string;

  // emails of recipients (if any).  If recipients.pending is defined, it's an email
  // invite and the acceptor(s) must be given.  Otherwise, may be accepted by anyone.
  // Recipients may not be defined as it's not included in database results by default.
  recipients?: {
    pending?: string[];
    accepted: string[];
    refused: string[];
  };

  // How many times this invite has been accepted so far:
  accepted: number;
  // How remaining times this invite can be used:
  remaining: number;

  // True when the invite names nobody BY DESIGN - a share link anyone holding the id may redeem.
  // An empty `recipients.pending` cannot stand in for this: Project and Organization invites carry
  // raw user ids, so a named invite whose recipients failed to resolve looks identical to a link
  // invite. Absent on invites created before this field existed; see inviteManager.canViewInvite
  // for how those are inferred.
  isLinkOnly?: boolean;

  name?: string;
  username?: string;
  // Who minted the invite. Absent on invites created before this field existed.
  inviterId?: string;
  // The `recipients` entries (lowercased) the inviter typed as an email address. Every other entry
  // was resolved server-side from a user id or username, so its address is something the inviter
  // never supplied and must not be shown back to them (see inviteManager.toSharerInviteViews).
  // Absent on invites created before this field existed, which therefore cannot be told apart.
  typedRecipients?: string[];

  // The bearer secret a share link actually carries, and the ONLY key redemption accepts for an
  // invite that has one. The `_id` was the bearer secret before this field existed, which made a
  // link guessable: an ObjectId is only partially random (timestamp + per-process counter) and is
  // disclosed by every surface that lists invites. Absent on invites minted before the cutover -
  // `resolveRedeemableInvite` keys the legacy `_id` door on exactly that absence, so the old door
  // closes for every new invite without a clock constant to maintain.
  token?: string;

  expiresAt: undefined | Date;
};

export interface IDocumentInvite extends IBaseInvite {
  type: InviteType;
  permissions: Permission[];
}

export type IInvite = IBaseInvite | IDocumentInvite;

export type IInviteDocument = IInvite & IMongoDocument;

export type IInviteDocumentWithDetails = IInviteDocument;
