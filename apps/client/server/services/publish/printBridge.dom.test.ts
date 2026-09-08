// @vitest-environment jsdom
//
// EXECUTION coverage for the in-frame print trigger. The static test asserts the tag's shape,
// which cannot tell whether the message contract or the shortcut interception actually works -
// and both are the whole feature: a bridge that never calls print() leaves the viewer with
// Chrome's clipped one-page render of the wrapper and no error anywhere.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { PRINT_BRIDGE_JS } from './printBridge';

/**
 * The bridge attaches to `window` and `document`, and jsdom keeps ONE of each for the whole
 * file - so without detaching, every bridge an earlier test eval'd is still listening and a
 * later dispatch runs all of them. Track what each run adds and remove it afterwards.
 */
let added: Array<[EventTarget, string, EventListener]> = [];
const nativeWindowAdd = window.addEventListener.bind(window);
const nativeDocumentAdd = document.addEventListener.bind(document);

/** Run the REAL shipped bridge, exactly as it runs inside the sandboxed frame. */
function runBridge(): void {
  // eval, deliberately: a reimplementation of the message/shortcut guards would assert itself.
  eval(PRINT_BRIDGE_JS);
}

function otherWindow(): Window {
  const frame = document.createElement('iframe');
  document.body.appendChild(frame);
  return frame.contentWindow as Window;
}

describe('print bridge (in-frame)', () => {
  let print: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    added = [];
    window.addEventListener = ((type: string, fn: EventListener, opts?: AddEventListenerOptions) => {
      added.push([window, type, fn]);
      nativeWindowAdd(type, fn, opts);
    }) as typeof window.addEventListener;
    document.addEventListener = ((type: string, fn: EventListener, opts?: AddEventListenerOptions) => {
      added.push([document, type, fn]);
      nativeDocumentAdd(type, fn, opts);
    }) as typeof document.addEventListener;
    print = vi.fn();
    vi.stubGlobal('print', print);
    document.body.innerHTML = '';
  });

  afterEach(() => {
    // Capture-phase listeners must be removed with the same flag, hence `true`.
    added.forEach(([target, type, fn]) => {
      target.removeEventListener(type, fn);
      target.removeEventListener(type, fn, true);
    });
    window.addEventListener = nativeWindowAdd as typeof window.addEventListener;
    document.addEventListener = nativeDocumentAdd as typeof document.addEventListener;
    vi.unstubAllGlobals();
  });

  it('prints on the parent print message', () => {
    runBridge();
    // Top-level jsdom, so window.parent === window: this IS a message from the parent.
    window.dispatchEvent(new MessageEvent('message', { data: { b4m: 'print' }, source: window }));

    expect(print).toHaveBeenCalledTimes(1);
  });

  it('ignores a print message from any window other than the parent', () => {
    runBridge();
    window.dispatchEvent(new MessageEvent('message', { data: { b4m: 'print' }, source: otherWindow() }));

    expect(print).not.toHaveBeenCalled();
  });

  it('ignores a parent message that is not a print request', () => {
    runBridge();
    window.dispatchEvent(new MessageEvent('message', { data: { b4m: 'pinmode', on: true }, source: window }));
    window.dispatchEvent(new MessageEvent('message', { data: 'print', source: window }));

    expect(print).not.toHaveBeenCalled();
  });

  it('claims Cmd/Ctrl+P so the browser prints the frame instead of the clipped wrapper', () => {
    runBridge();
    const meta = new KeyboardEvent('keydown', { key: 'p', metaKey: true, bubbles: true, cancelable: true });
    document.dispatchEvent(meta);

    expect(print).toHaveBeenCalledTimes(1);
    expect(meta.defaultPrevented).toBe(true);
  });

  it('leaves a plain p keypress alone', () => {
    runBridge();
    const plain = new KeyboardEvent('keydown', { key: 'p', bubbles: true, cancelable: true });
    document.dispatchEvent(plain);

    expect(print).not.toHaveBeenCalled();
    expect(plain.defaultPrevented).toBe(false);
  });
});
