import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import type { IFabFileDocument } from '@bike4mind/common';

const mockMutateAsync = vi.fn();
const mockSetCurrentSessionRaw = vi.fn();
const mockToastError = vi.fn();

vi.mock('sonner', () => ({ toast: { error: (...a: unknown[]) => mockToastError(...a) } }));

vi.mock('@client/app/hooks/data/sessions', () => ({
  useUpdateSession: () => ({ mutateAsync: mockMutateAsync }),
}));

vi.mock('@client/app/contexts/SessionsContext', async () => {
  const { create } = await import('zustand');
  interface Store {
    files: Record<string, IFabFileDocument[]>;
    setWorkBenchFiles: (sid: string, u: IFabFileDocument[] | ((p: IFabFileDocument[]) => IFabFileDocument[])) => void;
    getWorkBenchFiles: (sid: string) => IFabFileDocument[];
  }
  const useWorkBenchStore = create<Store>((set, get) => ({
    files: {},
    setWorkBenchFiles: (sid, u) =>
      set(s => ({
        files: { ...s.files, [sid]: typeof u === 'function' ? u(s.files[sid] ?? []) : u },
      })),
    getWorkBenchFiles: (sid: string) => get().files[sid] ?? [],
  }));
  return {
    useWorkBenchStore,
    useSessions: () => ({ setCurrentSessionRaw: mockSetCurrentSessionRaw }),
  };
});

import { useNotebookContextFiles } from './useNotebookContextFiles';
import { useWorkBenchStore } from '@client/app/contexts/SessionsContext';

const SID = 'session-1';
const file = (id: string): IFabFileDocument => ({ id, fileName: `${id}.pdf` }) as IFabFileDocument;
const ids = (sid = SID) =>
  useWorkBenchStore
    .getState()
    .getWorkBenchFiles(sid)
    .map(f => f.id);

