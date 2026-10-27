// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { getTurnstileToken } from './turnstile';
import userEvent from '@testing-library/user-event';

type RenderOptions = {
  callback: (t: string) => void;
  'error-callback': () => void;
  'expired-callback': () => void;
  'before-interactive-callback': () => void;
};

describe('getTurnstileToken', () => {
  const remove = vi.fn();
  let render: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    remove.mockReset();
    render = vi.fn(() => 'widget-1');
    window.turnstile = { render, remove } as unknown as typeof window.turnstile;
  });

  afterEach(() => {
    delete window.turnstile;
    vi.useRealTimers();
    document.body.replaceChildren();
    document.documentElement.removeAttribute('data-joy-color-scheme');
  });

  it('resolves with the token and cleans up the overlay and widget', async () => {
    render.mockImplementation((_el: HTMLElement, opts: RenderOptions) => {
      expect(document.querySelector('[data-testid="turnstile-challenge-widget"]')).not.toBeNull();
      queueMicrotask(() => opts.callback('tok-1'));
      return 'widget-1';
    });
    await expect(getTurnstileToken('site', 'otc-send')).resolves.toBe('tok-1');
    expect(render.mock.calls[0][1]).toMatchObject({ sitekey: 'site', action: 'otc-send' });
    expect(remove).toHaveBeenCalledWith('widget-1');
    expect(document.querySelector('[data-testid="turnstile-challenge-overlay"]')).toBeNull();
  });

  it('shows the backdrop and card only once an interactive challenge is needed', async () => {
    let opts: RenderOptions | undefined;
    render.mockImplementation((_el: HTMLElement, o: RenderOptions) => {
      opts = o;
      return 'widget-1';
    });
    const pending = getTurnstileToken('site', 'otc-send');
    await vi.waitFor(() => expect(opts).toBeDefined());
    const overlay = document.querySelector<HTMLElement>('[data-testid="turnstile-challenge-overlay"]')!;
    const card = document.querySelector<HTMLElement>('[data-testid="turnstile-challenge-card"]')!;
    expect(overlay.style.pointerEvents).toBe('none');
    expect(overlay.style.background).toBe('');
    expect(card.textContent).toContain('security check');
    expect(card.querySelector('p')!.style.display).toBe('none');

    opts!['before-interactive-callback']();
    expect(overlay.style.pointerEvents).toBe('auto');
    expect(overlay.style.background).not.toBe('');
    expect(card.style.borderRadius).toBe('12px');
    expect(card.querySelector('p')!.style.display).toBe('block');
    expect(card.getAttribute('role')).toBe('dialog');
    expect(card.getAttribute('aria-labelledby')).toBe(card.querySelector('p')!.id);

    opts!.callback('tok-1');
    await expect(pending).resolves.toBe('tok-1');
    expect(document.querySelector('[data-testid="turnstile-challenge-overlay"]')).toBeNull();
  });

  it('rejects and cleans up when the user cancels an interactive challenge', async () => {
    let opts: RenderOptions | undefined;
    render.mockImplementation((_el: HTMLElement, o: RenderOptions) => {
      opts = o;
      return 'widget-1';
    });
    const pending = getTurnstileToken('site', 'otc-send');
    await vi.waitFor(() => expect(opts).toBeDefined());
    const cancel = document.querySelector<HTMLButtonElement>('[data-testid="turnstile-challenge-cancel"]')!;
    expect(cancel.style.display).toBe('none');
    opts!['before-interactive-callback']();
    expect(cancel.style.display).toBe('block');
    cancel.click();
    await expect(pending).rejects.toThrow('turnstile-cancelled');
    expect(remove).toHaveBeenCalledWith('widget-1');
    expect(document.querySelector('[data-testid="turnstile-challenge-overlay"]')).toBeNull();
  });

  it('makes the page inert, focuses the card, and restores both on every exit', async () => {
    const page = document.createElement('main');
    const field = document.createElement('input');
    page.appendChild(field);
    const banner = document.createElement('aside');
    banner.setAttribute('inert', '');
    document.body.append(page, banner);
    field.focus();
    let opts: RenderOptions | undefined;
    render.mockImplementation((_el: HTMLElement, o: RenderOptions) => {
      opts = o;
      return 'widget-1';
    });
    const pending = getTurnstileToken('site', 'otc-send');
    await vi.waitFor(() => expect(opts).toBeDefined());
    expect(page.hasAttribute('inert')).toBe(false);
    opts!['before-interactive-callback']();
    const card = document.querySelector<HTMLElement>('[data-testid="turnstile-challenge-card"]')!;
    expect(page.hasAttribute('inert')).toBe(true);
    expect(document.activeElement).toBe(card);
    opts!.callback('tok-1');
    await pending;
    expect(page.hasAttribute('inert')).toBe(false);
    expect(banner.hasAttribute('inert')).toBe(true);
    expect(document.activeElement).toBe(field);
  });

  it('cancels on Escape only while the card is showing', async () => {
    let opts: RenderOptions | undefined;
    render.mockImplementation((_el: HTMLElement, o: RenderOptions) => {
      opts = o;
      return 'widget-1';
    });
    const pending = getTurnstileToken('site', 'otc-send');
    const rejection = expect(pending).rejects.toThrow('turnstile-cancelled');
    await vi.waitFor(() => expect(opts).toBeDefined());
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
    expect(document.querySelector('[data-testid="turnstile-challenge-overlay"]')).not.toBeNull();
    opts!['before-interactive-callback']();
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
    await rejection;
    expect(remove).toHaveBeenCalledWith('widget-1');
    expect(document.querySelector('[data-testid="turnstile-challenge-overlay"]')).toBeNull();
  });

  it('contains keyboard focus, cancels with Escape, and restores the previous focus', async () => {
    const user = userEvent.setup();
    const background = document.createElement('button');
    background.textContent = 'Sign in with Google';
    document.body.append(background);
    background.focus();
    let options: RenderOptions | undefined;
    render.mockImplementation((_element: HTMLElement, renderOptions: RenderOptions) => {
      options = renderOptions;
      return 'widget-1';
    });
    const pending = getTurnstileToken('site', 'otc-send');
    await vi.waitFor(() => expect(options).toBeDefined());
    expect(document.activeElement).toBe(background);
    options!['before-interactive-callback']();
    const card = document.querySelector<HTMLElement>('[data-testid="turnstile-challenge-card"]')!;
    expect(card.contains(document.activeElement)).toBe(true);
    await user.tab();
    expect(card.contains(document.activeElement)).toBe(true);
    await user.tab({ shift: true });
    expect(card.contains(document.activeElement)).toBe(true);
    background.focus();
    expect(card.contains(document.activeElement)).toBe(true);
    const rejection = expect(pending).rejects.toThrow('turnstile-cancelled');
    await user.keyboard('{Escape}');
    await rejection;
    expect(background.hasAttribute('inert')).toBeFalsy();
    expect(document.activeElement).toBe(background);
    expect(remove).toHaveBeenCalledWith('widget-1');
  });

  it('blocks portals mounted while interactive and restores them on exit', async () => {
    let options: RenderOptions | undefined;
    render.mockImplementation((_element: HTMLElement, renderOptions: RenderOptions) => {
      options = renderOptions;
      return 'widget-1';
    });
    const pending = getTurnstileToken('site', 'otc-send');
    await vi.waitFor(() => expect(options).toBeDefined());
    options!['before-interactive-callback']();
    const portal = document.createElement('aside');
    document.body.append(portal);
    await vi.waitFor(() => expect(portal.hasAttribute('inert')).toBe(true));
    options!.callback('tok-1');
    await pending;
    expect(portal.hasAttribute('inert')).toBe(false);
    const laterPortal = document.createElement('aside');
    document.body.append(laterPortal);
    await Promise.resolve();
    expect(laterPortal.hasAttribute('inert')).toBe(false);
  });

  it('wraps focus leaving either side of the challenge iframe', async () => {
    let options: RenderOptions | undefined;
    render.mockImplementation((element: HTMLElement, renderOptions: RenderOptions) => {
      element.append(document.createElement('iframe'));
      options = renderOptions;
      return 'widget-1';
    });
    const pending = getTurnstileToken('site', 'otc-send');
    await vi.waitFor(() => expect(options).toBeDefined());
    options!['before-interactive-callback']();
    const card = document.querySelector<HTMLElement>('[data-testid="turnstile-challenge-card"]')!;
    const cancel = document.querySelector<HTMLButtonElement>('[data-testid="turnstile-challenge-cancel"]')!;
    const iframe = card.querySelector('iframe')!;
    (card.firstElementChild as HTMLElement).focus();
    expect(document.activeElement).toBe(cancel);
    (card.lastElementChild as HTMLElement).focus();
    expect(document.activeElement).toBe(iframe);
    options!.callback('tok-1');
    await pending;
  });

  it.each(['success', 'error', 'expiry', 'timeout'] as const)(
    'restores background interaction and focus after interactive %s',
    async outcome => {
      vi.useFakeTimers();
      const background = document.createElement('button');
      const alreadyInert = document.createElement('div');
      alreadyInert.setAttribute('inert', '');
      document.body.append(background, alreadyInert);
      background.focus();
      let options: RenderOptions | undefined;
      render.mockImplementation((_element: HTMLElement, renderOptions: RenderOptions) => {
        options = renderOptions;
        options['before-interactive-callback']();
        return 'widget-1';
      });
      const pending = getTurnstileToken('site', 'otc-send');
      const result =
        outcome === 'success'
          ? expect(pending).resolves.toBe('tok-1')
          : expect(pending).rejects.toThrow(`turnstile-${outcome === 'expiry' ? 'expired' : outcome}`);
      await vi.advanceTimersByTimeAsync(0);
      expect(background.hasAttribute('inert')).toBe(true);
      options!['before-interactive-callback']();
      if (outcome === 'success') options!.callback('tok-1');
      if (outcome === 'error') options!['error-callback']();
      if (outcome === 'expiry') options!['expired-callback']();
      if (outcome === 'timeout') await vi.advanceTimersByTimeAsync(60_000);
      await result;
      expect(background.hasAttribute('inert')).toBeFalsy();
      expect(alreadyInert.hasAttribute('inert')).toBe(true);
      expect(document.activeElement).toBe(background);
      options!['before-interactive-callback']();
      expect(background.hasAttribute('inert')).toBeFalsy();
      expect(document.querySelector('[data-testid="turnstile-challenge-overlay"]')).toBeNull();
    }
  );

  it.each([320, 375, 1024])('fits the widget within a %ipx viewport', async width => {
    const originalWidth = window.innerWidth;
    vi.stubGlobal('innerWidth', width);
    render.mockImplementation((_element: HTMLElement, options: RenderOptions) => {
      queueMicrotask(() => options.callback('tok-1'));
      return 'widget-1';
    });
    try {
      await getTurnstileToken('site', 'otc-send');
      expect(render.mock.calls[0][1]).toMatchObject({ size: width < 380 ? 'compact' : 'normal' });
    } finally {
      vi.stubGlobal('innerWidth', originalWidth);
    }
  });

  it('matches the widget theme to the app color scheme', async () => {
    document.documentElement.setAttribute('data-joy-color-scheme', 'dark');
    render.mockImplementation((_el: HTMLElement, opts: RenderOptions) => {
      queueMicrotask(() => opts.callback('tok-1'));
      return 'widget-1';
    });
    await getTurnstileToken('site', 'otc-send');
    document.documentElement.removeAttribute('data-joy-color-scheme');
    await getTurnstileToken('site', 'otc-send');
    expect(render.mock.calls[0][1]).toMatchObject({ theme: 'dark' });
    expect(render.mock.calls[1][1]).toMatchObject({ theme: 'light' });
  });

  it('uses the compact widget on narrow viewports', async () => {
    render.mockImplementation((_el: HTMLElement, opts: RenderOptions) => {
      queueMicrotask(() => opts.callback('tok-1'));
      return 'widget-1';
    });
    const original = window.innerWidth;
    try {
      window.innerWidth = 320;
      await getTurnstileToken('site', 'otc-send');
      window.innerWidth = 1024;
      await getTurnstileToken('site', 'otc-send');
    } finally {
      window.innerWidth = original;
    }
    expect(render.mock.calls[0][1]).toMatchObject({ size: 'compact' });
    expect(render.mock.calls[1][1]).toMatchObject({ size: 'normal' });
  });

  it('expires the challenge and removes its widget', async () => {
    render.mockImplementation((_el: HTMLElement, options: RenderOptions) => {
      queueMicrotask(() => options['expired-callback']());
      return 'widget-1';
    });
    await expect(getTurnstileToken('site', 'otc-send')).rejects.toThrow('turnstile-expired');
    expect(remove).toHaveBeenCalledWith('widget-1');
    expect(document.querySelector('[data-testid="turnstile-challenge-overlay"]')).toBeNull();
  });

  it('times out an unsolved challenge and removes its widget', async () => {
    vi.useFakeTimers();
    const pending = getTurnstileToken('site', 'otc-send');
    const rejection = expect(pending).rejects.toThrow('turnstile-timeout');
    await vi.advanceTimersByTimeAsync(60_000);
    await rejection;
    expect(remove).toHaveBeenCalledWith('widget-1');
    expect(document.querySelector('[data-testid="turnstile-challenge-overlay"]')).toBeNull();
  });

  it('cleans up when rendering throws before producing a widget', async () => {
    vi.useFakeTimers();
    render.mockImplementation(() => {
      throw new Error('render failed');
    });
    await expect(getTurnstileToken('site', 'otc-send')).rejects.toThrow('render failed');
    expect(vi.getTimerCount()).toBe(0);
    expect(document.querySelector('[data-testid="turnstile-challenge-overlay"]')).toBeNull();
  });

  it('rejects when the widget reports an error and still cleans up', async () => {
    render.mockImplementation((_el: HTMLElement, opts: RenderOptions) => {
      queueMicrotask(() => opts['error-callback']());
      return 'widget-1';
    });
    await expect(getTurnstileToken('site', 'otc-send')).rejects.toThrow('turnstile-error');
    expect(document.querySelector('[data-testid="turnstile-challenge-overlay"]')).toBeNull();
  });
});

