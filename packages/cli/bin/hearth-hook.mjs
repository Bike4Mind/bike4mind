#!/usr/bin/env node
// Claude Code hook: forwards Stop/Notification hook events into the Hearth
// event log, so any Claude Code instance reports as a Hearth actor.
//
// Wire it in .claude/settings.json under hooks (Stop and/or Notification):
//   { "type": "command", "command": "node <path>/hearth-hook.mjs" }
// Requires: B4M_API_URL, B4M_API_KEY, B4M_HEARTH_CHANNEL env vars.
// Always exits 0 - a reporting hook must never block the session.

const { B4M_API_URL, B4M_API_KEY, B4M_HEARTH_CHANNEL } = process.env;

const chunks = [];
process.stdin.on('data', c => chunks.push(c));
process.stdin.on('end', async () => {
  try {
    if (!B4M_API_URL || !B4M_API_KEY || !B4M_HEARTH_CHANNEL) return;
    const hook = JSON.parse(Buffer.concat(chunks).toString() || '{}');
    const eventName = hook.hook_event_name ?? 'unknown';
    const text = hook.message ?? `Claude Code ${eventName} (session ${hook.session_id ?? 'unknown'})`;
    await fetch(new URL('/api/hearth/events', B4M_API_URL), {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-api-key': B4M_API_KEY },
      body: JSON.stringify({
        channelId: B4M_HEARTH_CHANNEL,
        kind: 'presence',
        human: { text, format: 'text' },
        machine: { schema: 'hearth.claude-code-hook@1', payload: { hook_event_name: eventName, session_id: hook.session_id ?? null } },
        refs: {},
      }),
      // Bounded so a hung request can never stall the session past 3s.
      signal: AbortSignal.timeout(3000),
    });
  } catch {
    // Swallow everything: reporting must never fail the hook.
  } finally {
    process.exit(0);
  }
});
