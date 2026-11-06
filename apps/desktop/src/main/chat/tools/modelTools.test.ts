import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import type { ChatMedia } from '@shared/chat';
import { EMPTY_MODEL_STATE, type ModelBuildReport, type ModelViewState } from '@shared/model3d';
import { modelScreenshot, modelView } from './modelTools';
import type { ModelViewPort, ToolContext, ToolReporter } from './types';

const OK: ModelBuildReport = {
  generation: 1,
  ok: true,
  summary: { parts: ['body'], size: [60, 40, 30], units: 'mm', triangles: 12, params: { width: 60 } },
};

function setup(report: ModelBuildReport = OK) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'model-tools-')));
  writeFileSync(join(root, 'chest.model.js'), 'export default () => null');
  let state: ModelViewState = EMPTY_MODEL_STATE;
  const view = {
    current: () => state,
    open: vi.fn(async (path: string) => {
      state = { path, kind: 'model', generation: 1, source: '', missing: false };
      return state;
    }),
    waitForBuild: vi.fn(async () => report),
    capture: vi.fn(async () => new Uint8Array([137, 80, 78, 71])),
    glbPath: () => join(root, 'chest.glb'),
  } satisfies ModelViewPort;
  const images: Buffer[] = [];
  const media: ChatMedia[] = [];
  const report_ = {
    image: (bytes: Buffer) => images.push(bytes),
    media: (item: ChatMedia) => media.push(item),
    label: () => undefined,
    progress: () => undefined,
  } as unknown as ToolReporter;
  const keepScreenshot = vi.fn(async () => ({ id: 'kept' }) as unknown as ChatMedia);
  const context: ToolContext = {
    roots: [root],
    workingDirectory: root,
    signal: new AbortController().signal,
    model: { view, keepScreenshot },
    images: {
      vision: true,
      prepare: bytes => ({
        bytes,
        mediaType: 'image/png',
        width: 1024,
        height: 1024,
        sourceWidth: 1024,
        sourceHeight: 1024,
      }),
    },
    report: report_,
  };
  return { root, view, context, images, media, keepScreenshot };
}

describe('model_view', () => {
  it('opens a relative path and returns the build summary with the GLB path', async () => {
    const { root, view, context } = setup();
    const text = await modelView.run({ path: 'chest.model.js' }, context);
    expect(view.open).toHaveBeenCalledWith(join(root, 'chest.model.js'));
    expect(text).toContain('Size: 60 x 40 x 30 mm');
    expect(text).toContain(`GLB written: ${join(root, 'chest.glb')}`);
  });

  it('refuses a model whose GLB would land in a protected folder', async () => {
    const { root, view, context } = setup();
    mkdirSync(join(root, 'vault'));
    writeFileSync(join(root, 'vault', 'safe.model.js'), 'export default () => null');
    const guarded = { ...context, protectedPaths: [join(root, 'vault')] };
    await expect(modelView.run({ path: 'vault/safe.model.js' }, guarded)).rejects.toThrow();
    expect(view.open).not.toHaveBeenCalled();
  });

  it('refuses a path outside the roots', async () => {
    const { context } = setup();
    await expect(modelView.run({ path: '/etc/passwd.model.js' }, context)).rejects.toThrow();
  });

  it('refuses a file that is not a model', async () => {
    const { root, context } = setup();
    writeFileSync(join(root, 'notes.txt'), 'hi');
    await expect(modelView.run({ path: 'notes.txt' }, context)).rejects.toThrow(/Not a model file/);
  });

  it('returns the build error with its line', async () => {
    const { context } = setup({ generation: 1, ok: false, error: 'nope is not defined', line: 2 });
    expect(await modelView.run({ path: 'chest.model.js' }, context)).toContain(
      'Build failed (line 2): nope is not defined'
    );
  });

  it('is unavailable without a model context', async () => {
    const { context } = setup();
    await expect(modelView.run({ path: 'chest.model.js' }, { ...context, model: undefined })).rejects.toThrow(
      /not available/
    );
  });
});

