/**
 * Manifest Comparator
 *
 * Compares a live Slack app manifest (from apps.manifest.export) against
 * our controlled fields to detect drift. Also provides merge logic to
 * update only the fields we control while preserving user customizations.
 */

import { getControlledManifestFields } from './manifestTemplate';
import { ManifestDifference } from '@bike4mind/common';

export type { ManifestDifference };

export interface CompareResult {
  isUpToDate: boolean;
  differences: ManifestDifference[];
}

/**
 * Extract the path portion from a URL, ignoring protocol and domain.
 * Used for comparing URLs across different environments.
 */
function extractPath(url: string): string {
  try {
    return new URL(url).pathname;
  } catch {
    return url;
  }
}

/**
 * Compare two string arrays in an order-independent way.
 * Returns true if they contain the same elements.
 */
function arraysEqual(a: string[], b: string[]): boolean {
  if (a.length !== b.length) return false;
  const sortedA = [...a].sort();
  const sortedB = [...b].sort();
  return sortedA.every((val, idx) => val === sortedB[idx]);
}

/**
 * Compare slash commands, ignoring URL domain (only comparing paths).
 * Commands are matched by their command name.
 */
function compareSlashCommands(
  liveCommands: Array<Record<string, unknown>>,
  expectedCommands: Array<{ command: string; url: string; description: string; should_escape: boolean }>
): ManifestDifference[] {
  const differences: ManifestDifference[] = [];

  // Check for missing commands
  for (const expected of expectedCommands) {
    const live = liveCommands.find(c => c.command === expected.command);
    if (!live) {
      differences.push({
        field: `features.slash_commands[${expected.command}]`,
        expected: expected,
        actual: undefined,
      });
      continue;
    }

    // Compare URL path only
    if (extractPath(live.url as string) !== extractPath(expected.url)) {
      differences.push({
        field: `features.slash_commands[${expected.command}].url`,
        expected: extractPath(expected.url),
        actual: extractPath(live.url as string),
      });
    }

    // Compare description
    if (live.description !== expected.description) {
      differences.push({
        field: `features.slash_commands[${expected.command}].description`,
        expected: expected.description,
        actual: live.description,
      });
    }
  }

  // Extra commands in live are not flagged: we only control our own commands.

  return differences;
}

/**
 * Compare a live manifest against our expected controlled fields.
 * Only compares fields we control - user-customizable fields are ignored.
 *
 * @param liveManifest - The manifest exported from Slack via apps.manifest.export
 * @param baseUrl - The base URL for this deployment (used to generate expected fields)
 * @returns Comparison result with isUpToDate flag and list of differences
 */
