import { readFileSync } from 'node:fs';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
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
import { run } from './credential-census';

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
  identityproviders: 'IdentityProvider',
  userapikeys: 'UserApiKey',
};

const key = generateEncryptionKey();
const unprefixedCiphertext = encryptSecret('protected', key);
const boundCiphertext = encryptSecret('protected', key, 'context');
const bcryptHash = bcrypt.hashSync('protected', 4);

let server: Awaited<ReturnType<typeof createMongoServer>>;
// Seeds and inspects through its own client: run() connects (and disconnects) mongoose's default
// connection, where the models live, so it must not share it.
let client: mongoose.mongo.MongoClient;
let db: mongoose.mongo.Db;
let counter = 0;
const canaries: string[] = [];
const seededIds: string[] = [];

beforeAll(async () => {
  server = await createMongoServer();
  client = await new mongoose.mongo.MongoClient(server.getUri()).connect();
  db = client.db('census_main');
});
afterAll(async () => {
  await client.close();
  await server.stop();
});
beforeEach(async () => {
  await db.dropDatabase();
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
    const result = await db.collection(field.collection).insertMany(docs.map(doc => ({ ...doc, ...extra })));
    seededIds.push(...Object.values(result.insertedIds).map(id => String(id)));
  }
}

describe('credential census', () => {
  it('pins every census collection and path to its model', () => {
    for (const field of CENSUS_FIELDS) {
      const model = mongoose.model(MODEL_BY_COLLECTION[field.collection]);
      expect(model.collection.collectionName, censusLabel(field)).toBe(field.collection);
      expect(model.schema.path(field.path), censusLabel(field)).toBeDefined();
    }
  });

  it('counts exact plaintext, unbound and checked values per field', async () => {
    await seed();
    const rows = await runCredentialCensus(db);

    expect(rows.map(row => row.label)).toEqual(CENSUS_FIELDS.map(censusLabel));
    for (const [index, field] of CENSUS_FIELDS.entries()) {
      const row = rows[index];
      expect({ label: row.label, checked: row.checked, plaintext: row.plaintext }, row.label).toEqual({
        label: censusLabel(field),
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
    const clean = await runCredentialCensus(db);
    expect(clean.every(row => row.plaintext === 0 && !row.unbound && row.checked === 2)).toBe(true);
    expect(censusExitCode(clean)).toBe(0);

    await db.collection('orgjiraconnections').insertOne({ accessToken: plaintext() });
    expect(censusExitCode(await runCredentialCensus(db))).toBe(1);
  });

  it('counts unbound ciphertext alone as pending', async () => {
    await db.collection('apikeys').insertOne({ apiKey: unprefixedCiphertext });
    const row = (await runCredentialCensus(db)).find(r => r.label === 'apikeys.apiKey')!;
    expect(row).toMatchObject({ checked: 1, plaintext: 0, unbound: 1 });
    expect(censusExitCode([row])).toBe(1);
    expect(formatCensus([row])).toContain('[backfill: migrate:protect-credentials]');
    expect(formatCensus([row])).not.toContain('(or');
  });

  it('ignores non-sensitive and masked admin settings', async () => {
    const [sensitive] = [...SENSITIVE_SETTING_KEYS];
    await db.collection('adminsettings').insertMany([
      { settingName: 'NotASensitiveSetting', settingValue: plaintext() },
      { settingName: sensitive, settingValue: `${SENSITIVE_SETTING_MASK}abcd` },
      { settingName: sensitive, settingValue: plaintext() },
    ]);
    const row = (await runCredentialCensus(db)).find(r => r.label === 'adminsettings.settingValue')!;
    expect(row).toMatchObject({ checked: 1, plaintext: 1 });
  });

  it('leaves documents and indexes unchanged', async () => {
    await seed();
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
    const output = formatCensus(await runCredentialCensus(db));
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
      /\.(insert|update|delete)\w*\(|\.(replaceOne|bulkWrite|findOneAnd\w*|save|createIndex\w*|drop\w*|renameCollection|create|command|find|createCollection|syncIndexes|ensureIndexes)\(|\$merge|\$out|syncIndexes|ensureIndexes|createCollection|connectDB/;
    for (const file of ['credential-census.ts', 'credential-census-report.ts']) {
      expect(readFileSync(new URL(`./${file}`, import.meta.url), 'utf8')).not.toMatch(write);
    }
  });
});

describe('credential census CLI', () => {
  const dbName = 'census_cli';
  const uriFor = (name = dbName): string => server.getUri().replace(/\/?$/, `/${name}`);
  let out: string[];
  let err: string[];

  const snapshot = async () => {
    const cliDb = client.db(dbName);
    return Promise.all(
      (await cliDb.listCollections().toArray()).map(async ({ name }) => ({
        name,
        docs: await cliDb.collection(name).find({}).toArray(),
        indexes: await cliDb.collection(name).listIndexes().toArray(),
      }))
    );
  };

  async function seedCli(protectedOnly: boolean): Promise<void> {
    const original = db;
    db = client.db(dbName);
    try {
      await seed(protectedOnly);
    } finally {
      db = original;
    }
  }

  beforeEach(async () => {
    await client.db(dbName).dropDatabase();
    out = [];
    err = [];
    vi.spyOn(console, 'log').mockImplementation((...args) => void out.push(args.join(' ')));
    vi.spyOn(console, 'error').mockImplementation((...args) => void err.push(args.join(' ')));
    vi.stubEnv('MONGODB_URI', uriFor());
    vi.stubEnv('STAGE', 'test');
  });
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
  });

  it('exits 1 with pending values, prints no value or id, and changes nothing', async () => {
    await seedCli(false);
    const before = await snapshot();
    expect(await run([])).toBe(1);
    const output = [...out, ...err].join('\n');
    expect(output).toContain(`Database: ${dbName}`);
    for (const secret of [...canaries, unprefixedCiphertext, boundCiphertext, bcryptHash]) {
      expect(output).not.toContain(secret);
    }
    for (const id of seededIds) expect(output).not.toContain(id);
    expect(await snapshot()).toEqual(before);
  });

  it('exits 0 when every value is protected', async () => {
    await seedCli(true);
    expect(await run([])).toBe(0);
  });

  it('exits 2 for an empty database', async () => {
    expect(await run([])).toBe(2);
    expect(err.join('\n')).toContain('wrong or empty database');
  });

  it('exits 2 when the URI needs a stage and none is set', async () => {
    vi.stubEnv('MONGODB_URI', 'mongodb://127.0.0.1:1/%STAGE%');
    vi.stubEnv('STAGE', '');
    vi.stubEnv('SEED_STAGE_NAME', '');
    expect(await run([])).toBe(2);
    expect(err.join('\n')).toContain('needs a stage');
  });

  it('exits 2 on an unreachable host without echoing the URI', async () => {
    vi.stubEnv('MONGODB_URI', 'mongodb://user:hun@ter2@127.0.0.1:1/db');
    expect(await run([])).toBe(2);
    const message = err.join('\n');
    expect(message).toContain('Credential census failed');
    expect(message).not.toMatch(/ter2|127\.0\.0\.1|hun/);
  });

  it('prints help without connecting', async () => {
    vi.stubEnv('MONGODB_URI', '');
    expect(await run(['--help'])).toBe(0);
    expect(out.join('\n')).toContain('identityproviders.samlConfig.decryptionPvk');
  });
});
