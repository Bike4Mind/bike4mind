import { IBaseRepository } from './BaseTypes';
import { IMongoDocument } from './common';

export enum InboxType {
  COMMON = 'common', // usual message send to user nothing special
  SHARE = 'share', // for sharing files, notebooks, etc. can indicate an accept button
}

export interface IInbox {
  userId: string; // sender of inbox message
  receiverId: string; // userId of inbox message receiver
  type: InboxType; // type of inbox
  title: string;
  message: string; // this should probably be a markdown string, wysiwyg
  readAt: Date | null;
  deletedAt: Date | null;
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
}