export function compareManifests(
  liveManifest: Record<string, unknown>,
  baseUrl: string,
  options?: { enableWorkflowSteps?: boolean }
): CompareResult {
  // Brand intentionally NOT threaded here: drift comparison checks slash-command
  // descriptions + shortcut/function presence, never the brand-templated copy, so the brand
  // value can't cause false drift. (The live app's brand comes from the admin display name at
  // creation, which differs from APP_NAME, so passing APP_NAME would be wrong, not just moot.)
  const expected = getControlledManifestFields(baseUrl, { enableWorkflowSteps: options?.enableWorkflowSteps });
  const differences: ManifestDifference[] = [];

  // Compare bot scopes
  const liveOauth = liveManifest.oauth_config as Record<string, unknown> | undefined;
  const liveScopes = liveOauth?.scopes as Record<string, string[]> | undefined;
  const liveBotScopes = liveScopes?.bot || [];
  const liveUserScopes = liveScopes?.user || [];

  if (!arraysEqual(liveBotScopes, expected.oauth_config.scopes.bot)) {
    differences.push({
      field: 'oauth_config.scopes.bot',
      expected: [...expected.oauth_config.scopes.bot].sort(),
      actual: [...liveBotScopes].sort(),
    });
  }

  if (!arraysEqual(liveUserScopes, expected.oauth_config.scopes.user)) {
    differences.push({
      field: 'oauth_config.scopes.user',
      expected: [...expected.oauth_config.scopes.user].sort(),
      actual: [...liveUserScopes].sort(),
    });
  }

  // Compare redirect_urls (by path only, to handle different environments)
  const liveRedirectUrls = (liveOauth?.redirect_urls as string[]) || [];
  const liveRedirectPaths = liveRedirectUrls.map(extractPath).sort();
  const expectedRedirectPaths = expected.oauth_config.redirect_urls.map(extractPath).sort();
  if (!arraysEqual(liveRedirectPaths, expectedRedirectPaths)) {
    differences.push({
      field: 'oauth_config.redirect_urls',
      expected: expectedRedirectPaths,
      actual: liveRedirectPaths,
    });
  }

  // Compare bot events
  const liveSettings = liveManifest.settings as Record<string, unknown> | undefined;
  const liveEvents = liveSettings?.event_subscriptions as Record<string, unknown> | undefined;
  const liveBotEvents = (liveEvents?.bot_events as string[]) || [];

  if (!arraysEqual(liveBotEvents, expected.settings.event_subscriptions.bot_events)) {
    differences.push({
      field: 'settings.event_subscriptions.bot_events',
      expected: [...expected.settings.event_subscriptions.bot_events].sort(),
      actual: [...liveBotEvents].sort(),
    });
  }

  // Compare event subscription URL (path only)
  const liveEventUrl = liveEvents?.request_url as string | undefined;
  if (liveEventUrl && extractPath(liveEventUrl) !== extractPath(expected.settings.event_subscriptions.request_url)) {
    differences.push({
      field: 'settings.event_subscriptions.request_url',
      expected: extractPath(expected.settings.event_subscriptions.request_url),
      actual: extractPath(liveEventUrl),
    });
  }

  // Compare interactivity
  const liveInteractivity = liveSettings?.interactivity as Record<string, unknown> | undefined;
  if (liveInteractivity?.is_enabled !== expected.settings.interactivity.is_enabled) {
    differences.push({
      field: 'settings.interactivity.is_enabled',
      expected: expected.settings.interactivity.is_enabled,
      actual: liveInteractivity?.is_enabled,
    });
  }

  const liveInteractivityUrl = liveInteractivity?.request_url as string | undefined;
  if (
    liveInteractivityUrl &&
    extractPath(liveInteractivityUrl) !== extractPath(expected.settings.interactivity.request_url)
  ) {
    differences.push({
      field: 'settings.interactivity.request_url',
      expected: extractPath(expected.settings.interactivity.request_url),
      actual: extractPath(liveInteractivityUrl),
    });
  }

  // Compare app_home
  const liveFeatures = liveManifest.features as Record<string, unknown> | undefined;
  const liveAppHome = liveFeatures?.app_home as Record<string, boolean> | undefined;

  if (liveAppHome) {
    const expectedAppHome = expected.features.app_home;
    for (const [key, value] of Object.entries(expectedAppHome)) {
      if (liveAppHome[key] !== value) {
        differences.push({
          field: `features.app_home.${key}`,
          expected: value,
          actual: liveAppHome[key],
        });
      }
    }
  } else {
    differences.push({
      field: 'features.app_home',
      expected: expected.features.app_home,
      actual: undefined,
    });
  }

  // Compare slash commands
  const liveSlashCommands = (liveFeatures?.slash_commands as Array<Record<string, unknown>>) || [];
  const commandDiffs = compareSlashCommands(liveSlashCommands, expected.features.slash_commands);
  differences.push(...commandDiffs);

  // Compare shortcuts
  const liveShortcuts = (liveFeatures?.shortcuts as Array<Record<string, unknown>>) || [];
  const expectedShortcuts = expected.features.shortcuts;
  for (const expectedShortcut of expectedShortcuts) {
    const live = liveShortcuts.find(s => s.callback_id === expectedShortcut.callback_id);
    if (!live) {
      differences.push({
        field: `features.shortcuts[${expectedShortcut.callback_id}]`,
        expected: expectedShortcut,
        actual: undefined,
      });
    }
  }

  // Compare functions (only when workflow steps are enabled)
  if (expected.functions) {
    const liveFunctions = (liveManifest.functions as Record<string, unknown>) || {};
    for (const [funcName, expectedFunc] of Object.entries(expected.functions)) {
      if (!liveFunctions[funcName]) {
        differences.push({
          field: `functions.${funcName}`,
          expected: expectedFunc,
          actual: undefined,
        });
      }
    }
  }

  // Compare function_runtime (only when workflow steps are enabled)
  if (expected.settings.function_runtime !== undefined) {
    if (liveSettings?.function_runtime !== expected.settings.function_runtime) {
      differences.push({
        field: 'settings.function_runtime',
        expected: expected.settings.function_runtime,
        actual: liveSettings?.function_runtime,
      });
    }
  }

  return {
    isUpToDate: differences.length === 0,
    differences,
  };
}

