import { IMongoDocument } from '.';

export interface ICounter {
  type: string;
  value: number;
  threshold?: number;
  tags?: Array<string> | null;
  updatedAt?: Date;
}

export interface ICounters {
  counters: ICounter[] | null;
}

export interface ICountersDocument extends ICounters, IMongoDocument {}
