import { getMcpPresetHost, type McpConnectionOwnerType } from '@bike4mind/common';

/**
 * The host `presets_only` admits for a connection, passed to `evaluateConnectionPolicy` as
 * `presetRemoteHost`. A platform connector is the deployment's own catalog entry, so its host is
 * its preset host: the default mode admits it, while the platform blocklist and an org's `off`
 * mode, blocked hosts and allowlist still apply to it.
 */
export function policyPresetHost(connection: {
  ownerType?: McpConnectionOwnerType;
  urlHost: string;
  presetId?: string;
}): string | undefined {
  return connection.ownerType === 'platform' ? connection.urlHost : getMcpPresetHost(connection.presetId);
}
