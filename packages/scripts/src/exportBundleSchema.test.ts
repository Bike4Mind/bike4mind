import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import Ajv2020 from 'ajv/dist/2020';
import addFormats from 'ajv-formats';
import { describe, expect, it } from 'vitest';

const root = resolve(import.meta.dirname, '../../../docs-site/static/schemas/export-v2');
const sample = resolve(root, 'sample');
const names = {
  notebooks: 'notebook',
  'chat-messages': 'chat-message',
  knowledge: 'knowledge',
  artifacts: 'artifact',
  tools: 'tool',
  agents: 'agent',
};

describe('published v2 export schemas', () => {
  it('validates every sample row, collection count and byte checksum', async () => {
    const ajv = addFormats(new Ajv2020({ allErrors: true }));
    const manifest = JSON.parse(await readFile(resolve(sample, 'manifest.json'), 'utf8')) as {
      collections: Record<string, { path: string; bytes: number; count: number; sha256: string }>;
      files: { path: string; bytes: number; sha256: string }[];
    };
    const manifestSchema = JSON.parse(await readFile(resolve(root, 'manifest.schema.json'), 'utf8'));
    const validateManifest = ajv.compile(manifestSchema);
    expect(validateManifest(manifest), JSON.stringify(validateManifest.errors)).toBe(true);
    expect(validateManifest({ ...manifest, files: [{ ...manifest.files[0], path: 'files/../escape' }] })).toBe(false);
    expect(validateManifest({ ...manifest, files: [{ ...manifest.files[0], path: 'files//escape' }] })).toBe(false);
    const verify = async (entry: { path: string; bytes: number; sha256: string }) => {
      const bytes = await readFile(resolve(sample, entry.path));
      expect(bytes.length).toBe(entry.bytes);
      expect(createHash('sha256').update(bytes).digest('hex')).toBe(entry.sha256);
      return bytes;
    };
    for (const [name, entry] of Object.entries(manifest.collections)) {
      const rows = (await verify(entry))
        .toString('utf8')
        .trimEnd()
        .split('\n')
        .map(line => JSON.parse(line) as unknown);
      expect(rows).toHaveLength(entry.count);
      const schemaName = names[name as keyof typeof names];
      if (!schemaName) continue;
      const schema = JSON.parse(await readFile(resolve(root, `${schemaName}.schema.json`), 'utf8'));
      const validate = ajv.compile(schema);
      for (const row of rows) expect(validate(row), `${name}: ${JSON.stringify(validate.errors)}`).toBe(true);
    }
    for (const file of manifest.files) await verify(file);
  });
});
