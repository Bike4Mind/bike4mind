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
import Dropdown from '@mui/joy/Dropdown';
import ListDivider from '@mui/joy/ListDivider';
import Menu from '@mui/joy/Menu';
import MenuButton from '@mui/joy/MenuButton';
import MenuItem from '@mui/joy/MenuItem';
import Snackbar from '@mui/joy/Snackbar';
import type { ChatFilePathAction, ChatFileView } from '@shared/chat';
import { ChevronIcon } from './icons';
import {
  belowElement,
  CopySubmenu,
  REVEAL_LABEL,
  SUBMENU_WIDTH,
  type Point,
  type SubmenuChoice,
} from './ImageContextMenu';
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
  /** The context menu for one link, at the pointer or below the link. */
  menu(path: string, at: Point, trigger: HTMLElement): void;
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
  showFile: ShowFile | undefined,
  menu: FilePathLinks['menu']
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
      menu,
    }),
    // generation is listed only so a recheck makes a fresh object.
    [flush, open, menu, generation]
  );
}

type CopyChoice = Exclude<ChatFilePathAction, 'reveal'>;

const COPY_CHOICES: SubmenuChoice<CopyChoice>[] = [
  { choice: 'copy-path', label: 'Path', testId: 'file-link-menu-copy-path-btn' },
  { choice: 'copy-relative-path', label: 'Relative path', testId: 'file-link-menu-copy-relative-path-btn' },
  { choice: 'copy-markdown', label: 'Markdown link', testId: 'file-link-menu-copy-markdown-btn' },
];

type MenuChoice = 'open' | 'open-externally' | 'attach' | ChatFilePathAction;

/** Mounted only while the menu is open, so the Copy submenu always starts closed. */
function FileLinkMenuItems({ canAttach, onPick }: { canAttach: boolean; onPick: (choice: MenuChoice) => void }) {
  const [copy, setCopy] = useState<{ top: number; flip: boolean; focusFirst: boolean } | null>(null);
  const copyItem = useRef<HTMLDivElement>(null);

  const openCopy = useCallback((focusFirst: boolean) => {
    const item = copyItem.current;
    if (!item) return;
    const flip = item.getBoundingClientRect().right + SUBMENU_WIDTH > window.innerWidth;
    setCopy({ top: item.offsetTop - 4, flip, focusFirst });
  }, []);
  const closeCopy = useCallback(() => setCopy(null), []);

  const item = (choice: MenuChoice, label: string, testId: string) => (
    <MenuItem onClick={() => onPick(choice)} onMouseEnter={closeCopy} data-testid={testId}>
      {label}
    </MenuItem>
  );

  return (
    <>
      {item('open', 'Open', 'file-link-menu-open-btn')}
      {item('open-externally', 'Open in default app', 'file-link-menu-open-external-btn')}
      {canAttach && <ListDivider />}
      {canAttach && item('attach', 'Attach as context', 'file-link-menu-attach-btn')}
      <ListDivider />
      <MenuItem
        ref={copyItem}
        aria-haspopup="menu"
        aria-expanded={copy !== null}
        onMouseEnter={() => openCopy(false)}
        onClick={(event: MouseEvent<HTMLDivElement> & { defaultMuiPrevented?: boolean }) => {
          // Opening the submenu must not count as choosing an item, which closes the menu.
          event.defaultMuiPrevented = true;
          openCopy(event.detail === 0);
        }}
        onKeyDown={event => {
          if (event.key !== 'ArrowRight') return;
          event.preventDefault();
          openCopy(true);
        }}
        data-testid="file-link-menu-copy-submenu-btn"
      >
        Copy
        <Box component="span" sx={{ ml: 'auto', display: 'flex' }}>
          <ChevronIcon open={false} />
        </Box>
      </MenuItem>
      {copy && (
        <CopySubmenu
          choices={COPY_CHOICES}
          testId="file-link-menu-copy-submenu"
          top={copy.top}
          flip={copy.flip}
          focusFirst={copy.focusFirst}
          onPick={onPick}
          onBack={() => {
            setCopy(null);
            copyItem.current?.focus();
          }}
        />
      )}
      {item('reveal', REVEAL_LABEL, 'file-link-menu-reveal-btn')}
    </>
  );
}

