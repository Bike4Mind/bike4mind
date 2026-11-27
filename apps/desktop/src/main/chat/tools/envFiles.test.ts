import { describe, expect, it } from 'vitest';
import { isEnvFile } from './envFiles';

describe('isEnvFile', () => {
  it.each([
    '/p/.env::$DATA',
    '/p/.env:stream',
    '/p/.env:stream:$DATA',
    '/p/.env.local::$DATA',
    '/p/.env.',
    '/p/.env..',
    '/p/.env ',
    '/p/.env. .',
    '/p/.ENV',
    '/p/.Env.Local',
    'C:\\p\\.env::$DATA',
    'C:\\p\\.ENV.',
    '/p/.env./x.txt',
    'C:\\p\\.env\\.',
    '.env/.',
    '/p/./.env',
    'C:.env::$DATA',
    'C:.env:s',
    'HEAD:.env.local:s',
    '.env/x/..',
    'C:\\p\\.env\\x\\..',
  ])('%s is a .env file', path => expect(isEnvFile(path)).toBe(true));

  it.each(['HEAD:.env', 'origin/main:.env.production', 'host:.env', 'C:.env', 'ns/pod:.env', '/p/notes.txt:.env'])(
    '%s is a .env file read as a revision, host or drive path',
    path => expect(isEnvFile(path)).toBe(true)
  );

  it.each(['my.env.d', '.env.sample', '.env.example.local'])('%s holds .env. and counts', path =>
    expect(isEnvFile(path)).toBe(true)
  );

  it.each([
    '/p/.env.example::$DATA',
    '/p/.env.example.',
    '/p/.ENV.EXAMPLE',
    'HEAD:.env.example',
    '.environment',
    'C:notes.txt:s',
    'src/.env/../app.ts',
  ])('%s is not', path => expect(isEnvFile(path)).toBe(false));

  it.each(['/p/.env', '/p/.env.local', '/p/.env.production', '/p/app.env', '/p/sub/.env.test.local'])(
    '%s is a .env file',
    path => expect(isEnvFile(path)).toBe(true)
  );

  it.each(['/p/.env.example', '/p/environment.ts', '/p/env', '/p/src/.environment', '/p/notes.txt'])(
    '%s is not',
    path => expect(isEnvFile(path)).toBe(false)
  );
});
