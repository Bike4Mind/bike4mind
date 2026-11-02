import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { CuratedCatalogSchema } from '@bike4mind/common';
import Ajv2020 from 'ajv/dist/2020';
import addFormats from 'ajv-formats';
import { afterEach, describe, expect, it } from 'vitest';
import { CATALOG_PATH, REPO_ROOT } from './cli';
import { checkCuratedSchema, curatedJsonSchemaText, SCHEMA_ID, SCHEMA_PATH } from './curatedSchema';

type Doc = Record<string, any>; // any: the fixtures edit arbitrary parts of a JSON document

const schema = JSON.parse(curatedJsonSchemaText());
const ajv = addFormats(new Ajv2020({ allErrors: true }));
const validate = ajv.compile(schema);

const catalog = async (): Promise<Doc> => JSON.parse(await readFile(path.join(REPO_ROOT, CATALOG_PATH), 'utf8'));

async function mutated(edit: (doc: Doc) => void): Promise<Doc> {
  const doc = await catalog();
  edit(doc);
  return doc;
}

const zodAccepts = (doc: Doc): boolean => CuratedCatalogSchema.safeParse(doc).success;

// Deletes every key (recursively) that is optional in the JSON Schema and whose removal Zod still accepts.
function pruneOptional(doc: Doc, target: Doc, node: Doc): void {
  if (Array.isArray(target)) {
    for (const item of target) pruneOptional(doc, item, node.items ?? {});
    return;
  }
  if (target === null || typeof target !== 'object' || !node.properties) return;
  for (const key of Object.keys(target)) {
    if ((node.required ?? []).includes(key)) continue;
    const removed = target[key];
    delete target[key];
    if (!zodAccepts(doc)) target[key] = removed;
  }
  for (const key of Object.keys(target)) pruneOptional(doc, target[key], node.properties[key] ?? {});
}

describe('curated list JSON Schema', () => {
  it('is draft 2020-12 with the served URL as its id', () => {
    expect(schema.$schema).toBe('https://json-schema.org/draft/2020-12/schema');
    expect(schema.$id).toBe(SCHEMA_ID);
  });

  it('accepts the bundled catalog, as Zod does', async () => {
    const doc = await catalog();
    expect(validate(doc), JSON.stringify(validate.errors)).toBe(true);
    expect(zodAccepts(doc)).toBe(true);
  });

  it('accepts a list that omits every defaulted top-level field', async () => {
    const doc = await mutated(d => {
      for (const key of ['sequence', 'changelog', 'revokedKeyIds', 'policy', 'tiers', 'notesUrl']) delete d[key];
    });
    expect(validate(doc), JSON.stringify(validate.errors)).toBe(true);
    // Zod additionally requires a sequence when a list is published.
    expect(zodAccepts(doc)).toBe(false);
  });

  it('accepts an entry and builds stripped of nested defaulted keys', async () => {
    const doc = await mutated(d => pruneOptional(d, d.entries[0], schema.properties.entries.items));
    expect(JSON.stringify(doc.entries[0]).length).toBeLessThan(JSON.stringify((await catalog()).entries[0]).length);
    expect(validate(doc), JSON.stringify(validate.errors)).toBe(true);
    expect(zodAccepts(doc)).toBe(true);
  });

  const rejected: [string, (doc: Doc) => void][] = [
    ['a wrong schemaVersion', d => (d.schemaVersion = 3)],
    ['a missing entries array', d => delete d.entries],
    ['a missing families map', d => delete d.families],
    ['a sequence of 0', d => (d.sequence = 0)],
    ['a fractional sequence', d => (d.sequence = 1.5)],
    ['a non-ISO updatedAt', d => (d.updatedAt = 'yesterday')],
    ['an updatedAt with an offset', d => (d.updatedAt = '2026-10-01T00:00:00+02:00')],
    ['a malformed revoked key id', d => (d.revokedKeyIds = ['not-a-key-id'])],
    ['a ranking for an unknown role', d => (d.rankings = { poetry: ['x'] })],
    ['an entry missing a required field', d => delete d.entries[0].license],
    ['an entry with no builds array', d => (d.entries[0].builds = 'none')],
    ['an entry role outside the enum', d => (d.entries[0].roles = ['poetry'])],
    ['a family key that is not a slug', d => (d.families['Not A Slug'] = Object.values(d.families)[0])],
    ['a javascript: link', d => (d.notesUrl = 'javascript:alert(1)')],
    ['an http:// link', d => (d.notesUrl = 'http://example.com/notes')],
  ];

  it.each(rejected)('rejects %s in both Ajv and Zod', async (_name, edit) => {
    const doc = await mutated(edit);
    expect(validate(doc)).toBe(false);
    expect(zodAccepts(doc)).toBe(false);
  });

  const zodOnly: [string, (doc: Doc) => void][] = [
    ['a repeated role', d => (d.entries[0].roles = [d.entries[0].roles[0], d.entries[0].roles[0]])],
    ['a link to a private host', d => (d.notesUrl = 'https://localhost/notes')],
    ['a duplicate entry id', d => d.entries.push(structuredClone(d.entries[0]))],
  ];

  it.each(zodOnly)('accepts %s in Ajv but Zod rejects it', async (_name, edit) => {
    const doc = await mutated(edit);
    expect(validate(doc), JSON.stringify(validate.errors)).toBe(true);
    expect(zodAccepts(doc)).toBe(false);
  });
});

describe('checkCuratedSchema', () => {
  const dirs: string[] = [];

  afterEach(async () => {
    await Promise.all(dirs.splice(0).map(dir => rm(dir, { recursive: true, force: true })));
  });

  it('passes for the committed file', async () => {
    expect(await checkCuratedSchema()).toBeNull();
  });

  it('reports a stale or missing file', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'curated-schema-'));
    dirs.push(root);
    expect(await checkCuratedSchema(root)).toMatch(/missing/);
    await mkdir(path.join(root, path.dirname(SCHEMA_PATH)), { recursive: true });
    await writeFile(path.join(root, SCHEMA_PATH), curatedJsonSchemaText().replace('"integer"', '"number"'));
    expect(await checkCuratedSchema(root)).toMatch(/stale; run pnpm --filter @bike4mind\/scripts curated:schema/);
    await writeFile(path.join(root, SCHEMA_PATH), curatedJsonSchemaText());
    expect(await checkCuratedSchema(root)).toBeNull();
  });
});
