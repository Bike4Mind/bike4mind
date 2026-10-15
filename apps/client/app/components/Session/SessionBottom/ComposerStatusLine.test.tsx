import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { act, render, screen } from '@testing-library/react';
const mobile = vi.hoisted(() => ({ value: false }));
vi.mock('@client/app/hooks/useIsMobile', () => ({ useIsMobile: () => mobile.value }));

import ComposerStatusLine, { useStatusLineCompact } from './ComposerStatusLine';

// jsdom has no layout: the left side reports a content width wider than itself on demand.
const size = { client: 300, content: 200 };
let fire: () => void = () => {};

class FakeResizeObserver {
  constructor(cb: () => void) {
    fire = cb;
  }
  observe() {}
  disconnect() {}
}

const Probe = ({ id }: { id: string }) => <span data-testid={id}>{useStatusLineCompact() ? 'compact' : 'full'}</span>;

beforeEach(() => {
  vi.stubGlobal('ResizeObserver', FakeResizeObserver);
  Object.defineProperty(HTMLElement.prototype, 'clientWidth', {
    configurable: true,
    get() {
      return size.client;
    },
  });
  Object.defineProperty(HTMLElement.prototype, 'scrollWidth', {
    configurable: true,
    get() {
      return Math.max(size.client, size.content);
    },
  });
  size.client = 300;
  size.content = 200;
  mobile.value = false;
});

afterEach(() => {
  vi.unstubAllGlobals();
  delete (HTMLElement.prototype as { clientWidth?: number }).clientWidth;
  delete (HTMLElement.prototype as { scrollWidth?: number }).scrollWidth;
});

describe('ComposerStatusLine', () => {
  it('keeps both sides full while the left side fits', () => {
    render(<ComposerStatusLine left={<Probe id="left" />} right={<Probe id="right" />} />);
    expect(screen.getByTestId('left')).toHaveTextContent('full');
    expect(screen.getByTestId('right')).toHaveTextContent('full');
  });

  it('turns both sides compact once the left side runs out of room', () => {
    render(<ComposerStatusLine left={<Probe id="left" />} right={<Probe id="right" />} />);
    size.content = 360;
    act(() => fire());
    expect(screen.getByTestId('left')).toHaveTextContent('compact');
    expect(screen.getByTestId('right')).toHaveTextContent('compact');
  });

  it('on phones keeps the notebook side compact and context and the balance in full', () => {
    mobile.value = true;
    render(<ComposerStatusLine left={<Probe id="left" />} right={<Probe id="right" />} />);
    expect(screen.getByTestId('left')).toHaveTextContent('compact');
    expect(screen.getByTestId('right')).toHaveTextContent('full');
  });

  it('on phones keeps the right side full even when the line runs out of room', () => {
    mobile.value = true;
    render(<ComposerStatusLine left={<Probe id="left" />} right={<Probe id="right" />} />);
    size.content = 360;
    act(() => fire());
    expect(screen.getByTestId('right')).toHaveTextContent('full');
  });
});
