import { describe, it, expect } from 'vitest';
import { DEFAULT_SANDBOX_CONFIG } from './types.js';

describe('DEFAULT_SANDBOX_CONFIG filesystem defaults', () => {
  const { allowedReadPaths, deniedPaths } = DEFAULT_SANDBOX_CONFIG.filesystem;

  it('does not allow reading the npm credential file', () => {
    expect(allowedReadPaths).not.toContain('$HOME/.npmrc');
    expect(deniedPaths).toContain('$HOME/.npmrc');
  });

  it.each([
    '$HOME/.netrc',
    '$HOME/.config/gh',
    '$HOME/.docker',
    '$HOME/.kube',
    '$HOME/.config/gcloud',
    '$HOME/.azure',
    '$HOME/.bike4mind',
  ])('denies %s', p => {
    expect(deniedPaths).toContain(p);
  });
});
