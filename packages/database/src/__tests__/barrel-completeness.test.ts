import { describe, it, expect } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';

const MODELS_DIR = path.resolve(__dirname, '../models');
const DOMAIN_DIRS = ['auth', 'content', 'social', 'billing', 'ai', 'infra', 'hearth'];

function getModelFilesInDomain(dir: string): string[] {
  const files: string[] = [];
  const entries = fs.readdirSync(dir, { withFileTypes: true });
  for (const entry of entries) {
    if (entry.isDirectory() && !entry.name.startsWith('__')) {
      files.push(...getModelFilesInDomain(path.join(dir, entry.name)));
    } else if (
      entry.isFile() &&
      entry.name.endsWith('.ts') &&
      !entry.name.endsWith('.test.ts') &&
      entry.name !== 'index.ts'
    ) {
      files.push(path.join(dir, entry.name));
    }
  }
  return files;
}

function getBarrelExports(indexPath: string): Set<string> {
  if (!fs.existsSync(indexPath)) return new Set();
  const content = fs.readFileSync(indexPath, 'utf-8');
  const exports = new Set<string>();
  for (const line of content.split('\n')) {
    const match = line.match(/from ['"](.+)['"]/);
    if (match) exports.add(match[1]);
  }
  return exports;
}

describe('Domain barrel completeness', () => {
  it('every model file in a domain dir is reachable via its domain barrel', () => {
    const missing: string[] = [];

    for (const domain of DOMAIN_DIRS) {
      const domainDir = path.join(MODELS_DIR, domain);
      if (!fs.existsSync(domainDir)) continue;

      const modelFiles = getModelFilesInDomain(domainDir);

      for (const file of modelFiles) {
        const relativeToDomain = path.relative(domainDir, file).replace(/\.ts$/, '');
        const importPath = `./${relativeToDomain}`;

        // Walk up the barrel chain: domain/sub/index.ts re-exports to domain/index.ts
        const subDir = path.dirname(file);
        const subBarrel = path.join(subDir, 'index.ts');
        const topBarrel = path.join(domainDir, 'index.ts');

        const subExports = getBarrelExports(subBarrel);
        const topExports = getBarrelExports(topBarrel);

        const basename = path.basename(relativeToDomain);
        const subExportPath = `./${basename}`;
        const subDirRelative = `./${path.dirname(relativeToDomain)}`;

        // Two-level chain check:
        // - Flat domain file (e.g. auth/UserModel.ts): must appear directly in domain barrel
        // - Sub-domain file (e.g. infra/ops/FooModel.ts): must be in sub-barrel AND
        //   sub-barrel must be re-exported by domain barrel - checking just that the domain
        //   barrel exports './ops' is always true for infra and would silently pass missing files
        const reachable =
          subDir === domainDir
            ? topExports.has(importPath)
            : subExports.has(subExportPath) && topExports.has(subDirRelative);

        if (!reachable) {
          missing.push(`${domain}: ${relativeToDomain}`);
        }
      }
    }

    expect(missing, `Missing from domain barrels:\n${missing.join('\n')}`).toHaveLength(0);
  });
});
