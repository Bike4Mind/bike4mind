// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { parseArtifacts } from '@bike4mind/utils/artifactParser';

const h = vi.hoisted(() => ({
  findTemplate: vi.fn(),
  findCache: vi.fn(),
  tryIncrement: vi.fn(),
  release: vi.fn(),
  start: vi.fn(),
  fail: vi.fn(),
  edit: vi.fn(),
  findFile: vi.fn(),
  requireOwnListing: vi.fn(),
}));

vi.mock('@bike4mind/database', () => ({
  SkillListingTemplate: { findOne: h.findTemplate },
  cacheRepository: {
    findByKey: h.findCache,
    tryIncrementWithinLimitFixedWindow: h.tryIncrement,
    releaseFromFixedWindow: h.release,
  },
  startSkillTemplateExampleRun: h.start,
  failSkillTemplateExampleRun: h.fail,
  editSkillTemplateExample: h.edit,
  fabFileRepository: { findById: h.findFile },
}));
vi.mock('./template', () => ({
  plainTemplate: (doc: unknown) => doc,
  requireOwnListing: h.requireOwnListing,
  requireLiveListing: (listing: { status: string }) => {
    if (listing.status !== 'approved') throw Object.assign(new Error('not live'), { statusCode: 409 });
  },
}));
vi.mock('./templateFreeRun', async () => {
  const { marked } = await import('marked');
  return { renderFreeRunResult: (md: string) => ({ html: marked.parse(md, { async: false }) as string }) };
});

import {
  capExampleSteps,
  editOwnTemplateExample,
  exampleRunCapKey,
  exampleRunsLeftToday,
  harvestExampleReply,
  renderExampleArtifact,
  selectExampleMedia,
  startOwnTemplateExample,
  templateExampleDispatchIdentity,
  TemplateExampleDispatchSchema,
} from './templateExample';

const AUTHOR = { id: 'author-1' };
const NOW = Date.UTC(2026, 10, 25, 12, 0, 0);
const listing = { id: 'l1', status: 'approved', currentApprovedVersionId: 'v1', authorUserId: 'author-1' };
const templateDoc = (extra: Record<string, unknown> = {}) => ({
  listingId: 'l1',
  status: 'draft',
  examplePrompt: 'Plan the launch',
  takesFile: false,
  ...extra,
});

beforeEach(() => {
  vi.clearAllMocks();
  h.requireOwnListing.mockResolvedValue(listing);
  h.release.mockResolvedValue(undefined);
  h.fail.mockResolvedValue(true);
});

describe('example run cap', () => {
  it('keys the counter per author per UTC day', () => {
    expect(exampleRunCapKey('a', NOW)).toBe('skill-template-example:author:a:2026-11-25');
  });

  it.each([
    [undefined, 5],
    [2, 3],
    [7, 0],
  ])('with %j runs used, %j are left', async (count, left) => {
    h.findCache.mockResolvedValue(count === undefined ? null : { result: { count } });
    expect(await exampleRunsLeftToday('a', NOW)).toBe(left);
  });
});

