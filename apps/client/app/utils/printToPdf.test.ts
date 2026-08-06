import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { buildPrintDocument, printHtmlForPdf } from './printToPdf';

describe('buildPrintDocument', () => {
  it('injects the print trigger just before </body>', () => {
    const doc = buildPrintDocument('<html><body><h1>Hi</h1></body></html>');
    expect(doc).toContain('window.print()');
    // The trigger precedes the closing body so it runs after the artifact's content.
    expect(doc.indexOf('window.print()')).toBeLessThan(doc.indexOf('</body>'));
    expect(doc).toContain('<h1>Hi</h1>');
  });

  it('appends the trigger when there is no body tag (e.g. a bare fragment)', () => {
    const doc = buildPrintDocument('<svg></svg>');
    expect(doc.startsWith('<svg></svg>')).toBe(true);
    expect(doc).toContain('window.print()');
  });

  it('drops an author CSP meta that would otherwise block the inline trigger', () => {
    const html =
      '<html><head><meta http-equiv="Content-Security-Policy" content="script-src \'none\'"></head>' +
      '<body>x</body></html>';
    const doc = buildPrintDocument(html);
    expect(doc.toLowerCase()).not.toContain('content-security-policy');
    expect(doc).toContain('window.print()');
  });
});

describe('printHtmlForPdf', () => {
  beforeEach(() => {
    document.body.innerHTML = '';
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  const frame = () => document.querySelector('iframe');

  it('mounts an opaque-origin sandboxed frame carrying the print document', () => {
    printHtmlForPdf('<html><body>doc</body></html>');
    const f = frame();
    expect(f).not.toBeNull();
    const sandbox = f!.getAttribute('sandbox') ?? '';
    expect(sandbox).toContain('allow-scripts');
    expect(sandbox).toContain('allow-modals');
    // No allow-same-origin: the frame cannot reach app cookies/DOM.
    expect(sandbox).not.toContain('allow-same-origin');
    expect(f!.getAttribute('srcdoc')).toContain('doc');
    expect(f!.getAttribute('srcdoc')).toContain('window.print()');
  });

  it('removes the frame when it reports completion from its own window', () => {
    printHtmlForPdf('<html><body>doc</body></html>');
    const f = frame();
    expect(f).not.toBeNull();

    // A completion ping from the frame we created reclaims the node.
    window.dispatchEvent(new MessageEvent('message', { data: 'b4m-print-complete', source: f!.contentWindow }));
    expect(frame()).toBeNull();
  });

  it('ignores completion pings from an unrelated window', () => {
    printHtmlForPdf('<html><body>doc</body></html>');
    window.dispatchEvent(new MessageEvent('message', { data: 'b4m-print-complete', source: window }));
    expect(frame()).not.toBeNull();
  });

  it('reclaims the frame on the backstop timeout if no completion arrives', () => {
    printHtmlForPdf('<html><body>doc</body></html>');
    expect(frame()).not.toBeNull();
    vi.advanceTimersByTime(120000);
    expect(frame()).toBeNull();
  });
});
