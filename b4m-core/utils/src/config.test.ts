import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';

// The shared utils barrel used to run dotenv.config() at import, which auto-loaded
// a cwd-relative .env for every one of the 600+ importers. The CLI was the only
// consumer relying on it, and a hostile clone's .env could inject host-integration
// vars (CLAUDE_PEON_DIR, etc.). These tests pin the removal: importing config
// reads no .env, and initializeConfig still resolves from the real process env.

describe('config: no dotenv auto-load', () => {
  let tmp: string;
  let origCwd: string;
  const PROBE = 'B4M_DOTENV_AUTOLOAD_PROBE';

  beforeEach(() => {
    origCwd = process.cwd();
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'b4m-config-'));
    fs.writeFileSync(path.join(tmp, '.env'), `${PROBE}=leaked\n`, 'utf-8');
    process.chdir(tmp);
    delete process.env[PROBE];
  });

  afterEach(() => {
    process.chdir(origCwd);
    fs.rmSync(tmp, { recursive: true, force: true });
    delete process.env[PROBE];
  });

  it('does not auto-load a cwd .env when the module is imported', async () => {
    await import('./config.js');
    expect(process.env[PROBE]).toBeUndefined();
  });

  it('initializeConfig reads from process.env first, with a fallback', async () => {
    const { initializeConfig } = await import('./config.js');
    process.env.SOME_KEY = 'from-env';
    try {
      const cfg = initializeConfig({ SOME_KEY: 'fallback', OTHER: 'fb' });
      expect((cfg as Record<string, string>).SOME_KEY).toBe('from-env');
      expect((cfg as Record<string, string>).OTHER).toBe('fb');
    } finally {
      delete process.env.SOME_KEY;
    }
  });
});
