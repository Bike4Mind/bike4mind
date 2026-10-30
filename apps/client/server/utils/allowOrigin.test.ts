import { afterEach, describe, expect, it, vi } from 'vitest';
import { setAllowOrigin } from './allowOrigin';

function capture() {
  const headers: Record<string, string> = {};
  const res = {
    setHeader: (k: string, v: string) => {
      headers[k] = v;
    },
  };
  return { headers, res };
}

const fromBrowser = { headers: { origin: 'https://example.com' } };
const noOrigin = { headers: {} };

describe('setAllowOrigin', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('sets the header off Lambda (Fargate, self-host, local dev)', () => {
    vi.stubEnv('AWS_LAMBDA_FUNCTION_NAME', '');
    const { headers, res } = capture();

    setAllowOrigin(fromBrowser, res, 'https://example.com');

    expect(headers['Access-Control-Allow-Origin']).toBe('https://example.com');
  });

  it('leaves a browser request to the function URL on Lambda, so the response carries one value', () => {
    vi.stubEnv('AWS_LAMBDA_FUNCTION_NAME', 'frontend-server');
    const { headers, res } = capture();

    setAllowOrigin(fromBrowser, res, 'https://example.com');

    expect(headers).not.toHaveProperty('Access-Control-Allow-Origin');
  });

  it('still sets it on Lambda when the request has no Origin, which the function URL skips', () => {
    vi.stubEnv('AWS_LAMBDA_FUNCTION_NAME', 'frontend-server');
    const { headers, res } = capture();

    setAllowOrigin(noOrigin, res, '*');

    expect(headers['Access-Control-Allow-Origin']).toBe('*');
  });
});
