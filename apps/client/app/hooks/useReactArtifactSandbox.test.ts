import { describe, it, expect, vi } from 'vitest';
import { act, renderHook } from '@testing-library/react';
import { useReactArtifactSandbox } from './useReactArtifactSandbox';

vi.mock('@client/app/hooks/data/settings', () => ({
  useExperimentalFeatureSettings: () => ({ data: [] }),
}));

const CODE = "import Sib from './Sib';\nexport default function App() { return <Sib />; }";

type Files = Record<string, string> | undefined;

function setup(initialFiles: Files) {
  const hook = renderHook(({ files }: { files: Files }) => useReactArtifactSandbox(CODE, ['react'], files), {
    initialProps: { files: initialFiles },
  });
  const contentWindow = { postMessage: vi.fn() };
  (hook.result.current.iframeRef as { current: unknown }).current = { contentWindow };
  const signalReady = () =>
    act(() => {
      window.dispatchEvent(
        new MessageEvent('message', {
          data: { type: 'react-sandbox-ready' },
          source: contentWindow as unknown as Window,
        })
      );
    });
  const lastPosted = () => contentWindow.postMessage.mock.calls.at(-1)?.[0] as Record<string, unknown>;
  return { hook, signalReady, lastPosted };
}

describe('useReactArtifactSandbox files', () => {
  it('posts files with the render message', () => {
    const { signalReady, lastPosted } = setup({ Sib: 'export default () => null;' });
    signalReady();
    expect(lastPosted()).toEqual({
      type: 'react-artifact-render',
      code: CODE,
      dependencies: ['react'],
      mode: 'eval',
      files: { Sib: 'export default () => null;' },
    });
  });

  it('leaves files out of the message when none are given, so the sandbox keeps its old rejection', () => {
    const { signalReady, lastPosted } = setup(undefined);
    signalReady();
    expect(lastPosted()).toEqual({
      type: 'react-artifact-render',
      code: CODE,
      dependencies: ['react'],
      mode: 'eval',
    });
  });

  it('forwards an empty files map, so the sandbox names the missing sibling', () => {
    const { signalReady, lastPosted } = setup({});
    signalReady();
    expect(lastPosted()).toEqual({
      type: 'react-artifact-render',
      code: CODE,
      dependencies: ['react'],
      mode: 'eval',
      files: {},
    });
  });

  it('does not remount for a new files object with equal content, and does for changed content', () => {
    const { hook, signalReady, lastPosted } = setup({ Sib: 'a', Other: 'b' });
    const initialKey = hook.result.current.iframeKey;

    hook.rerender({ files: { Other: 'b', Sib: 'a' } });
    expect(hook.result.current.iframeKey).toBe(initialKey);

    hook.rerender({ files: { Sib: 'a2', Other: 'b' } });
    expect(hook.result.current.iframeKey).toBe(initialKey + 1);
    signalReady();
    expect(lastPosted().files).toEqual({ Sib: 'a2', Other: 'b' });

    hook.rerender({ files: { Sib: 'a2' } });
    expect(hook.result.current.iframeKey).toBe(initialKey + 2);

    hook.rerender({ files: {} });
    expect(hook.result.current.iframeKey).toBe(initialKey + 3);
    hook.rerender({ files: undefined });
    expect(hook.result.current.iframeKey).toBe(initialKey + 4);
  });
});
