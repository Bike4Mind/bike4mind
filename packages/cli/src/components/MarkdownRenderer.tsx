import React from 'react';
import { Box, Text } from 'ink';
import { marked, type Token, type Tokens } from 'marked';
import { highlight } from 'cli-highlight';

interface MarkdownRendererProps {
  content: string;
  /** Terminal column width. Defaults to process.stdout.columns at render time. */
  columns?: number;
}

export function MarkdownRenderer({ content, columns: columnsProp }: MarkdownRendererProps) {
  const columns = columnsProp ?? process.stdout.columns ?? 80;
  const tokens = marked.lexer(content);

  return <Box flexDirection="column">{tokens.map((token, idx) => renderToken(token, idx, columns))}</Box>;
}

function renderToken(token: Token, idx: number, columns: number): React.ReactNode {
  switch (token.type) {
    case 'heading':
      return renderHeading(token as Tokens.Heading, idx);

    case 'code':
      return renderCodeBlock(token as Tokens.Code, idx);

    case 'paragraph':
      return renderParagraph(token as Tokens.Paragraph, idx);

    case 'list':
      return renderList(token as Tokens.List, idx);

    case 'blockquote':
      return renderBlockquote(token as Tokens.Blockquote, idx, columns);

    case 'hr':
      return (
        <Text key={idx} dimColor>
          {'─'.repeat(Math.max(1, columns - 4))}
        </Text>
      );

    case 'space':
      return null;

    default:
      // Fallback for unsupported token types
      if ('text' in token) {
        return <Text key={idx}>{token.text}</Text>;
      }
      return null;
  }
}

function renderHeading(token: Tokens.Heading, idx: number): React.ReactNode {
  const colors = {
    1: 'cyan' as const,
    2: 'cyan' as const,
    3: 'blue' as const,
    4: 'blue' as const,
    5: 'white' as const,
    6: 'white' as const,
  };

  const color = colors[token.depth as keyof typeof colors] || 'white';

  return (
    <Box key={idx} marginTop={idx > 0 ? 1 : 0}>
      <Text bold color={color}>
        {parseInlineText(token.text)}
      </Text>
    </Box>
  );
}

function renderCodeBlock(token: Tokens.Code, idx: number): React.ReactNode {
  let highlightedCode: string;

  try {
    highlightedCode = highlight(token.text, {
      language: token.lang || 'javascript',
      ignoreIllegals: true,
    });
  } catch (error) {
    // If highlighting fails, fall back to plain text
    highlightedCode = token.text;
  }

  return (
    <Box key={idx} flexDirection="column" paddingLeft={2}>
      {token.lang && (
        <Text dimColor color="gray">
          {token.lang}
        </Text>
      )}
      <Text>{highlightedCode}</Text>
    </Box>
  );
}

function renderParagraph(token: Tokens.Paragraph, idx: number): React.ReactNode {
  return (
    <Box key={idx}>
      <Text>{parseInlineText(token.text)}</Text>
    </Box>
  );
}

function renderList(token: Tokens.List, idx: number): React.ReactNode {
  return (
    <Box key={idx} flexDirection="column">
      {token.items.map((item, itemIdx) => renderListItem(item, itemIdx, token.ordered, itemIdx + 1))}
    </Box>
  );
}

function renderListItem(item: Tokens.ListItem, idx: number, ordered: boolean, number: number): React.ReactNode {
  const bullet = ordered ? `${number}.` : '•';

  return (
    <Box key={idx} paddingLeft={2}>
      <Text>
        {bullet} {parseInlineText(item.text)}
      </Text>
    </Box>
  );
}

function renderBlockquote(token: Tokens.Blockquote, idx: number, columns: number): React.ReactNode {
  return (
    <Box key={idx} paddingLeft={2} borderStyle="single" borderLeft borderColor="gray">
      {token.tokens.map((t, i) => renderToken(t, i, columns))}
    </Box>
  );
}

/**
 * Parse inline markdown formatting (bold, italic, code, links)
 * Returns React elements with proper formatting
 */
function parseInlineText(text: string): React.ReactNode {
  const parts: React.ReactNode[] = [];
  let lastIndex = 0;

  // Match bold (**text**), italic (*text*), and inline code (`code`)
  const regex = /(\*\*(.+?)\*\*)|(\*(.+?)\*)|(`(.+?)`)/g;
  let match;

  while ((match = regex.exec(text)) !== null) {
    // Add text before the match
    if (match.index > lastIndex) {
      parts.push(text.slice(lastIndex, match.index));
    }

    // Handle bold
    if (match[1]) {
      parts.push(
        <Text key={match.index} bold>
          {match[2]}
        </Text>
      );
    }
    // Handle italic
    else if (match[3]) {
      parts.push(
        <Text key={match.index} italic>
          {match[4]}
        </Text>
      );
    }
    // Handle inline code
    else if (match[5]) {
      parts.push(
        <Text key={match.index} color="cyan">
          {match[6]}
        </Text>
      );
    }

    lastIndex = regex.lastIndex;
  }

  // Add remaining text
  if (lastIndex < text.length) {
    parts.push(text.slice(lastIndex));
  }

  // If no formatting found, return plain text
  if (parts.length === 0) {
    return text;
  }

  return <>{parts}</>;
}
