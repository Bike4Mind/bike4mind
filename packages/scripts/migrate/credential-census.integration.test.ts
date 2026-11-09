import { readFileSync } from 'node:fs';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import mongoose from 'mongoose';
import bcrypt from 'bcryptjs';
// Imported for its side effect: registers every model so collection names and paths can be pinned.
import '@bike4mind/database';
import { SENSITIVE_SETTING_MASK } from '@bike4mind/common';
import { encryptSecret, generateEncryptionKey } from '@bike4mind/utils/security';
import { createMongoServer, MONGO_TEST_TIMEOUT_MS } from '../../database/src/__test__/createMongoServer';
import {
  CENSUS_FIELDS,
  censusExitCode,
  censusLabel,
  formatCensus,
  runCredentialCensus,
  type CensusField,
} from './credential-census-report';
import { SENSITIVE_SETTING_KEYS } from './encrypt-admin-settings-and-apikeys';

vi.setConfig({ testTimeout: MONGO_TEST_TIMEOUT_MS, hookTimeout: MONGO_TEST_TIMEOUT_MS });

const MODEL_BY_COLLECTION: Record<string, string> = {
  apikeys: 'ApiKey',
  mcpservers: 'McpServer',
  users: 'User',
  orgslackworkspaces: 'OrgSlackWorkspace',
  slackdevworkspaces: 'SlackDevWorkspace',
  adminsettings: 'AdminSettings',
  secretrotations: 'SecretRotation',
  memoryprincipalkeys: 'MemoryPrincipalKey',
  mcpconnections: 'McpConnection',
  mcpoauthclientregistrations: 'McpOAuthClientRegistration',
  mcpoauthpendings: 'McpOAuthPending',
  orggithubconnections: 'OrgGitHubConnection',
  orggoogledriveconnections: 'OrgGoogleDriveConnection',
  orgjiraconnections: 'OrgJiraConnection',
};

const key = generateEncryptionKey();
const unprefixedCiphertext = encryptSecret('protected', key);
const boundCiphertext = encryptSecret('protected', key, 'context');
const bcryptHash = bcrypt.hashSync('protected', 4);

let server: Awaited<ReturnType<typeof createMongoServer>>;
let counter = 0;
const canaries: string[] = [];
const seededIds: string[] = [];

beforeAll(async () => {
  server = await createMongoServer();
  await mongoose.connect(server.getUri(), { autoIndex: false, autoCreate: false });
});
afterAll(async () => {
  await mongoose.disconnect();
  await server.stop();
});
beforeEach(async () => {
  await mongoose.connection.dropDatabase();
  canaries.length = 0;
  seededIds.length = 0;
});

const plaintext = (): string => {
  const value = `canary-${++counter}-plain`;
  canaries.push(value);
  return value;
};

/** Values to store under one field: 2 plaintext, 2 protected, 1 empty. */
function valuesFor(field: CensusField, protectedOnly: boolean): string[] {
  const good =
    field.format === 'bcrypt'
      ? [bcryptHash, bcryptHash]
      : field.format === 'wrapped-dek'
        ? ['enc:wrapped-a', 'enc:wrapped-b']
        : [unprefixedCiphertext, boundCiphertext];
  if (field.format === 'bound-ciphertext' && protectedOnly) return [boundCiphertext, boundCiphertext];
  return protectedOnly ? good : [plaintext(), plaintext(), ...good, ''];
}

const nest = (path: string, value: unknown): Record<string, unknown> =>
  path
    .split('.')
    .reverse()
    .reduce<unknown>((inner, segment) => ({ [segment]: inner }), value) as Record<string, unknown>;

async function seed(protectedOnly = false): Promise<void> {
  for (const field of CENSUS_FIELDS) {
    const values = valuesFor(field, protectedOnly);
    const docs = field.array
      ? [
          nest(
            field.array,
            values.map(value => nest(field.path.slice(field.array!.length + 1), value))
          ),
        ]
      : values.map(value => nest(field.path, value));
    const extra = field.collection === 'adminsettings' ? { settingName: [...SENSITIVE_SETTING_KEYS][0] } : {};
    const result = await mongoose.connection
      .collection(field.collection)
      .insertMany(docs.map(doc => ({ ...doc, ...extra })));
    seededIds.push(...Object.values(result.insertedIds).map(id => String(id)));
  }
}

