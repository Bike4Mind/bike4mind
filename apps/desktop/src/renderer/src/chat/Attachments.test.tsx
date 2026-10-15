import { renderToStaticMarkup } from 'react-dom/server';
import type { ChatAttachment } from '@shared/chat';
import { describe, expect, it, vi } from 'vitest';
import { AttachmentRow } from './Attachments';

/**
 * Rendered to a string, like ApprovalChoice's tests and for the same reason: this package's
 * vitest runs on `node`.
 *
 * So what is asked here is the CLOSED row - that an image is wrapped in a real button and a text
 * file is not. The viewer is a portal that mounts only once opened, so it is absent from this
 * markup by design, which is itself worth asserting.
 */
const IMAGE: ChatAttachment = {
  id: 'a1',
  kind: 'image',
  name: 'wide-screenshot.png',
  mediaType: 'image/png',
  sourceBytes: 2048,
  byteSize: 2048,
  truncated: false,
};

const TEXT: ChatAttachment = { ...IMAGE, id: 'a2', kind: 'text', name: 'server.log', mediaType: 'text/plain' };

/**
 * readAttachment is what the tile awaits for its bytes. Static rendering never runs the effect,
 * so the stub only has to exist; the markup under test is the pre-bytes tile either way.
 */
function markup(attachments: readonly ChatAttachment[]): string {
  vi.stubGlobal('window', { b4m: { chat: { readAttachment: () => Promise.resolve(null) } } });
  return renderToStaticMarkup(<AttachmentRow sessionId="s1" attachments={attachments} />);
}

describe('AttachmentRow', () => {
  it('keeps a text attachment inert - there is nothing cropped to reveal', () => {
    const html = markup([TEXT]);
    expect(html).toContain('server.log');
    expect(html).not.toContain('data-testid="attachment-view-btn"');
  });

  it('does not mount the viewer until the tile is clicked', () => {
    expect(markup([IMAGE])).not.toContain('data-testid="attachment-viewer-image"');
  });

  it('leaves the remove control a separate button, so removing cannot also open the viewer', () => {
    const html = renderToStaticMarkup(<AttachmentRow sessionId="s1" attachments={[IMAGE]} onRemove={() => {}} />);
    expect(html).toContain('data-testid="attachment-remove-btn"');
    // Siblings inside the tile, never nested - a click on one is never a click on the other.
    expect(html).not.toMatch(/attachment-view-btn[\s\S]*?attachment-remove-btn[\s\S]*?<\/button>\s*<\/button>/);
  });
});
