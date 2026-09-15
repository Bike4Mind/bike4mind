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
  findAllByDocumentId: (documentId: string) => Promise<IInviteDocument[]>;
  findAllByPendingUserIdOrEmail: (
    userId: string,
    options?: { limit: number; page: number }
  ) => Promise<IInviteDocument[]>;
  countPendingByUserId: (userId: string) => Promise<number>;
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

  name?: string;
  username?: string;

  expiresAt: undefined | Date;
};

export interface IDocumentInvite extends IBaseInvite {
  type: InviteType;
  permissions: Permission[];
}

export type IInvite = IBaseInvite | IDocumentInvite;

export type IInviteDocument = IInvite & IMongoDocument;

export type IInviteDocumentWithDetails = IInviteDocument;
