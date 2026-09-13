/**
 * Tier 1 secret validation.
 *
 * Single source of truth for "is this security-critical secret actually configured",
 * consumed by three surfaces:
 * - deploy-time refusal in infra/secrets.ts
 * - the System Secrets admin page (pages/api/admin/system-secrets/tier1-status.ts)
 * - the System Health admin page (pages/api/admin/system-health.ts)
 *
 * It lives here rather than in apps/client because infra/*.ts is bundled into
 * sst.config.ts and can only resolve workspace packages linked at the repo root -
 * @bike4mind/infra is, @bike4mind/common is not. The placeholder literals below are
 * therefore a second declaration of the ones in @bike4mind/common; a test in
 * apps/client pins the two together.
 *
 * Length/format rules follow industry guidance:
 * - JWT_SECRET: 64+ chars for optimal HS256 security (256+ bits entropy)
 * - SESSION_SECRET: 32+ chars (express-session recommendation)
 * - SECRET_ENCRYPTION_KEY: exactly 64 hex chars (AES-256 requirement)
 * - MONGODB_URI: valid scheme, no localhost in production
 */

/** Placeholder SST substitutes for a secret that was never `sst secret set`. */
export const SST_PLACEHOLDER_VALUE = 'my-secret-placeholder-value';

/** Placeholder for optional secrets whose consumers degrade gracefully. */
export const NOT_CONFIGURED_PLACEHOLDER = 'not-configured';

export type ValidationSeverity = 'error' | 'warning' | 'info';

export type ValidationStatus = 'configured' | 'placeholder' | 'invalid' | 'missing' | 'warning' | 'insecure';

export interface Tier1ValidationResult {
  isValid: boolean;
  status: ValidationStatus;
  severity: ValidationSeverity;
  message?: string;
}

/**
 * Minimum required length for JWT_SECRET.
 * HS256 needs 256+ bits of entropy; 64 base64 chars provides ~384 bits.
 */
export const JWT_SECRET_MIN_LENGTH = 64;

/** Below this, JWT_SECRET is rejected outright; between the two it warns. */
export const JWT_SECRET_WARN_LENGTH = 32;

/** Express-session recommends at least 32 bytes of entropy. */
export const SESSION_SECRET_MIN_LENGTH = 32;

/** Floor for shared bearer/ingest tokens. Ours are minted with `openssl rand -hex 32`. */
export const SHARED_SECRET_MIN_LENGTH = 32;

/** Values that are never a real credential, however they got there. */
export const COMMON_PLACEHOLDERS = [
  SST_PLACEHOLDER_VALUE,
  NOT_CONFIGURED_PLACEHOLDER,
  'changeme',
  'change_me',
  'your_secret_here',
  'your-secret-key',
  'replace-me',
  'xxx',
  'todo',
  'fixme',
];

export function isCommonPlaceholder(value: string): boolean {
  const lower = value.trim().toLowerCase();
  return COMMON_PLACEHOLDERS.some(p => lower === p.toLowerCase());
}

/** Repeated single character, e.g. 'aaaaaaaa...'. */
function isLowEntropy(value: string): boolean {
  return /^(.)\1{15,}$/.test(value);
}

/**
 * Exactly 64 hex characters (32 bytes for AES-256). Same rule as
 * isValidEncryptionKey in @bike4mind/utils/security, restated here because that
 * package is not resolvable from the sst config bundle. The rule is fixed by the
 * cipher, so the two cannot meaningfully drift.
 */
function isEncryptionKeyFormat(value: string): boolean {
  return /^[a-f0-9]{64}$/i.test(value);
}

export function validateEncryptionKey(value: string | undefined): Tier1ValidationResult {
  if (!value) {
    return { isValid: false, status: 'missing', severity: 'error' };
  }
  if (isCommonPlaceholder(value)) {
    return { isValid: false, status: 'placeholder', severity: 'error' };
  }
  if (!isEncryptionKeyFormat(value)) {
    return {
      isValid: false,
      status: 'invalid',
      severity: 'error',
      message: 'Must be exactly 64 hexadecimal characters (32 bytes)',
    };
  }
  if (isLowEntropy(value)) {
    return {
      isValid: false,
      status: 'invalid',
      severity: 'error',
      message: 'Key appears to be low-entropy (repeated characters)',
    };
  }
  return { isValid: true, status: 'configured', severity: 'info' };
}

