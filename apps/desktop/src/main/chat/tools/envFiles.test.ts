import { describe, expect, it } from 'vitest';
import { isEnvFile } from './envFiles';

describe('isEnvFile', () => {
  it.each(['/p/.env', '/p/.env.local', '/p/.env.production', '/p/app.env', '/p/sub/.env.test.local'])(
    '%s is a .env file',
    path => expect(isEnvFile(path)).toBe(true)
  );

  it.each(['/p/.env.example', '/p/environment.ts', '/p/env', '/p/src/.environment', '/p/notes.txt'])(
    '%s is not',
    path => expect(isEnvFile(path)).toBe(false)
  );
});
