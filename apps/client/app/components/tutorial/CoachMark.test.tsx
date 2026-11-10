import React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { a11yAttr } from './a11y';
import { CoachMark, dockCard, placeCard, type Rect } from './CoachMark';

const viewport = { width: 1728, height: 936 };
const card = { width: 340, height: 170 };
const rect = (left: number, top: number, right: number, bottom: number): Rect => ({ left, top, right, bottom });
const cardAt = ({ left, top }: { left: number; top: number }) => rect(left, top, left + card.width, top + card.height);
const overlaps = (a: Rect, b: Rect) => a.left < b.right && b.left < a.right && a.top < b.bottom && b.top < a.bottom;
const onScreen = (r: Rect) =>
  r.left >= 16 && r.top >= 16 && r.right <= viewport.width - 16 && r.bottom <= viewport.height - 16;

describe('placeCard', () => {
  it('sits above a control at the bottom of the screen, inside the viewport', () => {
    const send = rect(1664, 872, 1718, 922);
    const placed = placeCard({ target: send, obstacles: [], card, viewport });
    expect(placed.side).toBe('above');
    expect(placed.top).toBe(872 - 12 - card.height);
    expect(onScreen(cardAt(placed))).toBe(true);
    expect(overlaps(cardAt(placed), send)).toBe(false);
  });

  it('rises past a toast that lands beside the control', () => {
    const send = rect(1664, 872, 1718, 922);
    const toast = rect(1348, 840, 1704, 912);
    const placed = placeCard({ target: send, obstacles: [toast], card, viewport });
    expect(placed.side).toBe('above');
    expect(placed.top).toBe(840 - 12 - card.height);
    expect(overlaps(cardAt(placed), toast)).toBe(false);
  });

  it('keeps clear of the whole target, so a canvas node keeps its title readable', () => {
    const node = rect(1129, 384, 1493, 614);
    const placed = placeCard({ target: node, obstacles: [], card, viewport });
    expect(overlaps(cardAt(placed), node)).toBe(false);
    expect(onScreen(cardAt(placed))).toBe(true);
  });

  it('takes the preferred side when it fits, top-aligned with the target', () => {
    const sidebarLink = rect(4, 124, 341, 180);
    const placed = placeCard({ target: sidebarLink, obstacles: [], card, viewport, prefer: 'right' });
    expect(placed).toEqual({ side: 'right', left: 341 + 12, top: 124 });
  });

  it('places left of the target when asked, leaving the panel beside it readable', () => {
    const submit = rect(934, 482, 1166, 532);
    const placed = placeCard({ target: submit, obstacles: [], card, viewport, prefer: 'left' });
    expect(placed).toEqual({ side: 'left', left: 934 - 12 - card.width, top: 482 });
  });

  it('falls back from a preferred side with no room', () => {
    const nearRight = rect(1500, 400, 1712, 440);
    const placed = placeCard({ target: nearRight, obstacles: [], card, viewport, prefer: 'right' });
    expect(placed.side).not.toBe('right');
    expect(overlaps(cardAt(placed), nearRight)).toBe(false);
  });

  it('slides a side placement down to stay on screen', () => {
    const low = rect(100, 880, 200, 920);
    const placed = placeCard({ target: low, obstacles: [], card, viewport, prefer: 'right' });
    expect(placed.side).toBe('right');
    expect(placed.top).toBe(viewport.height - 16 - card.height);
  });

  it('stays on screen, covering as little of the target as it can, when no side is clear', () => {
    const tall = rect(10, 10, 1718, 836);
    const placed = placeCard({ target: tall, obstacles: [], card, viewport });
    expect(placed).toEqual({ side: 'below', left: 16, top: viewport.height - 16 - card.height });
    expect(onScreen(cardAt(placed))).toBe(true);
  });
});

