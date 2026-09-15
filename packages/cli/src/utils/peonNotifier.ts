/**
 * peon-ping notifier - native b4m adapter for peon-ping (https://peonping.com).
 *
 * peon-ping plays game-character voice lines + on-screen banners when an AI
 * coding agent finishes a turn or needs attention. It consumes a small JSON
 * event on stdin (the "CESP" hook contract shared by Claude Code and every
 * peon-ping adapter):
 *
 *   { hook_event_name, notification_type, cwd, session_id, permission_mode }
 *
 * This module is the b4m CLI's equivalent of the shell adapters peon-ping
 * ships for other IDEs (see `adapters/openclaw.sh`), except it runs in-process
 * and is wired directly to the CLI's lifecycle via a store subscription.
 *
 * Behaviour is auto-detect: if a `peon.sh` is found on disk it is enabled,
 * otherwise every call is a silent no-op. Set `B4M_PEON_PING=0` to force it
 * off even when installed.
 */

import { spawn } from 'child_process';
import { existsSync } from 'fs';
import { homedir } from 'os';
import path from 'path';
import { logger } from './Logger';
import { useCliStore } from '../store';

/** Hook event names understood by peon.sh. */
export type PeonEvent = 'SessionStart' | 'Stop' | 'Notification' | 'PostToolUseFailure' | 'SessionEnd';

/** notification_type qualifier for `Notification` events. */
export type PeonNotificationType = '' | 'permission_prompt' | 'resource_limit' | 'progress';

/**
 * Resolve the path to `peon.sh`, checking the same locations peon-ping's own
 * adapters use. Returns null when peon-ping is not installed. Resolved once and
 * cached: `null` means "looked and found nothing".
 */
let resolvedScript: string | null | undefined;
function findPeonScript(): string | null {
  if (resolvedScript !== undefined) return resolvedScript;

  const claudeDir = process.env.CLAUDE_CONFIG_DIR || path.join(homedir(), '.claude');
  const candidates = [
    process.env.CLAUDE_PEON_DIR ? path.join(process.env.CLAUDE_PEON_DIR, 'peon.sh') : null,
    path.join(claudeDir, 'hooks', 'peon-ping', 'peon.sh'),
    path.join(homedir(), '.openpeon', 'peon.sh'),
  ].filter((p): p is string => p !== null);

  resolvedScript = candidates.find(p => existsSync(p)) ?? null;
  return resolvedScript;
}

/** Explicit off-switch via env, even when peon-ping is installed. */
function isDisabledByEnv(): boolean {
  const v = process.env.B4M_PEON_PING?.toLowerCase();
  return v === '0' || v === 'false' || v === 'off';
}

/** True when peon-ping is installed and not disabled. */
export function isPeonAvailable(): boolean {
  return !isDisabledByEnv() && findPeonScript() !== null;
}

/**
 * Fire a single peon-ping event. Fire-and-forget and fail-safe: the child is
 * detached and unref'd, all output is discarded, and any spawn error is logged
 * to the debug log but never surfaced - the CLI must never break because of a
 * missing or misbehaving peon install.
 */
export function notifyPeon(event: PeonEvent, options: { notificationType?: PeonNotificationType } = {}): void {
  if (isDisabledByEnv()) return;
  const script = findPeonScript();
  if (!script) return;

  const payload = JSON.stringify({
    hook_event_name: event,
    notification_type: options.notificationType ?? '',
    cwd: process.cwd(),
    session_id: useCliStore.getState().session?.id ?? `b4m-${process.pid}`,
    permission_mode: '',
  });

  try {
    const child = spawn('bash', [script], {
      stdio: ['pipe', 'ignore', 'ignore'],
      detached: true,
    });
    child.on('error', err => logger.debug(`peon-ping spawn failed: ${(err as Error).message}`));
    child.stdin?.on('error', () => {}); // ignore EPIPE if peon.sh exits early
    child.stdin?.end(payload);
    child.unref();
  } catch (err) {
    logger.debug(`peon-ping notify error: ${(err as Error).message}`);
  }
}

/**
 * Subscribe to CLI lifecycle and emit peon-ping events:
 * - `Stop` when the agent finishes a turn (isThinking true -> false)
 * - `Notification` (permission_prompt) when a permission / user-question /
 *   review-gate prompt first appears and the user needs to act
 *
 * Fires `SessionStart` immediately. Returns an unsubscribe function; call it
 * (and pass `emitSessionEnd`) on exit to emit `SessionEnd`.
 */
export function startPeonNotifier(): () => void {
  if (!isPeonAvailable()) return () => {};

  notifyPeon('SessionStart');

  const unsubscribe = useCliStore.subscribe((state, prev) => {
    // Turn complete: agent went from thinking to idle.
    if (prev.isThinking && !state.isThinking) {
      notifyPeon('Stop');
    }

    // Needs-attention: a blocking prompt just appeared.
    const promptAppeared =
      (!prev.permissionPrompt && !!state.permissionPrompt) ||
      (!prev.userQuestionPrompt && !!state.userQuestionPrompt) ||
      (!prev.reviewGatePrompt && !!state.reviewGatePrompt);
    if (promptAppeared) {
      notifyPeon('Notification', { notificationType: 'permission_prompt' });
    }
  });

  return unsubscribe;
}

/** Emit `SessionEnd`. Call on CLI exit. */
export function emitPeonSessionEnd(): void {
  notifyPeon('SessionEnd');
}