describe('Turnstile script loading', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    delete window.turnstile;
  });

  afterEach(() => {
    vi.useRealTimers();
    delete window.turnstile;
    document.querySelectorAll('script[src*="challenges.cloudflare.com"]').forEach(script => script.remove());
  });

  it('times out a stalled script and allows another attempt', async () => {
    const pending = getTurnstileToken('site', 'otc-send');
    const rejection = expect(pending).rejects.toThrow('turnstile-unavailable');
    await vi.advanceTimersByTimeAsync(60_000);
    await rejection;
    expect(document.querySelector('script[src*="challenges.cloudflare.com"]')).toBeNull();
    const retry = getTurnstileToken('site', 'otc-send');
    const retryRejection = expect(retry).rejects.toThrow('turnstile-unavailable');
    document.querySelector('script[src*="challenges.cloudflare.com"]')!.dispatchEvent(new Event('error'));
    await retryRejection;
  });

  it('retries after the script loads without exposing the API', async () => {
    const pending = getTurnstileToken('site', 'otc-send');
    const rejection = expect(pending).rejects.toThrow('turnstile-unavailable');
    document.querySelector('script[src*="challenges.cloudflare.com"]')!.dispatchEvent(new Event('load'));
    await rejection;
    const retry = getTurnstileToken('site', 'otc-send');
    const retryRejection = expect(retry).rejects.toThrow('turnstile-unavailable');
    expect(document.querySelector('script[src*="challenges.cloudflare.com"]')).not.toBeNull();
    document.querySelector('script[src*="challenges.cloudflare.com"]')!.dispatchEvent(new Event('error'));
    await retryRejection;
  });
});
