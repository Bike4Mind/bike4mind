import React, { type CSSProperties } from 'react';
import { useTheme } from '@mui/joy/styles';
import { Prism as SyntaxHighlighter } from 'react-syntax-highlighter';
import { getMarkdownSyntaxTheme } from '../Session/markdown/syntaxTheme';

/**
 * The inner presentation of every code surface in the app: the panel the highlighted code
 * sits on, its inset and its corner.
 *
 * Deliberately only the INSIDE. A standalone fence in chat adds the framed panel and the
 * language/copy header around this (see CodeBlockHeader); an artifact card or a viewer Code
 * tab does not, because it already sits in a frame that carries a title and its own actions,
 * and a second header inside the first reads as a box in a box.
 *
 * Lives in common/ rather than next to CodeBlockHeader so a Knowledge viewer can reach the
 * surface without importing a Session component - CodeBlockHeader pulls in CopyCodeButton,
 * and that edge is how the import cycle that silently killed highlighting last time formed.
 */
export const CODE_SURFACE_STYLE: CSSProperties = {
  margin: 0,
  border: 'none',
  borderRadius: '6px',
  background: 'var(--joy-palette-reading-surface, #13181C)',
  padding: '12px',
};

export interface HighlightedCodeProps {
  code: string;
  /** Prism language id. 'text'/'plain' still highlights as plain text. */
  language?: string;
  showLineNumbers?: boolean;
  wrapLongLines?: boolean;
  /**
   * Merged over CODE_SURFACE_STYLE. For hosts that must size the panel itself - a viewer
   * pane wants `minHeight: '100%'` so the surface fills the tab. Not a hook for restyling
   * the surface: colour, font and inset are the point of sharing this.
   */
  customStyle?: CSSProperties;
  className?: string;
}

/**
 * Highlighted code on the shared surface, in the Observatory palette.
 *
 * Every call site used to pass react-syntax-highlighter's stock `oneDark` plus its own
 * ad-hoc customStyle, so the same snippet had a different palette, inset and mono face in a
 * reply, a card and a viewer - and `oneDark` is dark-only, so all of them ignored light mode.
 *
 * Renders through a real `pre` (`PreTag="pre"`): observatory.css skins INLINE code via
 * `:not(pre) > code`, so under a div that skin matches and outlines every single line.
 */
export const HighlightedCode: React.FC<HighlightedCodeProps> = ({
  code,
  language,
  showLineNumbers = false,
  wrapLongLines,
  customStyle,
  className,
}) => {
  const theme = useTheme();
  const syntaxTheme = getMarkdownSyntaxTheme(theme.palette.mode);

  return (
    <SyntaxHighlighter
      // @ts-ignore - react-syntax-highlighter types the style prop too narrowly for a
      // plain selector-to-CSSProperties map.
      style={syntaxTheme}
      language={language}
      PreTag="pre"
      showLineNumbers={showLineNumbers}
      wrapLongLines={wrapLongLines}
      className={className}
      customStyle={customStyle ? { ...CODE_SURFACE_STYLE, ...customStyle } : CODE_SURFACE_STYLE}
    >
      {code}
    </SyntaxHighlighter>
  );
};

export default HighlightedCode;
