import { describe, expect, it } from 'vitest';
import { spendsCredits } from './riskAssessment';

describe('the credit-spending axis', () => {
  it.each(['generate_image', 'generate_speech', 'generate_sound_effect', 'generate_music', 'session_spawn'])(
    '%s spends credits and always asks',
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
