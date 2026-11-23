import { memo, useMemo, type ComponentProps } from 'react';
import Box from '@mui/joy/Box';
import Typography from '@mui/joy/Typography';
import { useTheme } from '@mui/joy/styles';
import ReactMarkdown, { type Components, type ExtraProps } from 'react-markdown';
import { Prism as SyntaxHighlighter } from 'react-syntax-highlighter';
import rehypeSanitize from 'rehype-sanitize';
import remarkBreaks from 'remark-breaks';
import remarkGfm from 'remark-gfm';
import type { ChatImageRef } from '@shared/chat';
import { BLOCK_COPY_BUTTON_CLASS, CopyMessageButton } from '../CopyMessageButton';
import { ExternalLink } from '../ExternalLink';
import { FilePathLink } from '../FilePathLink';
import { useImageMenu } from '../ImageContextMenu';
import { FILE_PATH_PROPERTY, rehypeFilePaths } from './filePaths';
import { fastRenderer } from './highlightElements';
import { codeBlockSx, markdownSx } from './markdownSx';
import { closeOpenFence } from './streamingMarkdown';
import { SYNTAX_THEMES } from './syntaxTheme';

/**
 * Module-level so their identity never changes: react-markdown rebuilds its whole pipeline
 * when a plugin array is a new value, which on a streaming reply would be every token.
 *
 * remark-breaks is here because the model writes prose with single newlines in it and means
 * them - the reply was drawn with `pre-wrap` before this, so without it every wrapped line
 * would reflow into its neighbour the moment markdown took over.
 *
 * rehype-raw is deliberately absent, and must stay absent. This renderer draws untrusted model
 * output inside a renderer that sits next to the `window.b4m` bridge, and raw HTML in a reply
 * buys nothing that markdown does not already say. rehype-sanitize is kept behind that as the
 * second lock rather than the only one; its default schema is also what preserves the
 * `language-*` class on a fence, which is what the highlighter reads the language from.
 *
 * rehypeFilePaths runs after the sanitizer, which would strip the attribute it adds.
 */
const REMARK_PLUGINS = [remarkGfm, remarkBreaks];
const REHYPE_PLUGINS = [rehypeSanitize, rehypeFilePaths];

type CodeProps = ComponentProps<'code'> & ExtraProps;

/** What a fence with no language hint is highlighted as; it earns no label. */
const UNKNOWN_LANGUAGE = 'text';

/**
 * The toolbar as a whole is what hides, background included: hidden, it would still paint over
 * the end of the first line and catch clicks there. It stays up while the copy button is
 * reporting an outcome, as revealCopyButtonSx keeps a message's button up.
 */
const TOOLBAR_CLASS = 'b4m-codeblock-toolbar';
const revealToolbarSx = {
  [`& .${TOOLBAR_CLASS}`]: { opacity: 0, pointerEvents: 'none', transition: 'opacity 120ms' },
  [`&:hover .${TOOLBAR_CLASS}, &:focus-within .${TOOLBAR_CLASS}, & .${TOOLBAR_CLASS}:has([data-state]:not([data-state="idle"]))`]:
    { opacity: 1, pointerEvents: 'auto' },
} as const;

/**
 * One fenced block, highlighted.
 *
 * Memoized on the code itself rather than on the message: a long reply re-renders on every
 * delta, and tokenizing every block it has already finished on every one of those is the
 * single most expensive thing this component could do. Props are all primitives, so a block
 * whose text has stopped changing re-renders exactly never, however long the reply runs.
 */
const CodeBlock = memo(function CodeBlock({
  code,
  language,
  mode,
}: {
  code: string;
  language: string;
  mode: 'light' | 'dark';
}) {
  return (
    // The toolbar sits outside the scroller so it stays put while a long line scrolls under it.
    <Box sx={{ position: 'relative', my: 1.5, ...revealToolbarSx }}>
      <Box sx={codeBlockSx} data-testid="chat-markdown-code-block" data-language={language}>
        {/* wrapLines stays off as it was: passing a renderer would otherwise switch it on. */}
        <SyntaxHighlighter
          language={language}
          style={SYNTAX_THEMES[mode]}
          PreTag="div"
          renderer={fastRenderer}
          wrapLines={false}
        >
          {code}
        </SyntaxHighlighter>
      </Box>
      <Box
        sx={{
          position: 'absolute',
          top: 4,
          right: 4,
          display: 'flex',
          alignItems: 'center',
          gap: 0.5,
          borderRadius: 'sm',
          // Over the code it covers, so the label never reads as part of the code.
          bgcolor: 'background.level1',
        }}
        className={TOOLBAR_CLASS}
        data-testid="reply-codeblock-toolbar"
      >
        {language !== UNKNOWN_LANGUAGE && (
          <Typography
            level="body-xs"
            textColor="text.tertiary"
            sx={{ pl: 0.75 }}
            data-testid="reply-codeblock-language"
          >
            {language}
          </Typography>
        )}
        <CopyMessageButton
          text={code}
          label="Copy code"
          className={BLOCK_COPY_BUTTON_CLASS}
          testId="reply-codeblock-copy-btn"
        />
      </Box>
    </Box>
  );
});

