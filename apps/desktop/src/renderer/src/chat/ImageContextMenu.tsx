import {
  createContext,
  memo,
  useCallback,
  useContext,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent,
  type MouseEvent,
  type ReactNode,
} from 'react';
import Box from '@mui/joy/Box';
import Dropdown from '@mui/joy/Dropdown';
import List from '@mui/joy/List';
import ListDivider from '@mui/joy/ListDivider';
import ListItem from '@mui/joy/ListItem';
import ListItemButton from '@mui/joy/ListItemButton';
import Menu from '@mui/joy/Menu';
import MenuButton from '@mui/joy/MenuButton';
import MenuItem from '@mui/joy/MenuItem';
import Sheet from '@mui/joy/Sheet';
import Snackbar from '@mui/joy/Snackbar';
import type { ChatImageAction, ChatImageRef } from '@shared/chat';
import { ChevronIcon } from './icons';
import { isMac, isWindows } from './platform';

export const REVEAL_LABEL = isMac ? 'Show in Finder' : isWindows ? 'Show in File Explorer' : 'Show in folder';

/** Room the Copy submenu needs to open to the right; nearer the edge it opens to the left. */
const SUBMENU_WIDTH = 200;

interface Point {
  x: number;
  y: number;
}

type OpenImageMenu = (image: ChatImageRef, at: Point, trigger: HTMLElement) => void;

const ImageMenuContext = createContext<OpenImageMenu | null>(null);

function belowElement(element: Element): Point {
  const rect = element.getBoundingClientRect();
  return { x: rect.left, y: rect.bottom };
}

/**
 * Handlers that open the conversation's image menu from one image: right-click, Shift+F10 or
 * the context-menu key. Undefined outside an ImageMenuProvider, so the composer's own draft
 * tiles get no menu. Callers pass a memoized ref; the handlers are rebuilt only when it changes.
 */
export function useImageMenu(image: ChatImageRef | null) {
  const open = useContext(ImageMenuContext);
  return useMemo(() => {
    if (!open || !image) return undefined;
    return {
      onContextMenu: (event: MouseEvent<HTMLElement>) => {
        event.preventDefault();
        // A contextmenu raised from the keyboard reports no pointer position.
        const fromKeyboard = event.clientX === 0 && event.clientY === 0;
        open(
          image,
          fromKeyboard ? belowElement(event.currentTarget) : { x: event.clientX, y: event.clientY },
          event.currentTarget
        );
      },
      onKeyDown: (event: KeyboardEvent<HTMLElement>) => {
        if (event.key !== 'ContextMenu' && !(event.shiftKey && event.key === 'F10')) return;
        event.preventDefault();
        open(image, belowElement(event.currentTarget), event.currentTarget);
      },
    };
  }, [open, image]);
}

type CopyChoice = 'copy' | 'copy-path' | 'copy-markdown';

/**
 * The Copy submenu, drawn inside the outer menu's listbox rather than portaled: the outer Menu
 * closes when focus leaves its listbox, so a submenu anywhere else would close both on entry.
 * Keys are stopped here for the same reason, or the outer list would also move on every arrow.
 */
