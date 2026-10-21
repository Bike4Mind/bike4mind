// @vitest-environment jsdom
//
// EXECUTION coverage for the in-frame sign-up gate bridge: a signed-in viewer is served the
// anonymous render, and this is the only thing that takes the gate back off it.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { buildSignupGateHtml, holdShareFooterCtaBeforeGate } from '@client/app/utils/shareFooter';
import { injectSignupGateBridge, SIGNUP_GATE_BRIDGE_JS } from './signupGateBridge';

const FOOTER_CARD =
  '<div style="margin-top:3rem;display:flex;justify-content:center;font-family:ui-sans-serif,system-ui,-apple-system,sans-serif">' +
  '<a href="https://acme.example/?utm_source=shared-artifact&utm_medium=share-footer&utm_campaign=publish">Try Acme</a>' +
  '</div>';

let added: Array<[string, EventListener]> = [];
const nativeWindowAdd = window.addEventListener.bind(window);

/** Run the REAL shipped bridge, exactly as it runs inside the sandboxed frame. */
function runBridge(): void {
  eval(SIGNUP_GATE_BRIDGE_JS);
}

function otherWindow(): Window {
  const frame = document.createElement('iframe');
  document.body.appendChild(frame);
  return frame.contentWindow as Window;
}

function fromParent(data: unknown, source: Window = window): void {
  // Top-level jsdom, so window.parent === window: `source: window` IS the parent.
  window.dispatchEvent(new MessageEvent('message', { data, source }));
}

const panel = () => document.getElementById('b4m-gate-panel') as HTMLElement;
const held = () => document.getElementById('b4m-footer-held') as HTMLElement;

describe('signup gate bridge (in-frame)', () => {
  beforeEach(() => {
    added = [];
    window.addEventListener = ((type: string, fn: EventListener, opts?: AddEventListenerOptions) => {
      added.push([type, fn]);
      nativeWindowAdd(type, fn, opts);
    }) as typeof window.addEventListener;
    const page = holdShareFooterCtaBeforeGate(
      `<html><body><p>content</p>${FOOTER_CARD}${buildSignupGateHtml().html}</body></html>`
    );
    document.body.innerHTML = page.slice(page.indexOf('<body>') + 6, page.lastIndexOf('</body>'));
  });

  afterEach(() => {
    added.forEach(([type, fn]) => window.removeEventListener(type, fn));
    window.addEventListener = nativeWindowAdd as typeof window.addEventListener;
    vi.restoreAllMocks();
  });

  it('starts with the gate showing and the footer card held', () => {
    runBridge();
    expect(panel().style.display).toBe('');
    expect(held().style.display).toBe('none');
  });

  it('swaps the gate for the footer card on the parent member message', () => {
    runBridge();
    fromParent({ b4m: 'member' });

    expect(panel().style.display).toBe('none');
    expect((document.getElementById('b4m-gate-dismiss') as HTMLInputElement).checked).toBe(true);
    expect(held().style.display).toBe('');
  });

  it('ignores a member message from any window other than the parent', () => {
    runBridge();
    fromParent({ b4m: 'member' }, otherWindow());

    expect(panel().style.display).toBe('');
    expect(held().style.display).toBe('none');
  });

  it('ignores other parent messages', () => {
    runBridge();
    fromParent({ b4m: 'print' });
    fromParent('member');

    expect(panel().style.display).toBe('');
  });

  it('announces itself so a member message sent before it loaded is re-sent', () => {
    const post = vi.spyOn(window, 'postMessage');
    runBridge();
    expect(post).toHaveBeenCalledWith({ b4m: 'gate-ready' }, '*');
  });
});

describe('injectSignupGateBridge', () => {
  it('lands before </body>, with no literal </script> inside the script body', () => {
    const out = injectSignupGateBridge('<html><body><p>x</p></body></html>');
    expect(out).toMatch(/<\/script><\/body><\/html>$/);
    expect(SIGNUP_GATE_BRIDGE_JS).not.toContain('</script>');
  });

  it('appends when there is no </body>', () => {
    expect(injectSignupGateBridge('<p>x</p>').startsWith('<p>x</p><script>')).toBe(true);
  });
});
