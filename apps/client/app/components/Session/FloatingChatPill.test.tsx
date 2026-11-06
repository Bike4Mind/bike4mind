import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { CssVarsProvider, extendTheme } from '@mui/joy/styles';
import { getThemeConfig } from '@client/app/utils/themes/themePrimitives';
import useSessionLayout, { setSessionLayout } from '@client/app/hooks/useSessionLayout';
import FloatingChatPill from './FloatingChatPill';

const theme = extendTheme({ ...getThemeConfig() });
const renderPill = (onExpand = vi.fn()) => {
  const result = render(
    <CssVarsProvider theme={theme}>
      <FloatingChatPill onExpand={onExpand} />
    </CssVarsProvider>
  );
  return { ...result, pill: screen.getByTestId('floating-chat-minimized'), onExpand };
};
const dragPill = (pill: HTMLElement, x: number, y: number) => {
  fireEvent.mouseDown(pill, { button: 0, clientX: 100, clientY: 100 });
  fireEvent.mouseMove(document, { clientX: 100 + x, clientY: 100 + y });
  fireEvent.mouseUp(document, { clientX: 100 + x, clientY: 100 + y });
};

describe('FloatingChatPill', () => {
  beforeEach(() => {
    vi.spyOn(HTMLElement.prototype, 'offsetWidth', 'get').mockReturnValue(160);
    vi.spyOn(HTMLElement.prototype, 'offsetHeight', 'get').mockReturnValue(40);
    vi.stubGlobal('innerWidth', 1024);
    vi.stubGlobal('innerHeight', 768);
    setSessionLayout({ floatingChatPillPosition: null });
  });
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it('starts at the bottom right and opens on click', () => {
    const { pill, onExpand } = renderPill();
    expect(pill.style.transform).toBe('translate(844px,708px)');
    fireEvent.click(pill, { detail: 1 });
    expect(onExpand).toHaveBeenCalledOnce();
  });

  it('moves out of the way without opening and remembers the position after remount', () => {
    const { pill, onExpand, unmount } = renderPill();
    const windowPosition = useSessionLayout.getState().floatingChatPosition;
    dragPill(pill, -250, -150);
    fireEvent.click(pill, { detail: 1 });
    expect(onExpand).not.toHaveBeenCalled();
    expect(pill.style.transform).toBe('translate(594px,558px)');
    expect(useSessionLayout.getState().floatingChatPosition).toEqual(windowPosition);
    const persisted: unknown = JSON.parse(localStorage.getItem('layout-control') ?? '{}');
    expect(persisted).toMatchObject({ state: { floatingChatPillPosition: { x: 594, y: 558 } } });
    unmount();
    expect(renderPill().pill.style.transform).toBe('translate(594px,558px)');
  });

  it('opens on a subsequent click or keyboard activation after dragging', () => {
    const { pill, onExpand } = renderPill();
    dragPill(pill, -100, -100);
    fireEvent.click(pill, { detail: 0 });
    expect(onExpand).toHaveBeenCalledTimes(1);
    fireEvent.mouseDown(pill, { button: 0, clientX: 100, clientY: 100 });
    fireEvent.mouseUp(document, { clientX: 100, clientY: 100 });
    fireEvent.click(pill, { detail: 1 });
    expect(onExpand).toHaveBeenCalledTimes(2);
  });

  it('allows slight movement during a click', () => {
    const { pill, onExpand } = renderPill();
    dragPill(pill, -2, -2);
    fireEvent.click(pill, { detail: 1 });
    expect(onExpand).toHaveBeenCalledOnce();
  });

  it('clamps dragging to all viewport edges', () => {
    const { pill } = renderPill();
    dragPill(pill, -2000, -2000);
    expect(pill.style.transform).toBe('translate(0px,0px)');
    dragPill(pill, 2000, 2000);
    expect(pill.style.transform).toBe('translate(864px,728px)');
  });

  it('keeps a saved position visible on mount and after viewport resizing', () => {
    setSessionLayout({ floatingChatPillPosition: { x: 2000, y: 2000 } });
    const { pill } = renderPill();
    expect(pill.style.transform).toBe('translate(864px,728px)');
    vi.stubGlobal('innerWidth', 400);
    vi.stubGlobal('innerHeight', 300);
    fireEvent(window, new Event('resize'));
    expect(pill.style.transform).toBe('translate(240px,260px)');
    expect(useSessionLayout.getState().floatingChatPillPosition).toEqual({ x: 240, y: 260 });
  });

  it('opens on a touch tap', () => {
    const { pill, onExpand } = renderPill();
    const touch = { identifier: 1, clientX: 100, clientY: 100, target: pill };
    fireEvent.touchStart(pill, { targetTouches: [touch], touches: [touch] });
    fireEvent.touchEnd(pill, { changedTouches: [touch], touches: [] });
    expect(onExpand).toHaveBeenCalledOnce();
  });

  it('moves with touch without opening on release', () => {
    const { pill, onExpand } = renderPill();
    const touch = { identifier: 1, clientX: 100, clientY: 100, target: pill };
    const moved = { ...touch, clientX: 50, clientY: 50 };
    fireEvent.touchStart(pill, { targetTouches: [touch], touches: [touch] });
    fireEvent.touchMove(document, { targetTouches: [moved], touches: [moved] });
    fireEvent.touchEnd(pill, { changedTouches: [moved], touches: [] });
    expect(pill.style.transform).toBe('translate(794px,658px)');
    expect(onExpand).not.toHaveBeenCalled();
    expect(useSessionLayout.getState().floatingChatPillPosition).toEqual({ x: 794, y: 658 });
  });
});
