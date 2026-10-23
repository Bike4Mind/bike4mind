import { describe, it, expect } from 'vitest';
import {
  bufferedContentType,
  inlineTypeFor,
  isRedirectedFetchDest,
  isSafeSignedOrigin,
  isStreamedFile,
  mediaLinkTtlSeconds,
  SIGNED_LINK_TTL_SECONDS,
  signedDisposition,
  signedResponseFor,
} from './signedFiles';

describe('inlineTypeFor', () => {
  it.each([
    ['files/deck.pdf', 'application/pdf'],
    ['media/clip.MP4', 'video/mp4'],
    ['a/b/c.webm', 'video/webm'],
    ['still.jpeg', 'image/jpeg'],
    ['track.mp3', 'audio/mpeg'],
  ])('%s -> %s', (path, type) => {
    expect(inlineTypeFor(path)).toBe(type);
  });

  it.each(['page.html', 'drawing.svg', 'data.xml', 'notes.txt', 'archive.zip', 'noext', 'dir.pdf/file'])(
    'never lets %s view inline',
    path => {
      expect(inlineTypeFor(path)).toBeNull();
    }
  );
});

describe('isStreamedFile', () => {
  it('streams video, audio and PDF but not images', () => {
    expect(isStreamedFile('clip.mp4')).toBe(true);
    expect(isStreamedFile('track.ogg')).toBe(true);
    expect(isStreamedFile('deck.pdf')).toBe(true);
    expect(isStreamedFile('still.png')).toBe(false);
    expect(isStreamedFile('style.css')).toBe(false);
  });
});

describe('signedResponseFor', () => {
  it('pins the type from the extension for inline viewing', () => {
    expect(signedResponseFor('files/deck.pdf', false)).toEqual({
      ResponseContentType: 'application/pdf',
      ResponseContentDisposition: `inline; filename="deck.pdf"; filename*=UTF-8''deck.pdf`,
    });
  });

  it('signs downloads and off-allowlist files as opaque attachments', () => {
    expect(signedResponseFor('files/deck.pdf', true).ResponseContentType).toBe('application/octet-stream');
    expect(signedResponseFor('page.html', false)).toEqual({
      ResponseContentType: 'application/octet-stream',
      ResponseContentDisposition: `attachment; filename="page.html"; filename*=UTF-8''page.html`,
    });
  });
});

describe('signedDisposition', () => {
  it('keeps the quoted filename ASCII and unbreakable, with the real name in filename*', () => {
    const e = String.fromCharCode(0xe9);
    const value = signedDisposition('inline', `files/R${e}sum${e} "final".pdf`);
    expect(value).toBe(`inline; filename="R_sum_ _final_.pdf"; filename*=UTF-8''R%C3%A9sum%C3%A9%20%22final%22.pdf`);
    expect(/^[\x20-\x7e]*$/.test(value)).toBe(true);
  });
});

describe('isSafeSignedOrigin', () => {
  const DOC = 'https://app.bike4mind.com';
  it('accepts a storage origin', () => {
    expect(isSafeSignedOrigin('https://bundles.s3.us-east-2.amazonaws.com', DOC)).toBe(true);
    expect(isSafeSignedOrigin('http://localhost:9000', 'http://localhost:3000')).toBe(true);
  });

  it.each([
    ['an artifact usercontent host', 'https://abc123.usercontent.app.bike4mind.com'],
    ['a non-http scheme', 'javascript:alert(1)'],
    ['garbage', 'not a url'],
  ])('rejects %s', (_label, origin) => {
    expect(isSafeSignedOrigin(origin, DOC)).toBe(false);
  });

  it('rejects the request origin', () => {
    expect(isSafeSignedOrigin('https://preview.bike4mind.com', 'https://preview.bike4mind.com')).toBe(false);
  });

  it('rejects the app host even when the request came from another origin', () => {
    // A preview host serving the request, so only the app-host check can catch this.
    expect(isSafeSignedOrigin('https://app.bike4mind.com', 'https://preview.bike4mind.com')).toBe(false);
    expect(isSafeSignedOrigin('https://APP.bike4mind.com:443', 'https://preview.bike4mind.com')).toBe(false);
  });
});

describe('bufferedContentType', () => {
  it.each(['video/mp4', 'audio/mp4', 'image/avif', 'application/wasm', 'audio/wav', 'model/gltf-binary'])(
    'sends %s, which the edge adapter would text-convert, as octet-stream',
    type => {
      expect(bufferedContentType(type)).toBe('application/octet-stream');
    }
  );

  it.each(['text/css', 'text/html; charset=utf-8', 'application/json', 'image/svg+xml', 'image/png', 'video/webm'])(
    'keeps %s, which survives the adapter',
    type => {
      expect(bufferedContentType(type)).toBe(type);
    }
  );
});

describe('signed link lifetimes', () => {
  it('opens redirect and ?sign=1 links for 15 minutes', () => {
    expect(SIGNED_LINK_TTL_SECONDS).toBe(900);
  });

  it('bounds a media link by the proof that authorized the render', () => {
    expect(mediaLinkTtlSeconds(20 * 60)).toBe(20 * 60);
    expect(mediaLinkTtlSeconds(5 * 60 * 60)).toBe(2 * 60 * 60);
    // A proof on its last seconds still yields a link that survives the page load.
    expect(mediaLinkTtlSeconds(3)).toBe(60);
    // Another gate (no proof cookie) has no lifetime to follow, so it gets the short file-link TTL.
    expect(mediaLinkTtlSeconds(null)).toBe(SIGNED_LINK_TTL_SECONDS);
  });
});

describe('isRedirectedFetchDest', () => {
  it.each(['video', 'audio', 'document', 'iframe', 'frame', 'embed', 'object'])('redirects a %s load', dest => {
    expect(isRedirectedFetchDest(dest)).toBe(true);
  });

  it.each([
    ['track'],
    ['empty'],
    ['script'],
    ['style'],
    ['image'],
    ['font'],
    ['worker'],
    [undefined],
    [['video', 'audio']],
  ])('keeps a %s request on the buffered path', dest => {
    expect(isRedirectedFetchDest(dest as string | string[] | undefined)).toBe(false);
  });
});
