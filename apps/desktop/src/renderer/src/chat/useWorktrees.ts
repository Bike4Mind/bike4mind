import { useCallback, useEffect, useRef, useState } from 'react';
import type { AppWorktree, WorktreeSweepItem } from '@shared/worktreeRemoval';
import { useRecentFolders } from './useRecentFolders';

export interface ProjectWorktrees {
  directory: string;
  name: string;
  worktrees: readonly AppWorktree[];
  error: string | null;
}

export interface WorktreesState {
  projects: readonly ProjectWorktrees[];
  loading: boolean;
  busy: boolean;
  /** What the last remove or sweep did to each path, including the ones it left alone. */
  report: readonly WorktreeSweepItem[];
  removeOne: (directory: string, path: string) => Promise<void>;
  removeAllSafe: (directory: string) => Promise<void>;
  reveal: (directory: string, path: string) => Promise<void>;
}

const messageOf = (error: unknown) => (error instanceof Error ? error.message : String(error));

/** App-created worktrees of every recent project folder, re-read after each removal. */
export function useWorktrees(): WorktreesState {
  const { folders } = useRecentFolders();
  const [projects, setProjects] = useState<readonly ProjectWorktrees[]>([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [report, setReport] = useState<readonly WorktreeSweepItem[]>([]);
  const live = useRef(true);
  const latest = useRef(0);

  const load = useCallback(async () => {
    const id = ++latest.current;
    const rows = await Promise.all(
      folders.map(async (folder): Promise<ProjectWorktrees> => {
        try {
          const worktrees = await window.b4m.chat.listWorktrees(folder.path);
          return { directory: folder.path, name: folder.name, worktrees, error: null };
        } catch (error) {
          return { directory: folder.path, name: folder.name, worktrees: [], error: messageOf(error) };
        }
      })
    );
    if (live.current && id === latest.current) {
      setProjects(rows.filter(row => row.worktrees.length > 0 || row.error));
      setLoading(false);
    }
  }, [folders]);

  useEffect(() => {
    live.current = true;
    void load();
    return () => {
      live.current = false;
    };
  }, [load]);

  const run = useCallback(
    async (action: () => Promise<readonly WorktreeSweepItem[]>) => {
      setBusy(true);
      try {
        setReport(await action());
      } catch (error) {
        setReport([{ path: '', branch: '', status: 'failed', message: messageOf(error) }]);
      } finally {
        await load();
        if (live.current) setBusy(false);
      }
    },
    [load]
  );

  const removeOne = useCallback(
    (directory: string, path: string) => run(() => window.b4m.chat.removeWorktrees(directory, [path])),
    [run]
  );
  const removeAllSafe = useCallback(
    (directory: string) => run(() => window.b4m.chat.removeWorktrees(directory)),
    [run]
  );
  const reveal = useCallback(
    async (directory: string, path: string) => {
      try {
        if (!(await window.b4m.chat.revealWorktree(directory, path))) {
          setReport([{ path, branch: '', status: 'skipped', message: 'This worktree is no longer listed.' }]);
          await load();
        }
      } catch (error) {
        setReport([{ path, branch: '', status: 'failed', message: messageOf(error) }]);
      }
    },
    [load]
  );

  return { projects, loading, busy, report, removeOne, removeAllSafe, reveal };
}
