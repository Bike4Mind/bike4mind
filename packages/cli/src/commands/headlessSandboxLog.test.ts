import { describe, it, expect, vi, afterEach } from 'vitest';
import { headlessSandboxLog } from './headlessCommand.js';

describe('headlessSandboxLog', () => {
  afterEach(() => vi.restoreAllMocks());

  it('routes both info and warn to stderr, never stdout (NDJSON runs on stdout)', () => {
    const err = vi.spyOn(process.stderr, 'write').mockReturnValue(true);
    const out = vi.spyOn(process.stdout, 'write').mockReturnValue(true);

    headlessSandboxLog.info('status line');
    headlessSandboxLog.warn('warning line');

    expect(err).toHaveBeenCalledWith('status line\n');
    expect(err).toHaveBeenCalledWith('warning line\n');
    // Routing either sink to stdout would corrupt the headless NDJSON protocol.
    expect(out).not.toHaveBeenCalled();
  });
});
