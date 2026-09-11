import { describe, it, expect } from 'vitest';
import { existsSync, readdirSync, readFileSync } from 'fs';
import path from 'path';
import { McpServerName } from '@bike4mind/common';
import {
  MCP_SERVER_ENV_KEYS,
  buildMcpChildEnv,
  findForbiddenMcpEnvKeys,
  isCodeInjectingMcpEnvKey,
  isForbiddenMcpEnvKey,
} from './childEnv';
import { mcpSettings } from './settings';

describe('buildMcpChildEnv', () => {
  it('passes only the named server declared variables', () => {
    const { env, droppedKeys } = buildMcpChildEnv({
      serverName: McpServerName.Github,
      envVariables: [
        { key: 'GITHUB_ACCESS_TOKEN', value: 'gho_abc' },
        { key: 'ATLASSIAN_ACCESS_TOKEN', value: 'not-this-servers' },
        { key: 'STRIPE_SECRET_KEY', value: 'sk_live' },
      ],
    });

    expect(env).toEqual({ GITHUB_ACCESS_TOKEN: 'gho_abc' });
    expect(droppedKeys).toEqual(['ATLASSIAN_ACCESS_TOKEN', 'STRIPE_SECRET_KEY']);
  });

  it('never inherits the host environment', () => {
    const { env } = buildMcpChildEnv({
      serverName: McpServerName.Notion,
      envVariables: [{ key: 'NOTION_ACCESS_TOKEN', value: 'secret_x' }],
    });

    // The transport layers the SDK's own curated defaults (PATH, HOME, ...) underneath this;
    // nothing else from the calling process may appear.
    expect(Object.keys(env)).toEqual(['NOTION_ACCESS_TOKEN']);
  });

  it('withholds NODE_OPTIONS from a declared server even when it is stored', () => {
    const { env, droppedKeys } = buildMcpChildEnv({
      serverName: McpServerName.Notion,
      envVariables: [
        { key: 'NOTION_ACCESS_TOKEN', value: 'secret_x' },
        { key: 'NODE_OPTIONS', value: '--require /tmp/payload.js' },
      ],
    });

    expect(env.NODE_OPTIONS).toBeUndefined();
    expect(droppedKeys).toEqual(['NODE_OPTIONS']);
  });

  it('falls back to refusing code-injecting keys for a caller-defined server with no contract', () => {
    const { env, droppedKeys } = buildMcpChildEnv({
      serverName: 'some-third-party-server',
      envVariables: [
        { key: 'THIRD_PARTY_TOKEN', value: 'abc' },
        { key: 'NODE_OPTIONS', value: '--require /tmp/payload.js' },
        { key: 'LD_PRELOAD', value: '/tmp/evil.so' },
      ],
    });

    expect(env).toEqual({ THIRD_PARTY_TOKEN: 'abc' });
    expect(droppedKeys).toEqual(['NODE_OPTIONS', 'LD_PRELOAD']);
  });

  // The owner of a `b4m` CLI config already picks the binary and its argv, so a PATH or proxy
  // they set is configuration, not an escalation - and withholding it breaks a wrapper script or
  // a corporate proxy for no gain. Only the code-injecting keys are still refused here.
  it('lets a caller-defined command keep PATH and the proxy variables', () => {
    const { env, droppedKeys } = buildMcpChildEnv({
      serverName: 'some-third-party-server',
      hasCustomCommand: true,
      envVariables: [
        { key: 'HTTPS_PROXY', value: 'http://corp-proxy.internal:8080' },
        { key: 'PATH', value: '/opt/wrapper/bin' },
        { key: 'NODE_OPTIONS', value: '--require /tmp/payload.js' },
      ],
    });

    expect(env).toEqual({ HTTPS_PROXY: 'http://corp-proxy.internal:8080', PATH: '/opt/wrapper/bin' });
    expect(droppedKeys).toEqual(['NODE_OPTIONS']);
  });

  // The documented CLI config points `name: "github"` at the upstream Docker image, which reads
  // GITHUB_TOKEN - a name our bundled server never declares. Applying our table to someone
  // else's program would silently start it with no credential at all.
  it('does not apply a bundled server declared keys to a caller-supplied command', () => {
    const { env, droppedKeys } = buildMcpChildEnv({
      serverName: McpServerName.Github,
      hasCustomCommand: true,
      envVariables: [
        { key: 'GITHUB_TOKEN', value: 'ghp_abc' },
        { key: 'NODE_OPTIONS', value: '--require /tmp/payload.js' },
      ],
    });

    expect(env).toEqual({ GITHUB_TOKEN: 'ghp_abc' });
    expect(droppedKeys).toEqual(['NODE_OPTIONS']);
  });

  it('accepts every variable each provider integration actually writes', () => {
    // The exact key sets written by the OAuth token managers and the manual settings form.
    const stored: Record<McpServerName, string[]> = {
      [McpServerName.Github]: ['GITHUB_ACCESS_TOKEN'],
      [McpServerName.Atlassian]: ['ATLASSIAN_ACCESS_TOKEN', 'ATLASSIAN_CLOUD_ID', 'ATLASSIAN_SITE_URL'],
      [McpServerName.LinkedIn]: ['LINKEDIN_ACCESS_TOKEN', 'COMPANY_NAME'],
      [McpServerName.Notion]: [
        'NOTION_ACCESS_TOKEN',
        'NOTION_WORKSPACE_ID',
        'NOTION_WRITE_ENABLED',
        'NOTION_ROOT_PAGE_ID',
        'NOTION_ACCESS_MODE',
        'NOTION_ALLOWED_PAGES',
        'NOTION_EXCLUDED_PAGE_IDS',
      ],
    };

    for (const [name, keys] of Object.entries(stored)) {
      const { droppedKeys } = buildMcpChildEnv({
        serverName: name,
        envVariables: keys.map(key => ({ key, value: 'v' })),
      });
      expect(droppedKeys, `${name} would lose stored variables`).toEqual([]);
    }
  });
});

