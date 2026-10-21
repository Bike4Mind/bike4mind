/**
 * Tier 1 Secret Validators
 *
 * The implementation now lives in @bike4mind/infra so the deploy-time refusal in
 * infra/secrets.ts can share it: infra/*.ts is bundled into sst.config.ts and can
 * only resolve workspace packages linked at the repo root, which rules out the
 * apps/client tree. This module is kept as a re-export so existing server routes
 * keep their `@server/security/tier1SecretValidators` import path unchanged.
 */
export type { ValidationSeverity, ValidationStatus, Tier1ValidationResult } from '@bike4mind/infra';
export {
  JWT_SECRET_MIN_LENGTH,
  JWT_SECRET_WARN_LENGTH,
  SESSION_SECRET_MIN_LENGTH,
  SHARED_SECRET_MIN_LENGTH,
  validateEncryptionKey,
  validateMongoUri,
  validateSessionSecret,
  validateJwtSecret,
  validateSharedSecret,
} from '@bike4mind/infra';
