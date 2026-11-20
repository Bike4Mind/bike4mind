// @vitest-environment node
import { describe, expect, it, vi } from 'vitest';
import { BadRequestError } from '@bike4mind/common';

vi.mock('@bike4mind/server-utils/security/tokenEncryption', () => ({
  encryptToken: (value: string) => `enc:${Buffer.from(value).toString('base64')}`,
}));

const { prepareConnectionUrl } = await import('./connectionUrl');

const hosted = { ownHosts: ['app.example.com', 'cdn.example.net'] };

function rejection(raw: string, network: Parameters<typeof prepareConnectionUrl>[1] = hosted): unknown {
  try {
    prepareConnectionUrl(raw, network);
  } catch (error) {
    return error;
  }
  return undefined;
}

describe('prepareConnectionUrl', () => {
  it('derives the stored fields: encrypted URL, masked display URL, host without the port', () => {
    const prepared = prepareConnectionUrl(
      'https://MCP.Example.com:8443/v1/abcdefghijklmnopqrstuvwxyz?key=secret#frag',
      hosted
    );
    expect(prepared.url).toBe('https://mcp.example.com:8443/v1/abcdefghijklmnopqrstuvwxyz?key=secret');
    expect(prepared.urlHost).toBe('mcp.example.com');
    expect(prepared.displayUrl).toBe('https://mcp.example.com:8443/v1/...wxyz');
    expect(prepared.urlEnc).toMatch(/^enc:/);
    expect(prepared.urlEnc).not.toContain('secret');
    expect(prepared.displayUrl).not.toContain('secret');
  });

  it.each([
    ['https://app.example.com/mcp', 'own_host'],
    ['https://api.app.example.com/mcp', 'own_host'],
    ['https://cdn.example.net/mcp', 'own_host'],
    ['http://mcp.example.com/mcp', 'scheme'],
    ['https://user:pass@mcp.example.com/', 'userinfo'],
    ['https://10.0.0.5/mcp', 'ip_literal'],
    ['https://localhost/mcp', 'internal_hostname'],
    ['https://mcp.example.com:22/', 'port'],
    ['not a url', 'malformed'],
  ])('refuses %j on hosted with a 400 naming the reason %s', (raw, reason) => {
    const error = rejection(raw);
    expect(error).toBeInstanceOf(BadRequestError);
    expect((error as BadRequestError).additionalInfo).toEqual({ code: 'invalid_url', reason });
  });

  it('admits http and an IP inside an allowed private CIDR only with the self-host opt-in', () => {
    const selfHost = { ownHosts: [], allowPrivateCidrs: ['10.20.0.0/16'], allowHttp: true };
    expect(prepareConnectionUrl('http://10.20.1.5:8080/mcp', selfHost).urlHost).toBe('10.20.1.5');
    expect((rejection('http://10.30.1.5/mcp', selfHost) as BadRequestError).additionalInfo).toMatchObject({
      reason: 'ip_literal',
    });
    expect((rejection('http://10.20.1.5/mcp') as BadRequestError).additionalInfo).toMatchObject({ reason: 'scheme' });
  });
});
