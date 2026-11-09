import type { mongo } from 'mongoose';
import { SENSITIVE_SETTING_MASK } from '@bike4mind/common';
import { ciphertextPatternSource, ciphertextVersionPrefix } from '@bike4mind/utils/security';
import { BCRYPT_HASH_PATTERN, slackFields } from './protect-stored-credentials-backfill';
import { SENSITIVE_SETTING_KEYS } from './encrypt-admin-settings-and-apikeys';

type Document = mongo.Document;

/**
 * What a stored value must look like to count as protected:
 * - ciphertext: any at-rest ciphertext (`isEncrypted`)
 * - bound-ciphertext: ciphertext, and additionally the context-bound `v2:` form
 * - bcrypt: a bcrypt hash
 * - wrapped-dek: a master-key wrapped data key (`enc:` prefix)
 */
export type CensusFormat = 'ciphertext' | 'bound-ciphertext' | 'bcrypt' | 'wrapped-dek';

export interface CensusField {
  collection: string;
  /** Dotted path of the stored value; for array fields, `<array>.<key>`. */
  path: string;
  /** Array path to unwind before testing `path`. */
  array?: string;
  format: CensusFormat;
  /** Operator command that converts this field, or null when none exists. */
  backfill: string | null;
  /** Extra top-level filter restricting which documents are examined. */
  filter?: Document;
}

export interface CensusRow {
  label: string;
  checked: number;
  /** Not in the protected format (plaintext, or unhashed). */
  plaintext: number;
  /** Ciphertext that is not yet context-bound; only for `bound-ciphertext` fields. */
  unbound?: number;
  backfill: string | null;
}

const PROTECT = 'migrate:protect-credentials';
const TOKENS = 'migrate:encrypt-tokens';
const ADMIN = 'migrate:encrypt-admin-secrets';
const IDP_MIGRATION = 'migration 20260904000000_encrypt-identity-provider-secrets';

const fields = (
  collection: string,
  paths: string[],
  format: CensusFormat,
  backfill: string | null,
  extra: Partial<CensusField> = {}
): CensusField[] => paths.map(path => ({ collection, path, format, backfill, ...extra }));

const escapeRegExp = (value: string): string => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

// Collection names are Mongoose's default pluralization; the integration test pins each to its model.
export const CENSUS_FIELDS: CensusField[] = [
  ...fields('apikeys', ['apiKey'], 'bound-ciphertext', PROTECT),
  ...fields('mcpservers', ['envVariables.value'], 'bound-ciphertext', PROTECT, {
    array: 'envVariables',
  }),
  ...fields('mcpservers', ['metadata.webhooks.github.secret'], 'ciphertext', TOKENS),
  ...fields(
    'users',
    [
      'atlassianConnect.accessToken',
      'atlassianConnect.refreshToken',
      'googleDrive.accessToken',
      'googleDrive.refreshToken',
      'slackSettings.slackUserToken',
      'blogIntegration.apiKey',
    ],
    'ciphertext',
    TOKENS
  ),
  ...fields('users', ['securityQuestions.answer'], 'bcrypt', PROTECT, { array: 'securityQuestions' }),
  ...fields('users', ['mfa.totpSecret', 'mfa.pendingBackupCodes'], 'ciphertext', null),
  ...fields('orgslackworkspaces', ['slackBotToken'], 'ciphertext', TOKENS),
  ...fields('slackdevworkspaces', ['slackBotToken'], 'ciphertext', TOKENS),
  ...fields('slackdevworkspaces', [...slackFields], 'ciphertext', PROTECT),
  ...fields('adminsettings', ['settingValue'], 'ciphertext', ADMIN, {
    filter: {
      settingName: { $in: Array.from(SENSITIVE_SETTING_KEYS) },
      settingValue: { $not: new RegExp(`^${escapeRegExp(SENSITIVE_SETTING_MASK)}`) },
    },
  }),
  ...fields('secretrotations', ['previousKey'], 'ciphertext', PROTECT),
  ...fields('memoryprincipalkeys', ['dek'], 'wrapped-dek', PROTECT),
  ...fields(
    'mcpconnections',
    [
      'urlEnc',
      'auth.oauth.manualClientIdEnc',
      'auth.oauth.manualClientSecretEnc',
      'auth.oauth.accessTokenEnc',
      'auth.oauth.refreshTokenEnc',
      'auth.apiKey.valueEnc',
    ],
    'ciphertext',
    null
  ),
  ...fields('mcpoauthclientregistrations', ['clientSecretEnc', 'registrationAccessTokenEnc'], 'ciphertext', null),
  ...fields('mcpoauthpendings', ['codeVerifierEnc'], 'ciphertext', null),
  ...fields('orggithubconnections', ['privateKey', 'cachedAccessToken', 'accessToken'], 'ciphertext', null),
  ...fields('orggoogledriveconnections', ['oauthRefreshToken'], 'ciphertext', null),
  ...fields('orgjiraconnections', ['accessToken'], 'ciphertext', null),
  ...fields(
    'identityproviders',
    ['samlConfig.decryptionPvk', 'samlConfig.privateCert', 'oktaConfig.clientSecret'],
    'ciphertext',
    IDP_MIGRATION
  ),
  ...fields('userapikeys', ['callbackSigningSecret'], 'ciphertext', null),
];

