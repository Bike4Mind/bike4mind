/**
 * loadPlugin tests drive real dynamic imports against fixture entry files
 * written to a temp dir - no npm, no mocking of import(). Fixtures import no
 * @bike4mind/* packages, which mirrors the real constraint on external
 * plugins (those packages are bundled into the CLI and unresolvable from a
 * plugin's node_modules).
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { promises as fs } from 'fs';
import path from 'path';
import { tmpdir } from 'os';
import { loadPlugin } from './loadPlugin';
import type { ValidPluginDescriptor } from '../plugins/PluginStore';
import type { PluginContext } from './pluginContract';

let dir: string;

const ctx: PluginContext = {
  logger: { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} },
};

function makeDescriptor(entryAbsPath: string): ValidPluginDescriptor {
  return {
    valid: true,
    name: 'fixture-plugin',
    version: '1.0.0',
    description: 'fixture',
    packageDir: path.dirname(entryAbsPath),
    entryAbsPath,
    configKey: 'fixture-plugin',
  };
}

async function writeFixture(filename: string, content: string): Promise<string> {
  const filePath = path.join(dir, filename);
  await fs.writeFile(filePath, content);
  return filePath;
}

const VALID_MODULE_BODY = `({
  name: 'fixture-plugin',
  description: 'fixture',
  getTools: () => [],
  getSystemPromptSection: () => 'section',
})`;

beforeAll(async () => {
  dir = await fs.mkdtemp(path.join(tmpdir(), 'b4m-load-plugin-'));
});

afterAll(async () => {
  await fs.rm(dir, { recursive: true, force: true });
});

describe('loadPlugin', () => {
  it('loads a valid ESM factory', async () => {
    const entry = await writeFixture('valid.mjs', `export default (ctx) => ${VALID_MODULE_BODY};`);
    const result = await loadPlugin(makeDescriptor(entry), ctx);
    expect('module' in result && result.module.name).toBe('fixture-plugin');
  });

  it('awaits an async factory', async () => {
    const entry = await writeFixture(
      'async.mjs',
      `export default async (ctx) => { await new Promise(r => setTimeout(r, 1)); return ${VALID_MODULE_BODY}; };`
    );
    const result = await loadPlugin(makeDescriptor(entry), ctx);
    expect('module' in result && result.module.getSystemPromptSection()).toBe('section');
  });

  it('loads a CJS entry through the ESM interop', async () => {
    const entry = await writeFixture('legacy.cjs', `module.exports = (ctx) => ${VALID_MODULE_BODY};`);
    const result = await loadPlugin(makeDescriptor(entry), ctx);
    expect('module' in result && result.module.name).toBe('fixture-plugin');
  });

  it('passes the context through to the factory', async () => {
    const entry = await writeFixture(
      'ctx.mjs',
      `export default (ctx) => { ctx.logger.info('hi'); return ${VALID_MODULE_BODY}; };`
    );
    const calls: string[] = [];
    const result = await loadPlugin(makeDescriptor(entry), {
      logger: { ...ctx.logger, info: message => calls.push(message) },
    });
    expect('module' in result).toBe(true);
    expect(calls).toEqual(['hi']);
  });

  it('reports an unresolvable entry as an error', async () => {
    const result = await loadPlugin(makeDescriptor(path.join(dir, 'missing.mjs')), ctx);
    expect('error' in result && result.error).toContain('failed to import');
  });

  it('reports a top-level throw as an error', async () => {
    const entry = await writeFixture('throws.mjs', `throw new Error('top-level boom');`);
    const result = await loadPlugin(makeDescriptor(entry), ctx);
    expect('error' in result && result.error).toContain('top-level boom');
  });

  it('reports a missing default export as an error', async () => {
    const entry = await writeFixture('nodefault.mjs', `export const foo = 1;`);
    const result = await loadPlugin(makeDescriptor(entry), ctx);
    expect('error' in result && result.error).toContain('default-export');
  });

  it('reports a throwing factory as an error', async () => {
    const entry = await writeFixture('factorythrow.mjs', `export default () => { throw new Error('factory boom'); };`);
    const result = await loadPlugin(makeDescriptor(entry), ctx);
    expect('error' in result && result.error).toContain('factory boom');
  });

  it('reports an invalid module shape as an error', async () => {
    const entry = await writeFixture('badshape.mjs', `export default () => ({ name: 'x' });`);
    const result = await loadPlugin(makeDescriptor(entry), ctx);
    expect('error' in result && result.error).toContain('valid feature module');
  });
});
