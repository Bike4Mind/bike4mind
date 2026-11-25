import type { mongo } from 'mongoose';
import {
  apiKeySecretContext,
  isContextBound,
  isEncrypted,
  mcpEnvSecretContext,
  rotateSecret,
} from '@bike4mind/utils/security';
import { slackFields } from './protect-stored-credentials-backfill';

type Document = mongo.Document;

/**
 * One stored location of at-rest ciphertext. The table below is the single list the re-encrypt
 * command walks; `reencrypt-stored-secrets-coverage.test.ts` fails when the credential census or an
 * encrypting call site names a field that is missing here.
 */
export interface SweepField {
  collection: string;
  /** Dotted path of the stored value. A segment ending in `[]` is an array whose items are walked. */
  path: string;
  /** Other top-level fields the context needs, added to the projection. */
  needs?: string[];
  /** Rebuilds the owning context of a context-bound value from its document and array item. */
  context?: (doc: Document, item?: Document) => string;
  /** Walk every string nested under `path`, whatever shape the value has. */
  deep?: boolean;
}

const fields = (collection: string, paths: readonly string[], extra: Partial<SweepField> = {}): SweepField[] =>
  paths.map(path => ({ collection, path, ...extra }));

// Collection names are Mongoose's default pluralization; the integration test pins each to its model.
export const SWEEP_FIELDS: SweepField[] = [
  ...fields('apikeys', ['apiKey'], {
    needs: ['userId'],
    context: doc => apiKeySecretContext(doc.userId, String(doc._id)),
  }),
  ...fields('mcpservers', ['envVariables[].value'], {
    needs: ['userId'],
    context: (doc, item) => mcpEnvSecretContext(doc.userId, String(doc._id), item?.key),
  }),
  ...fields('mcpservers', ['metadata.webhooks.github.secret']),
  ...fields('users', [
    'atlassianConnect.accessToken',
    'atlassianConnect.refreshToken',
    'googleDrive.accessToken',
    'googleDrive.refreshToken',
    'slackSettings.slackUserToken',
    'blogIntegration.apiKey',
    'notionConnect.accessToken',
    'mfa.totpSecret',
    'mfa.pendingBackupCodes',
    'authProviders[].accessToken',
    'authProviders[].refreshToken',
    'oauthCredentials.accessToken',
    'oauthCredentials.refreshToken',
  ]),
  ...fields('orgslackworkspaces', ['slackBotToken']),
  ...fields('slackdevworkspaces', ['slackBotToken', ...slackFields]),
  // Deep: sensitive settings are strings, object-valued settings nest their secrets, and extension
  // packages register settings this repo cannot list.
  ...fields('adminsettings', ['settingValue'], { deep: true }),
  ...fields('secretrotations', ['previousKey']),
  ...fields('mcpconnections', [
    'urlEnc',
    'auth.oauth.manualClientIdEnc',
    'auth.oauth.manualClientSecretEnc',
    'auth.oauth.accessTokenEnc',
    'auth.oauth.refreshTokenEnc',
    'auth.apiKey.valueEnc',
  ]),
  ...fields('mcpoauthclientregistrations', ['clientSecretEnc', 'registrationAccessTokenEnc']),
  ...fields('mcpoauthpendings', ['codeVerifierEnc']),
  ...fields('orggithubconnections', ['privateKey', 'cachedAccessToken', 'accessToken']),
  ...fields('orggoogledriveconnections', ['oauthRefreshToken']),
  ...fields('orgjiraconnections', ['accessToken']),
  ...fields('identityproviders', ['samlConfig.decryptionPvk', 'samlConfig.privateCert', 'oktaConfig.clientSecret']),
  ...fields('userapikeys', ['callbackSigningSecret']),
  ...fields('systemsecrets', ['encryptedValue', 'previousEncryptedValue']),
  ...fields('jirawebhookconfigs', ['secret', 'previousSecret']),
  ...fields('orgwebhookconfigs', ['secret']),
  ...fields('githublakeauthgrants', ['encryptedToken']),
  ...fields('overwatchsocialconnections', ['accessToken', 'refreshToken']),
];

export const sweepLabel = (field: SweepField): string => `${field.collection}.${field.path}`;

interface Occurrence {
  value: string;
  /** Update path of this exact value (array positions as indexes), or null when it cannot be addressed. */
  setPath: string | null;
  item?: Document;
}

const isRecord = (node: unknown): node is Document =>
  node !== null && typeof node === 'object' && !Array.isArray(node) && Object.getPrototypeOf(node) === Object.prototype;

// A key with a dot or a leading dollar cannot be named in an update path.
const addressable = (key: string): boolean => key !== '' && !key.includes('.') && !key.startsWith('$');

function* strings(node: unknown, prefix: string[] | null, item?: Document): Generator<Occurrence> {
  if (typeof node === 'string') {
    yield { value: node, setPath: prefix ? prefix.join('.') : null, item };
  } else if (Array.isArray(node)) {
    for (const [index, child] of node.entries()) yield* strings(child, prefix && [...prefix, String(index)], item);
  } else if (isRecord(node)) {
    for (const [key, child] of Object.entries(node)) {
      yield* strings(child, prefix && addressable(key) ? [...prefix, key] : null, item);
    }
  }
}

function* walk(
  node: unknown,
  segments: string[],
  prefix: string[],
  deep: boolean,
  item?: Document
): Generator<Occurrence> {
  if (segments.length === 0) {
    if (deep) yield* strings(node, prefix, item);
    else if (typeof node === 'string') yield { value: node, setPath: prefix.join('.'), item };
    return;
  }
  if (!isRecord(node)) return;
  const [head, ...rest] = segments;
  const isArray = head.endsWith('[]');
  const key = isArray ? head.slice(0, -2) : head;
  const child = node[key];
  if (!isArray) {
    yield* walk(child, rest, [...prefix, key], deep, item);
  } else if (Array.isArray(child)) {
    for (const [index, element] of child.entries()) {
      yield* walk(element, rest, [...prefix, key, String(index)], deep, isRecord(element) ? element : item);
    }
  }
}

