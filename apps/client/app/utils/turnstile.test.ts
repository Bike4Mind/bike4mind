// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { getTurnstileToken, MAX_CHALLENGE_ATTEMPTS, TurnstileError } from './turnstile';

type RenderOptions = {
  callback: (t: string) => void;
  'error-callback': (errorCode?: string) => boolean;
  'expired-callback': () => void;
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
  });

  it('resolves with the token and cleans up the overlay and widget', async () => {
    render.mockImplementation((_el: HTMLElement, opts: RenderOptions) => {
      expect(document.querySelector('[data-testid="turnstile-challenge-widget"]')).not.toBeNull();
      queueMicrotask(() => opts.callback('tok-1'));
      return 'widget-1';
    });
    await expect(getTurnstileToken('site', 'otc-send')).resolves.toBe('tok-1');
    expect(render.mock.calls[0][1]).toMatchObject({ sitekey: 'site', action: 'otc-send', retry: 'never' });
    expect(remove).toHaveBeenCalledWith('widget-1');
    expect(document.querySelector('[data-testid="turnstile-challenge-overlay"]')).toBeNull();
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

  it('does not retry an expired challenge', async () => {
    render.mockImplementation((_el: HTMLElement, opts: RenderOptions) => {
      queueMicrotask(() => opts['expired-callback']());
      return 'widget-1';
    });
    await expect(getTurnstileToken('site', 'otc-send')).rejects.toMatchObject({ reason: 'expired' });
    expect(render).toHaveBeenCalledTimes(1);
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
