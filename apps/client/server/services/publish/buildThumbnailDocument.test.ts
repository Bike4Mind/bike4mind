import { describe, it, expect, vi } from 'vitest';
import { createHash } from 'node:crypto';
import { BLESSED_SCRIPT_PATHS } from '@bike4mind/common';
import { buildSignupGateHtml } from '@client/app/utils/shareFooter';
import { buildThumbnailDocument } from './buildThumbnailDocument';
import { PUBLISH_HOST } from './validateBundle';

const sha = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');

const INDEX = Buffer.from(
  '<!doctype html><html><head><link rel="stylesheet" href="style.css"></head>' +
    '<body><img src="logo.png" alt="logo"><video src="clip.mp4"></video></body></html>'
);
const FILES: Record<string, Buffer> = {
  'index.html': INDEX,
  'style.css': Buffer.from('body{color:#123456}'),
  'logo.png': Buffer.from([0x89, 0x50, 0x4e, 0x47]),
  'clip.mp4': Buffer.from('video-bytes'),
};
const MANIFEST = [
  { path: 'index.html', mimeType: 'text/html' },
  { path: 'style.css', mimeType: 'text/css' },
  { path: 'logo.png', mimeType: 'image/png' },
  { path: 'clip.mp4', mimeType: 'video/mp4' },
];

const loader = (files: Record<string, Buffer>) =>
  vi.fn(async (path: string) => {
    const file = files[path];
    if (!file) throw new Error(`no such object: ${path}`);
    return file;
  });

describe('buildThumbnailDocument', () => {
  it('inlines the bundle assets from storage so the render needs no URL to the artifact', async () => {
    const load = loader(FILES);
    const doc = await buildThumbnailDocument({
      versionId: sha(INDEX),
      manifest: MANIFEST,
      load,
      appOrigin: 'https://app.example.test',
    });

    expect(doc).not.toBeNull();
    expect(doc?.srcdoc).toContain('color:#123456');
    expect(doc?.srcdoc).toContain('data:image/png;base64,');
    expect(doc?.srcdoc).not.toMatch(/href="style\.css"|src="logo\.png"/);
    // The video is skipped on purpose, so it is not reported as a gap in the render.
    expect(doc?.droppedAssets).toEqual({ missing: [], oversized: [], failed: [] });
  });

  it('never loads always-streamed media, which a still frame does not need', async () => {
    const load = loader(FILES);
    await buildThumbnailDocument({
      versionId: sha(INDEX),
      manifest: MANIFEST,
      load,
      appOrigin: 'https://app.example.test',
    });
    expect(load).not.toHaveBeenCalledWith('clip.mp4');
  });

  it('returns null once a newer publish has overwritten index.html', async () => {
    const doc = await buildThumbnailDocument({
      versionId: 'f'.repeat(64),
      manifest: MANIFEST,
      load: loader(FILES),
      appOrigin: 'https://app.example.test',
    });
    expect(doc).toBeNull();
  });

  it('allows only the blessed library scripts on the app origin', async () => {
    const doc = await buildThumbnailDocument({
      versionId: sha(INDEX),
      manifest: MANIFEST,
      load: loader(FILES),
      appOrigin: 'https://app.example.test/some/path?x=1',
    });
    const origins = [...new Set(['https://app.example.test', PUBLISH_HOST ? `https://${PUBLISH_HOST}` : ''])].filter(
      Boolean
    );
    expect(doc?.allowedScriptUrls).toEqual(origins.flatMap(o => BLESSED_SCRIPT_PATHS.map(p => `${o}${p}`)));
  });

  it('ignores a non-http app origin rather than allowlisting it', async () => {
    const doc = await buildThumbnailDocument({
      versionId: sha(INDEX),
      manifest: MANIFEST,
      load: loader(FILES),
      appOrigin: 'javascript:alert(1)',
    });
    expect(doc?.allowedScriptUrls.some(u => u.startsWith('javascript:'))).toBe(false);
  });

  it('renders a baked sign-up gate dismissed, as the owner sees the page', async () => {
    const gated = Buffer.from(
      `<!doctype html><html><head><style>${buildSignupGateHtml().styles}</style></head><body><h1>Report</h1>${buildSignupGateHtml().html}</body></html>`
    );
    const doc = await buildThumbnailDocument({
      versionId: sha(gated),
      manifest: [{ path: 'index.html', mimeType: 'text/html' }],
      load: loader({ 'index.html': gated }),
      appOrigin: 'https://app.example.test',
    });
    expect(doc?.srcdoc).toContain('Report');
    expect(doc?.srcdoc).toMatch(/<input type="checkbox" id="b4m-gate-dismiss" checked/);
    expect(doc?.srcdoc).toContain('#b4m-gate-dismiss:checked~#b4m-gate-panel{display:none!important}');
  });

  it('reports a bundle file that failed to load instead of failing the render', async () => {
    const { 'logo.png': _missing, ...withoutLogo } = FILES;
    const doc = await buildThumbnailDocument({
      versionId: sha(INDEX),
      manifest: MANIFEST,
      load: loader(withoutLogo),
      appOrigin: 'https://app.example.test',
    });
    expect(doc?.droppedAssets).toEqual({ missing: [], oversized: [], failed: ['logo.png'] });
  });

  it('reports refs to files the bundle does not contain, by bundle path and once each', async () => {
    const page = Buffer.from(
      '<!doctype html><html><head><link rel="stylesheet" href="./theme.css"></head>' +
        '<body><img src="img/a.png"><img src="./img/a.png"><img src="logo.png"></body></html>'
    );
    const doc = await buildThumbnailDocument({
      versionId: sha(page),
      manifest: [
        { path: 'index.html', mimeType: 'text/html' },
        { path: 'logo.png', mimeType: 'image/png' },
      ],
      load: loader({ ...FILES, 'index.html': page }),
      appOrigin: 'https://app.example.test',
    });
    expect(doc?.droppedAssets).toEqual({ missing: ['theme.css', 'img/a.png'], oversized: [], failed: [] });
  });
});
