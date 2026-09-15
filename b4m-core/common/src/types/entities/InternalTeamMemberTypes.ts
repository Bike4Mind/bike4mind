import { IBaseRepository } from './BaseTypes';
import { IMongoDocument } from './common';

export interface IInternalTeamMember {
  name: string;
  phone: string;
  email?: string;
  role?: string;
  department?: string;
  isActive?: boolean;
}

export interface IInternalTeamMemberDocument extends IInternalTeamMember, IMongoDocument {}

export interface IInternalTeamMemberRepository extends IBaseRepository<IInternalTeamMemberDocument> {
  findAllActive(): Promise<IInternalTeamMemberDocument[]>;
  findByPhone(phone: string): Promise<IInternalTeamMemberDocument | null>;
}
