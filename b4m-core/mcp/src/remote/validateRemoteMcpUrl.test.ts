import { describe, expect, it } from 'vitest';
import { RemoteMcpInvalidUrlError, type RemoteMcpUrlRejection } from './errors';
import { validateRemoteMcpUrl, type ValidateRemoteMcpUrlOptions } from './validateRemoteMcpUrl';

function rejection(url: string, options?: ValidateRemoteMcpUrlOptions): RemoteMcpUrlRejection | 'accepted' {
  try {
    validateRemoteMcpUrl(url, options);
    return 'accepted';
  } catch (error) {
    if (error instanceof RemoteMcpInvalidUrlError) return error.reason;
    throw error;
  }
}

describe('validateRemoteMcpUrl', () => {
  it('normalizes: lowercased host, no fragment, no trailing dot', () => {
    expect(validateRemoteMcpUrl('https://MCP.Example.COM./v1/mcp?x=1#frag').href).toBe(
      'https://mcp.example.com/v1/mcp?x=1'
    );
  });

  it.each([
    ['https with a path', 'https://mcp.linear.app/mcp'],
    ['explicit 443', 'https://mcp.example.com:443/mcp'],
    ['high port', 'https://mcp.example.com:8443/mcp'],
  ])('accepts %s', (_label, url) => {
    expect(rejection(url)).toBe('accepted');
  });

  it.each([
    ['not a URL', 'mcp.example.com/mcp', 'malformed'],
    ['plain http', 'http://mcp.example.com/mcp', 'scheme'],
    ['ftp', 'ftp://mcp.example.com/', 'scheme'],
    ['userinfo', 'https://user:pass@mcp.example.com/mcp', 'userinfo'],
    ['username only', 'https://user@mcp.example.com/mcp', 'userinfo'],
  ] as const)('rejects %s', (_label, url, reason) => {
    expect(rejection(url)).toBe(reason);
  });

  it.each([
    ['dotted IPv4', 'https://93.184.216.34/mcp'],
    ['loopback', 'https://127.0.0.1/mcp'],
    ['metadata', 'https://169.254.169.254/latest/meta-data'],
    ['decimal IPv4', 'https://2130706433/mcp'],
    ['decimal metadata', 'https://2852039166/'],
    ['octal IPv4', 'https://0177.0.0.1/mcp'],
    ['hex IPv4', 'https://0x7f.0x0.0x0.0x1/mcp'],
    ['hex whole', 'https://0x7f000001/mcp'],
    ['short form', 'https://127.1/mcp'],
    ['IPv6 loopback', 'https://[::1]/mcp'],
    ['public IPv6', 'https://[2606:4700:4700::1111]/mcp'],
    ['IPv4-mapped IPv6 dotted', 'https://[::ffff:169.254.169.254]/'],
    ['IPv4-mapped IPv6 hex', 'https://[::ffff:a9fe:a9fe]/'],
    ['unique-local IPv6', 'https://[fd00::1]/'],
  ])('rejects an IP literal: %s', (_label, url) => {
    expect(rejection(url)).toBe('ip_literal');
  });

  it.each([
    ['localhost', 'https://localhost/mcp'],
    ['localhost with trailing dot', 'https://localhost./mcp'],
    ['subdomain of localhost', 'https://app.localhost/mcp'],
    ['.local', 'https://printer.local/mcp'],
    ['.internal', 'https://api.corp.internal/mcp'],
    ['GCP metadata', 'https://metadata.google.internal/'],
    ['single label', 'https://intranet/mcp'],
    ['k8s service', 'https://svc.default.svc.cluster.local/'],
    ['home.arpa', 'https://nas.home.arpa/'],
  ])('rejects an internal hostname: %s', (_label, url) => {
    expect(rejection(url)).toBe('internal_hostname');
  });

  it('rejects own hosts and their subdomains, given as hosts or URLs', () => {
    const options = { ownHosts: ['https://app.bike4mind.com', 'cdn.bike4mind.com'] };
    expect(rejection('https://app.bike4mind.com/api/mcp', options)).toBe('own_host');
    expect(rejection('https://APP.bike4mind.com./x', options)).toBe('own_host');
    expect(rejection('https://edge.cdn.bike4mind.com/x', options)).toBe('own_host');
    expect(rejection('https://bike4mind.com/x', options)).toBe('accepted');
    expect(rejection('https://notapp.bike4mind.com.evil.example/x', options)).toBe('accepted');
  });

  it.each([
    ['22', 'https://mcp.example.com:22/', 'port'],
    ['80 on https', 'https://mcp.example.com:80/', 'port'],
    ['1023', 'https://mcp.example.com:1023/', 'port'],
    ['1024', 'https://mcp.example.com:1024/', 'accepted'],
  ] as const)('port %s', (_label, url, expected) => {
    expect(rejection(url)).toBe(expected);
  });

  describe('self-host opt-in', () => {
    const selfHost = { allowHttp: true, allowPrivateCidrs: ['10.20.0.0/16'] };

    it('accepts http and an IP literal inside an allowed CIDR', () => {
      expect(rejection('http://10.20.1.5:8080/mcp', selfHost)).toBe('accepted');
      expect(rejection('http://mcp.lan:8080/mcp', selfHost)).toBe('accepted');
    });

    it('still rejects literals outside the CIDRs, loopback, metadata and localhost', () => {
      expect(rejection('http://10.21.0.1/mcp', selfHost)).toBe('ip_literal');
      expect(rejection('http://127.0.0.1:8080/mcp', { ...selfHost, allowPrivateCidrs: ['127.0.0.0/8'] })).toBe(
        'ip_literal'
      );
      expect(rejection('http://169.254.169.254/', { ...selfHost, allowPrivateCidrs: ['169.254.0.0/16'] })).toBe(
        'ip_literal'
      );
      expect(rejection('http://localhost:8080/mcp', selfHost)).toBe('internal_hostname');
      expect(rejection('http://metadata.google.internal/', selfHost)).toBe('internal_hostname');
    });
  });
});
