import { describe, it, expect, beforeEach } from 'vitest';
import { markWhatsNewShown, resetWhatsNewShownForTests, wasWhatsNewShown } from './whatsNewSession';

describe('whatsNewSession', () => {
  beforeEach(() => resetWhatsNewShownForTests());

  it("is false until What's New opens, then stays true", () => {
    expect(wasWhatsNewShown()).toBe(false);
    markWhatsNewShown();
    expect(wasWhatsNewShown()).toBe(true);
  });
});