describe('dockCard', () => {
  const composer = rect(354, 652, 1555, 755);
  const statusLine = rect(354, 615, 1555, 645);
  const small = { width: 1568, height: 765 };

  it('stays in its corner when nothing there is in the way', () => {
    expect(dockCard({ side: 'right', card, viewport: small, obstacles: [] })).toBe(24);
    expect(
      dockCard({ side: 'left', card, viewport: { width: 2000, height: 765 }, obstacles: [rect(400, 600, 1200, 760)] })
    ).toBe(24);
  });

  it('rises above the composer and the status line over it, in either corner', () => {
    for (const side of ['left', 'right'] as const) {
      const bottom = dockCard({ side, card, viewport: small, obstacles: [composer, statusLine] });
      expect(bottom).toBe(small.height - statusLine.top + 12);
      const left = side === 'left' ? 24 : small.width - 24 - card.width;
      const top = small.height - bottom - card.height;
      const docked = rect(left, top, left + card.width, top + card.height);
      expect(overlaps(docked, composer) || overlaps(docked, statusLine)).toBe(false);
    }
  });

  it('stays on screen when the card is too tall to fit above what it avoids', () => {
    const tall = { width: 340, height: 700 };
    expect(dockCard({ side: 'right', card: tall, viewport: small, obstacles: [composer] })).toBe(
      small.height - 700 - 16
    );
  });
});

