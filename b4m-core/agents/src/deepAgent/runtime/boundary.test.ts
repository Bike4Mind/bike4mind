import { readdirSync, readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { describe, it, expect } from 'vitest';

/**
 * Open-core boundary guard.
 *
 * @bike4mind/agents ships the infra-free deepAgent runtime. It must NEVER pull
 * in the host's persistence/services/deploy layers, or the "runnable open core"
 * promise breaks and OSS consumers can't build it. OSS licensing is
 * irreversible, so this is enforced in CI, not by convention.
 */
// '@server' also catches '@server/...' as a substring, so it need not be listed twice.
const FORBIDDEN = ['@bike4mind/database', '@bike4mind/services', 'sst', '@server'];

const runtimeDir = fileURLToPath(new URL('.', import.meta.url));
const pkgJsonPath = fileURLToPath(new URL('../../../package.json', import.meta.url));

describe('open-core boundary', () => {
  it('the agents package declares no host-infra dependencies', () => {
    const pkg = JSON.parse(readFileSync(pkgJsonPath, 'utf8')) as {
      dependencies?: Record<string, string>;
      devDependencies?: Record<string, string>;
      peerDependencies?: Record<string, string>;
    };
    const declared = Object.keys({ ...pkg.dependencies, ...pkg.devDependencies, ...pkg.peerDependencies });
    const offenders = declared.filter(d => d === '@bike4mind/database' || d === '@bike4mind/services' || d === 'sst');
    expect(offenders, `agents package.json must not depend on ${offenders.join(', ')}`).toEqual([]);
  });

  it('no runtime source file imports a host-infra module', () => {
    const sources = readdirSync(runtimeDir).filter(f => f.endsWith('.ts') && !f.endsWith('.test.ts'));
    const violations: string[] = [];
    for (const file of sources) {
      const text = readFileSync(new URL(file, new URL('.', import.meta.url)), 'utf8');
      for (const spec of FORBIDDEN) {
        // Match both quote styles - a formatter shift to double quotes must not
        // silently disable the guard.
        if (text.includes(`'${spec}`) || text.includes(`"${spec}`)) violations.push(`${file} → ${spec}`);
      }
    }
    expect(violations, `forbidden imports found:\n${violations.join('\n')}`).toEqual([]);
  });
});