describe('startOwnTemplateExample', () => {
  const dispatch = vi.fn();
  const expiresAt = new Date(NOW + 1000);

  beforeEach(() => {
    dispatch.mockResolvedValue(undefined);
    h.tryIncrement.mockResolvedValue({ success: true, count: 1, expiresAt });
  });

  it('spends a run, marks it running and dispatches the run with the template prompt', async () => {
    h.findTemplate.mockResolvedValue(templateDoc({ takesFile: true }));
    h.start.mockResolvedValue({ listingId: 'l1', example: { status: 'running' } });
    const result = await startOwnTemplateExample(AUTHOR, 'l1', {}, { dispatch, now: () => NOW });
    expect(result).toEqual({ listingId: 'l1', example: { status: 'running' } });
    expect(h.tryIncrement).toHaveBeenCalledWith(exampleRunCapKey('author-1', NOW), 5, expect.any(Number));
    expect(h.start).toHaveBeenCalledWith('l1', new Date(NOW), new Date(NOW - 15 * 60_000));
    const payload = dispatch.mock.calls[0][0];
    expect(TemplateExampleDispatchSchema.parse(payload)).toEqual(payload);
    expect(payload).toMatchObject({
      listingId: 'l1',
      userId: 'author-1',
      prompt: 'Plan the launch',
      versionId: 'v1',
      takesFile: true,
      sampleFile: null,
      cap: { key: exampleRunCapKey('author-1', NOW), expiresAt: expiresAt.toISOString() },
    });
  });

  it('passes an uploaded sample file and an edited prompt', async () => {
    h.findTemplate.mockResolvedValue(templateDoc({ takesFile: true }));
    h.start.mockResolvedValue({
      example: { sampleFile: { source: 'upload', fabFileId: 'f1', name: 'notes.pdf', mime: 'application/pdf' } },
    });
    await startOwnTemplateExample(AUTHOR, 'l1', { prompt: 'Other prompt' }, { dispatch, now: () => NOW });
    expect(dispatch.mock.calls[0][0]).toMatchObject({
      prompt: 'Other prompt',
      sampleFile: { fabFileId: 'f1', name: 'notes.pdf', mime: 'application/pdf' },
    });
  });

  it('answers 429 once the daily runs are spent', async () => {
    h.findTemplate.mockResolvedValue(templateDoc());
    h.tryIncrement.mockResolvedValue({ success: false, count: 5, expiresAt });
    await expect(startOwnTemplateExample(AUTHOR, 'l1', {}, { dispatch, now: () => NOW })).rejects.toMatchObject({
      statusCode: 429,
      message: expect.stringMatching(/all 5 example runs for today/),
    });
    expect(h.start).not.toHaveBeenCalled();
  });

  it('gives the run back when another run is in flight', async () => {
    h.findTemplate.mockResolvedValue(templateDoc());
    h.start.mockResolvedValue(null);
    await expect(startOwnTemplateExample(AUTHOR, 'l1', {}, { dispatch, now: () => NOW })).rejects.toMatchObject({
      statusCode: 409,
    });
    expect(h.release).toHaveBeenCalledWith(exampleRunCapKey('author-1', NOW), 1, expiresAt);
    expect(dispatch).not.toHaveBeenCalled();
  });

  it('fails the run and gives it back when the dispatch fails', async () => {
    h.findTemplate.mockResolvedValue(templateDoc());
    h.start.mockResolvedValue({ example: { status: 'running' } });
    dispatch.mockRejectedValue(new Error('unreachable'));
    await expect(startOwnTemplateExample(AUTHOR, 'l1', {}, { dispatch, now: () => NOW })).rejects.toThrow(
      'unreachable'
    );
    expect(h.fail).toHaveBeenCalledWith('l1', new Date(NOW), expect.any(String));
    expect(h.release).toHaveBeenCalled();
  });

  it.each([
    ['no template', null, 404],
    ['a template in review', templateDoc({ status: 'in_review' }), 409],
    ['no example prompt', templateDoc({ examplePrompt: '  ' }), 400],
  ])('refuses %s without spending a run', async (_name, doc, status) => {
    h.findTemplate.mockResolvedValue(doc);
    await expect(startOwnTemplateExample(AUTHOR, 'l1', {}, { dispatch, now: () => NOW })).rejects.toMatchObject({
      statusCode: status,
    });
    expect(h.tryIncrement).not.toHaveBeenCalled();
  });

  it('refuses a listing that is not live', async () => {
    h.requireOwnListing.mockResolvedValue({ ...listing, status: 'withdrawn' });
    await expect(startOwnTemplateExample(AUTHOR, 'l1', {}, { dispatch })).rejects.toMatchObject({ statusCode: 409 });
  });
});

describe('editOwnTemplateExample', () => {
  const withExample = templateDoc({ example: { status: 'ready', reply: 'x'.repeat(100), enabled: true } });

  it('switches the demo off and trims the reply', async () => {
    h.findTemplate.mockResolvedValue(withExample);
    h.edit.mockResolvedValue({ updated: true });
    expect(await editOwnTemplateExample(AUTHOR, 'l1', { enabled: false, replyTrimmedTo: 40 })).toEqual({
      updated: true,
    });
    expect(h.edit).toHaveBeenCalledWith('l1', { enabled: false, replyTrimmedTo: 40 });
  });

  it('refuses a trim that does not shorten the reply', async () => {
    h.findTemplate.mockResolvedValue(withExample);
    await expect(editOwnTemplateExample(AUTHOR, 'l1', { replyTrimmedTo: 100 })).rejects.toMatchObject({
      statusCode: 400,
    });
  });

  it("swaps in an author-owned sample file and refuses another user's file", async () => {
    h.findTemplate.mockResolvedValue(withExample);
    h.edit.mockResolvedValue({});
    h.findFile.mockResolvedValue({
      userId: 'author-1',
      filePath: 'p',
      fileName: 'brief.pdf',
      mimeType: 'application/pdf; charset=binary',
    });
    await editOwnTemplateExample(AUTHOR, 'l1', { sampleFabFileId: 'f1' });
    expect(h.edit).toHaveBeenCalledWith('l1', {
      sampleFile: { name: 'brief.pdf', mime: 'application/pdf', source: 'upload', fabFileId: 'f1' },
    });

    h.findFile.mockResolvedValue({ userId: 'someone-else', filePath: 'p', fileName: 'x', mimeType: 'text/plain' });
    await expect(editOwnTemplateExample(AUTHOR, 'l1', { sampleFabFileId: 'f2' })).rejects.toMatchObject({
      statusCode: 404,
    });
  });

  it('needs an example first', async () => {
    h.findTemplate.mockResolvedValue(templateDoc());
    await expect(editOwnTemplateExample(AUTHOR, 'l1', { enabled: false })).rejects.toMatchObject({ statusCode: 409 });
  });
});

