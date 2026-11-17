import { describe, it, expect, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { FAIL_MB, WARN_MB, classify, formatReport, publishablePackages } from '../check-npm-metadata-size.mjs';

const MB = 1024 * 1024;
const roots = [];

afterEach(() => {
  while (roots.length) fs.rmSync(roots.pop(), { recursive: true, force: true });
});

function makeRepo(manifests) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'npm-metadata-size-'));
  roots.push(root);
  for (const [dir, manifest] of Object.entries(manifests)) {
    fs.mkdirSync(path.join(root, dir), { recursive: true });
    fs.writeFileSync(path.join(root, dir, 'package.json'), JSON.stringify(manifest));
  }
  return root;
}

describe('publishablePackages', () => {
  it('lists packages with a publishConfig that are not private, sorted', () => {
    const root = makeRepo({
      'b4m-core/utils': { name: '@scope/utils', publishConfig: { access: 'restricted' } },
      'packages/cli': { name: '@scope/cli', publishConfig: { access: 'public' } },
      'packages/config': { name: '@scope/config', private: true, publishConfig: { access: 'public' } },
      'packages/scripts': { name: '@scope/scripts' },
    });
    expect(publishablePackages(root)).toEqual(['@scope/cli', '@scope/utils']);
  });

  it('returns nothing when neither package root exists', () => {
    expect(publishablePackages(makeRepo({}))).toEqual([]);
  });
});

describe('classify', () => {
  it('is ok below the warning tier', () => {
    expect(classify(WARN_MB * MB - 1)).toBe('ok');
  });

  it('warns from the warning tier up to the failure tier', () => {
    expect(classify(WARN_MB * MB)).toBe('warn');
    expect(classify(FAIL_MB * MB - 1)).toBe('warn');
  });

  it('fails from the failure tier up', () => {
    expect(classify(FAIL_MB * MB)).toBe('fail');
  });
});

describe('formatReport', () => {
  it('orders by size and puts unreadable packages last', () => {
    const report = formatReport([
      { name: '@scope/small', bytes: 5 * MB, versions: 10, status: 'ok' },
      { name: '@scope/hidden', error: 'HTTP 404' },
      { name: '@scope/large', bytes: 95 * MB, versions: 9000, status: 'fail' },
    ]);
    const rows = report.split('\n').slice(2);
    expect(rows).toEqual([
      '| @scope/large | 95.0 MB | 9000 | fail |',
      '| @scope/small | 5.0 MB | 10 | ok |',
      '| @scope/hidden | - | - | unreadable: HTTP 404 |',
    ]);
  });
});
