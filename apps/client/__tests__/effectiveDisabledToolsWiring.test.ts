import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Wiring drift guard for the client's tool denylist.
 *
 * A surface's contributed denials apply at read time, and the client mirrors them so its
 * affordances match what the server will do: a denied tool is hidden rather than shown and
 * refused. The mirror is advisory (the server is the enforcement point), so a site that goes back
 * to reading `currentSession.disabledTools` directly breaks nothing loudly - it just offers the
 * user a control for a tool they cannot use. Every client site that decides tool availability from
 * a session therefore has to reach the denylist through `effectiveDisabledTools`.
 *
 * Reading the sources rather than rendering them: the sites are a hook, a button, a panel and the
 * send path, and none of them owns a harness for this. The check is per file, so reverting one site
 * fails on that site alone.
 */

const CLIENT_ROOT = join(__dirname, '..');

const CALL_SITES = [
  'app/components/Session/AISettings/useActiveTools.ts',
  'app/components/Session/AISettings/ImageOptionsPanel.tsx',
  'app/components/Session/AttachFileButton.tsx',
  'app/components/Session/SessionBottom/useSendMessage.ts',
];

describe('effectiveDisabledTools wiring', () => {
  it.each(CALL_SITES)('%s reads the session denylist through effectiveDisabledTools', file => {
    const source = readFileSync(join(CLIENT_ROOT, file), 'utf8');

    expect(source, `${file} no longer calls effectiveDisabledTools, so its surface denials are gone`).toContain(
      'effectiveDisabledTools('
    );
    // Presence alone would pass with a leftover direct read elsewhere in the same file, which
    // silently drops the surface denials at that site. Fail the file if any direct read remains.
    expect(source, `${file} reads the session denylist directly, bypassing the surface denials`).not.toMatch(
      /[sS]ession\??\.disabledTools\b/
    );
  });
});