/**
 * Turns on file path links for the replies inside it. With no conversation, or with no provider at
 * all (a test that renders a reply alone), a path is drawn as the plain text it was.
 *
 * One context menu serves every link in the conversation, as ImageMenuProvider does for images.
 */
export function FilePathLinkProvider({
  sessionId,
  recheck,
  showFile,
  onAttach,
  children,
}: {
  sessionId: string | null;
  recheck?: unknown;
  /** Where a text file opens in the app. Without it every link opens in another app. */
  showFile?: ShowFile;
  /** Adds the file to the composer's draft. Without it the menu has no Attach item. */
  onAttach?: (path: string) => Promise<void>;
  children: ReactNode;
}) {
  const [notice, setNotice] = useState<string | null>(null);
  const [menuState, setMenuState] = useState<{ path: string; at: Point } | null>(null);
  const trigger = useRef<HTMLElement | null>(null);
  const openMenu = useCallback<FilePathLinks['menu']>((path, at, element) => {
    trigger.current = element;
    setMenuState({ path, at });
  }, []);
  const returnFocus = useCallback(() => {
    if (trigger.current?.isConnected) trigger.current.focus();
  }, []);
  const links = useFilePathLinks(sessionId ?? '', recheck, setNotice, showFile, openMenu);

  const failed = useCallback((error: unknown) => setNotice(error instanceof Error ? error.message : String(error)), []);
  const pick = useCallback(
    (choice: MenuChoice) => {
      const path = menuState?.path;
      setMenuState(null);
      returnFocus();
      if (!path || !sessionId) return;
      if (choice === 'open' || choice === 'open-externally') links.open(path, choice === 'open-externally');
      else if (choice === 'attach') onAttach?.(path).catch(failed);
      else
        window.b4m.chat.filePathAction(sessionId, path, choice).then(result => {
          if (!result.ok) setNotice(result.error);
        }, failed);
    },
    [menuState, sessionId, links, onAttach, failed, returnFocus]
  );

  return (
    <FilePathContext.Provider value={sessionId ? links : null}>
      {children}
      <Dropdown open={menuState !== null} onOpenChange={(_event, open) => !open && setMenuState(null)}>
        {/* Anchored to a zero-size point at the cursor, since a Joy Menu has to hang off a button. */}
        <MenuButton
          slots={{ root: 'span' }}
          slotProps={{
            root: {
              'aria-hidden': true,
              tabIndex: -1,
              // Joy restores focus to its anchor after Escape. Forward that to the link.
              onFocus: returnFocus,
              style: {
                position: 'fixed',
                left: menuState?.at.x ?? 0,
                top: menuState?.at.y ?? 0,
                width: 0,
                height: 0,
                pointerEvents: 'none',
              },
            },
          }}
        />
        <Menu
          size="sm"
          placement="bottom-start"
          // Visible, not the default auto, so the Copy submenu can hang outside the list.
          sx={{ overflow: 'visible', minWidth: 200 }}
          data-testid="file-link-context-menu"
        >
          {menuState && <FileLinkMenuItems canAttach={onAttach !== undefined} onPick={pick} />}
        </Menu>
      </Dropdown>
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
    if (event.key === 'ContextMenu' || (event.shiftKey && event.key === 'F10')) {
      event.preventDefault();
      links.menu(path, belowElement(event.currentTarget), event.currentTarget);
      return;
    }
    if (event.key !== 'Enter') return;
    event.preventDefault();
    links.open(path, external(event));
  };
  const onContextMenu = (event: MouseEvent<HTMLElement>) => {
    event.preventDefault();
    // A contextmenu raised from the keyboard reports no pointer position.
    const fromKeyboard = event.clientX === 0 && event.clientY === 0;
    links.menu(
      path,
      fromKeyboard ? belowElement(event.currentTarget) : { x: event.clientX, y: event.clientY },
      event.currentTarget
    );
  };

  return (
    <Box
      component="a"
      role="link"
      tabIndex={0}
      title={found}
      onClick={onClick}
      onKeyDown={onKeyDown}
      onContextMenu={onContextMenu}
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