export const censusLabel = (field: CensusField): string =>
  `${field.collection}.${field.array ? field.path.replace(`${field.array}.`, `${field.array}[].`) : field.path}`;

const ciphertext = new RegExp(ciphertextPatternSource, 'i');
const unprefixed = new RegExp(`^${escapeRegExp(ciphertextVersionPrefix)}`);

// The value is a non-empty string; mirrors the backfills' `if (!value)` guards.
const present = (path: string): Document => ({ [path]: { $type: 'string', $ne: '' } });

function notProtected(path: string, format: CensusFormat): Document {
  switch (format) {
    case 'bcrypt':
      return { [path]: { $not: new RegExp(BCRYPT_HASH_PATTERN.source) } };
    case 'wrapped-dek':
      return { [path]: { $not: /^enc:/ } };
    default:
      return { [path]: { $not: ciphertext } };
  }
}

// Ciphertext that lacks the context-bound `v2:` prefix.
const unbound = (path: string): Document => ({
  $and: [{ [path]: { $regex: ciphertext.source, $options: 'i' } }, { [path]: { $not: unprefixed } }],
});

/** Counts server-side so no stored value ever reaches this process. */
async function count(db: mongo.Db, field: CensusField, ...conditions: Document[]): Promise<number> {
  const pipeline: Document[] = [];
  if (field.filter) pipeline.push({ $match: field.filter });
  if (field.array) pipeline.push({ $unwind: `$${field.array}` });
  pipeline.push({ $match: { $and: [present(field.path), ...conditions] } }, { $count: 'n' });
  const [result] = await db.collection(field.collection).aggregate<{ n: number }>(pipeline).toArray();
  return result?.n ?? 0;
}

export async function runCredentialCensus(db: mongo.Db, census: CensusField[] = CENSUS_FIELDS): Promise<CensusRow[]> {
  const rows: CensusRow[] = [];
  for (const field of census) {
    const row: CensusRow = {
      label: censusLabel(field),
      checked: await count(db, field),
      plaintext: await count(db, field, notProtected(field.path, field.format)),
      backfill: field.backfill,
    };
    if (field.format === 'bound-ciphertext') row.unbound = await count(db, field, unbound(field.path));
    rows.push(row);
  }
  return rows;
}

const pending = (row: CensusRow): number => row.plaintext + (row.unbound ?? 0);

/**
 * 2 when no field has any value (wrong or empty database: a clean answer would be false), else 1
 * while any field still holds a plaintext, unhashed or unbound value, else 0.
 */
export const censusExitCode = (rows: CensusRow[]): 0 | 1 | 2 =>
  rows.every(row => row.checked === 0) ? 2 : rows.some(row => pending(row) > 0) ? 1 : 0;

export function formatCensus(rows: CensusRow[]): string {
  const width = Math.max(...rows.map(row => row.label.length));
  return rows
    .map(row => {
      const unboundPart = row.unbound === undefined ? '' : `  unbound=${row.unbound}`;
      const hint = pending(row) > 0 ? `  [${row.backfill ? `backfill: ${row.backfill}` : 'no backfill'}]` : '';
      return `${row.label.padEnd(width)}  checked=${row.checked}  plaintext=${row.plaintext}${unboundPart}${hint}`;
    })
    .join('\n');
}

export function formatFieldMap(census: CensusField[] = CENSUS_FIELDS): string {
  return census.map(field => `  ${censusLabel(field)}  ->  ${field.backfill ?? 'no backfill'}`).join('\n');
}
