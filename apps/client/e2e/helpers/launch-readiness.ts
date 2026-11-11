import { expect, type Locator, type Page } from '@playwright/test';

/**
 * Launch-readiness gate A6.1: the money paths must work on a short phone screen over a slow link.
 * 375x667 is the smallest phone viewport still in wide use (iPhone SE 2nd/3rd gen, iPhone 8).
 * Chromium only: the throttle below goes through CDP.
 */
export const SHORT_SCREEN_MOBILE = {
  viewport: { width: 375, height: 667 },
  deviceScaleFactor: 2,
  isMobile: true,
  hasTouch: true,
} as const;

/**
 * Chrome DevTools' "Slow 4G" preset (formerly "Fast 3G"): 562.5 ms round trip, ~1.44 Mbps down,
 * ~675 kbps up. Throughputs are bytes per second, as CDP expects.
 */
const SLOW_LINK = {
  offline: false,
  latency: 562.5,
  downloadThroughput: (1.6 * 1024 * 1024 * 0.9) / 8,
  uploadThroughput: (750 * 1024 * 0.9) / 8,
} as const;

/** Throttles every request the page makes, including the SPA bundle, for the rest of the test. */
export async function throttleToSlowLink(page: Page): Promise<void> {
  const cdp = await page.context().newCDPSession(page);
  await cdp.send('Network.enable');
  await cdp.send('Network.emulateNetworkConditions', SLOW_LINK);
}

/**
 * Asserts a control can be used as-is on the current viewport: scrolled to, fully inside the
 * viewport, and the topmost element at the centre and both horizontal ends of each line box, so no dialog, toast,
 * banner or overlay sits over it. Call it only on an enabled control, since a disabled Joy button
 * drops pointer events and would never be hit.
 */
export async function expectReachable(control: Locator, name: string): Promise<void> {
  await control.scrollIntoViewIfNeeded();
  await expect(control, `${name} is visible`).toBeVisible();
  await expect(control, `${name} is fully on screen`).toBeInViewport({ ratio: 1 });

  const coveredBy = await control.evaluate(element => {
    // One rect per line box: an inline link that wraps spans two lines, and its bounding box
    // centre can land on the neighbouring text. A block control has a single rect.
    const rects = Array.from(element.getClientRects()).filter(rect => rect.width > 0 && rect.height > 0);
    if (rects.length === 0) return ['no rendered box'];
    const probes = rects.flatMap(rect => {
      const centreY = rect.top + rect.height / 2;
      // Stay clear of rounded corners, which hit-test as the element underneath.
      const inset = Math.min(12, rect.width / 4);
      return [rect.left + inset, rect.left + rect.width / 2, rect.right - inset].map(x => ({ x, y: centreY }));
    });
    return probes.flatMap(({ x, y: centreY }) => {
      const hit = document.elementFromPoint(x, centreY);
      if (hit && (hit === element || element.contains(hit))) return [];
      if (!hit) return [`nothing at (${Math.round(x)}, ${Math.round(centreY)})`];
      const testId = hit.closest('[data-testid]')?.getAttribute('data-testid');
      return [`${hit.tagName.toLowerCase()}${testId ? `[data-testid=${testId}]` : ''}`];
    });
  });
  expect(coveredBy, `${name} is covered by another element`).toEqual([]);
}

/** Asserts the page does not scroll sideways, which on a phone hides content past the right edge. */
export async function expectNoHorizontalOverflow(page: Page): Promise<void> {
  const overflow = await page.evaluate(
    () => (document.scrollingElement?.scrollWidth ?? 0) - document.documentElement.clientWidth
  );
  expect(overflow, 'page is wider than the viewport').toBeLessThanOrEqual(0);
}
