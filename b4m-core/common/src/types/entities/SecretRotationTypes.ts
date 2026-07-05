import { IMongoDocument } from './common';
import { IBaseRepository } from '.';

export interface ISecretRotation {
  id: string;
  keyName: string;
  previousKey?: string;
  rotatedAt: Date;
  nextRotation: Date;
  rotationIntervalDays: number;
  lastRotatedById?: string;
  lastRotatedByName?: string;
  description?: string;
  isActive: boolean;
}

export interface ISecretRotationDocument extends ISecretRotation, IMongoDocument {}

export interface ISecretRotationRepository extends IBaseRepository<ISecretRotationDocument> {
  findByKeyName(keyName: string): Promise<ISecretRotationDocument | null>;
  findActiveKeys(): Promise<ISecretRotationDocument[]>;
  rotateKey(keyName: string, previousKey: string, rotatedBy: string): Promise<ISecretRotationDocument | null>;
}
