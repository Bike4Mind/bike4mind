import { useEffect, useRef } from 'react';
import Box from '@mui/joy/Box';
import { useTheme } from '@mui/joy/styles';
import { FitAddon } from '@xterm/addon-fit';
import { WebLinksAddon } from '@xterm/addon-web-links';
import { Terminal } from '@xterm/xterm';
import '@xterm/xterm/css/xterm.css';
import { isTerminalToggle, TERMINAL_SCROLLBACK } from './terminalPanelState';
import { xtermTheme } from './terminalTheme';

const RESIZE_SETTLE_MS = 60;

/**
 * One terminal's screen: an xterm bound to a pty in main.
 *
 * Mounted per terminal and per restart (its key carries the generation), and only while it is
 * on screen; the shell itself lives in main and keeps running. Attaching hands back what the
 * shell printed meanwhile, so a remount picks up where it left off.
 *
 * Its own module so the panel can load it lazily: xterm is the largest thing in the renderer,
 * and most sessions never open a terminal.
 */
export default function TerminalView({
  terminalId,
  focusKey,
  onOpenLink,
}: {
  terminalId: string;
  /** Focuses the terminal whenever it changes to a positive value, and on mount if positive. */
  focusKey: number;
  onOpenLink: (url: string) => void;
}) {
  const host = useRef<HTMLDivElement | null>(null);
  const terminal = useRef<Terminal | null>(null);
  const theme = useTheme();
  const mode = theme.palette.mode;
  const fontFamily = theme.fontFamily.code;
  const openLink = useRef(onOpenLink);
  openLink.current = onOpenLink;
  // Read once at mount; the effect below follows later changes without rebuilding the screen.
  const initialMode = useRef(mode);

  useEffect(() => {
    const element = host.current;
    if (!element) return;
    let disposed = false;
    const term = new Terminal({
      scrollback: TERMINAL_SCROLLBACK,
      fontFamily,
      fontSize: 12,
      lineHeight: 1.2,
      cursorBlink: true,
      theme: xtermTheme(element, initialMode.current),
    });
    const fit = new FitAddon();
    term.loadAddon(fit);
    term.loadAddon(new WebLinksAddon((_event, uri) => openLink.current(uri)));
    // Otherwise xterm consumes Ctrl+` as a NUL byte and the panel cannot be toggled from inside it.
    term.attachCustomKeyEventHandler(event => !isTerminalToggle(event));
    term.open(element);
    terminal.current = term;

    // Pushes that land before the attach answers are newer than its replay; held until it has
    // been written so the screen gets them in order.
    let attached = false;
    const early: string[] = [];
    const offData = window.b4m.terminal.onData(event => {
      if (event.terminalId !== terminalId) return;
      if (attached) term.write(event.data);
      else early.push(event.data);
    });
    const input = term.onData(data => window.b4m.terminal.write(terminalId, data));

    let size = { cols: 0, rows: 0 };
    let resizeTimer: ReturnType<typeof setTimeout> | undefined;
    const fitNow = () => {
      if (disposed || element.clientWidth === 0 || element.clientHeight === 0) return;
      try {
        fit.fit();
      } catch {
        // Not measurable yet (the renderer has not laid the font out); the next resize retries.
        return;
      }
      if (term.cols === size.cols && term.rows === size.rows) return;
      const first = size.cols === 0;
      size = { cols: term.cols, rows: term.rows };
      // The screen follows a drag every frame; the shell is told once it settles, since every
      // resize it hears is a SIGWINCH and a full prompt redraw.
      clearTimeout(resizeTimer);
      const tell = () => window.b4m.terminal.resize(terminalId, size.cols, size.rows);
      if (first) tell();
      else resizeTimer = setTimeout(tell, RESIZE_SETTLE_MS);
    };
    let frame = 0;
    const resizes = new ResizeObserver(() => {
      if (!frame) {
        frame = requestAnimationFrame(() => {
          frame = 0;
          fitNow();
        });
      }
    });
    resizes.observe(element);
    fitNow();

    void window.b4m.terminal.attach(terminalId).then(attachment => {
      if (disposed) return;
      attached = true;
      if (attachment?.replay) term.write(attachment.replay);
      for (const chunk of early) term.write(chunk);
      early.length = 0;
    });

    return () => {
      disposed = true;
      clearTimeout(resizeTimer);
      resizes.disconnect();
      if (frame) cancelAnimationFrame(frame);
      offData();
      input.dispose();
      window.b4m.terminal.detach(terminalId);
      term.dispose();
      terminal.current = null;
    };
  }, [terminalId, fontFamily]);

  useEffect(() => {
    if (terminal.current && host.current) terminal.current.options.theme = xtermTheme(host.current, mode);
  }, [mode]);

  useEffect(() => {
    if (focusKey > 0) terminal.current?.focus();
  }, [focusKey]);

  // The inset lives on the wrapper: the fit addon sizes rows to the host's computed box, so
  // padding on the host itself would push the last row out of view.
  return (
    <Box sx={{ position: 'absolute', inset: 0, pl: 1.5, pt: 0.5 }}>
      <Box ref={host} sx={{ width: '100%', height: '100%' }} data-testid="terminal-view-screen" />
    </Box>
  );
}