describe('model_screenshot', () => {
  it('captures the default views, keeps the image and shows it to the model', async () => {
    const { view, context, images, media, keepScreenshot } = setup();
    const text = await modelScreenshot.run({ path: 'chest.model.js' }, context);
    expect(view.capture).toHaveBeenCalledWith(['front', 'right', 'top', 'iso'], 'rest');
    expect(keepScreenshot).toHaveBeenCalled();
    expect(media).toHaveLength(1);
    expect(images).toHaveLength(1);
    expect(text).toContain('You see it below');
  });

  it('returns the error and no image when the build failed', async () => {
    const { view, context, images } = setup({ generation: 1, ok: false, error: 'boom' });
    const text = await modelScreenshot.run({ path: 'chest.model.js' }, context);
    expect(text).toContain('Build failed: boom');
    expect(view.capture).not.toHaveBeenCalled();
    expect(images).toHaveLength(0);
  });

  it('renders the joints open when asked, and says so', async () => {
    const { view, context } = setup();
    const text = await modelScreenshot.run({ path: 'chest.model.js', views: ['iso'], pose: 'open' }, context);
    expect(view.capture).toHaveBeenCalledWith(['iso'], 'open');
    expect(text).toContain('from iso, joints open');
    await expect(modelScreenshot.run({ path: 'chest.model.js', pose: 'ajar' }, context)).rejects.toThrow(
      /pose must be/
    );
  });

  it('names the open file when no path is given, and only then', async () => {
    const { root, context } = setup();
    const opened = await modelScreenshot.run({ path: 'chest.model.js' }, context);
    expect(opened).not.toContain('No path given');
    const reused = await modelScreenshot.run({}, context);
    expect(reused).toMatch(
      new RegExp(`^No path given; used the model open in the pane: ${join(root, 'chest.model.js')}\\n`)
    );
  });

  it('names the open file on a failed build too when no path is given', async () => {
    const { root, view, context } = setup({ generation: 1, ok: false, error: 'boom' });
    await view.open(join(root, 'chest.model.js'));
    const text = await modelScreenshot.run({}, context);
    expect(text).toContain(`used the model open in the pane: ${join(root, 'chest.model.js')}`);
    expect(text).toContain('Build failed: boom');
  });

  it("will not use an open model outside the session's folders when no path is given", async () => {
    const { view, context } = setup();
    const elsewhere = realpathSync(mkdtempSync(join(tmpdir(), 'other-project-')));
    writeFileSync(join(elsewhere, 'lamp.model.js'), 'export default () => null');
    await view.open(join(elsewhere, 'lamp.model.js'));
    await expect(modelScreenshot.run({}, context)).rejects.toThrow(/outside this session's folders/);
    expect(view.waitForBuild).not.toHaveBeenCalled();
    expect(view.capture).not.toHaveBeenCalled();
  });

  it('refuses to report a model another caller opened during the build', async () => {
    const { root, view, context } = setup();
    const other = join(root, 'lamp.model.js');
    view.waitForBuild.mockImplementationOnce(async () => {
      await view.open(other);
      return OK;
    });
    await expect(modelScreenshot.run({ path: 'chest.model.js' }, context)).rejects.toThrow(/switched to another file/);
    expect(view.capture).not.toHaveBeenCalled();
  });

  it('refuses to show a capture of a model another caller opened during it', async () => {
    const { root, view, context, keepScreenshot } = setup();
    view.capture.mockImplementationOnce(async () => {
      await view.open(join(root, 'lamp.model.js'));
      return new Uint8Array([1]);
    });
    await expect(modelScreenshot.run({ path: 'chest.model.js' }, context)).rejects.toThrow(/switched to another file/);
    expect(keepScreenshot).not.toHaveBeenCalled();
  });

  it('needs an open model when no path is given, and validates views', async () => {
    const { context } = setup();
    await expect(modelScreenshot.run({}, context)).rejects.toThrow(/No model is open/);
    await expect(modelScreenshot.run({ path: 'chest.model.js', views: ['under'] }, context)).rejects.toThrow(
      /views must be/
    );
  });
});
