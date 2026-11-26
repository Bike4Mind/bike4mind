// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ISkillTemplateExample } from '@bike4mind/common';

const h = vi.hoisted(() => ({
  findOne: vi.fn(),
  snapshot: vi.fn(),
  ownListing: vi.fn(),
  freeRun: vi.fn(),
  imageFile: vi.fn(),
  signFile: vi.fn(),
  signGenerated: vi.fn(),
  signFileUrl: vi.fn(),
  credits: vi.fn(),
  findFabFile: vi.fn(),
  findSampleFile: vi.fn(),
}));

vi.mock('@bike4mind/database', () => ({
  SkillListingTemplate: { findOne: h.findOne, updateOne: vi.fn() },
  FabFile: { findOne: () => ({ select: () => ({ lean: h.findFabFile }) }) },
  fabFileRepository: { findById: h.findSampleFile },
  adminSettingsRepository: {},
  apiKeyRepository: {},
  cacheRepository: {},
}));
vi.mock('@bike4mind/server-utils/utils/config', () => ({ Config: { JWT_SECRET: 'test-secret' } }));
vi.mock('@server/utils/auth/turnstile', () => ({ getTurnstileFreeRunPolicy: vi.fn() }));
vi.mock('@bike4mind/llm-adapters', () => ({
  buildApiKeyTable: vi.fn(),
  getAvailableModels: vi.fn(),
  getLlmByModel: vi.fn(),
}));
vi.mock('@bike4mind/services', () => ({ apiKeyService: {} }));
vi.mock('@bike4mind/server-utils/services/operationsModelService', () => ({ OperationsModelService: {} }));
vi.mock('@bike4mind/server-utils/utils/storage/index', () => ({
  getFilesStorage: () => ({ getSignedUrl: h.signFile }),
  getGeneratedImageStorage: () => ({ getSignedUrl: h.signGenerated }),
}));
vi.mock('@client/config/general', () => ({ getBrandName: () => 'Acme' }));
vi.mock('@server/utils/starterCredits', () => ({ getOpenSignupStarterCredits: h.credits }));
vi.mock('./template', () => ({ approvedSnapshotOf: h.snapshot, requireOwnListing: h.ownListing, isLive: () => true }));
vi.mock('./templateImage', () => ({
  isPublicTemplatePage: (listing: { visibility: string }) => ['public', 'unlisted'].includes(listing.visibility),
  templatePageImageFile: h.imageFile,
  templateImageDeps: () => ({ signFileUrl: h.signFileUrl }),
}));
vi.mock('./templateFreeRun', async () => {
  const actual = await vi.importActual<typeof import('./templateFreeRun')>('./templateFreeRun');
  return { ...actual, freeRunPageState: h.freeRun };
});

import {
  buildTemplatePageView,
  findOwnPreviewTemplate,
  requiredConnectors,
  signExampleMedia,
  templatePageExampleOf,
} from './templatePageView';
import type { ServableTemplate } from './templatePage';

const example = (over: Partial<ISkillTemplateExample> = {}): ISkillTemplateExample => ({
  status: 'ready',
  enabled: true,
  prompt: 'Plan the launch',
  reply: '## Plan\n\nShip on Monday, then tell everyone about it.',
  steps: [{ label: 'Read 3 issues', simulated: false }],
  ...over,
});

const template = (over: Partial<ServableTemplate> = {}): ServableTemplate => ({
  _id: 't1',
  listingId: 'l1',
  slug: 'launch-plan',
  headline: 'Turn a goal into a plan',
  inputs: [{ label: 'Your goal', required: true }],
  examplePrompt: 'Plan the launch',
  freeRunEnabled: true,
  previewImage: { fabFileId: 'f1', source: 'upload', approved: true },
  takesFile: false,
  example: example(),
  ...over,
});

const listing = (over: Record<string, unknown> = {}) =>
  ({
    id: 'l1',
    name: 'launch-plan',
    visibility: 'public',
    authorUserId: 'author-1',
    authorName: 'Ada',
    ratingSum: 9,
    ratingCount: 2,
    ...over,
  }) as never;

