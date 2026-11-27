import { useLayoutEffect, useRef } from 'react';

const GAP = 12;

export function avatarDetailsPosition(
  scene: { width: number; height: number },
  avatar: { left: number; right: number; top: number },
  panel: { width: number; height: number }
) {
  const rightRoom = scene.width - avatar.right - GAP;
  const leftRoom = avatar.left - GAP;
  const left = rightRoom >= panel.width || rightRoom >= leftRoom ? avatar.right + GAP : avatar.left - GAP - panel.width;
  return {
    left: Math.max(GAP, Math.min(left, scene.width - panel.width - GAP)),
    top: Math.max(GAP, Math.min(avatar.top, scene.height - panel.height - GAP)),
  };
}

export function useAvatarDetailsPosition(agentId: string | undefined, enabled: boolean, sceneId?: string) {
  const ref = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const panel = ref.current;
    const scene = panel?.parentElement;
    if (!enabled || !panel || !scene || !agentId) return;
    let avatar: HTMLElement | undefined;
    let frame = 0;
    let previous = '';
    const position = () => {
      if (document.hidden) return;
      if (!avatar?.isConnected || avatar.dataset.agentAvatar !== agentId) {
        avatar = [...scene.querySelectorAll<HTMLElement>('[data-agent-avatar]')].find(
          element => element.dataset.agentAvatar === agentId
        );
      }
      if (avatar) {
        const bounds = scene.getBoundingClientRect();
        const target = avatar.getBoundingClientRect();
        // Convert displayed coordinates back to scene units, including a transformed scene.
        const scaleX = bounds.width / scene.clientWidth || 1;
        const scaleY = bounds.height / scene.clientHeight || 1;
        const next = avatarDetailsPosition(
          { width: scene.clientWidth, height: scene.clientHeight },
          {
            left: (target.left - bounds.left) / scaleX,
            right: (target.right - bounds.left) / scaleX,
            top: (target.top - bounds.top) / scaleY,
          },
          { width: panel.offsetWidth, height: panel.offsetHeight }
        );
        const key = `${next.left},${next.top}`;
        if (key !== previous) {
          panel.style.left = `${next.left}px`;
          panel.style.top = `${next.top}px`;
          previous = key;
        }
      }
      frame = window.requestAnimationFrame(position);
    };
    const onVisibility = () => {
      window.cancelAnimationFrame(frame);
      if (!document.hidden) position();
    };
    position();
    document.addEventListener('visibilitychange', onVisibility);
    return () => {
      window.cancelAnimationFrame(frame);
      document.removeEventListener('visibilitychange', onVisibility);
      panel.style.removeProperty('left');
      panel.style.removeProperty('top');
    };
  }, [agentId, enabled, sceneId]);
  return ref;
}
