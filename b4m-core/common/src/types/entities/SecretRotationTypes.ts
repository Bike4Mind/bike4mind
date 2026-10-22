import { IMongoDocument } from './common';
import { IBaseRepository } from '.';

export interface ISecretRotation {
  id: string;
  keyName: string;
  previousKey?: string;
  capturedKeyFingerprint?: string;
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
  /** `findByKeyName` with `previousKey` included; grace-window verifiers only. Read-only. */
  findByKeyNameWithSecret(keyName: string): Promise<ISecretRotationDocument | null>;
  /**
   * Drop a rotated-out secret whose grace window has expired, capturing the window's fingerprint
   * first. A no-op while the rotation is still inside `graceMs`.
   */
  expirePreviousKey(keyName: string, graceMs: number): Promise<void>;
  findActiveKeys(): Promise<ISecretRotationDocument[]>;
}