function CopySubmenu({
  onDisk,
  top,
  flip,
  focusFirst,
  onPick,
  onBack,
}: {
  onDisk: boolean;
  top: number;
  flip: boolean;
  focusFirst: boolean;
  onPick: (choice: CopyChoice) => void;
  onBack: () => void;
}) {
  const submenu = useRef<HTMLDivElement>(null);
  const list = useRef<HTMLUListElement>(null);

  useLayoutEffect(() => {
    const element = submenu.current;
    if (!element) return;
    const keepInViewport = () => {
      // Measure without the previous correction after Joy moves its outer menu.
      element.style.transform = '';
      const rect = element.getBoundingClientRect();
      const shift = Math.max(4 - rect.top, Math.min(0, window.innerHeight - 4 - rect.bottom));
      element.style.transform = `translateY(${shift}px)`;
    };
    keepInViewport();
    // Joy updates the outer menu's transform after placing or flipping it.
    const outerMenu = element.closest('[role="menu"]');
    const placement = new MutationObserver(keepInViewport);
    if (outerMenu) placement.observe(outerMenu, { attributes: true, attributeFilter: ['style'] });
    const size = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(keepInViewport);
    size?.observe(element);
    window.addEventListener('resize', keepInViewport);
    return () => {
      placement.disconnect();
      size?.disconnect();
      window.removeEventListener('resize', keepInViewport);
    };
  }, [top, flip, onDisk]);
  const items = () => Array.from(list.current?.querySelectorAll<HTMLElement>('[role="menuitem"]') ?? []);

  useEffect(() => {
    if (focusFirst) items()[0]?.focus();
  }, [focusFirst]);

  const onKeyDown = (event: KeyboardEvent<HTMLElement>) => {
    event.stopPropagation();
    const all = items();
    const index = all.indexOf(document.activeElement as HTMLElement);
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault();
      const step = event.key === 'ArrowDown' ? 1 : -1;
      all[(index + step + all.length) % all.length]?.focus();
    } else if (event.key === 'Escape' || event.key === (flip ? 'ArrowRight' : 'ArrowLeft')) {
      event.preventDefault();
      onBack();
    }
  };

  const choices: { choice: CopyChoice; label: string; testId: string; show: boolean }[] = [
    { choice: 'copy', label: 'Image', testId: 'image-menu-copy-image-btn', show: onDisk },
    { choice: 'copy-path', label: 'File path', testId: 'image-menu-copy-path-btn', show: onDisk },
    { choice: 'copy-markdown', label: 'Markdown', testId: 'image-menu-copy-markdown-btn', show: true },
  ];

  return (
    <Box component="li" role="none" sx={{ listStyle: 'none' }}>
      <Sheet
        ref={submenu}
        variant="outlined"
        sx={{
          position: 'absolute',
          top,
          ...(flip ? { right: '100%' } : { left: '100%' }),
          minWidth: 160,
          maxHeight: 'calc(100vh - 8px)',
          overflowY: 'auto',
          borderRadius: 'sm',
          boxShadow: 'md',
          bgcolor: 'background.popup',
        }}
        onKeyDown={onKeyDown}
        data-testid="image-menu-copy-submenu"
      >
        <List ref={list} size="sm" role="menu" aria-label="Copy" sx={{ py: 0.5 }}>
          {choices
            .filter(entry => entry.show)
            .map(entry => (
              <ListItem key={entry.choice} role="none">
                <ListItemButton
                  role="menuitem"
                  tabIndex={-1}
                  onClick={() => onPick(entry.choice)}
                  data-testid={entry.testId}
                >
                  {entry.label}
                </ListItemButton>
              </ListItem>
            ))}
        </List>
      </Sheet>
    </Box>
  );
}

interface MenuCallbacks {
  onAction: (image: ChatImageRef, action: ChatImageAction) => void;
  onAttach: (image: ChatImageRef) => void;
}

/** Mounted only while the menu is open, so the Copy submenu always starts closed. */
function ImageMenuItems({
  image,
  canAttach,
  onAction,
  onAttach,
}: { image: ChatImageRef; canAttach: boolean } & MenuCallbacks) {
  const [copy, setCopy] = useState<{ top: number; flip: boolean; focusFirst: boolean } | null>(null);
  const copyItem = useRef<HTMLDivElement>(null);
  const onDisk = image.source !== 'remote';

  const openCopy = useCallback((focusFirst: boolean) => {
    const item = copyItem.current;
    if (!item) return;
    const flip = item.getBoundingClientRect().right + SUBMENU_WIDTH > window.innerWidth;
    setCopy({ top: item.offsetTop - 4, flip, focusFirst });
  }, []);

  const closeCopy = useCallback(() => setCopy(null), []);

  const run = (action: ChatImageAction) => onAction(image, action);

  return (
    <>
      {onDisk && (
        <MenuItem onClick={() => run('copy')} onMouseEnter={closeCopy} data-testid="image-menu-copy-btn">
          Copy image
        </MenuItem>
      )}
      {onDisk && (
        <MenuItem onClick={() => run('save')} onMouseEnter={closeCopy} data-testid="image-menu-save-btn">
          Save image...
        </MenuItem>
      )}
      {onDisk && canAttach && <ListDivider />}
      {onDisk && canAttach && (
        <MenuItem onClick={() => onAttach(image)} onMouseEnter={closeCopy} data-testid="image-menu-attach-btn">
          Attach as context
        </MenuItem>
      )}
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
        data-testid="image-menu-copy-submenu-btn"
      >
        Copy
        <Box component="span" sx={{ ml: 'auto', display: 'flex' }}>
          <ChevronIcon open={false} />
        </Box>
      </MenuItem>
      {copy && (
        <CopySubmenu
          onDisk={onDisk}
          top={copy.top}
          flip={copy.flip}
          focusFirst={copy.focusFirst}
          onPick={run}
          onBack={() => {
            setCopy(null);
            copyItem.current?.focus();
          }}
        />
      )}
      {onDisk && <ListDivider />}
      {onDisk && (
        <MenuItem onClick={() => run('reveal')} onMouseEnter={closeCopy} data-testid="image-menu-reveal-btn">
          {REVEAL_LABEL}
        </MenuItem>
      )}
    </>
  );
}

