import { describe, expect, it } from 'vitest';
import { spendsCredits, readsUntrusted, sendsOut } from './riskAssessment';

describe('the credit-spending axis', () => {
  it.each(['generate_image', 'generate_speech', 'generate_sound_effect', 'generate_music', 'session_spawn'])(
    '%s is classified as spending credits',
    name => {
      expect(spendsCredits(name)).toBe(true);
    }
  );

  it('does not fold the shell tools into the cost axis', () => {
    expect(spendsCredits('bash_execute')).toBe(false);
    expect(spendsCredits('file_write')).toBe(false);
  });

  it('leaves session_send to the approval mode, because the relay bounds already cap the chain', () => {
    expect(spendsCredits('session_send')).toBe(false);
  });
});

describe('external content provenance', () => {
  it.each([
    'web_fetch',
    'web_search',
    'skill',
    'session_read',
    'browser_snapshot',
    'browser_future_tool',
    'mcp__server__tool',
    'screen_capture',
    'simulator_screenshot',
    'model_view',
  ])('%s can steer a later outbound command', name => {
    expect(readsUntrusted(name)).toBe(true);
  });
  it.each(['file_read', 'file_write', 'bash_execute', 'generate_image'])(
    '%s does not itself mark external text',
    name => {
      expect(readsUntrusted(name)).toBe(false);
    }
  );
});

describe('outbound transport boundaries', () => {
  it.each(['session_send', 'session_spawn', 'web_fetch', 'mcp__server__tool', 'browser_navigate'])(
    '%s can move data or instructions beyond the reply',
    name => {
      expect(sendsOut(name)).toBe(true);
    }
  );
  it.each(['list', 'close', 'select'])('keeps browser tab %s behind its existing identity checks', action => {
    expect(sendsOut('browser_tabs', { action })).toBe(false);
  });
  it.each(['new', 'future_action'])('treats browser tab %s as outbound', action => {
    expect(sendsOut('browser_tabs', { action })).toBe(true);
  });
});
