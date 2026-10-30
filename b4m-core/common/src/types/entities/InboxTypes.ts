import { IBaseRepository } from './BaseTypes';
import { IMongoDocument } from './common';

export enum InboxType {
  COMMON = 'common', // usual message send to user nothing special
  SHARE = 'share', // for sharing files, notebooks, etc. can indicate an accept button
  LOOP = 'loop', // a loop needs its owner; written and resolved by the loop scheduler's notice sweep
}

export interface IInbox {
  userId: string; // sender of inbox message
  receiverId: string; // userId of inbox message receiver
  type: InboxType; // type of inbox
  title: string;
  message: string; // this should probably be a markdown string, wysiwyg
  readAt: Date | null;
  deletedAt: Date | null;
  /** Dedupe key of a system notice, unique among open notices; unset when the notice is resolved. Server-only. */
  sourceKey?: string;
  /** App-relative path the inbox offers to open. Server-only. */
  link?: string;
}

export interface IInboxDocument extends IInbox, IMongoDocument {}

export interface IInboxRepository extends IBaseRepository<IInboxDocument> {
  findByReceiverId(receiverId: string, options?: { sort?: Record<string, unknown> }): Promise<IInboxDocument[]>;
  markAsRead(ids: string[], receiverId?: string): Promise<void>;
  createInboxMessage(data: {
    userId: string;
    receiverId: string;
    title: string;
    message: string;
    type: InboxType;
  }): Promise<IInboxDocument>;
  deleteByReceiverId(receiverId: string, messageId: string): Promise<boolean>;
  /** Creates a keyed notice; returns false when an open notice with that `sourceKey` already exists. */
  upsertKeyedNotice(data: {
    userId: string;
    receiverId: string;
    title: string;
    message: string;
    type: InboxType;
    sourceKey: string;
    link?: string;
  }): Promise<boolean>;
  /** Open keyed notices whose `sourceKey` starts with `prefix`. */
  listOpenKeyed(prefix: string): Promise<{ id: string; sourceKey: string }[]>;
  /** Soft-deletes the notices and frees their `sourceKey` so the same key can recur. */
  resolveKeyed(ids: string[]): Promise<void>;
}
