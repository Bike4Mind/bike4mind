// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import userEvent from '@testing-library/user-event';
import {
  getTurnstileToken,
  MAX_CHALLENGE_ATTEMPTS,
  TURNSTILE_BROWSER_REJECTED_MESSAGE,
  TURNSTILE_RETRY_MESSAGE,
  TurnstileCancelledError,
  TurnstileError,
  turnstileFailureMessage,
} from './turnstile';

type RenderOptions = {
  callback: (t: string) => void;
  'error-callback': (errorCode?: string) => boolean;
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
    expect(render.mock.calls[0][1]).toMatchObject({
      sitekey: 'site',
      action: 'otc-send',
      retry: 'never',
      theme: 'light',
      size: 'normal',
      'before-interactive-callback': expect.any(Function),
    });
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
    await expect(pending).rejects.toBeInstanceOf(TurnstileCancelledError);
    expect(render).toHaveBeenCalledTimes(1);
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

  it('parks Tab focus before the widget in its closed shadow root and wraps at the card edges', async () => {
    let options: RenderOptions | undefined;
    render.mockImplementation((element: HTMLElement, renderOptions: RenderOptions) => {
      // Real Turnstile mounts its iframe in a closed shadow root, so the page cannot query it.
      const host = document.createElement('div');
      host.attachShadow({ mode: 'closed' }).append(document.createElement('iframe'));
      element.append(host);
      options = renderOptions;
      return 'widget-1';
    });
    const pending = getTurnstileToken('site', 'otc-send');
    await vi.waitFor(() => expect(options).toBeDefined());
    options!['before-interactive-callback']();
    const card = document.querySelector<HTMLElement>('[data-testid="turnstile-challenge-card"]')!;
    const cancel = document.querySelector<HTMLButtonElement>('[data-testid="turnstile-challenge-cancel"]')!;
    const startSentinel = card.firstElementChild as HTMLElement;
    const endSentinel = card.lastElementChild as HTMLElement;
    const pressTab = (shiftKey = false) => {
      const event = new KeyboardEvent('keydown', { key: 'Tab', shiftKey, cancelable: true });
      document.dispatchEvent(event);
      return event;
    };

    // The first Tab from the card goes to the widget instead of skipping it to Cancel.
    expect(document.activeElement).toBe(card);
    expect(pressTab().defaultPrevented).toBe(false);
    expect(document.activeElement).toBe(startSentinel);

    // Shift+Tab leaving the widget lands on the start sentinel and wraps to Cancel.
    cancel.focus();
    startSentinel.focus();
    expect(document.activeElement).toBe(cancel);

    // Tab on Cancel moves to just before the widget and lets the native Tab step into it.
    expect(pressTab().defaultPrevented).toBe(false);
    expect(document.activeElement).toBe(startSentinel);

    // Shift+Tab from before the widget, or from the card itself, wraps to Cancel.
    expect(pressTab(true).defaultPrevented).toBe(true);
    expect(document.activeElement).toBe(cancel);
    card.focus();
    expect(pressTab(true).defaultPrevented).toBe(true);
    expect(document.activeElement).toBe(cancel);

    // Shift+Tab on Cancel is left to the browser, which steps back into the widget.
    expect(pressTab(true).defaultPrevented).toBe(false);
    expect(document.activeElement).toBe(cancel);

    endSentinel.focus();
    expect(document.activeElement).toBe(startSentinel);

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
      // A site configuration error is not retried, so the challenge ends on this attempt.
      if (outcome === 'error') options!['error-callback']('110200');
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

  it('restarts the timeout when the interactive card appears', async () => {
    vi.useFakeTimers();
    let options: RenderOptions | undefined;
    render.mockImplementation((_el: HTMLElement, o: RenderOptions) => {
      options = o;
      return 'widget-1';
    });
    let settled = false;
    const pending = getTurnstileToken('site', 'otc-send').finally(() => {
      settled = true;
    });
    const rejection = expect(pending).rejects.toThrow('turnstile-timeout');
    await vi.advanceTimersByTimeAsync(50_000);
    options!['before-interactive-callback']();
    await vi.advanceTimersByTimeAsync(50_000);
    expect(settled).toBe(false);
    await vi.advanceTimersByTimeAsync(10_000);
    await rejection;
  });

  it('cleans up when rendering throws before producing a widget', async () => {
    vi.useFakeTimers();
    render.mockImplementation(() => {
      throw new Error('render failed');
    });
    await expect(getTurnstileToken('site', 'otc-send')).rejects.toThrow('turnstile-render-failed');
    expect(vi.getTimerCount()).toBe(0);
    expect(document.querySelector('[data-testid="turnstile-challenge-overlay"]')).toBeNull();
  });

  it('retries a widget error with a fresh widget and resolves once one succeeds', async () => {
    vi.useFakeTimers();
    render
      .mockImplementationOnce((_el: HTMLElement, opts: RenderOptions) => {
        queueMicrotask(() => expect(opts['error-callback']('300030')).toBe(true));
        return 'widget-1';
      })
      .mockImplementationOnce((_el: HTMLElement, opts: RenderOptions) => {
        queueMicrotask(() => opts.callback('tok-2'));
        return 'widget-2';
      });
    const pending = getTurnstileToken('site', 'otc-send');
    await vi.advanceTimersByTimeAsync(1_500);
    await expect(pending).resolves.toBe('tok-2');
    expect(remove.mock.calls).toEqual([['widget-1'], ['widget-2']]);
    expect(document.querySelector('[data-testid="turnstile-challenge-overlay"]')).toBeNull();
  });

  it('gives up after the last attempt with the error code and attempt count', async () => {
    vi.useFakeTimers();
    render.mockImplementation((_el: HTMLElement, opts: RenderOptions) => {
      queueMicrotask(() => opts['error-callback']('600010'));
      return 'widget-1';
    });
    const pending = getTurnstileToken('site', 'otc-send').catch((error: unknown) => error);
    await vi.advanceTimersByTimeAsync(10_000);
    const error = await pending;
    expect(error).toBeInstanceOf(TurnstileError);
    expect(error).toMatchObject({ reason: 'error', errorCode: '600010', attempts: MAX_CHALLENGE_ATTEMPTS });
    expect(render).toHaveBeenCalledTimes(MAX_CHALLENGE_ATTEMPTS);
    expect(document.querySelector('[data-testid="turnstile-challenge-overlay"]')).toBeNull();
  });

  it('does not retry a site configuration error', async () => {
    render.mockImplementation((_el: HTMLElement, opts: RenderOptions) => {
      queueMicrotask(() => opts['error-callback']('110200'));
      return 'widget-1';
    });
    await expect(getTurnstileToken('site', 'otc-send')).rejects.toMatchObject({ reason: 'error', attempts: 1 });
    expect(render).toHaveBeenCalledTimes(1);
  });

  it('retries a challenge timeout error', async () => {
    vi.useFakeTimers();
    render
      .mockImplementationOnce((_el: HTMLElement, opts: RenderOptions) => {
        queueMicrotask(() => opts['error-callback']('110600'));
        return 'widget-1';
      })
      .mockImplementationOnce((_el: HTMLElement, opts: RenderOptions) => {
        queueMicrotask(() => opts.callback('tok-2'));
        return 'widget-2';
      });
    const pending = getTurnstileToken('site', 'otc-send');
    await vi.advanceTimersByTimeAsync(1_500);
    await expect(pending).resolves.toBe('tok-2');
  });

  it('does not retry an expired challenge', async () => {
    render.mockImplementation((_el: HTMLElement, opts: RenderOptions) => {
      queueMicrotask(() => opts['expired-callback']());
      return 'widget-1';
    });
    await expect(getTurnstileToken('site', 'otc-send')).rejects.toMatchObject({ reason: 'expired' });
    expect(render).toHaveBeenCalledTimes(1);
  });

  it('stops retrying when the user cancels during the retry delay', async () => {
    vi.useFakeTimers();
    render.mockImplementation((_el: HTMLElement, opts: RenderOptions) => {
      opts['before-interactive-callback']();
      queueMicrotask(() => opts['error-callback']('300030'));
      return 'widget-1';
    });
    const pending = getTurnstileToken('site', 'otc-send').catch((error: unknown) => error);
    await vi.advanceTimersByTimeAsync(0);
    expect(render).toHaveBeenCalledTimes(1);
    document.querySelector<HTMLButtonElement>('[data-testid="turnstile-challenge-cancel"]')!.click();
    await vi.advanceTimersByTimeAsync(10_000);
    expect(await pending).toBeInstanceOf(TurnstileCancelledError);
    expect(render).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
    expect(document.querySelector('[data-testid="turnstile-challenge-overlay"]')).toBeNull();
  });

  it('cancels a retried attempt without starting another one', async () => {
    vi.useFakeTimers();
    let options: RenderOptions | undefined;
    render
      .mockImplementationOnce((_el: HTMLElement, opts: RenderOptions) => {
        queueMicrotask(() => opts['error-callback']('300030'));
        return 'widget-1';
      })
      .mockImplementationOnce((_el: HTMLElement, opts: RenderOptions) => {
        options = opts;
        return 'widget-2';
      });
    const pending = getTurnstileToken('site', 'otc-send').catch((error: unknown) => error);
    await vi.advanceTimersByTimeAsync(1_500);
    options!['before-interactive-callback']();
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
    await vi.advanceTimersByTimeAsync(10_000);
    expect(await pending).toBeInstanceOf(TurnstileCancelledError);
    expect(render).toHaveBeenCalledTimes(2);
    expect(remove.mock.calls).toEqual([['widget-1'], ['widget-2']]);
  });

  it('ignores a late interactive callback from a widget whose attempt already ended', async () => {
    vi.useFakeTimers();
    const page = document.createElement('main');
    document.body.append(page);
    const options: RenderOptions[] = [];
    render.mockImplementation((_el: HTMLElement, opts: RenderOptions) => {
      options.push(opts);
      if (options.length === 1) queueMicrotask(() => opts['error-callback']('300030'));
      return `widget-${options.length}`;
    });
    const pending = getTurnstileToken('site', 'otc-send').catch((error: unknown) => error);
    await vi.advanceTimersByTimeAsync(0);
    options[0]['before-interactive-callback']();
    expect(document.querySelector('[data-testid="turnstile-challenge-card"]')!.getAttribute('role')).toBeNull();
    expect(page.hasAttribute('inert')).toBe(false);
    await vi.advanceTimersByTimeAsync(1_500 + 60_000);
    expect(await pending).toMatchObject({ reason: 'timeout', attempts: 2 });
    options[1]['before-interactive-callback']();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('keeps one card across retry attempts', async () => {
    vi.useFakeTimers();
    const page = document.createElement('main');
    document.body.append(page);
    const overlays: Element[] = [];
    render
      .mockImplementationOnce((el: HTMLElement, opts: RenderOptions) => {
        overlays.push(el.closest('[data-testid="turnstile-challenge-overlay"]')!);
        opts['before-interactive-callback']();
        queueMicrotask(() => opts['error-callback']('300030'));
        return 'widget-1';
      })
      .mockImplementationOnce((el: HTMLElement, opts: RenderOptions) => {
        overlays.push(el.closest('[data-testid="turnstile-challenge-overlay"]')!);
        opts['before-interactive-callback']();
        queueMicrotask(() => opts.callback('tok-2'));
        return 'widget-2';
      });
    const pending = getTurnstileToken('site', 'otc-send');
    await vi.advanceTimersByTimeAsync(0);
    expect(page.hasAttribute('inert')).toBe(true);
    expect(document.querySelectorAll('[data-testid="turnstile-challenge-overlay"]')).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1_500);
    await expect(pending).resolves.toBe('tok-2');
    expect(overlays[0]).toBe(overlays[1]);
    expect(page.hasAttribute('inert')).toBe(false);
  });

  it('runs concurrent challenges one at a time, each with its own token', async () => {
    const solvers: RenderOptions[] = [];
    render.mockImplementation((_el: HTMLElement, opts: RenderOptions) => {
      solvers.push(opts);
      return `widget-${solvers.length}`;
    });
    const first = getTurnstileToken('site', 'otc-send');
    const second = getTurnstileToken('site', 'otc-send');
    await vi.waitFor(() => expect(solvers).toHaveLength(1));
    solvers[0]['before-interactive-callback']();
    await new Promise(resolve => setTimeout(resolve, 0));
    expect(render).toHaveBeenCalledTimes(1);
    expect(document.querySelectorAll('[data-testid="turnstile-challenge-overlay"]')).toHaveLength(1);
    solvers[0].callback('tok-1');
    await expect(first).resolves.toBe('tok-1');
    await vi.waitFor(() => expect(solvers).toHaveLength(2));
    expect(document.querySelectorAll('[data-testid="turnstile-challenge-overlay"]')).toHaveLength(1);
    solvers[1].callback('tok-2');
    await expect(second).resolves.toBe('tok-2');
  });

  it('dismisses challenges queued behind a cancelled one but runs later ones', async () => {
    const solvers: RenderOptions[] = [];
    render.mockImplementation((_el: HTMLElement, opts: RenderOptions) => {
      solvers.push(opts);
      return `widget-${solvers.length}`;
    });
    const first = getTurnstileToken('site', 'otc-send');
    const queued = getTurnstileToken('site', 'otc-send');
    await vi.waitFor(() => expect(solvers).toHaveLength(1));
    solvers[0]['before-interactive-callback']();
    document.querySelector<HTMLButtonElement>('[data-testid="turnstile-challenge-cancel"]')!.click();
    await expect(first).rejects.toBeInstanceOf(TurnstileCancelledError);
    await expect(queued).rejects.toBeInstanceOf(TurnstileCancelledError);
    expect(render).toHaveBeenCalledTimes(1);
    expect(document.querySelector('[data-testid="turnstile-challenge-overlay"]')).toBeNull();

    const later = getTurnstileToken('site', 'otc-send');
    await vi.waitFor(() => expect(solvers).toHaveLength(2));
    solvers[1].callback('tok-2');
    await expect(later).resolves.toBe('tok-2');
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

  const turnstileScript = () => document.querySelector('script[src*="challenges.cloudflare.com"]');

  it('times out a stalled script without a second wait and allows another attempt', async () => {
    const pending = getTurnstileToken('site', 'otc-send');
    const rejection = expect(pending).rejects.toMatchObject({ reason: 'script-timeout', attempts: 1 });
    await vi.advanceTimersByTimeAsync(60_000);
    await rejection;
    expect(turnstileScript()).toBeNull();
    const retry = getTurnstileToken('site', 'otc-send');
    const retryRejection = expect(retry).rejects.toMatchObject({ reason: 'script-error', attempts: 2 });
    turnstileScript()!.dispatchEvent(new Event('error'));
    await vi.advanceTimersByTimeAsync(0);
    turnstileScript()!.dispatchEvent(new Event('error'));
    await retryRejection;
  });

  it('retries after the script loads without exposing the API', async () => {
    const pending = getTurnstileToken('site', 'otc-send');
    const rejection = expect(pending).rejects.toThrow('turnstile-unavailable');
    turnstileScript()!.dispatchEvent(new Event('load'));
    await rejection;
    const retry = getTurnstileToken('site', 'otc-send');
    const retryRejection = expect(retry).rejects.toThrow('turnstile-unavailable');
    expect(turnstileScript()).not.toBeNull();
    turnstileScript()!.dispatchEvent(new Event('load'));
    await retryRejection;
  });

  it('retries a script that failed to load and solves once it loads', async () => {
    const render = vi.fn((_el: HTMLElement, opts: RenderOptions) => {
      queueMicrotask(() => opts.callback('tok-1'));
      return 'widget-1';
    });
    const pending = getTurnstileToken('site', 'otc-send');
    turnstileScript()!.dispatchEvent(new Event('error'));
    await vi.advanceTimersByTimeAsync(0);
    window.turnstile = { render, remove: vi.fn() } as unknown as typeof window.turnstile;
    turnstileScript()!.dispatchEvent(new Event('load'));
    await expect(pending).resolves.toBe('tok-1');
  });
});

describe('turnstileFailureMessage', () => {
  it.each(['300030', '600010'])('sends a browser Cloudflare judged bot-like (%s) to a regular browser', code => {
    expect(turnstileFailureMessage(new TurnstileError('error', MAX_CHALLENGE_ATTEMPTS, code))).toBe(
      TURNSTILE_BROWSER_REJECTED_MESSAGE
    );
  });

  it.each([
    ['a challenge timeout code', new TurnstileError('error', 3, '110600')],
    ['a widget error without a code', new TurnstileError('error', 3)],
    ['our own timeout', new TurnstileError('timeout', 1)],
    ['an expired token', new TurnstileError('expired', 1)],
    ['a script error', new TurnstileError('script-error', 2)],
    ['a non-Turnstile error', new Error('boom')],
  ])('asks for a refresh on %s', (_label, error) => {
    expect(turnstileFailureMessage(error)).toBe(TURNSTILE_RETRY_MESSAGE);
  });
});
