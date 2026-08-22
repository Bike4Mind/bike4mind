import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const MANIFEST_PATH = join(__dirname, '../../../blueprints/manifest.json');

const REQUIRED_APPLIED_KEYS = ['blueprint', 'entry', 'blueprintHash', 'appliedAt', 'generatedFiles'] as const;

describe('blueprints/manifest.json', () => {
  it('parses as valid JSON', () => {
    const raw = readFileSync(MANIFEST_PATH, 'utf-8');
    expect(() => JSON.parse(raw)).not.toThrow();
  });

  it('has the required top-level shape', () => {
    const manifest = JSON.parse(readFileSync(MANIFEST_PATH, 'utf-8'));
    expect(typeof manifest.product).toBe('string');
    expect(manifest.product.length).toBeGreaterThan(0);
    expect(Array.isArray(manifest.applied)).toBe(true);
    expect(Array.isArray(manifest.skipped)).toBe(true);
  });

  it('every applied entry carries the five required keys', () => {
    const { applied } = JSON.parse(readFileSync(MANIFEST_PATH, 'utf-8'));
    for (const entry of applied as Record<string, unknown>[]) {
      for (const key of REQUIRED_APPLIED_KEYS) {
        expect(entry, `applied entry "${entry.blueprint}" is missing required key "${key}"`).toHaveProperty(key);
      }
    }
  });
});
