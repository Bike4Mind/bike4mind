import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { debug, debugError, debugWarn } from '../logger.js';

describe('notion debug logger', () => {
  let stderr: ReturnType<typeof vi.spyOn>;
  let stdout: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    stdout = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    vi.stubEnv('NOTION_DEBUG', '1');
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  const lines = () => stderr.mock.calls.map(([chunk]) => JSON.parse(String(chunk)));

  it('writes one redacted JSON line to stderr and nothing to stdout', () => {
    debug('request', { token: 'abc-secret-value', pageId: 'p1' });

    expect(lines()).toHaveLength(1);
    expect(lines()[0]).toMatchObject({ severity: 'debug', scope: 'notion', msg: 'request' });
    expect(lines()[0].detail).toEqual({ token: '[REDACTED]', pageId: 'p1' });
    expect(String(stderr.mock.calls[0][0])).not.toContain('abc-secret-value');
    expect(stdout).not.toHaveBeenCalled();
  });

  it('keeps the warn and error levels and serializes errors', () => {
    debugWarn('slow');
    debugError('boom', new Error('failed for a@example.com'));

    const [warn, error] = lines();
    expect(warn).toMatchObject({ severity: 'warn', msg: 'slow' });
    expect(error).toMatchObject({ severity: 'error', msg: 'boom' });
    expect(error.error.message).toBe('failed for ***@example.com');
    expect(stdout).not.toHaveBeenCalled();
  });

  it('is silent unless NOTION_DEBUG is set', () => {
    vi.stubEnv('NOTION_DEBUG', '');
    debug('x', { a: 1 });
    debugWarn('x');
    debugError('x');
    expect(stderr).not.toHaveBeenCalled();
  });
});
