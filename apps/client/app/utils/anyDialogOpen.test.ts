// @vitest-environment jsdom
import { describe, it, expect, afterEach } from 'vitest';
import { isAnyModalDialogOpen } from './anyDialogOpen';

// The real regression is that MUI Joy keeps closed drawers mounted with
// `visibility: hidden`. That's a genuine-browser-rendering concern jsdom can't faithfully
// reproduce, so it's covered by QA's live Playwright run. Here we deterministically verify the
// helper's *logic*: it scans modal dialogs and delegates the visible/not decision to
// `checkVisibility` (the browser primitive that correctly ignores hidden-but-mounted drawers).

const addDialog = (): HTMLElement => {
  const el = document.createElement('div');
  el.setAttribute('role', 'dialog');
  el.setAttribute('aria-modal', 'true');
  document.body.appendChild(el);
  return el;
};

describe('isAnyModalDialogOpen', () => {
  afterEach(() => {
    document.body.innerHTML = '';
  });

  it('returns false when no modal dialogs are present', () => {
    expect(isAnyModalDialogOpen()).toBe(false);
  });

  it('returns false when the only dialog reports itself not visible (the hidden-but-mounted case)', () => {
    const el = addDialog();
    el.checkVisibility = () => false;
    expect(isAnyModalDialogOpen()).toBe(false);
  });

  it('returns true when a dialog reports itself visible', () => {
    const el = addDialog();
    el.checkVisibility = () => true;
    expect(isAnyModalDialogOpen()).toBe(true);
  });

  it('returns true if any one of several dialogs is visible', () => {
    const hidden = addDialog();
    hidden.checkVisibility = () => false;
    const visible = addDialog();
    visible.checkVisibility = () => true;
    expect(isAnyModalDialogOpen()).toBe(true);
  });
});
