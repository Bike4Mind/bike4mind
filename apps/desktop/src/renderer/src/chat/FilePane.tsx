import {
  memo,
  useCallback,
  useDeferredValue,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type CSSProperties,
  type RefObject,
} from 'react';
import Alert from '@mui/joy/Alert';
import Box from '@mui/joy/Box';
import IconButton from '@mui/joy/IconButton';
import Stack from '@mui/joy/Stack';
import Tooltip from '@mui/joy/Tooltip';
import Typography from '@mui/joy/Typography';
import { useTheme } from '@mui/joy/styles';
import { Prism as SyntaxHighlighter } from 'react-syntax-highlighter';
import type { ChatFilePathOpenResult, ChatFileView } from '@shared/chat';
import { CloseIcon, ExternalLinkIcon, ReloadIcon } from './icons';
import { thinScrollbarSx } from './layout';
import { SYNTAX_THEMES } from './markdown/syntaxTheme';
import { ResizeHandle } from './ResizeHandle';
import {
  clampFilePaneWidth,
  FILE_PANE_MIN_WIDTH,
  FILE_PANE_WIDTH,
  filePaneMaxWidth,
  readFilePaneWidth,
  writeFilePaneWidth,
} from './filePaneWidth';

export type TextFileView = Extract<ChatFileView, { kind: 'text' }>;

/** Past this, tokenizing the whole file would stall the window; it is drawn as plain text instead. */
const HIGHLIGHT_LIMIT = 200 * 1024;

const LANGUAGES: Record<string, string> = {
  ts: 'typescript',
  mts: 'typescript',
  cts: 'typescript',
  tsx: 'tsx',
  js: 'javascript',
  mjs: 'javascript',
  cjs: 'javascript',
  jsx: 'jsx',
  json: 'json',
  md: 'markdown',
  mdx: 'markdown',
  py: 'python',
  rb: 'ruby',
  go: 'go',
  rs: 'rust',
  java: 'java',
  kt: 'kotlin',
  swift: 'swift',
  c: 'c',
  h: 'c',
  cc: 'cpp',
  cpp: 'cpp',
  hpp: 'cpp',
  cs: 'csharp',
  css: 'css',
  scss: 'scss',
  html: 'markup',
  xml: 'markup',
  svg: 'markup',
  yml: 'yaml',
  yaml: 'yaml',
  toml: 'toml',
  sh: 'bash',
  bash: 'bash',
  zsh: 'bash',
  sql: 'sql',
  php: 'php',
  graphql: 'graphql',
  gql: 'graphql',
};

/** The Prism language for a file name, or 'text' when there is none worth guessing. */
export function languageFor(name: string): string {
  if (/^dockerfile$/i.test(name)) return 'docker';
  const extension = /\.([^.]+)$/.exec(name)?.[1]?.toLowerCase();
  return (extension && LANGUAGES[extension]) || 'text';
}

const formatSize = (bytes: number) =>
  bytes < 1024
    ? `${bytes} B`
    : bytes < 1024 * 1024
      ? `${(bytes / 1024).toFixed(1)} KB`
      : `${(bytes / 1024 / 1024).toFixed(1)} MB`;

const PRE_STYLE: CSSProperties = {
  margin: 0,
  padding: '8px 0',
  background: 'transparent',
  fontSize: '12px',
  minWidth: 'fit-content',
};
const LINE_NUMBER_STYLE: CSSProperties = {
  minWidth: '3em',
  paddingRight: '1em',
  color: 'var(--joy-palette-text-tertiary)',
};

const lineStyle = (number: number, line?: number): CSSProperties =>
  number === line ? { display: 'block', backgroundColor: 'var(--joy-palette-warning-softBg)' } : { display: 'block' };

/**
 * The file as plain text, laid out line for line as the highlighter lays it out (same container
 * styles, same line-number column), so swapping the highlighted copy in moves nothing.
 */
function PlainLines({ lines, line, mode }: { lines: string[]; line?: number; mode: 'light' | 'dark' }) {
  const theme = SYNTAX_THEMES[mode];
  return (
    <pre style={{ ...theme['pre[class*="language-"]'], ...PRE_STYLE }}>
      <code style={theme['code[class*="language-"]']}>
        {lines.map((content, index) => (
          <span key={index} data-line={index + 1} style={lineStyle(index + 1, line)}>
            <span style={{ display: 'inline-block', textAlign: 'right', userSelect: 'none', ...LINE_NUMBER_STYLE }}>
              {index + 1}
            </span>
            {content}
            {'\n'}
          </span>
        ))}
      </code>
    </pre>
  );
}

