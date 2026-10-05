import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { pathToFileURL } from 'url';
import { isDirectInvocation } from '../isDirectInvocation';

let dir: string;
let originalArgv1: string | undefined;

beforeEach(() => {
  // realpath the tmp root: on macOS os.tmpdir() is itself under a symlink (/var -> /private/var).
  dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'is-direct-invocation-')));
  originalArgv1 = process.argv[1];
});

afterEach(() => {
  process.argv[1] = originalArgv1 as string;
  fs.rmSync(dir, { recursive: true, force: true });
});

describe('isDirectInvocation', () => {
  it('is true when argv[1] is the module itself', () => {
    const script = path.join(dir, 'script.ts');
    fs.writeFileSync(script, '');
    process.argv[1] = script;
    expect(isDirectInvocation(pathToFileURL(script).href)).toBe(true);
  });

  it('is true when launched through a symlinked directory', () => {
    const realDir = path.join(dir, 'real');
    fs.mkdirSync(realDir);
    const script = path.join(realDir, 'script.ts');
    fs.writeFileSync(script, '');
    const linkDir = path.join(dir, 'link');
    fs.symlinkSync(realDir, linkDir);
    process.argv[1] = path.join(linkDir, 'script.ts');
    expect(isDirectInvocation(pathToFileURL(script).href)).toBe(true);
  });

  it('is true regardless of file extension, so a compiled copy still runs', () => {
    const script = path.join(dir, 'script.js');
    fs.writeFileSync(script, '');
    process.argv[1] = script;
    expect(isDirectInvocation(pathToFileURL(script).href)).toBe(true);
  });

  it('is false when another script is the entrypoint (module was imported)', () => {
    const script = path.join(dir, 'script.ts');
    const other = path.join(dir, 'other.ts');
    fs.writeFileSync(script, '');
    fs.writeFileSync(other, '');
    process.argv[1] = other;
    expect(isDirectInvocation(pathToFileURL(script).href)).toBe(false);
  });

  it('is false when argv[1] is missing or does not exist', () => {
    const script = path.join(dir, 'script.ts');
    fs.writeFileSync(script, '');
    process.argv[1] = undefined as unknown as string;
    expect(isDirectInvocation(pathToFileURL(script).href)).toBe(false);
    process.argv[1] = path.join(dir, 'missing.ts');
    expect(isDirectInvocation(pathToFileURL(script).href)).toBe(false);
  });
});
