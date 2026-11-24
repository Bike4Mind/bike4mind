// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { ChatSessionMode, ChatSessionSummary } from '@shared/chat';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { pickStudioSession, STUDIO_START_FAILED, useStudioSession } from './studioSession';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const summary = (id: string, mode: ChatSessionMode = 'studio', archived = false): ChatSessionSummary =>
  ({ id, mode, ...(archived ? { archived } : {}) }) as ChatSessionSummary;

describe('pickStudioSession', () => {
  it('prefers the remembered session, then the most recent, and ignores other modes', () => {
    const sessions = [summary('chat1', 'chat'), summary('new'), summary('old')];
    expect(pickStudioSession(sessions, 'old')).toBe('old');
    expect(pickStudioSession(sessions, 'gone')).toBe('new');
    expect(pickStudioSession(sessions, null)).toBe('new');
    expect(pickStudioSession([summary('chat1', 'chat')], 'chat1')).toBeNull();
  });

  it('skips archived sessions, even a remembered one', () => {
    const sessions = [summary('arch', 'studio', true), summary('open')];
    expect(pickStudioSession(sessions, 'arch')).toBe('open');
    expect(pickStudioSession([summary('arch', 'studio', true)], null)).toBeNull();
  });
});

describe('useStudioSession', () => {
  let container: HTMLDivElement;
  let root: Root;
  let latest: ReturnType<typeof useStudioSession>;
  let create: ReturnType<typeof vi.fn<() => Promise<string>>>;

  function Harness(props: { active: boolean; sessions?: ChatSessionSummary[] }) {
    latest = useStudioSession({
      active: props.active,
      loading: false,
      sessions: props.sessions ?? [],
      remembered: null,
      create,
    });
    return null;
  }
  const render = (props: { active: boolean; sessions?: ChatSessionSummary[] }) =>
    act(async () => root.render(<Harness {...props} />));

  beforeEach(() => {
    create = vi.fn<() => Promise<string>>();
    container = document.createElement('div');
    root = createRoot(container);
  });
  afterEach(() => act(() => root.unmount()));

  it('starts one session when there is none, and binds to it once listed', async () => {
    create.mockResolvedValue('s1');
    await render({ active: true });
    expect(create).toHaveBeenCalledTimes(1);
    await render({ active: true, sessions: [summary('s1')] });
    expect(latest.sessionId).toBe('s1');
    expect(create).toHaveBeenCalledTimes(1);
  });

  it('reports a failed start once per visit and tries again on the next', async () => {
    create.mockRejectedValue(new Error('signed out'));
    await render({ active: true });
    expect(latest.error).toBe(STUDIO_START_FAILED);
    await render({ active: true });
    expect(create).toHaveBeenCalledTimes(1);

    await render({ active: false });
    expect(latest.error).toBeNull();
    await render({ active: true });
    expect(create).toHaveBeenCalledTimes(2);
  });

  it('does not start a second session while one is still starting after a return', async () => {
    let finish: (id: string) => void = () => undefined;
    create.mockImplementation(() => new Promise(resolve => (finish = resolve)));
    await render({ active: true });
    await render({ active: false });
    await render({ active: true });
    expect(create).toHaveBeenCalledTimes(1);
    // The real create lists the session before it resolves.
    await act(async () => {
      root.render(<Harness active sessions={[summary('s1')]} />);
      finish('s1');
    });
    expect(latest.sessionId).toBe('s1');
    expect(create).toHaveBeenCalledTimes(1);
  });

  it('ignores a failure from a visit the user left, and retries in the current one', async () => {
    let fail: (error: Error) => void = () => undefined;
    create.mockImplementationOnce(() => new Promise((_, reject) => (fail = reject)));
    create.mockResolvedValueOnce('s2');
    await render({ active: true });
    await render({ active: false });
    await render({ active: true });
    await act(async () => fail(new Error('late')));
    expect(latest.error).toBeNull();
    expect(create).toHaveBeenCalledTimes(2);
  });

  it('drops a stale error once a session is bound', async () => {
    create.mockRejectedValue(new Error('signed out'));
    await render({ active: true });
    expect(latest.error).toBe(STUDIO_START_FAILED);
    await render({ active: true, sessions: [summary('s9')] });
    expect(latest.error).toBeNull();
    expect(latest.sessionId).toBe('s9');
  });
});