/** Every string stored at `field.path` in one document, with the update path of each. */
export const occurrences = (doc: Document, field: SweepField): Generator<Occurrence> =>
  walk(doc, field.path.split('.'), [], field.deep === true);

export type SweepMode = 'rewrite' | 'dry-run' | 'verify';

export interface SweepRow {
  label: string;
  /** Ciphertext values examined. */
  checked: number;
  /** Already under the current key. */
  current: number;
  /** Moved to the current key, or in dry-run mode, would be. Always 0 in verify mode. */
  rotated: number;
  /** Changed between read and write, so left for the next run. */
  conflicts: number;
  /**
   * Not usable as found: no supplied key opens it, its context cannot be rebuilt, or its path
   * cannot be addressed. In verify mode, where only the current key is supplied, this is every
   * value that is not under the current key.
   */
  unreadable: number;
}

export interface SweepOptions {
  currentKey: string;
  /** Ignored in verify mode, which answers with the current key alone. */
  previousKey?: string;
  mode: SweepMode;
  fields?: SweepField[];
}

const queryPath = (field: SweepField): string => field.path.replaceAll('[]', '');
const topLevel = (field: SweepField): string => queryPath(field).split('.')[0];

/**
 * Walks every field of the table once per collection. Reads and writes go through the raw driver:
 * model setters and hooks would encrypt a second time, default query filters hide soft-deleted
 * rows that still hold ciphertext, and timestamps would move on rows whose content did not change.
 * Each write is conditional on the exact ciphertext that was read and sets that one path only.
 */
export async function sweepStoredSecrets(db: mongo.Db, options: SweepOptions): Promise<SweepRow[]> {
  const { currentKey, mode, fields: table = SWEEP_FIELDS } = options;
  const previousKey = mode === 'verify' ? undefined : options.previousKey;
  const rows = new Map<SweepField, SweepRow>(
    table.map(field => [
      field,
      { label: sweepLabel(field), checked: 0, current: 0, rotated: 0, conflicts: 0, unreadable: 0 },
    ])
  );

  const byCollection = new Map<string, SweepField[]>();
  for (const field of table) byCollection.set(field.collection, [...(byCollection.get(field.collection) ?? []), field]);

  for (const [name, group] of byCollection) {
    const collection = db.collection(name);
    // A deep field has no fixed shape to filter on, so its collection is read whole.
    const filter = group.some(field => field.deep)
      ? {}
      : { $or: group.map(field => ({ [queryPath(field)]: { $type: 'string' } })) };
    const projection = Object.fromEntries(
      group.flatMap(field => [topLevel(field), ...(field.needs ?? [])]).map(key => [key, 1])
    );

    for await (const doc of collection.find(filter, { projection })) {
      for (const field of group) {
        const row = rows.get(field)!;
        for (const { value, setPath, item } of occurrences(doc, field)) {
          if (!isEncrypted(value)) continue;
          row.checked++;
          const bound = isContextBound(value);
          if (bound && !field.context) {
            row.unreadable++;
            continue;
          }
          const outcome = rotateSecret(value, currentKey, previousKey, bound ? field.context!(doc, item) : undefined);
          if (outcome.state === 'current') {
            row.current++;
          } else if (outcome.state === 'unreadable' || setPath === null) {
            row.unreadable++;
          } else if (mode === 'dry-run') {
            row.rotated++;
          } else {
            // update-validators-off: native driver write of one ciphertext path; schema validators do not apply
            const result = await collection.updateOne(
              { _id: doc._id, [setPath]: value },
              { $set: { [setPath]: outcome.value } }
            );
            if (result.modifiedCount === 1) row.rotated++;
            else row.conflicts++;
          }
        }
      }
    }
  }
  return [...rows.values()];
}

/**
 * 2 when no ciphertext was found at all (wrong or empty database: a clean answer would be false),
 * else 1 while any value is unreadable or was left for another run, else 0.
 */
export const sweepExitCode = (rows: SweepRow[]): 0 | 1 | 2 =>
  rows.every(row => row.checked === 0) ? 2 : rows.some(row => row.unreadable + row.conflicts > 0) ? 1 : 0;

/** Counts only: no stored value and no document id is ever part of a row. */
export function formatSweep(rows: SweepRow[], mode: SweepMode): string {
  const width = Math.max(...rows.map(row => row.label.length));
  const line = (row: SweepRow): string => {
    const head = `${row.label.padEnd(width)}  checked=${row.checked}  current=${row.current}`;
    if (mode === 'verify') return `${head}  not-current=${row.unreadable}`;
    const rotated = mode === 'dry-run' ? 'would-rotate' : 'rotated';
    return `${head}  ${rotated}=${row.rotated}  conflicts=${row.conflicts}  unreadable=${row.unreadable}`;
  };
  const total = rows.reduce<SweepRow>(
    (sum, row) => ({
      label: 'TOTAL',
      checked: sum.checked + row.checked,
      current: sum.current + row.current,
      rotated: sum.rotated + row.rotated,
      conflicts: sum.conflicts + row.conflicts,
      unreadable: sum.unreadable + row.unreadable,
    }),
    { label: 'TOTAL', checked: 0, current: 0, rotated: 0, conflicts: 0, unreadable: 0 }
  );
  return [...rows, total].map(line).join('\n');
}