/**
 * The menu itself: Copy image, Save image..., Attach as context, a Copy submenu and Show in
 * Finder. Items that cannot apply to the image are left out rather than shown and failing - a
 * remote image has no file, so it offers only its Markdown.
 *
 * Memoized because the shell above re-renders on every streamed token.
 */
export const ImageContextMenu = memo(function ImageContextMenu({
  image,
  at,
  canAttach,
  onClose,
  onReturnFocus,
  onAction,
  onAttach,
}: {
  image: ChatImageRef | null;
  at: Point | null;
  canAttach: boolean;
  onClose: () => void;
  onReturnFocus: () => void;
} & MenuCallbacks) {
  return (
    <Dropdown open={image !== null} onOpenChange={(_event, open) => !open && onClose()}>
      {/* Anchored to a zero-size point at the cursor, since a Joy Menu has to hang off a button. */}
      <MenuButton
        slots={{ root: 'span' }}
        slotProps={{
          root: {
            'aria-hidden': true,
            tabIndex: -1,
            // Joy restores focus to its anchor after Escape. Forward that to the real image.
            onFocus: onReturnFocus,
            style: {
              position: 'fixed',
              left: at?.x ?? 0,
              top: at?.y ?? 0,
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
        data-testid="image-context-menu"
      >
        {image && <ImageMenuItems image={image} canAttach={canAttach} onAction={onAction} onAttach={onAttach} />}
      </Menu>
    </Dropdown>
  );
});

/**
 * One image menu for a whole conversation view. Images reach it through `useImageMenu`, which
 * holds only a stable opener, so a thread of hundreds of images mounts one Menu and opening it
 * re-renders none of them.
 *
 * `onAttach` is absent where there is no composer to attach to, and the item is then hidden.
 */
export function ImageMenuProvider({
  onAttach,
  children,
}: {
  onAttach?: (image: ChatImageRef) => Promise<void>;
  children: ReactNode;
}) {
  const [menu, setMenu] = useState<{ image: ChatImageRef; at: Point } | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const trigger = useRef<HTMLElement | null>(null);
  const open = useCallback<OpenImageMenu>((image, at, element) => {
    trigger.current = element;
    setMenu({ image, at });
  }, []);
  const returnFocus = useCallback(() => {
    if (trigger.current?.isConnected) trigger.current.focus();
  }, []);
  const close = useCallback(() => setMenu(null), []);

  const report = useCallback((error: unknown) => setNotice(error instanceof Error ? error.message : String(error)), []);

  const onAction = useCallback(
    (image: ChatImageRef, action: ChatImageAction) => {
      setMenu(null);
      returnFocus();
      void window.b4m.chat.imageAction(image, action).then(result => {
        if (!result.ok) setNotice(result.error);
      }, report);
    },
    [report, returnFocus]
  );

  const attach = useCallback(
    (image: ChatImageRef) => {
      setMenu(null);
      returnFocus();
      onAttach?.(image).catch(report);
    },
    [onAttach, report, returnFocus]
  );

  return (
    <ImageMenuContext.Provider value={open}>
      {children}
      <ImageContextMenu
        image={menu?.image ?? null}
        at={menu?.at ?? null}
        canAttach={onAttach !== undefined}
        onClose={close}
        onReturnFocus={returnFocus}
        onAction={onAction}
        onAttach={attach}
      />
      <Snackbar
        open={notice !== null}
        onClose={() => setNotice(null)}
        autoHideDuration={6000}
        color="danger"
        variant="soft"
        size="sm"
        anchorOrigin={{ vertical: 'bottom', horizontal: 'center' }}
        data-testid="image-menu-error-notice"
      >
        {notice}
      </Snackbar>
    </ImageMenuContext.Provider>
  );
}
