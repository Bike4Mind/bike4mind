import { describe, expect, it } from 'vitest';
import { isImageAttachment, resolveAttachScope } from './attachmentScope';

describe('isImageAttachment', () => {
  it.each([
    ['image/png', true],
    ['image/jpeg', true],
    ['image/svg+xml', true],
    ['IMAGE/PNG', true],
    ['application/pdf', false],
    ['text/csv', false],
    ['text/markdown', false],
    // 'image' has to be the type, not a substring of the subtype
    ['text/imageish', false],
    ['', false],
  ])('%s -> %s', (mimeType, expected) => {
    expect(isImageAttachment(mimeType)).toBe(expected);
  });

  it('is false for a missing mime type rather than throwing', () => {
    expect(isImageAttachment(undefined)).toBe(false);
    expect(isImageAttachment(null)).toBe(false);
  });
});

describe('resolveAttachScope', () => {
  // The two assertions below are the point of this file. #959 was caused by uploads
  // defaulting to single-turn scope, so a document defaulting to anything but
  // 'notebook' - or an image defaulting to 'notebook' - is a regression, not a tweak.
  it('defaults a document to notebook scope', () => {
    expect(resolveAttachScope('auto', 'application/pdf')).toBe('notebook');
    expect(resolveAttachScope('auto', 'text/csv')).toBe('notebook');
  });

  it('defaults an image to message scope', () => {
    expect(resolveAttachScope('auto', 'image/png')).toBe('message');
  });

  it('treats an unknown mime type as a document', () => {
    expect(resolveAttachScope('auto', undefined)).toBe('notebook');
  });

  it('honours an explicit mode over the mime type', () => {
    expect(resolveAttachScope('notebook', 'image/png')).toBe('notebook');
    expect(resolveAttachScope('message', 'application/pdf')).toBe('message');
  });
});
