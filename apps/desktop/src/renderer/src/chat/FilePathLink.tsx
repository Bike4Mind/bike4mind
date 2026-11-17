import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent,
  type MouseEvent,
  type ReactNode,
} from 'react';
import Box from '@mui/joy/Box';
import Snackbar from '@mui/joy/Snackbar';
import type { ChatFileView } from '@shared/chat';
import { isMac } from './platform';

type TextFileView = Extract<ChatFileView, { kind: 'text' }>;

/** Shows a text file in the app's Files pane; the path is as the reply wrote it. */
export type ShowFile = (requested: string, view: TextFileView) => void;

/** Must stay at or below MAX_PATHS_PER_CHECK in main/chat/filePathLinks.ts, which refuses a longer list. */
const BATCH = 200;

interface FilePathLinks {
  /** The settled answer for `path`: its absolute path, null when it is not a file here, undefined when not asked yet. */
  known(path: string): string | null | undefined;
  check(path: string): Promise<string | null>;
  /** In the Files pane when there is one and the path is a text file; in another app otherwise. */
  open(path: string, externally?: boolean): void;
}

const FilePathContext = createContext<FilePathLinks | null>(null);

/**
 * Asks main which paths exist for one conversation, a batch per tick and each path once.
 *
 * Paths that did not resolve are asked again whenever `recheck` changes, since a reply often names
 * a file before a later tool call writes it. Paths that resolved are kept.
 */
function useFilePathLinks(
  sessionId: string,
  recheck: unknown,
  report: (message: string) => void,
  showFile: ShowFile | undefined
): FilePathLinks {
  const cache = useRef(new Map<string, Promise<string | null>>());
  const settled = useRef(new Map<string, string | null>());
  const queue = useRef<{ path: string; resolve: (found: string | null) => void }[]>([]);
  const scheduled = useRef(false);

  const [generation, setGeneration] = useState(0);
  const firstRecheck = useRef(recheck);
  useEffect(() => {
    if (Object.is(firstRecheck.current, recheck)) return;
    firstRecheck.current = recheck;
    for (const [path, found] of settled.current) {
      if (found !== null) continue;
      settled.current.delete(path);
      cache.current.delete(path);
    }
    setGeneration(value => value + 1);
  }, [recheck]);

  const flush = useCallback(() => {
    scheduled.current = false;
    while (queue.current.length > 0) {
      const batch = queue.current.splice(0, BATCH);
      window.b4m.chat
        .checkFilePaths(
          sessionId,
          batch.map(entry => entry.path)
        )
        .then(
          found => batch.forEach((entry, index) => entry.resolve(found[index] ?? null)),
          () => batch.forEach(entry => entry.resolve(null))
        );
    }
  }, [sessionId]);

  const failed = useCallback(
    (error: unknown) => report(error instanceof Error ? error.message : String(error)),
    [report]
  );

  const openExternally = useCallback(
    (path: string) => {
      window.b4m.chat.openFilePath(sessionId, path).then(result => {
        if (!result.ok) report(result.error);
      }, failed);
    },
    [sessionId, report, failed]
  );

  // A folder or a binary file has nothing the pane can show, so it goes to the OS as before.
  const open = useCallback(
    (path: string, externally = false) => {
      if (externally || !showFile) {
        openExternally(path);
        return;
      }
      window.b4m.chat.readFilePath(sessionId, path).then(view => {
        if (view.kind === 'text') showFile(path, view);
        else if (view.kind === 'error') report(view.error);
        else openExternally(path);
      }, failed);
    },
    [sessionId, showFile, openExternally, report, failed]
  );

  // A new object per generation, so every link re-reads its answer after a recheck.
  return useMemo(
    () => ({
      known: path => settled.current.get(path),
      check: path => {
        let pending = cache.current.get(path);
        if (!pending) {
          pending = new Promise<string | null>(resolve => {
            queue.current.push({ path, resolve });
            if (!scheduled.current) {
              scheduled.current = true;
              setTimeout(flush, 0);
            }
          }).then(found => {
            settled.current.set(path, found);
            return found;
          });
          cache.current.set(path, pending);
        }
        return pending;
      },
      open,
    }),
    // generation is listed only so a recheck makes a fresh object.
    [flush, open, generation]
  );
}

/**
 * Turns on file path links for the replies inside it. With no conversation, or with no provider at
 * all (a test that renders a reply alone), a path is drawn as the plain text it was.
 */
export function FilePathLinkProvider({
  sessionId,
  recheck,
  showFile,
  children,
}: {
  sessionId: string | null;
  recheck?: unknown;
  /** Where a text file opens in the app. Without it every link opens in another app. */
  showFile?: ShowFile;
  children: ReactNode;
}) {
  const [notice, setNotice] = useState<string | null>(null);
  const links = useFilePathLinks(sessionId ?? '', recheck, setNotice, showFile);
  return (
    <FilePathContext.Provider value={sessionId ? links : null}>
      {children}
      <Snackbar
        open={notice !== null}
        onClose={() => setNotice(null)}
        autoHideDuration={6000}
        color="danger"
        variant="soft"
        size="sm"
        anchorOrigin={{ vertical: 'bottom', horizontal: 'center' }}
        data-testid="file-link-error-notice"
      >
        {notice}
      </Snackbar>
    </FilePathContext.Provider>
  );
}

/**
 * A path a reply names: a link that opens the file once main has confirmed it exists in this
 * conversation's folders, and its text exactly as written until then, or if it never does.
 * Cmd-click (Ctrl-click off macOS) skips the Files pane and opens it in another app.
 */
export function FilePathLink({ path, children }: { path: string; children: ReactNode }) {
  const links = useContext(FilePathContext);
  const [found, setFound] = useState<string | null | undefined>(() => links?.known(path));

  useEffect(() => {
    if (!links) return;
    const known = links.known(path);
    setFound(known);
    if (known !== undefined) return;
    let live = true;
    void links.check(path).then(result => {
      if (live) setFound(result);
    });
    return () => {
      live = false;
    };
  }, [links, path]);

  if (!links || !found) return <>{children}</>;

  const external = (event: MouseEvent | KeyboardEvent) => (isMac ? event.metaKey : event.ctrlKey);
  const onClick = (event: MouseEvent<HTMLElement>) => links.open(path, external(event));
  const onKeyDown = (event: KeyboardEvent<HTMLElement>) => {
    if (event.key !== 'Enter') return;
    event.preventDefault();
    links.open(path, external(event));
  };

  return (
    <Box
      component="a"
      role="link"
      tabIndex={0}
      title={found}
      onClick={onClick}
      onKeyDown={onKeyDown}
      data-testid="chat-markdown-file-link"
      data-file-path={found}
      sx={{
        color: 'var(--joy-palette-primary-plainColor)',
        textDecoration: 'underline',
        textUnderlineOffset: '2px',
        cursor: 'pointer',
      }}
    >
      {children}
    </Box>
  );
}