beforeEach(() => {
  vi.clearAllMocks();
  h.snapshot.mockResolvedValue({ snapshot: { allowedTools: [] }, versionId: 'v1' });
  h.freeRun.mockResolvedValue(null);
  h.imageFile.mockResolvedValue({ filePath: 'files/f1.jpg', mimeType: 'image/jpeg' });
  h.signFileUrl.mockResolvedValue('https://files.example.com/f1.jpg?sig=1');
  h.signGenerated.mockImplementation(async (key: string) => `https://gen.example.com/${key}?sig=1`);
  h.signFile.mockImplementation(async (key: string) => `https://files.example.com/${key}?sig=1`);
  h.credits.mockResolvedValue(2500);
  h.findFabFile.mockResolvedValue({ moderationStatus: 'clean', mimeType: 'video/mp4' });
  h.findSampleFile.mockResolvedValue({ moderationStatus: 'clean' });
});

describe('requiredConnectors', () => {
  it('names the known providers of server-scoped tools once each', () => {
    expect(
      requiredConnectors(['github__create_issue', 'github__list_issues', 'Read', 'notion__notion_search', 'acme__x'])
    ).toEqual(['GitHub', 'Notion']);
    expect(requiredConnectors(undefined)).toEqual([]);
  });
});

describe('templatePageExampleOf', () => {
  it('is null when the demo is off or there is no reply, whatever the run status', async () => {
    expect(await templatePageExampleOf(null)).toBeNull();
    expect(await templatePageExampleOf(example({ enabled: false }))).toBeNull();
    expect(await templatePageExampleOf(example({ reply: '  ' }))).toBeNull();
    expect(await templatePageExampleOf(example({ status: 'failed', error: 'boom' }))).not.toBeNull();
    expect(await templatePageExampleOf(example({ status: 'running' }))).not.toBeNull();
  });

  it('renders the reply through the free-run sanitizer', async () => {
    const view = await templatePageExampleOf(
      example({ reply: '# Hi\n\n<script>alert(1)</script><img src=x onerror=alert(1)> [link](https://x.test)' })
    );
    expect(view?.replyHtml).toContain('<h1>Hi</h1>');
    expect(view?.replyHtml).not.toMatch(/<script|<img|onerror|href=/);
  });

  it('applies the trim', async () => {
    const view = await templatePageExampleOf(example({ replyTrimmedTo: 16 }));
    expect(view?.replyHtml).toBe('<h2>Plan</h2>\n<p>Ship on</p>\n');
  });

  it('signs images in the generated-images bucket and videos in the files bucket', async () => {
    const images = await templatePageExampleOf(
      example({
        media: {
          kind: 'carousel',
          items: [
            { key: 'a.png', mime: 'image/png', bytes: 1, moderation: 'clean', width: 10, height: 20 },
            { key: 'b.png', mime: 'image/png', bytes: 1, moderation: 'clean' },
          ],
        },
      })
    );
    expect(images?.media).toEqual({
      kind: 'carousel',
      items: [
        { src: 'https://gen.example.com/a.png?sig=1', mime: 'image/png', width: 10, height: 20 },
        { src: 'https://gen.example.com/b.png?sig=1', mime: 'image/png', width: undefined, height: undefined },
      ],
    });
    expect(h.signGenerated).toHaveBeenCalledWith(
      'a.png',
      'get',
      expect.objectContaining({ audience: 'browser', expiresIn: 3600, ResponseContentType: 'image/png' })
    );

    const video = await templatePageExampleOf(
      example({ media: { kind: 'video', items: [{ key: 'v.mp4', mime: 'video/mp4', bytes: 1, durationS: 9 }] } })
    );
    expect(video?.media?.items[0].src).toBe('https://files.example.com/v.mp4?sig=1');
  });

  it.each([['pending'], ['blocked'], [null]])('does not sign a video whose file is %s', async status => {
    h.findFabFile.mockResolvedValue(status === null ? null : { moderationStatus: status });
    const video = await templatePageExampleOf(
      example({ media: { kind: 'video', items: [{ key: 'v.mp4', mime: 'video/mp4', bytes: 1, durationS: 9 }] } })
    );
    expect(video?.media).toBeNull();
    expect(h.signFile).not.toHaveBeenCalled();
  });

  it.each([['blocked'], ['error'], [undefined]] as const)(
    'never signs or shows an image whose moderation verdict is %s',
    async moderation => {
      const view = await templatePageExampleOf(
        example({
          media: {
            kind: 'carousel',
            items: [
              { key: 'ok.png', mime: 'image/png', bytes: 1, moderation: 'clean' },
              { key: 'bad.png', mime: 'image/png', bytes: 1, ...(moderation ? { moderation } : {}) },
            ],
          },
        })
      );
      expect(view?.media).toEqual({
        kind: 'image',
        items: [
          { src: 'https://gen.example.com/ok.png?sig=1', mime: 'image/png', width: undefined, height: undefined },
        ],
      });
      expect(h.signGenerated).not.toHaveBeenCalledWith('bad.png', expect.anything(), expect.anything());
    }
  );

  it('signExampleMedia refuses an image without a clean verdict', async () => {
    await expect(signExampleMedia({ key: 'old.png', mime: 'image/png', bytes: 1 })).rejects.toThrow(
      'not passed moderation'
    );
    expect(h.signGenerated).not.toHaveBeenCalled();
  });

  it('drops media it cannot sign, and a carousel left with one slide shows as an image', async () => {
    h.signGenerated.mockImplementation(async (key: string) => {
      if (key === 'b.png') throw new Error('gone');
      return `https://gen.example.com/${key}`;
    });
    const view = await templatePageExampleOf(
      example({
        media: {
          kind: 'carousel',
          items: [
            { key: 'a.png', mime: 'image/png', bytes: 1, moderation: 'clean' },
            { key: 'b.png', mime: 'image/png', bytes: 1, moderation: 'clean' },
          ],
        },
      })
    );
    expect(view?.media?.kind).toBe('image');
    expect(view?.media?.items).toHaveLength(1);
  });

  it('re-sanitizes a stored artifact so a script or handler payload never reaches the page', async () => {
    const payload = '<p>ok</p><script>alert(1)</script><img src=x onerror="alert(2)"><div onclick="x()">hi</div>';
    for (const type of ['html', 'markdown']) {
      const view = await templatePageExampleOf(example({ artifact: { type, title: 'T', html: payload } }));
      expect(view?.artifact?.html).toContain('<p>ok</p>');
      expect(view?.artifact?.html).not.toMatch(/script|onerror|onclick|alert/);
    }
  });

  it('keeps a diagram out of the panel, since nothing on the page draws it', async () => {
    const view = await templatePageExampleOf(
      example({
        artifact: { type: 'mermaid', title: 'Flow', html: '<pre><code class="language-mermaid">a-->b</code></pre>' },
      })
    );
    expect(view?.artifact).toBeNull();
  });

  it('keeps the artifact, steps and sample file metadata', async () => {
    const view = await templatePageExampleOf(
      example({
        artifact: { type: 'markdown', title: 'Plan', html: '<p>doc</p>' },
        sampleFile: { name: 'brief.pdf', mime: 'application/pdf', pages: 2, source: 'generated', fabFileId: 'f9' },
        steps: [{ label: 'Posted a comment', simulated: true }],
      })
    );
    expect(view?.artifact).toEqual({ title: 'Plan', html: '<p>doc</p>' });
    expect(view?.sampleFile).toEqual({ name: 'brief.pdf', mime: 'application/pdf', pages: 2 });
    expect(view?.steps).toEqual([{ label: 'Posted a comment', simulated: true }]);
  });

  it.each([
    [{ moderationStatus: 'pending' }],
    [{ moderationStatus: 'blocked' }],
    [{ moderationStatus: 'clean', deletedAt: new Date() }],
    [null],
  ])('hides the sample file card while its file is not serveable (%o)', async row => {
    h.findSampleFile.mockResolvedValue(row);
    const view = await templatePageExampleOf(
      example({
        sampleFile: { name: 'brief.pdf', mime: 'application/pdf', source: 'upload', fabFileId: 'f9' },
      })
    );
    expect(view?.sampleFile).toBeNull();
  });
});