/**
 * The file itself, highlighted, with line numbers. Memoized on the text: the shell above re-renders
 * on every streamed token, and re-tokenizing a long file each time would stall the reply.
 *
 * Highlighting a file of a couple of thousand lines takes a few hundred ms in one synchronous
 * render, so the pane first draws it plain and highlights it in a deferred render after that.
 */
const FileBody = memo(function FileBody({
  text,
  language,
  line,
  mode,
}: {
  text: string;
  language: string;
  line?: number;
  mode: 'light' | 'dark';
}) {
  // A file's closing newline ends its last line rather than starting another.
  const content = text.replace(/\r?\n$/, '');
  const ready = useDeferredValue(content, '') === content;
  if (!ready) return <PlainLines lines={content.split(/\r?\n/)} line={line} mode={mode} />;

  const highlighted = text.length <= HIGHLIGHT_LIMIT;
  return (
    <SyntaxHighlighter
      language={highlighted ? language : 'text'}
      style={SYNTAX_THEMES[mode]}
      showLineNumbers
      wrapLines
      lineProps={(number: number) => ({ 'data-line': number, style: lineStyle(number, line) })}
      customStyle={PRE_STYLE}
      lineNumberStyle={LINE_NUMBER_STYLE}
    >
      {content}
    </SyntaxHighlighter>
  );
});

/**
 * A file a reply named, shown beside the conversation rather than in another app. Read-only.
 *
 * It holds what main read (`view`) and asks for it again on `refreshKey`, which ChatShell bumps
 * when a turn settles, since the turn may have just rewritten the file. Every read goes through
 * the same checks as the link that opened it (main/chat/filePathLinks.ts).
 */
