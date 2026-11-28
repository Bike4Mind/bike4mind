/**
 * Shared by the infra key policy, the mint script, the unwrap probe and the aws-kms key provider.
 * Keep this a dependency-free leaf: infra imports it by relative path.
 */

/** KMS encryption context `purpose` the per-stage data key is wrapped under. */
export const SECRETS_AT_REST_PURPOSE = 'secrets-at-rest';

/** Name of the SST secret holding the wrapped per-stage data key (declared in infra/secrets.ts). */
export const WRAPPED_DATA_KEY_SECRET_NAME = 'SECRET_DATA_KEY_WRAPPED';

/** Preview stages are named `pr<N>`. */
export const isPreviewStageName = (stage: string) => /^pr\d+$/.test(stage);