describe('buildTemplatePageView', () => {
  it('builds the public view: author, rating, connectors, example and link-preview tags', async () => {
    h.snapshot.mockResolvedValue({ snapshot: { allowedTools: ['github__list_issues'] }, versionId: 'v1' });
    const view = await buildTemplatePageView({
      template: template(),
      listing: listing(),
      isPublic: true,
      origin: 'https://app.test',
      cookieHeader: 'a=1',
    });
    expect(view).toMatchObject({
      authorName: 'Ada',
      rating: { sum: 9, count: 2 },
      connectors: ['GitHub'],
      takesFile: false,
      imageSrc: '/api/skills/template/image/launch-plan?v=f1',
      starterCredits: 2500,
      share: { canonicalUrl: 'https://app.test/t/launch-plan' },
    });
    expect(view.example?.prompt).toBe('Plan the launch');
    expect(h.freeRun).toHaveBeenCalledWith(expect.anything(), expect.anything(), 'a=1');
  });

  it('shows no connectors when the approved version cannot be read', async () => {
    h.snapshot.mockRejectedValue(new Error('not found'));
    const view = await buildTemplatePageView({ template: template(), listing: listing(), isPublic: true, origin: '' });
    expect(view.connectors).toEqual([]);
  });

  it('builds the preview: inert free-run box, signed image, no link-preview tags, no visitor state', async () => {
    const view = await buildTemplatePageView({
      template: template(),
      listing: listing(),
      isPublic: true,
      origin: 'https://app.test',
      preview: true,
    });
    expect(view.freeRun).toEqual({ state: 'preview' });
    expect(view.share).toBeNull();
    expect(view.imageSrc).toBe('https://files.example.com/f1.jpg?sig=1');
    expect(h.freeRun).not.toHaveBeenCalled();
  });

  it('draws no box in the preview when the free run is off, private or ineligible', async () => {
    const off = await buildTemplatePageView({
      template: template({ freeRunEnabled: false }),
      listing: listing(),
      isPublic: true,
      origin: '',
      preview: true,
    });
    expect(off.freeRun).toBeNull();
    const org = await buildTemplatePageView({
      template: template(),
      listing: listing({ visibility: 'organization' }),
      isPublic: false,
      origin: '',
      preview: true,
    });
    expect(org.freeRun).toBeNull();
    h.snapshot.mockResolvedValue({ snapshot: { allowedTools: ['Read'] }, versionId: 'v1' });
    const tools = await buildTemplatePageView({
      template: template(),
      listing: listing(),
      isPublic: true,
      origin: '',
      preview: true,
    });
    expect(tools.freeRun).toBeNull();
  });
});

describe('findOwnPreviewTemplate', () => {
  const lean = (value: unknown) => ({ select: () => ({ lean: async () => value }) });

  it('loads the author template whatever its status', async () => {
    h.ownListing.mockResolvedValue(listing());
    h.findOne.mockReturnValue(lean(template()));
    const found = await findOwnPreviewTemplate({ id: 'author-1' } as never, 'l1');
    expect(h.findOne).toHaveBeenCalledWith({ listingId: 'l1' });
    expect(found.isPublic).toBe(true);
    expect(found.template.slug).toBe('launch-plan');
  });

  it('404s when the listing has no template', async () => {
    h.ownListing.mockResolvedValue(listing());
    h.findOne.mockReturnValue(lean(null));
    await expect(findOwnPreviewTemplate({ id: 'author-1' } as never, 'l1')).rejects.toThrow('Template not found');
  });
});