export function validateMongoUri(value: string | undefined, stage?: string): Tier1ValidationResult {
  if (!value) {
    return { isValid: false, status: 'missing', severity: 'error' };
  }
  if (isCommonPlaceholder(value)) {
    return { isValid: false, status: 'placeholder', severity: 'error' };
  }
  if (!value.startsWith('mongodb://') && !value.startsWith('mongodb+srv://')) {
    return {
      isValid: false,
      status: 'invalid',
      severity: 'error',
      message: 'Must start with mongodb:// or mongodb+srv://',
    };
  }
  const isProduction = stage === 'prod' || stage === 'production';
  const isLocalhost = value.includes('localhost') || value.includes('127.0.0.1');
  if (isProduction && isLocalhost) {
    return {
      isValid: false,
      status: 'invalid',
      severity: 'error',
      message: 'localhost MongoDB should not be used in production',
    };
  }
  return { isValid: true, status: 'configured', severity: 'info' };
}

export function validateSessionSecret(value: string | undefined): Tier1ValidationResult {
  if (!value) {
    return { isValid: false, status: 'missing', severity: 'error' };
  }
  if (isCommonPlaceholder(value)) {
    return { isValid: false, status: 'placeholder', severity: 'error' };
  }
  if (isLowEntropy(value)) {
    return {
      isValid: false,
      status: 'invalid',
      severity: 'error',
      message: 'Secret appears to be low-entropy (repeated characters)',
    };
  }
  if (value.length < SESSION_SECRET_MIN_LENGTH) {
    return {
      isValid: false,
      status: 'insecure',
      severity: 'error',
      message: `Only ${value.length} characters. Must be at least ${SESSION_SECRET_MIN_LENGTH} for security.`,
    };
  }
  return { isValid: true, status: 'configured', severity: 'info' };
}

export function validateJwtSecret(value: string | undefined): Tier1ValidationResult {
  if (!value) {
    return { isValid: false, status: 'missing', severity: 'error' };
  }
  if (isCommonPlaceholder(value)) {
    return { isValid: false, status: 'placeholder', severity: 'error' };
  }
  if (isLowEntropy(value)) {
    return {
      isValid: false,
      status: 'invalid',
      severity: 'error',
      message: 'Secret appears to be low-entropy (repeated characters)',
    };
  }
  if (value.length < JWT_SECRET_WARN_LENGTH) {
    return {
      isValid: false,
      status: 'insecure',
      severity: 'error',
      message: `Only ${value.length} characters. Must be at least ${JWT_SECRET_WARN_LENGTH} for security.`,
    };
  }
  if (value.length < JWT_SECRET_MIN_LENGTH) {
    return {
      isValid: true,
      status: 'warning',
      severity: 'warning',
      message: `Only ${value.length} characters. Recommend ${JWT_SECRET_MIN_LENGTH}+ for optimal security.`,
    };
  }
  return { isValid: true, status: 'configured', severity: 'info' };
}

/**
 * Shared bearer / ingest tokens. No structure to check beyond "not a reserved
 * literal and long enough to not be guessable" - these are opaque random strings.
 */
export function validateSharedSecret(value: string | undefined): Tier1ValidationResult {
  if (!value) {
    return { isValid: false, status: 'missing', severity: 'error' };
  }
  if (isCommonPlaceholder(value)) {
    return { isValid: false, status: 'placeholder', severity: 'error' };
  }
  if (isLowEntropy(value)) {
    return {
      isValid: false,
      status: 'invalid',
      severity: 'error',
      message: 'Token appears to be low-entropy (repeated characters)',
    };
  }
  if (value.length < SHARED_SECRET_MIN_LENGTH) {
    return {
      isValid: false,
      status: 'insecure',
      severity: 'error',
      message: `Only ${value.length} characters. Must be at least ${SHARED_SECRET_MIN_LENGTH} for security.`,
    };
  }
  return { isValid: true, status: 'configured', severity: 'info' };
}

/**
 * When an unconfigured value blocks a deploy.
 *
 * `always` - an unset value is a forgeable credential or a dead data plane on any
 * stage, so every stage refuses. `production` - an unset value only means the
 * integration is not wired, which is a legitimate state for a throwaway preview but
 * an anonymous control plane on a stage that serves real traffic.
 */
export type Tier1Enforcement = 'always' | 'production';

export interface Tier1SecretSpec {
  name: string;
  enforcement: Tier1Enforcement;
  validate: (value: string | undefined, stage?: string) => Tier1ValidationResult;
  /** `sst secret set` line an operator can paste. */
  hint: (stage: string) => string;
  /** One line on what an unconfigured value exposes, shown in the deploy refusal. */
  exposure: string;
}

const setHint = (name: string, generator: string) => (stage: string) =>
  `AWS_PROFILE=<your-profile> pnpm sst secret set ${name} ${generator} --stage ${stage}`;

const RANDOM_HEX = '"$(openssl rand -hex 32)"';
const RANDOM_BASE64 = '"$(openssl rand -base64 48)"';