/**
 * Whether a `code` node is inline, read from where it sits in the source.
 *
 * react-markdown stopped passing an `inline` prop at v9, so position is what is left: inline
 * code opens and closes on one line, and a fenced block always spans at least its two fences -
 * which is exactly what closeOpenFence guarantees for a block that is still streaming.
 */
function isInline(node: ExtraProps['node']): boolean {
  const position = node?.position;
  if (!position) return false;
  return position.start.line === position.end.line && position.start.column !== position.end.column;
}

/**
 * An image a reply links. The sanitizer keeps only http(s) sources and the CSP then refuses to
 * load them, so nothing here is on disk: the menu offers its Markdown and no more. Focusable
 * only when there is a menu to open from the keyboard.
 */
function MarkdownImage({ src, alt, ...props }: ComponentProps<'img'>) {
  const url = typeof src === 'string' && /^https?:/i.test(src) ? src : null;
  const imageRef = useMemo<ChatImageRef | null>(() => (url ? { source: 'remote', url } : null), [url]);
  const menu = useImageMenu(imageRef);
  return (
    <img {...props} src={src} alt={alt} tabIndex={menu ? 0 : undefined} {...menu} data-testid="chat-markdown-image" />
  );
}

function buildComponents(mode: 'light' | 'dark'): Components {
  return {
    // The fence draws its own container, so react-markdown's <pre> would only nest a second
    // one around it - and a <div> inside a <pre> is not valid content either.
    pre: ({ children }) => <>{children}</>,

    code({ node, className, children, ref: _ref, ...props }: CodeProps) {
      if (isInline(node)) {
        return (
          <code {...props} data-testid="chat-markdown-inline-code">
            {children}
          </code>
        );
      }
      const language = /language-(\w+)/.exec(className ?? '')?.[1] ?? UNKNOWN_LANGUAGE;
      // An empty fence has no children at all.
      return <CodeBlock code={String(children ?? '').replace(/\n$/, '')} language={language} mode={mode} />;
    },

    img: ({ node: _node, ...props }) => <MarkdownImage {...props} />,

    // A reply cannot write a span (raw HTML is never parsed, see above), so this is rehypeFilePaths' marker.
    span({ node, children, ...props }) {
      const path = node?.properties?.[FILE_PATH_PROPERTY];
      if (typeof path === 'string') return <FilePathLink path={path}>{children}</FilePathLink>;
      return <span {...props}>{children}</span>;
    },

    // The same link a prompt draws, so the two open, and look, the same way. Bare urls arrive
    // here as links too: remark-gfm's autolink literals turn them into ordinary `a` nodes.
    a: ({ node: _node, ref: _ref, target: _target, ...props }) => (
      <ExternalLink {...props} testId="chat-markdown-link" />
    ),
  };
}

/**
 * One round's prose, as markdown.
 *
 * Memoized on the text, which is what keeps a streaming reply cheap: a turn that has run ten
 * rounds re-renders only the round still being written, and the nine above it are not reparsed
 * on any of the tokens that follow. A theme change still lands, because that arrives through
 * context rather than through props.
 */
export const ReplyMarkdown = memo(function ReplyMarkdown({ text }: { text: string }) {
  const mode = useTheme().palette.mode === 'dark' ? 'dark' : 'light';
  const components = useMemo(() => buildComponents(mode), [mode]);

  return (
    <Box sx={markdownSx} data-testid="chat-markdown">
      <ReactMarkdown remarkPlugins={REMARK_PLUGINS} rehypePlugins={REHYPE_PLUGINS} components={components}>
        {closeOpenFence(text)}
      </ReactMarkdown>
    </Box>
  );
});
