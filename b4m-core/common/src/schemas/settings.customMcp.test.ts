import { describe, it, expect } from 'vitest';
import { isCustomMcpEnabled, parseCustomMcpPresetClients, settingsMap, userReadableSettingKeys } from './settings';
import { SettingScopeLevel } from '../types/entities/ScopedSettingTypes';

describe('EnableCustomMcpConnectors - the gate on every custom connector surface', () => {
  const entry = settingsMap.EnableCustomMcpConnectors;

  it('is off by default, including for a key never written', () => {
    expect(entry.defaultValue).toBe(false);
    expect(entry.schema.safeParse(undefined).data).toBe(false);
  });

  it('hangs off EnableMCPServer, is readable by the gallery and is a platform-only master switch', () => {
    expect(entry.dependsOn).toBe('EnableMCPServer');
    expect(userReadableSettingKeys()).toContain('EnableCustomMcpConnectors');
    expect((entry as { scope?: unknown }).scope).toBeUndefined();
  });
});

describe('isCustomMcpEnabled - platform flag AND org policy', () => {
  it.each([
    [true, { mode: 'presets_only' as const }, true],
    [true, { mode: 'any' as const }, true],
    [true, undefined, true],
    [true, { mode: 'off' as const }, false],
    [false, { mode: 'any' as const }, false],
    [undefined, { mode: 'any' as const }, false],
    [false, { mode: 'off' as const }, false],
  ])('platform %s, org %j -> %s', (flag, policy, expected) => {
    expect(isCustomMcpEnabled(flag, policy)).toBe(expected);
  });
});

describe('customMcpPolicy', () => {
  const entry = settingsMap.customMcpPolicy;

  it('defaults to presets only with the agreed limits', () => {
    expect(entry.schema.parse('{}')).toEqual({
      mode: 'presets_only',
      allowedHostPatterns: [],
      blockedHostPatterns: [],
      allowUnauthenticated: true,
      allowWriteTools: true,
      requireApprovalForAll: false,
      maxConnectionsPerUser: 20,
    });
    expect(entry.defaultValue).toEqual(entry.schema.parse({}));
  });

  it('accepts a stored org override as a JSON string', () => {
    const parsed = entry.schema.parse(JSON.stringify({ mode: 'allowlist', allowedHostPatterns: ['*.example.com'] }));
    expect(parsed).toMatchObject({ mode: 'allowlist', allowedHostPatterns: ['*.example.com'] });
  });

  it('rejects an unknown mode and an out-of-range connection cap', () => {
    expect(entry.schema.safeParse({ mode: 'everything' }).success).toBe(false);
    expect(entry.schema.safeParse({ maxConnectionsPerUser: -1 }).success).toBe(false);
    expect(entry.schema.safeParse({ maxConnectionsPerUser: 1.5 }).success).toBe(false);
  });

  it('is org-settable and not readable by members', () => {
    expect(entry.scope.settableAt).toEqual([SettingScopeLevel.Organization]);
    expect(userReadableSettingKeys()).not.toContain('customMcpPolicy');
  });
});

describe('platform-only custom MCP settings', () => {
  it.each(['customMcpBlockedHosts', 'customMcpPresetClients', 'customMcpAllowPrivateNetworks'] as const)(
    '%s has no org override and is not member-readable',
    key => {
      expect((settingsMap[key] as { scope?: unknown }).scope).toBeUndefined();
      expect(userReadableSettingKeys()).not.toContain(key);
    }
  );

  it('the kill switch and preset clients stay visible while the flag is off (no dependsOn)', () => {
    expect((settingsMap.customMcpBlockedHosts as { dependsOn?: string }).dependsOn).toBeUndefined();
    expect((settingsMap.customMcpPresetClients as { dependsOn?: string }).dependsOn).toBeUndefined();
  });

  it('customMcpBlockedHosts defaults to an empty list', () => {
    expect(settingsMap.customMcpBlockedHosts.schema.parse('{}')).toEqual({ hosts: [] });
  });

  it('customMcpPresetClients is a sensitive string', () => {
    const entry = settingsMap.customMcpPresetClients;
    expect(entry.isSensitive).toBe(true);
    expect(entry.type).toBe('string');
    expect(entry.defaultValue).toBe('');
  });

  it('customMcpAllowPrivateNetworks defaults closed and validates CIDRs', () => {
    const schema = settingsMap.customMcpAllowPrivateNetworks.schema;
    expect(schema.parse('{}')).toEqual({ cidrs: [], allowHttp: false });
    expect(schema.safeParse({ cidrs: ['10.0.0.0/8', '192.168.1.0/24', 'fd00::/8'] }).success).toBe(true);
    expect(schema.safeParse({ cidrs: ['10.0.0.0'] }).success).toBe(false);
    expect(schema.safeParse({ cidrs: ['10.0.0.0/33'] }).success).toBe(false);
    expect(schema.safeParse({ cidrs: ['example.com/8'] }).success).toBe(false);
  });
});

describe('parseCustomMcpPresetClients', () => {
  it('parses a valid map', () => {
    expect(parseCustomMcpPresetClients('{"asana":{"clientId":"id","clientSecret":"s"}}')).toEqual({
      asana: { clientId: 'id', clientSecret: 's' },
    });
  });

  it.each([undefined, '', '   ', 'not json', '{"asana":{}}', '[1]', 42])('reads %j as no clients', raw => {
    expect(parseCustomMcpPresetClients(raw)).toEqual({});
  });
});
