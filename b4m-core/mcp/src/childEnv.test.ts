import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync } from 'fs';
import path from 'path';
import { McpServerName } from '@bike4mind/common';
import { MCP_SERVER_ENV_KEYS, buildMcpChildEnv, findForbiddenMcpEnvKeys, isForbiddenMcpEnvKey } from './childEnv';
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

  it('falls back to refusing runtime keys for a caller-defined server with no declared contract', () => {
    const { env, droppedKeys } = buildMcpChildEnv({
      serverName: 'some-third-party-server',
      envVariables: [
        { key: 'THIRD_PARTY_TOKEN', value: 'abc' },
        { key: 'NODE_OPTIONS', value: '--require /tmp/payload.js' },
        { key: 'HTTPS_PROXY', value: 'http://attacker.example' },
        { key: 'PATH', value: '/tmp/bin' },
      ],
    });

    expect(env).toEqual({ THIRD_PARTY_TOKEN: 'abc' });
    expect(droppedKeys).toEqual(['NODE_OPTIONS', 'HTTPS_PROXY', 'PATH']);
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

describe('MCP_SERVER_ENV_KEYS stays in sync with the server code', () => {
  const serverDir = (name: string) => path.resolve(import.meta.dirname, name);

  /** Every `process.env.X` read under a server directory, tests excluded. */
  const envReads = (dir: string): Set<string> => {
    const found = new Set<string>();
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.name === '__tests__') continue;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        envReads(full).forEach(key => found.add(key));
        continue;
      }
      if (!entry.name.endsWith('.ts') || entry.name.endsWith('.test.ts')) continue;
      for (const match of readFileSync(full, 'utf8').matchAll(/process\.env\.([A-Z0-9_]+)/g)) {
        found.add(match[1]);
      }
    }
    return found;
  };

  for (const name of Object.values(McpServerName)) {
    it(`${name} declares every variable its server reads`, () => {
      const declared = MCP_SERVER_ENV_KEYS[name];
      const missing = [...envReads(serverDir(name))].filter(key => !declared.includes(key));
      expect(missing, `${name} reads these but childEnv.ts withholds them`).toEqual([]);
    });
  }

  it('declares every variable the settings form offers', () => {
    for (const [name, settings] of Object.entries(mcpSettings)) {
      const declared = (MCP_SERVER_ENV_KEYS as Record<string, readonly string[] | undefined>)[name];
      if (!declared) continue;
      const offered = settings.envVariables.map(definition =>
        typeof definition === 'string' ? definition : definition.key
      );
      expect(
        offered.filter(key => !declared.includes(key)),
        `${name} settings form offers undeliverable keys`
      ).toEqual([]);
    }
  });
});
