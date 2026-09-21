import type { ISecretRotationDocument } from '@bike4mind/common';

/** A rotation record minus its secret. What the admin API is allowed to return. */
export interface SafeSecretRotation {
  id: string;
  keyName: string;
  rotatedAt: Date;
  nextRotation: Date;
  rotationIntervalDays: number;
  lastRotatedById?: string;
  lastRotatedByName?: string;
  description?: string;
  isActive: boolean;
}

/**
 * Allowlist, not a delete: `previousKey` holds a live signing secret during the grace
 * window, so every response naming these records is built field-by-field. A secret-ish
 * field added to the schema later is therefore absent from responses until someone adds
 * it here on purpose. The model's `select: false` is the first layer; this is the second.
 */
export function toSafeSecretRotation(secret: ISecretRotationDocument): SafeSecretRotation {
  return {
    id: secret.id,
    keyName: secret.keyName,
    rotatedAt: secret.rotatedAt,
    nextRotation: secret.nextRotation,
    rotationIntervalDays: secret.rotationIntervalDays,
    lastRotatedById: secret.lastRotatedById,
    lastRotatedByName: secret.lastRotatedByName,
    description: secret.description,
    isActive: secret.isActive,
  };
}

export function calculateNextRotationDate(days: number): Date {
  const date = new Date();
  date.setDate(date.getDate() + days);
  return date;
}