const INGEST_TOKENS = [
  'SECOPS_ZAP_INGEST_TOKEN',
  'SECOPS_CODE_INGEST_TOKEN',
  'SECOPS_PACKAGES_INGEST_TOKEN',
  'SECOPS_SECRETS_INGEST_TOKEN',
  'SECOPS_PROWLER_INGEST_TOKEN',
  'SECOPS_ATTACK_SIMULATION_INGEST_TOKEN',
  'RATE_LIMIT_INGEST_TOKEN',
];

/**
 * Every secret whose unconfigured state is a security defect rather than a disabled
 * feature. Order is the order the admin page and the deploy refusal report them in.
 */
export const TIER1_SECRET_SPECS: readonly Tier1SecretSpec[] = [
  {
    name: 'MONGODB_URI',
    enforcement: 'always',
    validate: validateMongoUri,
    hint: setHint('MONGODB_URI', '"mongodb+srv://..."'),
    exposure: 'the stage has no database to read or write',
  },
  {
    name: 'SESSION_SECRET',
    enforcement: 'always',
    validate: validateSessionSecret,
    hint: setHint('SESSION_SECRET', RANDOM_BASE64),
    exposure: 'sessions are signed with a value published in this repository',
  },
  {
    name: 'JWT_SECRET',
    enforcement: 'always',
    validate: validateJwtSecret,
    hint: setHint('JWT_SECRET', RANDOM_BASE64),
    exposure: 'anyone can mint a token for any user, including an admin',
  },
  {
    name: 'SECRET_ENCRYPTION_KEY',
    enforcement: 'always',
    validate: validateEncryptionKey,
    hint: setHint('SECRET_ENCRYPTION_KEY', RANDOM_HEX),
    exposure: 'stored user secrets are encrypted under a key published in this repository',
  },
  {
    name: 'CHAT_COMPLETION_INTERNAL_SECRET',
    enforcement: 'always',
    validate: validateSharedSecret,
    hint: setHint('CHAT_COMPLETION_INTERNAL_SECRET', RANDOM_HEX),
    exposure: 'the internal quest-dispatch bearer is a value published in this repository',
  },
  ...INGEST_TOKENS.map(
    (name): Tier1SecretSpec => ({
      name,
      enforcement: 'production',
      validate: validateSharedSecret,
      hint: setHint(name, RANDOM_HEX),
      exposure: 'the ingest route it gates accepts unauthenticated writes',
    })
  ),
];

export interface Tier1SecretStatus extends Tier1ValidationResult {
  name: string;
  enforcement: Tier1Enforcement;
  /** Set for every result that is not `configured`. */
  hint?: string;
  exposure: string;
  /** True when this result must stop a deploy of this stage. */
  blocksDeploy: boolean;
}

export interface EvaluateTier1SecretsOptions {
  stage: string;
  /** Whether this stage serves real traffic (infra/constants.ts PRODUCTION_STAGES). */
  isProductionStage: boolean;
  /**
   * Resolve a secret to the value the stage will actually run with. Return
   * `undefined` for "never set for this stage", which resolves to the placeholder
   * default declared in infra/secrets.ts.
   */
  read: (name: string) => string | undefined;
}

/**
 * Status of every tier-1 secret for one stage. Never returns or logs a secret value.
 */
export function evaluateTier1Secrets(options: EvaluateTier1SecretsOptions): Tier1SecretStatus[] {
  const { stage, isProductionStage, read } = options;
  return TIER1_SECRET_SPECS.map(spec => {
    const value = read(spec.name);
    const result: Tier1ValidationResult =
      value === undefined
        ? {
            isValid: false,
            status: 'placeholder',
            severity: 'error',
            message: 'Never set for this stage - resolves to the placeholder default declared in infra/secrets.ts.',
          }
        : spec.validate(value, stage);
    const enforced = spec.enforcement === 'always' || isProductionStage;
    return {
      ...result,
      name: spec.name,
      enforcement: spec.enforcement,
      hint: result.status === 'configured' ? undefined : spec.hint(stage),
      exposure: spec.exposure,
      blocksDeploy: !result.isValid && enforced,
    };
  });
}

/**
 * Deploy refusal message for the statuses that block. Names only - no value, no
 * length, nothing that narrows a guess.
 */
export function formatTier1DeployFailure(stage: string, statuses: readonly Tier1SecretStatus[]): string {
  const blockers = statuses.filter(s => s.blocksDeploy);
  const lines = blockers.map(s => `  - ${s.name} [${s.status}]: ${s.exposure}\n      ${s.hint}`);
  return [
    `Refusing to deploy stage "${stage}": ${blockers.length} tier-1 secret${blockers.length === 1 ? '' : 's'} ${
      blockers.length === 1 ? 'is' : 'are'
    } not configured.`,
    '',
    ...lines,
    '',
    'Set each one, then deploy again. To configure every preview stage at once, set it',
    'as a fallback in that account instead: append --fallback and drop --stage.',
  ].join('\n');
}
