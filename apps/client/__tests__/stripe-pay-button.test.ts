// @vitest-environment node
import type { Frame, Locator, Page } from '@playwright/test';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { payButton } from '../e2e/helpers/stripe-pay-button';

type Button = { name: string; testId: string; locator: Locator };

function button(name: string, visible = true, testId = ''): Button {
  return { name, testId, locator: { isVisible: vi.fn(async () => visible) } as unknown as Locator };
}

function query(buttons: Button[]) {
  return {
    buttons,
    or: (other: { buttons: Button[] }) => ({
      all: async () => [...new Set([...buttons, ...other.buttons])].map(candidate => candidate.locator),
    }),
  };
}

function frame(buttons: Button[]): Frame {
  return {
    getByTestId: (testId: string) => query(buttons.filter(candidate => candidate.testId === testId)),
    getByRole: (_role: string, options: { name: RegExp }) =>
      query(buttons.filter(candidate => options.name.test(candidate.name))),
    isDetached: () => false,
    url: () => 'https://fixture.invalid/checkout',
    locator: () => ({ ariaSnapshot: async () => buttons.map(candidate => candidate.name).join('\n') }),
  } as unknown as Frame;
}

function page(frames: Frame[]): Page {
  let time = 0;
  vi.spyOn(Date, 'now').mockImplementation(() => time);
  return {
    frames: () => frames,
    waitForTimeout: async (milliseconds: number) => {
      time += milliseconds;
    },
  } as unknown as Page;
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('Stripe checkout submit button', () => {
  it.each(['Subscribe', 'Pay', 'sUbScRiBe'])('finds the exact %s button after Link', async name => {
    const submit = button(name);
    const checkout = page([frame([button('Pay securely with Link'), submit])]);
    expect(await payButton(checkout)).toBe(submit.locator);
  });

  it.each(['Pay securely with Link', 'Pay with Link', 'Subscribe to newsletter', 'Pay later', 'Payment'])(
    'rejects %s and preserves frame diagnostics',
    async name => {
      const checkout = page([frame([button(name)])]);
      await expect(payButton(checkout, 10)).rejects.toThrow(
        `No pay button in any of 1 frames:\nhttps://fixture.invalid/checkout\n${name}`
      );
    }
  );

  it('supports the legacy submit test id', async () => {
    const submit = button('Complete order', true, 'hosted-payment-submit-button');
    expect(await payButton(page([frame([submit])]))).toBe(submit.locator);
  });

  it('skips a hidden legacy candidate before a visible submit in the same frame', async () => {
    const submit = button('Subscribe');
    expect(await payButton(page([frame([button('Old submit', false, 'hosted-payment-submit-button'), submit])]))).toBe(
      submit.locator
    );
  });

  it('skips a hidden candidate in an earlier frame', async () => {
    const submit = button('Subscribe');
    expect(await payButton(page([frame([button('Pay', false)]), frame([submit])]))).toBe(submit.locator);
  });

  it('skips a frame that detaches during lookup', async () => {
    const detached = {
      getByTestId: () => {
        throw new Error('detached frame');
      },
      isDetached: () => true,
    } as unknown as Frame;
    const submit = button('Subscribe');
    expect(await payButton(page([detached, frame([submit])]))).toBe(submit.locator);
  });

  it('propagates lookup errors from an attached frame', async () => {
    const broken = {
      getByTestId: () => {
        throw new Error('invalid lookup');
      },
      isDetached: () => false,
    } as unknown as Frame;
    await expect(payButton(page([broken]))).rejects.toThrow('invalid lookup');
  });
});
