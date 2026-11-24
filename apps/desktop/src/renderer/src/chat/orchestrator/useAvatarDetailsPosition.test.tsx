// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { useAvatarDetailsPosition, avatarDetailsPosition } from './useAvatarDetailsPosition';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

it('tracks only the displayed avatar without React renders and cleans up on close', async () => {
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  let nextFrame: FrameRequestCallback = () => {};
  const request = vi.spyOn(window, 'requestAnimationFrame').mockImplementation(callback => {
    nextFrame = callback;
    return 42;
  });
  const cancel = vi.spyOn(window, 'cancelAnimationFrame').mockImplementation(() => {});
  let renders = 0;
  function Panel({ id, enabled = true }: { id: string; enabled?: boolean }) {
    renders += 1;
    const ref = useAvatarDetailsPosition(id, enabled);
    return (
      <div data-testid="position-scene">
        <div data-agent-avatar="a" />
        <div data-agent-avatar="b" />
        <div ref={ref} data-testid="position-panel" />
      </div>
    );
  }
  try {
    await act(async () => root.render(<Panel id="a" />));
    const scene = host.querySelector<HTMLElement>('[data-testid="position-scene"]')!;
    const panel = host.querySelector<HTMLElement>('[data-testid="position-panel"]')!;
    const avatars = scene.querySelectorAll<HTMLElement>('[data-agent-avatar]');
    Object.defineProperties(scene, { clientWidth: { value: 1000 }, clientHeight: { value: 600 } });
    Object.defineProperties(panel, { offsetWidth: { value: 320 }, offsetHeight: { value: 300 } });
    vi.spyOn(scene, 'getBoundingClientRect').mockReturnValue(new DOMRect(50, 50, 1000, 600));
    const moving = vi.spyOn(avatars[0], 'getBoundingClientRect').mockReturnValue(new DOMRect(150, 150, 60, 60));
    vi.spyOn(avatars[1], 'getBoundingClientRect').mockReturnValue(new DOMRect(950, 550, 60, 60));
    nextFrame(0);
    expect(panel.style.left).toBe('172px');
    expect(panel.style.top).toBe('100px');
    const before = renders;
    moving.mockReturnValue(new DOMRect(250, 170, 60, 60));
    nextFrame(16);
    expect(panel.style.left).toBe('272px');
    expect(panel.style.top).toBe('120px');
    expect(renders).toBe(before);
    await act(async () => root.render(<Panel id="b" />));
    expect(panel.style.left).toBe('568px');
    expect(panel.style.top).toBe('288px');
    await act(async () => root.render(<Panel id="b" enabled={false} />));
    expect(cancel).toHaveBeenCalledWith(42);
    expect(panel.style.left).toBe('');
    expect(panel.style.top).toBe('');
  } finally {
    act(() => root.unmount());
    host.remove();
    request.mockRestore();
    cancel.mockRestore();
    vi.restoreAllMocks();
  }
});

describe('avatarDetailsPosition (pure)', () => {
  describe('avatarDetailsPosition', () => {
    const scene = { width: 1000, height: 600 };
    const panel = { width: 320, height: 300 };

    it('opens beside the avatar with a small gap', () => {
      expect(avatarDetailsPosition(scene, { left: 100, right: 160, top: 100 }, panel)).toEqual({ left: 172, top: 100 });
    });

    it('flips left at the right edge and clamps at the floor', () => {
      expect(avatarDetailsPosition(scene, { left: 900, right: 960, top: 500 }, panel)).toEqual({ left: 568, top: 288 });
    });

    it('clamps a scene-width panel and an avatar beyond the top edge', () => {
      expect(
        avatarDetailsPosition(
          { width: 280, height: 200 },
          { left: 100, right: 160, top: -20 },
          { width: 256, height: 176 }
        )
      ).toEqual({ left: 12, top: 12 });
    });

    it('repositions for a newly selected avatar', () => {
      const first = avatarDetailsPosition(scene, { left: 100, right: 160, top: 100 }, panel);
      const second = avatarDetailsPosition(scene, { left: 700, right: 760, top: 200 }, panel);
      expect(second).toEqual({ left: 368, top: 200 });
      expect(second).not.toEqual(first);
    });
  });
});