export function FilePane({
  sessionId,
  requested,
  view: initial,
  refreshKey,
  conversation,
  onOpenExternally,
  onClose,
}: {
  sessionId: string;
  /** The path as the reply wrote it, which is what main resolves again on a reload. */
  requested: string;
  view: TextFileView;
  refreshKey?: unknown;
  conversation: RefObject<HTMLElement | null>;
  onOpenExternally: (requested: string) => Promise<ChatFilePathOpenResult>;
  onClose: () => void;
}) {
  const mode = useTheme().palette.mode === 'dark' ? 'dark' : 'light';
  const [view, setView] = useState<TextFileView>(initial);
  const [problem, setProblem] = useState<string | null>(null);
  const [width, setWidth] = useState(readFilePaneWidth);
  const [dragging, setDragging] = useState(false);
  const [limit, setLimit] = useState(() => filePaneMaxWidth(window.innerWidth, Number.POSITIVE_INFINITY));
  const [pane, setPane] = useState<HTMLDivElement | null>(null);
  const body = useRef<HTMLDivElement>(null);
  const clamp = useCallback((next: number) => clampFilePaneWidth(next, limit), [limit]);
  // A reload belongs to this selection, not merely to the mounted conversation pane.
  const selection = useRef({ sessionId, requested, initial, request: 0 });
  if (
    selection.current.sessionId !== sessionId ||
    selection.current.requested !== requested ||
    selection.current.initial !== initial
  ) {
    selection.current = { sessionId, requested, initial, request: 0 };
  }
  const owner = selection.current;
  const live = useRef(true);
  useEffect(() => {
    live.current = true;
    return () => {
      live.current = false;
      selection.current.request += 1;
    };
  }, []);

  // A new link click hands a new view; it replaces whatever a reload last read.
  useEffect(() => {
    setView(initial);
    setProblem(null);
  }, [initial]);

  const reload = useCallback(() => {
    const request = ++owner.request;
    const isCurrent = () => live.current && selection.current === owner && owner.request === request;
    void window.b4m.chat.readFilePath(sessionId, requested).then(
      next => {
        if (!isCurrent()) return;
        if (next.kind === 'text') {
          setView(current => ({ ...next, ...(current.line ? { line: current.line } : {}) }));
          setProblem(null);
        } else {
          setProblem(next.kind === 'error' ? next.error : 'That path is no longer a text file.');
        }
      },
      (error: unknown) => {
        if (isCurrent()) setProblem(error instanceof Error ? error.message : String(error));
      }
    );
  }, [sessionId, requested, owner]);

  const firstRefresh = useRef(refreshKey);
  useEffect(() => {
    if (Object.is(firstRefresh.current, refreshKey)) return;
    firstRefresh.current = refreshKey;
    reload();
  }, [refreshKey, reload]);

  // The pane and the conversation split what the sidebar and other panes leave; see ModelPane.
  useLayoutEffect(() => {
    const measure = () => {
      const other = conversation.current?.getBoundingClientRect().width;
      const own = pane?.getBoundingClientRect().width ?? 0;
      setLimit(filePaneMaxWidth(window.innerWidth, other === undefined ? Number.POSITIVE_INFINITY : own + other));
    };
    measure();
    const observer = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(measure);
    if (conversation.current) observer?.observe(conversation.current);
    window.addEventListener('resize', measure);
    return () => {
      observer?.disconnect();
      window.removeEventListener('resize', measure);
    };
  }, [conversation, pane]);

  // Brought to the cited line once it is drawn, and again when another link names another line.
  useEffect(() => {
    const element = view.line ? body.current?.querySelector(`[data-line="${view.line}"]`) : null;
    if (element && 'scrollIntoView' in element) element.scrollIntoView({ block: 'center' });
    else body.current?.scrollTo?.({ top: 0 });
  }, [view.path, view.line]);

  const shown = Math.min(width, limit);

  return (
    <Stack
      ref={setPane}
      style={{ width: shown }}
      sx={{
        position: 'relative',
        flexShrink: 0,
        borderLeft: '1px solid',
        borderColor: 'divider',
        bgcolor: 'background.level1',
        height: '100%',
        minHeight: 0,
      }}
      data-testid="file-pane"
      data-path={view.path}
    >
      <ResizeHandle
        edge="left"
        label="Resize file pane"
        testId="file-pane-resize-handle"
        width={shown}
        min={Math.min(FILE_PANE_MIN_WIDTH, limit)}
        max={limit}
        defaultWidth={FILE_PANE_WIDTH}
        clamp={clamp}
        dragging={dragging}
        onWidth={setWidth}
        onCommit={writeFilePaneWidth}
        onDraggingChange={setDragging}
        sx={{ left: -5 }}
      />
      <Stack direction="row" alignItems="center" spacing={0.5} sx={{ px: 1.5, pt: 1.5, pb: 1 }}>
        <Box sx={{ flex: 1, minWidth: 0 }}>
          <Typography level="title-sm" noWrap title={view.path} data-testid="file-pane-title">
            {view.name}
          </Typography>
          <Typography level="body-xs" textColor="text.tertiary" noWrap title={view.path}>
            {view.path}
          </Typography>
        </Box>
        <Tooltip size="sm" variant="soft" placement="bottom-end" title="Reload">
          <IconButton
            size="sm"
            variant="plain"
            color="neutral"
            aria-label="Reload the file"
            onClick={reload}
            data-testid="file-pane-reload-btn"
          >
            <ReloadIcon />
          </IconButton>
        </Tooltip>
        <Tooltip size="sm" variant="soft" placement="bottom-end" title="Open in default app">
          <IconButton
            size="sm"
            variant="plain"
            color="neutral"
            aria-label="Open in default app"
            onClick={() => {
              const isCurrent = () => live.current && selection.current === owner;
              void onOpenExternally(requested).then(
                result => {
                  if (isCurrent()) setProblem(result.ok ? null : result.error);
                },
                (error: unknown) => {
                  if (isCurrent()) setProblem(error instanceof Error ? error.message : String(error));
                }
              );
            }}
            data-testid="file-pane-open-external-btn"
          >
            <ExternalLinkIcon />
          </IconButton>
        </Tooltip>
        <IconButton
          size="sm"
          variant="plain"
          color="neutral"
          aria-label="Close the file"
          onClick={onClose}
          data-testid="file-pane-close-btn"
        >
          <CloseIcon />
        </IconButton>
      </Stack>

      {problem && (
        <Alert color="warning" variant="soft" size="sm" sx={{ mx: 1.5, mb: 1 }} data-testid="file-pane-error">
          {problem}
        </Alert>
      )}
      {view.truncated && (
        <Typography level="body-xs" textColor="text.tertiary" sx={{ px: 1.5, pb: 1 }} data-testid="file-pane-truncated">
          Showing the first {formatSize(view.text.length)} of {formatSize(view.size)}. Open it in its default app to see
          the rest.
        </Typography>
      )}

      <Box
        ref={body}
        sx={{
          flex: 1,
          minHeight: 0,
          overflow: 'auto',
          ...thinScrollbarSx,
          borderTop: '1px solid',
          borderColor: 'divider',
          bgcolor: 'background.surface',
        }}
        data-testid="file-pane-body"
      >
        <FileBody text={view.text} language={languageFor(view.name)} line={view.line} mode={mode} />
      </Box>
    </Stack>
  );
}