describe('CoachMark', () => {
  const boxes = new Map<string, Rect>();
  const realRect = HTMLElement.prototype.getBoundingClientRect;
  const realWidth = window.innerWidth;
  const realHeight = window.innerHeight;

  afterEach(() => {
    boxes.clear();
    HTMLElement.prototype.getBoundingClientRect = realRect;
    Object.defineProperty(window, 'innerWidth', { configurable: true, value: realWidth });
    Object.defineProperty(window, 'innerHeight', { configurable: true, value: realHeight });
  });

  const stubRects = () => {
    HTMLElement.prototype.getBoundingClientRect = vi.fn(function (this: HTMLElement) {
      const key = this.getAttribute('data-testid') ?? (this.hasAttribute('data-sonner-toast') ? 'toast' : '');
      const r = boxes.get(key) ?? rect(0, 0, 0, 0);
      return { ...r, x: r.left, y: r.top, width: r.right - r.left, height: r.bottom - r.top, toJSON: () => r };
    });
  };

  it('places itself above an anchor at the bottom, clear of its ring and of a toast', async () => {
    boxes.set('send', rect(980, 712, 1010, 742));
    boxes.set('tutorial-coach-card', rect(0, 0, 340, 150));
    boxes.set('toast', rect(650, 690, 1010, 750));
    stubRects();
    render(
      <>
        <button data-testid="send">Send</button>
        <ol>
          <li data-sonner-toast="">Adding file</li>
        </ol>
        <CoachMark stepKey="s" body="Press Send." anchor="send" onLeave={() => undefined} />
      </>
    );
    const cardEl = screen.getByTestId('tutorial-coach-card');
    await waitFor(() => expect(cardEl).toHaveStyle({ top: `${690 - 12 - 150}px` }));
    expect(cardEl).toHaveStyle({ left: `${window.innerWidth - 340 - 16}px` });
  });

  it('docks above an element it avoids when it has no anchor', async () => {
    Object.defineProperty(window, 'innerWidth', { configurable: true, value: 1568 });
    Object.defineProperty(window, 'innerHeight', { configurable: true, value: 765 });
    boxes.set('composer', rect(354, 652, 1555, 755));
    boxes.set('tutorial-coach-card', rect(0, 0, 340, 150));
    stubRects();
    render(
      <>
        <div data-testid="composer" />
        <CoachMark
          stepKey="s"
          body="Read the answer."
          placement="left"
          avoid='[data-testid="composer"]'
          onLeave={() => undefined}
        />
      </>
    );
    const cardEl = screen.getByTestId('tutorial-coach-card');
    await waitFor(() => expect(cardEl).toHaveStyle({ left: '24px', bottom: `${765 - 652 + 12}px` }));
  });

  it('keeps clear of an avoided element beside its anchor, as a status line over the composer', async () => {
    Object.defineProperty(window, 'innerWidth', { configurable: true, value: 1568 });
    Object.defineProperty(window, 'innerHeight', { configurable: true, value: 765 });
    boxes.set('send', rect(1500, 712, 1540, 742));
    boxes.set('status', rect(354, 615, 1555, 645));
    boxes.set('tutorial-coach-card', rect(0, 0, 340, 150));
    stubRects();
    render(
      <>
        <div data-testid="status" />
        <button data-testid="send">Send</button>
        <CoachMark
          stepKey="s"
          body="Press Send."
          anchor="send"
          avoid='[data-testid="status"]'
          onLeave={() => undefined}
        />
      </>
    );
    await waitFor(() => expect(screen.getByTestId('tutorial-coach-card')).toHaveStyle({ top: `${615 - 12 - 150}px` }));
  });

  it("docks the step pill clear of the composer's voice button, which no step has to name", async () => {
    Object.defineProperty(window, 'innerWidth', { configurable: true, value: 1568 });
    Object.defineProperty(window, 'innerHeight', { configurable: true, value: 765 });
    boxes.set('voice-record-btn', rect(1490, 712, 1522, 744));
    boxes.set('tutorial-coach-pill', rect(0, 0, 110, 32));
    stubRects();
    render(
      <>
        <button data-testid="voice-record-btn">Voice</button>
        <CoachMark stepKey="s" body="b" progress={{ index: 2, count: 14 }} onLeave={() => undefined} />
      </>
    );
    fireEvent.click(screen.getByTestId('tutorial-coach-hide'));
    await waitFor(() =>
      expect(screen.getByTestId('tutorial-coach-pill')).toHaveStyle({ right: '24px', bottom: `${765 - 712 + 12}px` })
    );
  });

  it('scrolls an anchor half under the bottom of its scrolling box into view', async () => {
    boxes.set('chat', rect(0, 100, 600, 700));
    boxes.set('chip', rect(20, 680, 300, 720));
    stubRects();
    const scroll = vi.fn();
    render(
      <>
        <div data-testid="chat" style={{ overflowY: 'auto' }}>
          <button
            data-testid="chip"
            ref={el => {
              if (el) el.scrollIntoView = scroll;
            }}
          >
            Open the canvas
          </button>
        </div>
        <CoachMark stepKey="s" body="Open the canvas." anchor="chip" onLeave={() => undefined} />
      </>
    );
    await waitFor(() => expect(scroll).toHaveBeenCalledWith({ block: 'center', behavior: 'smooth' }));
  });

  it('leaves an anchor alone when its scrolling box shows all of it', async () => {
    boxes.set('chat', rect(0, 100, 600, 700));
    boxes.set('chip', rect(20, 600, 300, 640));
    stubRects();
    const scroll = vi.fn();
    render(
      <>
        <div data-testid="chat" style={{ overflowY: 'auto' }}>
          <button
            data-testid="chip"
            ref={el => {
              if (el) el.scrollIntoView = scroll;
            }}
          >
            Open the canvas
          </button>
        </div>
        <CoachMark stepKey="s" body="Open the canvas." anchor="chip" onLeave={() => undefined} />
      </>
    );
    await screen.findByTestId('tutorial-anchor-ring');
    expect(scroll).not.toHaveBeenCalled();
  });

  const renderChip = (scroll: () => void) =>
    render(
      <>
        <div data-testid="chat" style={{ overflowY: 'auto' }}>
          <button
            data-testid="chip"
            ref={el => {
              if (el) el.scrollIntoView = scroll;
            }}
          >
            Open the canvas
          </button>
        </div>
        <CoachMark stepKey="s" body="Open the canvas." anchor="chip" onLeave={() => undefined} />
      </>
    );
  const replyLandsAbove = () => {
    boxes.set('chip', rect(20, 680, 300, 720));
    act(() => {
      screen.getByTestId('chat').prepend(document.createElement('p'));
    });
  };

  it('scrolls the anchor back into view when the page pushes it out just after it appears', async () => {
    boxes.set('chat', rect(0, 100, 600, 700));
    boxes.set('chip', rect(20, 600, 300, 640));
    stubRects();
    const scroll = vi.fn();
    renderChip(scroll);
    await screen.findByTestId('tutorial-anchor-ring');
    expect(scroll).not.toHaveBeenCalled();
    replyLandsAbove();
    await waitFor(() => expect(scroll).toHaveBeenCalledWith({ block: 'center', behavior: 'smooth' }));
  });

  it('leaves the anchor where the page put it once the user has scrolled', async () => {
    boxes.set('chat', rect(0, 100, 600, 700));
    boxes.set('chip', rect(20, 600, 300, 640));
    stubRects();
    const scroll = vi.fn();
    renderChip(scroll);
    await screen.findByTestId('tutorial-anchor-ring');
    fireEvent.wheel(window);
    replyLandsAbove();
    await new Promise(resolve => setTimeout(resolve, 500));
    expect(scroll).not.toHaveBeenCalled();
  });

  it('still reveals a push-out that lands just before the settle window closes', async () => {
    const realNow = Date.now;
    let offset = 0;
    vi.spyOn(Date, 'now').mockImplementation(() => realNow() + offset);
    try {
      boxes.set('chat', rect(0, 100, 600, 700));
      boxes.set('chip', rect(20, 600, 300, 640));
      stubRects();
      const scroll = vi.fn();
      renderChip(scroll);
      await screen.findByTestId('tutorial-anchor-ring');
      replyLandsAbove();
      await new Promise(resolve => setTimeout(resolve, 40));
      offset = 2500;
      act(() => {
        screen.getByTestId('chat').append(document.createElement('p'));
      });
      await waitFor(() => expect(scroll).toHaveBeenCalledWith({ block: 'center', behavior: 'smooth' }));
    } finally {
      vi.mocked(Date.now).mockRestore();
    }
  });

  it('re-places itself when the window resizes, though the anchor has not moved', async () => {
    Object.defineProperty(window, 'innerWidth', { configurable: true, value: 1024 });
    boxes.set('send', rect(600, 712, 630, 742));
    boxes.set('tutorial-coach-card', rect(0, 0, 340, 150));
    stubRects();
    render(
      <>
        <button data-testid="send">Send</button>
        <CoachMark stepKey="s" body="Press Send." anchor="send" onLeave={() => undefined} />
      </>
    );
    const cardEl = screen.getByTestId('tutorial-coach-card');
    await waitFor(() => expect(cardEl).toHaveStyle({ left: `${600 - 6}px` }));
    Object.defineProperty(window, 'innerWidth', { configurable: true, value: 800 });
    act(() => {
      window.dispatchEvent(new Event('resize'));
    });
    await waitFor(() => expect(cardEl).toHaveStyle({ left: `${800 - 340 - 16}px` }));
  });

  it('drops the ring while a modal covers the anchor, and brings it back once the modal closes', async () => {
    boxes.set('verb', rect(650, 457, 772, 485));
    boxes.set('tutorial-coach-card', rect(0, 0, 340, 150));
    stubRects();
    render(
      <>
        <div data-testid="app-root">
          <button data-testid="verb">Inputs &amp; solve</button>
        </div>
        <CoachMark stepKey="s" body="Open the problem." anchor="verb" onLeave={() => undefined} />
      </>
    );
    await waitFor(() => expect(screen.getByTestId('tutorial-anchor-ring')).toBeInTheDocument());
    const root = screen.getByTestId('app-root');
    act(() => root.setAttribute(a11yAttr('ariaHidden'), 'true'));
    await waitFor(() => expect(screen.queryByTestId('tutorial-anchor-ring')).toBeNull());
    act(() => root.removeAttribute(a11yAttr('ariaHidden')));
    await waitFor(() => expect(screen.getByTestId('tutorial-anchor-ring')).toBeInTheDocument());
  });

  it('follows an anchor that a layout shift moves without resizing it', async () => {
    boxes.set('submit', rect(900, 300, 1000, 340));
    boxes.set('tutorial-coach-card', rect(0, 0, 340, 150));
    stubRects();
    render(
      <>
        <div data-testid="panel">
          <button data-testid="submit">Submit</button>
        </div>
        <CoachMark stepKey="s" body="Press Submit." anchor="submit" onLeave={() => undefined} />
      </>
    );
    const ring = await screen.findByTestId('tutorial-anchor-ring');
    expect(ring).toHaveStyle({ top: `${300 - 6}px` });
    boxes.set('submit', rect(900, 420, 1000, 460));
    act(() => {
      screen.getByTestId('panel').prepend(document.createElement('p'));
    });
    await waitFor(() => expect(screen.getByTestId('tutorial-anchor-ring')).toHaveStyle({ top: `${420 - 6}px` }));
  });

  it('shows the step count, or the heading on a card without one', () => {
    const { rerender } = render(
      <CoachMark stepKey="s" body="b" progress={{ index: 1, count: 14 }} onLeave={() => undefined} />
    );
    expect(screen.getByTestId('tutorial-coach-progress')).toHaveTextContent('Step 1 of 14');
    rerender(<CoachMark stepKey="s" body="b" heading="All 14 steps done" onLeave={() => undefined} />);
    expect(screen.getByTestId('tutorial-coach-progress')).toHaveTextContent('All 14 steps done');
    rerender(
      <CoachMark
        stepKey="s"
        body="b"
        heading="All 14 steps done"
        onShowSteps={() => undefined}
        onLeave={() => undefined}
      />
    );
    expect(screen.getByTestId('tutorial-coach-steps')).toHaveTextContent('All 14 steps done');
  });

  it('keeps Tab inside a panel card, wrapping at either end', () => {
    render(
      <CoachMark stepKey="s" body="b" title="Done" panel onLeave={() => undefined}>
        <button data-testid="first-quest">First</button>
        <button data-testid="last-quest">Last</button>
      </CoachMark>
    );
    const card = screen.getByTestId('tutorial-coach-card');
    const stops = Array.from(card.querySelectorAll('button'));
    const last = stops[stops.length - 1];
    last.focus();
    fireEvent.keyDown(last, { key: 'Tab' });
    expect(document.activeElement).toBe(stops[0]);
    fireEvent.keyDown(stops[0], { key: 'Tab', shiftKey: true });
    expect(document.activeElement).toBe(last);
  });

  it('brings Tab back into a panel card once focus has fallen to the page behind it', () => {
    render(
      <>
        <button data-testid="behind">Behind</button>
        <CoachMark stepKey="s" body="b" title="Done" panel onLeave={() => undefined}>
          <button data-testid="first-quest">First</button>
          <button data-testid="last-quest">Last</button>
        </CoachMark>
      </>
    );
    const stops = Array.from(screen.getByTestId('tutorial-coach-card').querySelectorAll('button'));
    const behind = screen.getByTestId('behind');
    behind.focus();
    fireEvent.keyDown(behind, { key: 'Tab' });
    expect(document.activeElement).toBe(stops[0]);
    document.body.focus();
    fireEvent.keyDown(document.body, { key: 'Tab', shiftKey: true });
    expect(document.activeElement).toBe(stops[stops.length - 1]);
  });

  it('closes a panel on Escape even when focus is outside the card', () => {
    const onLeave = vi.fn();
    render(
      <CoachMark stepKey="s" body="b" title="Done" panel onLeave={onLeave}>
        <button>Only</button>
      </CoachMark>
    );
    document.body.focus();
    fireEvent.keyDown(document.body, { key: 'Escape' });
    expect(onLeave).toHaveBeenCalledTimes(1);
  });

  it('keeps focus in a panel when the scrim is pressed', () => {
    render(
      <CoachMark stepKey="s" body="b" title="Done" panel onLeave={() => undefined}>
        <button>Only</button>
      </CoachMark>
    );
    expect(fireEvent.mouseDown(screen.getByTestId('tutorial-panel-scrim'))).toBe(false);
  });

  it('focuses a panel card that offers no primary button, so focus is inside the modal', () => {
    render(
      <CoachMark stepKey="s" body="b" title="Done" panel onLeave={() => undefined}>
        <button>Secondary</button>
      </CoachMark>
    );
    expect(document.activeElement).toBe(screen.getByTestId('tutorial-coach-card'));
  });

  it('leaves Tab alone on a card that is not a panel', () => {
    render(
      <CoachMark stepKey="s" body="b" onLeave={() => undefined}>
        <button data-testid="only">Only</button>
      </CoachMark>
    );
    const stops = Array.from(screen.getByTestId('tutorial-coach-card').querySelectorAll('button'));
    const last = stops[stops.length - 1];
    last.focus();
    expect(fireEvent.keyDown(last, { key: 'Tab' })).toBe(true);
    expect(document.activeElement).toBe(last);
  });

  it('hides into a step pill on close, reopens from it, and returns on its own for the next step', () => {
    const onLeave = vi.fn();
    const props = { body: 'b', progress: { index: 3, count: 14 }, onLeave };
    const { rerender } = render(<CoachMark stepKey="s3" {...props} />);
    fireEvent.click(screen.getByTestId('tutorial-coach-hide'));
    expect(screen.getByTestId('tutorial-coach-card')).not.toBeVisible();
    expect(screen.getByTestId('tutorial-coach-pill')).toHaveTextContent('Step 3 of 14');
    expect(onLeave).not.toHaveBeenCalled();

    fireEvent.click(screen.getByTestId('tutorial-coach-pill'));
    expect(screen.getByTestId('tutorial-coach-card')).toBeVisible();
    expect(screen.queryByTestId('tutorial-coach-pill')).toBeNull();

    fireEvent.keyDown(screen.getByTestId('tutorial-coach-card'), { key: 'Escape' });
    expect(screen.getByTestId('tutorial-coach-pill')).toBeVisible();
    rerender(<CoachMark stepKey="s4" {...props} progress={{ index: 4, count: 14 }} />);
    expect(screen.getByTestId('tutorial-coach-card')).toBeVisible();
    expect(screen.queryByTestId('tutorial-coach-pill')).toBeNull();

    // A step hidden earlier opens as a card when the user comes back to it.
    fireEvent.click(screen.getByTestId('tutorial-coach-hide'));
    rerender(<CoachMark stepKey="s3" {...props} />);
    expect(screen.getByTestId('tutorial-coach-card')).toBeVisible();
    expect(screen.queryByTestId('tutorial-coach-pill')).toBeNull();

    fireEvent.click(screen.getByTestId('tutorial-coach-leave'));
    expect(onLeave).toHaveBeenCalledTimes(1);
  });

  it('brings a hidden card back when its step turns done, so what comes next is not left behind the pill', () => {
    const props = { stepKey: 's5', body: 'b', progress: { index: 5, count: 14 }, onLeave: () => undefined };
    const { rerender } = render(<CoachMark {...props} />);
    fireEvent.click(screen.getByTestId('tutorial-coach-hide'));
    expect(screen.getByTestId('tutorial-coach-pill')).toBeVisible();

    rerender(<CoachMark {...props} done />);
    expect(screen.getByTestId('tutorial-coach-card')).toBeVisible();
    expect(screen.queryByTestId('tutorial-coach-pill')).toBeNull();

    // Once done, the card can still be tucked away again.
    fireEvent.click(screen.getByTestId('tutorial-coach-hide'));
    expect(screen.getByTestId('tutorial-coach-pill')).toBeVisible();
  });

  it('closes a panel card from its X, with no pill and no separate Leave', () => {
    const onLeave = vi.fn();
    render(<CoachMark stepKey="bridge" body="b" title="Done" panel onLeave={onLeave} />);
    expect(screen.queryByTestId('tutorial-coach-hide')).toBeNull();
    const close = screen.getByTestId('tutorial-coach-leave');
    expect(close).toHaveAttribute(a11yAttr('ariaLabel'), 'Leave tutorial');
    expect(screen.getAllByTestId('tutorial-coach-leave')).toHaveLength(1);

    fireEvent.click(close);
    expect(onLeave).toHaveBeenCalledTimes(1);
    expect(screen.queryByTestId('tutorial-coach-pill')).toBeNull();
    expect(screen.getByTestId('tutorial-coach-card')).toBeVisible();
  });

  it('pulses the ring until the target is pressed, and pulses again on the next step', () => {
    const target = document.createElement('button');
    target.setAttribute('data-testid', 'target');
    target.getBoundingClientRect = () => DOMRect.fromRect({ x: 100, y: 100, width: 80, height: 32 });
    document.body.appendChild(target);
    try {
      const { rerender } = render(<CoachMark stepKey="s1" body="b" anchor="target" onLeave={() => undefined} />);
      expect(screen.getByTestId('tutorial-anchor-ring')).toHaveAttribute('data-pulsing', 'true');
      fireEvent.click(target);
      expect(screen.getByTestId('tutorial-anchor-ring')).not.toHaveAttribute('data-pulsing');
      rerender(<CoachMark stepKey="s2" body="b" anchor="target" onLeave={() => undefined} />);
      expect(screen.getByTestId('tutorial-anchor-ring')).toHaveAttribute('data-pulsing', 'true');
    } finally {
      target.remove();
    }
  });
});