describe('credential census', () => {
  it('pins every census collection and path to its model', () => {
    for (const field of CENSUS_FIELDS) {
      const model = mongoose.model(MODEL_BY_COLLECTION[field.collection]);
      expect(model.collection.collectionName, censusLabel(field)).toBe(field.collection);
      expect(model.schema.path(field.array ?? field.path), censusLabel(field)).toBeDefined();
    }
  });

  it('counts exact plaintext, unbound and checked values per field', async () => {
    await seed();
    const rows = await runCredentialCensus(mongoose.connection.db!);

    expect(rows.map(row => row.label)).toEqual(CENSUS_FIELDS.map(censusLabel));
    for (const [index, field] of CENSUS_FIELDS.entries()) {
      const row = rows[index];
      expect({ label: row.label, checked: row.checked, plaintext: row.plaintext }, row.label).toEqual({
        label: row.label,
        checked: 4,
        plaintext: 2,
      });
      expect(row.unbound, row.label).toBe(field.format === 'bound-ciphertext' ? 1 : undefined);
      expect(row.backfill).toBe(field.backfill);
    }
    expect(censusExitCode(rows)).toBe(1);
  });

  it('exits 0 when every value is protected, and 1 once one plaintext row appears', async () => {
    await seed(true);
    const db = mongoose.connection.db!;
    const clean = await runCredentialCensus(db);
    expect(clean.every(row => row.plaintext === 0 && !row.unbound && row.checked === 2)).toBe(true);
    expect(censusExitCode(clean)).toBe(0);

    await db.collection('orgjiraconnections').insertOne({ accessToken: plaintext() });
    expect(censusExitCode(await runCredentialCensus(db))).toBe(1);
  });

  it('counts unbound ciphertext alone as pending', async () => {
    const db = mongoose.connection.db!;
    await db.collection('apikeys').insertOne({ apiKey: unprefixedCiphertext });
    const row = (await runCredentialCensus(db)).find(r => r.label === 'apikeys.apiKey')!;
    expect(row).toMatchObject({ checked: 1, plaintext: 0, unbound: 1 });
    expect(censusExitCode([row])).toBe(1);
  });

  it('ignores non-sensitive and masked admin settings', async () => {
    const [sensitive] = [...SENSITIVE_SETTING_KEYS];
    await mongoose.connection.db!.collection('adminsettings').insertMany([
      { settingName: 'NotASensitiveSetting', settingValue: plaintext() },
      { settingName: sensitive, settingValue: `${SENSITIVE_SETTING_MASK}abcd` },
      { settingName: sensitive, settingValue: plaintext() },
    ]);
    const row = (await runCredentialCensus(mongoose.connection.db!)).find(
      r => r.label === 'adminsettings.settingValue'
    )!;
    expect(row).toMatchObject({ checked: 1, plaintext: 1 });
  });

  it('leaves documents and indexes unchanged', async () => {
    await seed();
    const db = mongoose.connection.db!;
    const snapshot = async () =>
      Promise.all(
        (await db.listCollections().toArray()).map(async ({ name }) => ({
          name,
          docs: await db.collection(name).find({}).toArray(),
          indexes: await db.collection(name).listIndexes().toArray(),
        }))
      );
    const before = await snapshot();
    await runCredentialCensus(db);
    expect(await snapshot()).toEqual(before);
  });

  it('never prints a stored value or a document id', async () => {
    await seed();
    const output = formatCensus(await runCredentialCensus(mongoose.connection.db!));
    expect(canaries.length).toBeGreaterThan(0);
    for (const secret of [...canaries, unprefixedCiphertext, boundCiphertext, bcryptHash]) {
      expect(output).not.toContain(secret);
    }
    for (const id of seededIds) expect(output).not.toContain(id);
  });

  it('names the backfill only for rows with pending values', () => {
    const output = formatCensus([
      { label: 'a.pending', checked: 1, plaintext: 1, backfill: 'migrate:x' },
      { label: 'b.pending', checked: 1, plaintext: 1, backfill: null },
      { label: 'c.clean', checked: 1, plaintext: 0, backfill: 'migrate:y' },
    ]).split('\n');
    expect(output[0]).toContain('[backfill: migrate:x]');
    expect(output[1]).toContain('[no backfill]');
    expect(output[2]).not.toContain('[');
  });

  it('contains no write or connectDB call', () => {
    const write =
      /\.(insert|update|delete)\w*\(|\.(replaceOne|bulkWrite|findOneAnd\w*|save|createIndex\w*|drop\w*|renameCollection)\(|connectDB/;
    for (const file of ['credential-census.ts', 'credential-census-report.ts']) {
      expect(readFileSync(new URL(`./${file}`, import.meta.url), 'utf8')).not.toMatch(write);
    }
  });
});
