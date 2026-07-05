import { IBaseRepository } from './BaseTypes';
import { IMongoDocument } from './common';

export enum RegInviteStatusType {
  open = 'open',
  used = 'used',
  waiting = 'waiting',
}

export interface RegInviteUsageEntry {
  userId: string;
  usedAt: Date;
}

export type IRegistrationInvite = {
  status: RegInviteStatusType;
  code: string;
  userId: string; // sender id
  usedbyId?: undefined | string; // used by user id
  expiresAt?: undefined | Date; // if undefined, never expires
  used?: undefined | Date; // used date
  email?: undefined | string;
  title?: undefined | string;
  description?: undefined | string;
  unlimitedUse?: boolean; // allow reuse until expiration
  usageHistory?: RegInviteUsageEntry[]; // record of each usage event
  tags?: string[];
  startingCredits?: number;
  startingStorage?: number;
};

export interface IRegInviteDocument extends IRegistrationInvite, IMongoDocument {}

export interface IRegistrationInviteRepository extends IBaseRepository<IRegInviteDocument> {
  findByCode: (code: string) => Promise<IRegistrationInvite | null>;
  createMany: (invites: Omit<IRegInviteDocument, 'id'>[]) => Promise<IRegInviteDocument[]>;
  deleteByIds: (ids: string[]) => Promise<void>;
  findAll: () => Promise<IRegInviteDocument[]>;
  formatRegInvites: (invites: Partial<IRegistrationInvite>, ids: string[]) => Promise<IRegInviteDocument[]>;
}
