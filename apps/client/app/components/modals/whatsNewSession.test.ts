import { describe, it, expect, beforeEach } from 'vitest';
import {
  markGearsDiscoveryShown,
  markWhatsNewShown,
  resetWhatsNewShownForTests,
  wasGearsDiscoveryShown,
  wasWhatsNewShown,
} from './whatsNewSession';

describe('whatsNewSession', () => {
  beforeEach(() => resetWhatsNewShownForTests());

  it("is false until What's New opens, then stays true", () => {
    expect(wasWhatsNewShown()).toBe(false);
    markWhatsNewShown();
    expect(wasWhatsNewShown()).toBe(true);
    expect(wasGearsDiscoveryShown()).toBe(false);
  });

  it('tracks the gears discovery modal separately', () => {
    markGearsDiscoveryShown();
    expect(wasGearsDiscoveryShown()).toBe(true);
    expect(wasWhatsNewShown()).toBe(false);
  });
});