/**
 * Merge our controlled fields into a live manifest.
 * Preserves all user-customizable fields (display_information, etc.)
 * and only overwrites the fields we control.
 *
 * @param liveManifest - The manifest exported from Slack
 * @param baseUrl - The base URL for this deployment
 * @returns A new manifest with controlled fields updated, ready to push back to Slack
 */
export function mergeManifest(
  liveManifest: Record<string, unknown>,
  baseUrl: string,
  options?: { enableWorkflowSteps?: boolean }
): Record<string, unknown> {
  const enableWorkflowSteps = options?.enableWorkflowSteps ?? true;
  // Brand intentionally NOT threaded: merge already overwrites shortcuts/functions
  // wholesale (pre-existing behavior), and APP_NAME differs from the admin display name the
  // app was created with, so passing it would rewrite live copy to the wrong brand. Generic
  // copy here is the safe default; brand-aware manifest sync is out of scope.
  const controlled = getControlledManifestFields(baseUrl, { enableWorkflowSteps });

  // Deep clone the live manifest to avoid mutations
  const merged = JSON.parse(JSON.stringify(liveManifest)) as Record<string, unknown>;

  // Update oauth_config scopes and redirect_urls from controlled fields, preserve other oauth fields
  const mergedOauth = (merged.oauth_config || {}) as Record<string, unknown>;
  mergedOauth.scopes = controlled.oauth_config.scopes;
  mergedOauth.redirect_urls = controlled.oauth_config.redirect_urls;
  merged.oauth_config = mergedOauth;

  // Merge features (preserve bot_user and other feature fields)
  const mergedFeatures = (merged.features || {}) as Record<string, unknown>;
  mergedFeatures.app_home = controlled.features.app_home;
  mergedFeatures.slash_commands = controlled.features.slash_commands;
  mergedFeatures.shortcuts = controlled.features.shortcuts;
  merged.features = mergedFeatures;

  // Merge functions (conditionally based on workflow steps toggle)
  if (controlled.functions) {
    merged.functions = controlled.functions;
  } else {
    delete merged.functions;
  }

  // Merge settings (preserve socket_mode_enabled, token_rotation_enabled, etc.)
  const mergedSettings = (merged.settings || {}) as Record<string, unknown>;
  mergedSettings.event_subscriptions = controlled.settings.event_subscriptions;
  mergedSettings.interactivity = controlled.settings.interactivity;
  if (controlled.settings.function_runtime) {
    mergedSettings.function_runtime = controlled.settings.function_runtime;
  } else {
    delete mergedSettings.function_runtime;
  }
  mergedSettings.org_deploy_enabled = enableWorkflowSteps;
  merged.settings = mergedSettings;

  return merged;
}

/**
 * Extract the base URL from a live manifest's event subscription URL.
 * Falls back to constructing from request headers if the URL is missing or unparseable.
 *
 * @param liveManifest - The manifest exported from Slack
 * @param fallbackHeaders - Request headers for fallback (x-forwarded-proto, host)
 * @param logger - Optional logger for warning on fallback
 * @returns The base URL (protocol + host)
 */
export function extractBaseUrl(
  liveManifest: Record<string, unknown>,
  fallbackHeaders: { protocol?: string; host?: string },
  logger?: { warn: (msg: string, meta?: Record<string, unknown>) => void }
): string {
  const liveSettings = liveManifest?.settings as Record<string, unknown> | undefined;
  const liveEvents = liveSettings?.event_subscriptions as Record<string, unknown> | undefined;
  const liveEventUrl = liveEvents?.request_url as string | undefined;

  if (liveEventUrl) {
    try {
      const url = new URL(liveEventUrl);
      return `${url.protocol}//${url.host}`;
    } catch {
      logger?.warn('Failed to parse event subscription URL from manifest, falling back to request host', {
        liveEventUrl,
      });
    }
  }

  const protocol = fallbackHeaders.protocol || 'https';
  const host = fallbackHeaders.host;
  if (!host) {
    throw new Error('Cannot determine base URL: no event subscription URL in manifest and no host header in request');
  }
  return `${protocol}://${host}`;
}
