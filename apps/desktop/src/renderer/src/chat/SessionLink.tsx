import { createContext, Fragment, useContext, useMemo, type MouseEvent, type ReactNode } from 'react';
import Box from '@mui/joy/Box';
import { findSessionMentions } from '@shared/sessionMention';
import { LinkifiedText } from './ExternalLink';

/** Opens a conversation by id. Provided by the shell, which owns which one is open. */
export const SessionOpenerContext = createContext<((sessionId: string) => void) | undefined>(undefined);

/**
 * A name in the thread that opens another conversation.
 *
 * Drawn as a button, not an anchor: there is no URL to follow, and a click must not reach a
 * parent `<summary>`, whose default action would toggle the disclosure it sits in. Without an
 * opener it degrades to plain text rather than a link that does nothing.
 */
export function SessionLink({
  sessionId,
  children,
  testId,
  onOpen,
}: {
  sessionId: string;
  children: ReactNode;
  testId: string;
  /** Overrides the context, for callers rendered outside the provider. */
  onOpen?: (sessionId: string) => void;
}) {
  const contextOpen = useContext(SessionOpenerContext);
  const open = onOpen ?? contextOpen;
  if (!open) return <>{children}</>;

  const click = (event: MouseEvent<HTMLElement>) => {
    event.preventDefault();
    event.stopPropagation();
    open(sessionId);
  };

  return (
    <Box
      component="button"
      type="button"
      onClick={click}
      data-testid={testId}
      data-session-id={sessionId}
      sx={{
        all: 'unset',
        boxSizing: 'border-box',
        color: 'var(--joy-palette-primary-plainColor)',
        cursor: 'pointer',
        textDecoration: 'underline',
        textUnderlineOffset: '2px',
        '&:focus-visible': { outline: '2px solid var(--joy-palette-focusVisible)', borderRadius: '2px' },
      }}
    >
      {children}
    </Box>
  );
}

/**
 * What the user typed, with `@[Title](session:<id>)` drawn as a link to that conversation and
 * urls made clickable. The title shown is the one recorded at send time.
 */
export function MentionedText({ text }: { text: string }) {
  const parts = useMemo(() => {
    const out: ({ kind: 'text'; text: string } | { kind: 'mention'; sessionId: string; title: string })[] = [];
    let cursor = 0;
    for (const mention of findSessionMentions(text)) {
      if (mention.start > cursor) out.push({ kind: 'text', text: text.slice(cursor, mention.start) });
      out.push({ kind: 'mention', sessionId: mention.sessionId, title: mention.title });
      cursor = mention.end;
    }
    if (cursor < text.length) out.push({ kind: 'text', text: text.slice(cursor) });
    return out;
  }, [text]);

  return (
    <>
      {parts.map((part, index) =>
        part.kind === 'mention' ? (
          <SessionLink key={index} sessionId={part.sessionId} testId="session-mention-link">
            @{part.title}
          </SessionLink>
        ) : (
          <Fragment key={index}>
            <LinkifiedText text={part.text} />
          </Fragment>
        )
      )}
    </>
  );
}
