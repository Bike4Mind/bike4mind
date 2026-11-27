import { afterEach, describe, expect, it } from 'vitest';
import { shareFragmentCaptureScript } from '../shareFragment';

describe('shareFragmentCaptureScript', () => {
  const runCapture = () => new Function(shareFragmentCaptureScript())();

  afterEach(() => {
    delete window.__b4mShareFragment;
    window.history.replaceState(null, '', '/');
  });

  it.each(['/app/report/shared', '/other/report/shared', '/app/items/shared', '/app/report/shared/'])(
    'takes the fragment out of %s before anything else reads the location',
    path => {
      window.history.replaceState(null, '', `${path}?ref=mail#secret-token`);

      runCapture();

      expect(window.location.hash).toBe('');
      expect(window.location.href).not.toContain('secret-token');
      expect(window.location.search).toBe('?ref=mail');
      expect(window.__b4mShareFragment).toEqual({ pathname: path, hash: '#secret-token' });
    }
  );

  it.each(['/notebooks#section', '/shared-files#x', '/app/report/shared-old#x', '/app/report/shared'])(
    'leaves %s alone',
    url => {
      window.history.replaceState(null, '', url);

      runCapture();

      expect(window.location.href).toContain(url);
      expect(window.__b4mShareFragment).toBeUndefined();
    }
  );
});
