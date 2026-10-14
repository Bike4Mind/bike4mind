import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { act, render, screen } from '@testing-library/react';
import { useRef } from 'react';
import { useOverflowCompact } from './useOverflowCompact';

// jsdom has no layout: drive the row's sizes by hand and fire the observer when they change.
const size = { client: 500, fullContent: 400, compactContent: 200 };
let fire: () => void = () => {};

class FakeResizeObserver {
  constructor(cb: () => void) {
    fire = cb;
  }
  observe() {}
  disconnect() {}
}

const Row = () => {
  const ref = useRef<HTMLDivElement>(null);
  const compact = useOverflowCompact(ref);
  return (
    <div ref={ref} data-testid="row" data-compact={String(compact)}>
      <span />
    </div>
  );
};

const resize = (client: number) => {
  size.client = client;
  act(() => fire());
};

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
    get(this: HTMLElement) {
      const compact = this.getAttribute('data-compact') === 'true';
      return Math.max(size.client, compact ? size.compactContent : size.fullContent);
    },
  });
  size.client = 500;
});

afterEach(() => {
  vi.unstubAllGlobals();
  // Drop the overrides so the prototype's own getters (0 under jsdom) come back.
  delete (HTMLElement.prototype as { clientWidth?: number }).clientWidth;
  delete (HTMLElement.prototype as { scrollWidth?: number }).scrollWidth;
});

describe('useOverflowCompact', () => {
  it('stays full while the content fits', () => {
    render(<Row />);
    expect(screen.getByTestId('row')).toHaveAttribute('data-compact', 'false');
  });

  it('goes compact once the full content overflows the row', () => {
    render(<Row />);
    resize(350);
    expect(screen.getByTestId('row')).toHaveAttribute('data-compact', 'true');
  });

  it('does not flip back just because the compact content now fits', () => {
    render(<Row />);
    resize(350);
    resize(380);
    expect(screen.getByTestId('row')).toHaveAttribute('data-compact', 'true');
  });

  it('expands again once the row is as wide as the full content was', () => {
    render(<Row />);
    resize(350);
    resize(400);
    expect(screen.getByTestId('row')).toHaveAttribute('data-compact', 'false');
  });
});
