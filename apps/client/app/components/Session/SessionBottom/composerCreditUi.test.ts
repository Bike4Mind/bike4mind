import { describe, it, expect } from 'vitest';
import { getComposerCreditUi } from './composerCreditUi';

const base = {
  enforceCredits: true,
  effectiveCredits: 5000,
  exhaustedByVoice: false,
  hasModels: true,
  lowWarningDismissed: false,
  lowThreshold: 100,
};

describe('getComposerCreditUi', () => {
  it('shows nothing with a healthy balance', () => {
    expect(getComposerCreditUi(base)).toEqual({
      replaceComposer: false,
      lowCreditsNotice: false,
      toolbarBlocked: false,
    });
  });

  it('replaces the message box and blocks the toolbar when the balance is out', () => {
    expect(getComposerCreditUi({ ...base, effectiveCredits: 0 })).toEqual({
      replaceComposer: true,
      lowCreditsNotice: false,
      toolbarBlocked: true,
    });
    expect(getComposerCreditUi({ ...base, effectiveCredits: -20 }).replaceComposer).toBe(true);
  });

  it('treats a balance a voice session ran out as exhausted, whatever the number says', () => {
    expect(getComposerCreditUi({ ...base, effectiveCredits: 50, exhaustedByVoice: true })).toEqual({
      replaceComposer: true,
      lowCreditsNotice: false,
      toolbarBlocked: true,
    });
  });

  it('keeps the message box with the dismissible notice when the balance is low', () => {
    expect(getComposerCreditUi({ ...base, effectiveCredits: 40 })).toEqual({
      replaceComposer: false,
      lowCreditsNotice: true,
      toolbarBlocked: false,
    });
    expect(getComposerCreditUi({ ...base, effectiveCredits: 40, lowWarningDismissed: true }).lowCreditsNotice).toBe(
      false
    );
  });

  it('shows no credit notice at all when enforcement is off, even at zero', () => {
    expect(getComposerCreditUi({ ...base, enforceCredits: false, effectiveCredits: 0 })).toEqual({
      replaceComposer: false,
      lowCreditsNotice: false,
      toolbarBlocked: false,
    });
  });

  it('leaves the box to NoModelsWarning without models, but still blocks an exhausted toolbar', () => {
    expect(getComposerCreditUi({ ...base, hasModels: false, effectiveCredits: 0 })).toEqual({
      replaceComposer: false,
      lowCreditsNotice: false,
      toolbarBlocked: true,
    });
    expect(getComposerCreditUi({ ...base, hasModels: false, effectiveCredits: 40 }).lowCreditsNotice).toBe(false);
  });
});
