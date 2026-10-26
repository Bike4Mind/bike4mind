// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { getTurnstileToken } from './turnstile';

type RenderOptions = { callback: (t: string) => void; 'error-callback': () => void };

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

  it('rejects when the widget reports an error and still cleans up', async () => {
    render.mockImplementation((_el: HTMLElement, opts: RenderOptions) => {
      queueMicrotask(() => opts['error-callback']());
      return 'widget-1';
    });
    await expect(getTurnstileToken('site', 'otc-send')).rejects.toThrow('turnstile-error');
    expect(document.querySelector('[data-testid="turnstile-challenge-overlay"]')).toBeNull();
  });
});