describe('isForbiddenMcpEnvKey', () => {
  it.each([
    'NODE_OPTIONS',
    'node_options',
    'NODE_EXTRA_CA_CERTS',
    'ELECTRON_RUN_AS_NODE',
    'LD_PRELOAD',
    'DYLD_INSERT_LIBRARIES',
    'PATH',
    'HTTPS_PROXY',
    'no_proxy',
    'npm_config_registry',
  ])('refuses %s', key => {
    expect(isForbiddenMcpEnvKey(key)).toBe(true);
  });

  it.each(['GITHUB_ACCESS_TOKEN', 'NOTION_ACCESS_TOKEN', 'NOTION_DEBUG', 'COMPANY_NAME'])('allows %s', key => {
    expect(isForbiddenMcpEnvKey(key)).toBe(false);
  });

  it('sees through surrounding whitespace', () => {
    expect(isForbiddenMcpEnvKey(' NODE_OPTIONS ')).toBe(true);
    expect(findForbiddenMcpEnvKeys([{ key: 'OK' }, { key: '\tNODE_OPTIONS' }])).toEqual(['\tNODE_OPTIONS']);
  });
});

describe('isCodeInjectingMcpEnvKey', () => {
  it.each([
    'NODE_OPTIONS',
    'node_options',
    'NODE_EXTRA_CA_CERTS',
    'ELECTRON_RUN_AS_NODE',
    'LD_PRELOAD',
    'DYLD_INSERT_LIBRARIES',
  ])('refuses %s', key => {
    expect(isCodeInjectingMcpEnvKey(key)).toBe(true);
  });

  // The narrower half of the write-time denylist: these steer resolution rather than execution,
  // so a caller-supplied command keeps them.
  it.each(['PATH', 'PATHEXT', 'HTTPS_PROXY', 'no_proxy', 'npm_config_registry', 'GLOBAL_AGENT_HTTP_PROXY'])(
    'allows %s through, though a stored record still cannot set it',
    key => {
      expect(isCodeInjectingMcpEnvKey(key)).toBe(false);
      expect(isForbiddenMcpEnvKey(key)).toBe(true);
    }
  );
});

describe('MCP_SERVER_ENV_KEYS stays in sync with the server code', () => {
  const packageSrc = path.resolve(import.meta.dirname);
  const commonSrc = path.resolve(packageSrc, '../../common/src');

  /**
   * Directories to scan per server. A server's own directory plus the `@bike4mind/common`
   * provider modules it reads its credentials through - `atlassian/config.ts` gets its three
   * variables from `common/src/atlassian/config.ts`, not from anything under `mcp/src/atlassian`.
   */
  const scannedDirs: Record<McpServerName, string[]> = {
    [McpServerName.Github]: [path.join(packageSrc, McpServerName.Github)],
    [McpServerName.Notion]: [path.join(packageSrc, McpServerName.Notion)],
    [McpServerName.LinkedIn]: [path.join(packageSrc, McpServerName.LinkedIn), path.join(commonSrc, 'linkedin')],
    [McpServerName.Atlassian]: [
      path.join(packageSrc, McpServerName.Atlassian),
      path.join(commonSrc, 'atlassian'),
      path.join(commonSrc, 'jira'),
      path.join(commonSrc, 'confluence'),
    ],
  };

  /**
   * Every literal `process.env` read under a directory, tests excluded. Both access forms are
   * matched, but a computed key is not resolvable by any scan - `common/src/atlassian/config.ts`
   * reads `process.env[key]` from a caller-passed name, so its three ATLASSIAN_* variables are
   * pinned by the settings assertion below rather than by this one.
   */
  const envReads = (dir: string): Set<string> => {
    const found = new Set<string>();
    if (!existsSync(dir)) return found;
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.name === '__tests__') continue;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        envReads(full).forEach(key => found.add(key));
        continue;
      }
      if (!entry.name.endsWith('.ts') || entry.name.endsWith('.test.ts')) continue;
      const source = readFileSync(full, 'utf8');
      for (const match of source.matchAll(/process\.env(?:\.([A-Z0-9_]+)|\[['"]([A-Z0-9_]+)['"]\])/g)) {
        found.add(match[1] ?? match[2]);
      }
    }
    return found;
  };

  for (const name of Object.values(McpServerName)) {
    it(`${name} declares every variable its server reads`, () => {
      const declared = MCP_SERVER_ENV_KEYS[name];
      const read = new Set(scannedDirs[name].flatMap(dir => [...envReads(dir)]));
      const missing = [...read].filter(key => !declared.includes(key));
      expect(missing, `${name} reads these but childEnv.ts withholds them`).toEqual([]);
    });
  }

  it('declares every variable this package settings table offers', () => {
    for (const [name, settings] of Object.entries(mcpSettings)) {
      const declared = (MCP_SERVER_ENV_KEYS as Record<string, readonly string[] | undefined>)[name];
      if (!declared) continue;
      const offered = settings.envVariables.map(definition =>
        typeof definition === 'string' ? definition : definition.key
      );
      expect(
        offered.filter(key => !declared.includes(key)),
        `${name} offers undeliverable keys`
      ).toEqual([]);
    }
  });
});
