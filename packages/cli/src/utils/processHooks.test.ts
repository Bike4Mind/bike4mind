import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { existsSync, readFileSync, mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { ProcessHooks, parseSettingsHooks, getProcessHooks, __resetProcessHooksForTest } from './processHooks';

/**
 * Mirrors the host's signal-hook settings: a Notification/permission_prompt write
 * hook (`cat > p`) plus rm clear hooks. The write hook exercises stdin->EOF (cat
 * blocks until stdin closes).
 */
function hostSettings(sentinelPath: string) {
  return {
    hooks: {
      Notification: [
        { matcher: 'permission_prompt', hooks: [{ type: 'command', command: `cat > '${sentinelPath}'` }] },
      ],
      PostToolUse: [{ matcher: '*', hooks: [{ type: 'command', command: `rm -f '${sentinelPath}'` }] }],
      Stop: [{ matcher: '*', hooks: [{ type: 'command', command: `rm -f '${sentinelPath}'` }] }],
      UserPromptSubmit: [{ hooks: [{ type: 'command', command: `rm -f '${sentinelPath}'` }] }],
    },
  };
}

describe('processHooks', () => {
  let dir: string;
  let sentinel: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'b4m-hooks-'));
    sentinel = join(dir, 'signal.json');
    __resetProcessHooksForTest();
    delete process.env.B4M_SETTINGS_JSON;
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
    __resetProcessHooksForTest();
    delete process.env.B4M_SETTINGS_JSON;
  });

  describe('parseSettingsHooks', () => {
    it('returns null for undefined / malformed JSON / missing hooks (never throws)', () => {
      expect(parseSettingsHooks(undefined)).toBeNull();
      expect(parseSettingsHooks('not json{')).toBeNull();
      expect(parseSettingsHooks('"a string"')).toBeNull();
      expect(parseSettingsHooks('{}')).toBeNull();
      expect(parseSettingsHooks('{"hooks":null}')).toBeNull();
    });

    it('extracts the hooks object', () => {
      const hooks = parseSettingsHooks(JSON.stringify(hostSettings(sentinel)));
      expect(hooks?.Notification).toHaveLength(1);
    });
  });

  describe('lifecycle (sentinel write/clear via real shell)', () => {
    it('Notification/permission_prompt writes the sentinel; stdin is piped then EOF-closed', async () => {
      const hooks = new ProcessHooks(hostSettings(sentinel).hooks);
      await hooks.fireNotificationPermissionPrompt('bash_execute');

      expect(existsSync(sentinel)).toBe(true);
      // `cat` wrote our stdin payload - proves stdin was piped AND closed (else cat hangs).
      const body = JSON.parse(readFileSync(sentinel, 'utf-8'));
      expect(body.hook_event_name).toBe('Notification');
      expect(body.matcher).toBe('permission_prompt');
      expect(body.tool_name).toBe('bash_execute');
    });

    it('PostToolUse / Stop / UserPromptSubmit each remove the sentinel', async () => {
      const hooks = new ProcessHooks(hostSettings(sentinel).hooks);

      await hooks.fireNotificationPermissionPrompt('x');
      expect(existsSync(sentinel)).toBe(true);
      await hooks.firePostToolUse('x');
      expect(existsSync(sentinel)).toBe(false);

      await hooks.fireNotificationPermissionPrompt('x');
      await hooks.fireStop();
      expect(existsSync(sentinel)).toBe(false);

      await hooks.fireNotificationPermissionPrompt('x');
      await hooks.fireUserPromptSubmit();
      expect(existsSync(sentinel)).toBe(false);
    });

    it('does not fire a clear for an unmatched matcher', async () => {
      // Only a Notification hook with matcher "other" - permission_prompt must not match it.
      const hooks = new ProcessHooks({
        Notification: [{ matcher: 'other', hooks: [{ type: 'command', command: `cat > '${sentinel}'` }] }],
      });
      await hooks.fireNotificationPermissionPrompt('x');
      expect(existsSync(sentinel)).toBe(false);
    });
  });

  describe('getProcessHooks singleton', () => {
    it('returns null when B4M_SETTINGS_JSON is unset, an instance when set', () => {
      expect(getProcessHooks()).toBeNull();
      __resetProcessHooksForTest();
      process.env.B4M_SETTINGS_JSON = JSON.stringify(hostSettings(sentinel));
      expect(getProcessHooks()).toBeInstanceOf(ProcessHooks);
    });
  });
});