describe('useNotebookContextFiles', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockMutateAsync.mockResolvedValue({});
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- resetting the test double's state
    (useWorkBenchStore as any).setState({ files: {} });
  });

  it('appends the file and persists the full id list', async () => {
    const { result } = renderHook(() => useNotebookContextFiles());
    await act(async () => {
      await result.current.addToNotebookContext(SID, file('a'));
    });

    expect(ids()).toEqual(['a']);
    expect(mockMutateAsync).toHaveBeenCalledWith({ id: SID, knowledgeIds: ['a'], propagateToProjects: true });
  });

  it('defaults to propagating, and forwards false for automatic promotion', async () => {
    // The guard this locks: an auto-promoted upload must not fan out to the projects
    // containing this notebook. Dropping the option, or defaulting it to true, sends
    // propagateToProjects: true and shares the file with every project member.
    const { result } = renderHook(() => useNotebookContextFiles());
    await act(async () => {
      await result.current.addToNotebookContext(SID, file('a'), { propagateToProjects: false });
    });

    expect(mockMutateAsync).toHaveBeenCalledWith({ id: SID, knowledgeIds: ['a'], propagateToProjects: false });
  });

  it('writes once when the same file is added twice before the first write lands', async () => {
    // A real double-click, unlike the sequential case below: the second call starts
    // while the first write is still in flight. It returns on the contents check
    // because the optimistic append is a synchronous store write. Making that append
    // async - or moving it after the await - would let both writes through.
    let releaseFirst: () => void = () => {};
    mockMutateAsync.mockImplementationOnce(
      () =>
        new Promise<object>(res => {
          releaseFirst = () => res({});
        })
    );

    const { result } = renderHook(() => useNotebookContextFiles());
    let first: Promise<void>;
    await act(async () => {
      first = result.current.addToNotebookContext(SID, file('a'));
      await result.current.addToNotebookContext(SID, file('a'));
    });
    await act(async () => {
      releaseFirst();
      await first!;
    });

    expect(ids()).toEqual(['a']);
    expect(mockMutateAsync).toHaveBeenCalledOnce();
  });

  it('writes once for a duplicate add', async () => {
    const { result } = renderHook(() => useNotebookContextFiles());
    await act(async () => {
      await result.current.addToNotebookContext(SID, file('a'));
      await result.current.addToNotebookContext(SID, file('a'));
    });

    expect(ids()).toEqual(['a']);
    expect(mockMutateAsync).toHaveBeenCalledOnce();
  });

  it('persists the union when two adds overlap, rather than the second clobbering the first', async () => {
    // Reading the store at persist time is what makes this work; computing the id
    // list from a captured session would send ['b'] and drop 'a'.
    let releaseFirst: () => void = () => {};
    mockMutateAsync.mockImplementationOnce(
      () =>
        new Promise<object>(res => {
          releaseFirst = () => res({});
        })
    );

    const { result } = renderHook(() => useNotebookContextFiles());
    let firstAdd: Promise<void>;
    await act(async () => {
      firstAdd = result.current.addToNotebookContext(SID, file('a'));
      await result.current.addToNotebookContext(SID, file('b'));
    });
    await act(async () => {
      releaseFirst();
      await firstAdd!;
    });

    expect(ids()).toEqual(['a', 'b']);
    expect(mockMutateAsync).toHaveBeenLastCalledWith(expect.objectContaining({ knowledgeIds: ['a', 'b'] }));
  });

  it('rolls the optimistic append back when the write fails', async () => {
    mockMutateAsync.mockRejectedValueOnce(new Error('boom'));
    const { result } = renderHook(() => useNotebookContextFiles());

    await act(async () => {
      await expect(result.current.addToNotebookContext(SID, file('a'))).rejects.toThrow('boom');
    });

    expect(ids()).toEqual([]);
    expect(mockToastError).toHaveBeenCalledOnce();
  });

  it('skips the server write for an unsaved notebook but still tracks the file locally', async () => {
    const { result } = renderHook(() => useNotebookContextFiles());
    await act(async () => {
      await result.current.addToNotebookContext('', file('a'));
      await result.current.addToNotebookContext('optimistic-session-xyz', file('b'));
    });

    expect(ids('')).toEqual(['a']);
    expect(ids('optimistic-session-xyz')).toEqual(['b']);
    expect(mockMutateAsync).not.toHaveBeenCalled();
  });

  it('removes a file and persists the remainder', async () => {
    const { result } = renderHook(() => useNotebookContextFiles());
    await act(async () => {
      await result.current.addToNotebookContext(SID, file('a'));
      await result.current.addToNotebookContext(SID, file('b'));
      await result.current.removeFromNotebookContext(SID, 'a');
    });

    expect(ids()).toEqual(['b']);
    expect(mockMutateAsync).toHaveBeenLastCalledWith(expect.objectContaining({ knowledgeIds: ['b'] }));
  });

  it('restores the removed file when the write fails', async () => {
    const { result } = renderHook(() => useNotebookContextFiles());
    await act(async () => {
      await result.current.addToNotebookContext(SID, file('a'));
    });
    mockMutateAsync.mockRejectedValueOnce(new Error('nope'));
    await act(async () => {
      await expect(result.current.removeFromNotebookContext(SID, 'a')).rejects.toThrow('nope');
    });

    expect(ids()).toEqual(['a']);
  });

  it('syncs currentSession only while it is still the active notebook', async () => {
    const { result } = renderHook(() => useNotebookContextFiles());
    await act(async () => {
      await result.current.addToNotebookContext(SID, file('a'));
    });

    const updater = mockSetCurrentSessionRaw.mock.calls[0][0] as (
      p: { id: string; knowledgeIds?: string[] } | null
    ) => unknown;
    expect(updater({ id: SID })).toEqual({ id: SID, knowledgeIds: ['a'] });
    // A session switch landed mid-write: leave the new session's doc alone.
    expect(updater({ id: 'other' })).toEqual({ id: 'other' });
    expect(updater(null)).toBeNull();
  });
});
