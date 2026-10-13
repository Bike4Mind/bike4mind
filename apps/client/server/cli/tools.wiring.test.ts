import { describe, it, expect, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

vi.mock('@bike4mind/utils', () => ({ registerLambdaErrorHandlers: vi.fn() }));
vi.mock('./tools', () => ({ handleToolRequest: vi.fn() }));

const repoRoot = resolve(__dirname, '../../../..');

describe('CLI tools Lambda wiring', () => {
  it('infra points at an exported handler function in tools.handler', async () => {
    const infra = readFileSync(resolve(repoRoot, 'infra/cliToolHandler.ts'), 'utf8');
    const spec = infra.match(/handler:\s*'([^']+)'/)?.[1] ?? '';
    const dot = spec.lastIndexOf('.');
    const filePath = spec.slice(0, dot);
    const exportName = spec.slice(dot + 1);

    expect(filePath).toBe('apps/client/server/cli/tools.handler');
    expect(exportName).toBe('handler');

    const mod = await import('./tools.handler');
    expect(typeof (mod as Record<string, unknown>)[exportName]).toBe('function');
  });

  it('tools.ts does not export a Lambda handler', () => {
    const src = readFileSync(resolve(__dirname, 'tools.ts'), 'utf8');
    expect(src).not.toMatch(/export\s+const\s+handler\b|export\s*\{[^}]*\bhandler\b/);
  });
});
