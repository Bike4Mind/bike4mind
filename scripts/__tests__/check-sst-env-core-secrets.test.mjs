import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

const script = fileURLToPath(new URL('../check-sst-env-core-secrets.mjs', import.meta.url));
const declaration = name => `"${name}": { "type": "sst.sst.Secret" }\n`;
let directory;

function write(file, source) {
  const path = join(directory, file);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, source);
}

function git(...args) {
  return execFileSync('git', args, { cwd: directory, encoding: 'utf8' });
}

function run(staged = false) {
  return spawnSync(process.execPath, [script, ...(staged ? ['--staged'] : [])], {
    cwd: directory,
    encoding: 'utf8',
  });
}

beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), 'sst-env-core-secrets-'));
  git('init', '--quiet');
  write('infra/secrets.ts', "export const secret = new sst.Secret('CORE_TOKEN', 'x');\n");
  write('sst-env.d.ts', declaration('CORE_TOKEN'));
  git('add', '.');
});

afterEach(() => {
  rmSync(directory, { recursive: true, force: true });
});

describe('sst-env core secret guard', () => {
  it('accepts core declarations in both snapshots', () => {
    expect(run().status).toBe(0);
    expect(run(true).status).toBe(0);
  });

  it('rejects a contributed secret name', () => {
    write('sst-env.d.ts', declaration('OVERLAY_PRIVATE_TOKEN'));
    const result = run();
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('sst-env.d.ts: OVERLAY_PRIVATE_TOKEN');
  });

  it('does not let an unstaged core constructor authorize a staged private name', () => {
    write('sst-env.d.ts', declaration('OVERLAY_PRIVATE_TOKEN'));
    git('add', 'sst-env.d.ts');
    write('infra/secrets.ts', "new sst.Secret('OVERLAY_PRIVATE_TOKEN', 'x');\n");
    expect(run(true).status).toBe(1);
  });

  it('uses a staged core addition even when the working tree removes it', () => {
    write('infra/newSecret.ts', "new sst.Secret('NEW_CORE_TOKEN', 'x');\n");
    write('sst-env.d.ts', declaration('NEW_CORE_TOKEN'));
    git('add', '.');
    rmSync(join(directory, 'infra/newSecret.ts'));
    expect(run(true).status).toBe(0);
  });

  it('does not trust a core declaration removed from the index', () => {
    git('rm', '--cached', 'infra/secrets.ts');
    expect(run(true).status).toBe(1);
  });

  it.each([
    "// new sst.Secret('OVERLAY_PRIVATE_TOKEN', 'x');\n",
    "/* new sst.Secret('OVERLAY_PRIVATE_TOKEN', 'x'); */\n",
    "const example = \"new sst.Secret('OVERLAY_PRIVATE_TOKEN', 'x')\";\n",
    "const example = `new sst.Secret('OVERLAY_PRIVATE_TOKEN', 'x')`;\n",
  ])('ignores a constructor example in a comment or literal: %s', source => {
    write('infra/secrets.ts', source);
    write('sst-env.d.ts', declaration('OVERLAY_PRIVATE_TOKEN'));
    git('add', '.');
    expect(run().status).toBe(1);
    expect(run(true).status).toBe(1);
  });

  it('does not mistake a URL in a string for a line comment', () => {
    write('infra/secrets.ts', "const url = 'https://example.com'; new sst.Secret('CORE_TOKEN', 'x');\n");
    expect(run().status).toBe(0);
  });

  it('checks the staged declaration even when the working tree restores a safe copy', () => {
    write('sst-env.d.ts', declaration('OVERLAY_PRIVATE_TOKEN'));
    git('add', 'sst-env.d.ts');
    write('sst-env.d.ts', declaration('CORE_TOKEN'));
    expect(run(true).status).toBe(1);
  });
});