describe('templateExampleDispatchIdentity', () => {
  it('never looks like a real quest id', () => {
    expect(
      templateExampleDispatchIdentity({ listingId: 'l1', userId: 'u1', runAt: '2026-11-25T12:00:00.000Z' } as never)
    ).toEqual({ questId: 'template-example:l1', userId: 'u1', sessionId: '2026-11-25T12:00:00.000Z' });
  });
});

describe('renderExampleArtifact', () => {
  it('renders markdown and strips links and images', () => {
    const artifact = renderExampleArtifact({ type: 'markdown', title: ' Plan ', content: '# Plan\n\n- [ ] ship' });
    expect(artifact).toMatchObject({ type: 'markdown', title: 'Plan' });
    expect(artifact?.html).toContain('<h1');
  });

  it('keeps static HTML and drops scripts, styles, handlers and URLs', () => {
    const artifact = renderExampleArtifact({
      type: 'html',
      content:
        '<h2 onclick="x()">Hi</h2><script>alert(1)</script><style>p{}</style><a href="https://evil">x</a><img src=x><p style="color:red">ok</p>',
    });
    expect(artifact?.html).toBe('<h2>Hi</h2>x<p>ok</p>');
  });

  it('renders a code artifact in a prose language as Markdown', () => {
    expect(renderExampleArtifact({ type: 'code', language: 'text', content: '# Plan' })?.html).toContain('<h1');
    expect(renderExampleArtifact({ type: 'code', language: 'ts', content: '# x' })?.html).toBe(
      '<pre><code># x</code></pre>'
    );
  });

  it('escapes code and keeps mermaid as a fence the page can draw', () => {
    expect(renderExampleArtifact({ type: 'code', language: 'html', content: '<b>&</b>' })?.html).toBe(
      '<pre><code>&lt;b&gt;&amp;&lt;/b&gt;</code></pre>'
    );
    expect(renderExampleArtifact({ type: 'mermaid', content: 'graph TD; A-->B' })?.html).toBe(
      '<pre><code class="language-mermaid">graph TD; A--&gt;B</code></pre>'
    );
  });

  it.each(['react', 'svg', 'python', 'recharts'])('makes a %s artifact chat-only', type => {
    expect(renderExampleArtifact({ type, content: 'x' })).toBeNull();
  });

  it('drops an empty or oversized render', () => {
    expect(renderExampleArtifact({ type: 'html', content: '<script>x</script>' })).toBeNull();
    expect(renderExampleArtifact({ type: 'code', language: 'ts', content: 'x'.repeat(200_001) })).toBeNull();
  });
});

describe('harvestExampleReply', () => {
  it('takes the reply without artifact blocks and the first renderable artifact', () => {
    const reply = [
      'Here is your plan.',
      '<artifact identifier="a" type="application/vnd.ant.react" title="App">export default () => null</artifact>',
      '<artifact identifier="b" type="text/markdown" title="Action plan"># Steps</artifact>',
    ].join('\n');
    const harvested = harvestExampleReply(reply, parseArtifacts);
    expect(harvested.reply).toBe('Here is your plan.');
    expect(harvested.artifact).toMatchObject({ type: 'code', title: 'Action plan' });
    expect(harvested.artifact?.html).toContain('<h1');
  });

  it('caps the reply', () => {
    expect(harvestExampleReply('y'.repeat(9000), parseArtifacts).reply).toHaveLength(8000);
  });
});

describe('capExampleSteps', () => {
  it('keeps at most 12 steps of at most 80 characters', () => {
    const steps = capExampleSteps(Array.from({ length: 15 }, () => ({ label: 'z'.repeat(100), simulated: true })));
    expect(steps).toHaveLength(12);
    expect(steps[0].label).toHaveLength(80);
  });
});

describe('selectExampleMedia', () => {
  const MB = 1024 * 1024;
  const image = (key: string, bytes = MB, mime = 'image/png') => ({ key, mime, bytes });

  it('prefers a video within the caps', () => {
    const video = { key: 'v', mime: 'video/mp4', bytes: 10 * MB, durationS: 20 };
    expect(selectExampleMedia([image('i'), video])).toEqual({ kind: 'video', items: [video] });
  });

  it.each([
    ['too long', { durationS: 31, bytes: MB }],
    ['too large', { durationS: 10, bytes: 51 * MB }],
    ['of unknown length', { bytes: MB }],
  ])('drops a video %s', (_name, extra) => {
    expect(selectExampleMedia([{ key: 'v', mime: 'video/mp4', ...extra }])).toBeNull();
  });

  it('shows one image, or up to 10 as a carousel, dropping large and SVG images', () => {
    expect(selectExampleMedia([image('a')])).toEqual({ kind: 'image', items: [image('a')] });
    expect(selectExampleMedia([image('big', 11 * MB), image('s', MB, 'image/svg+xml')])).toBeNull();
    const many = Array.from({ length: 12 }, (_, i) => image(`k${i}`));
    const media = selectExampleMedia(many);
    expect(media?.kind).toBe('carousel');
    expect(media?.items).toHaveLength(10);
  });
});
