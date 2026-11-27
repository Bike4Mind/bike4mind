import { Fragment, useMemo, type ComponentPropsWithoutRef, type MouseEvent } from 'react';
import Box from '@mui/joy/Box';
import { isExternallyOpenable } from '@shared/externalLinks';
import { splitLinks } from './messageLinks';

/**
 * A link in a message, in a prompt and a reply alike, that leaves for the user's browser and
 * never navigates this window.
 *
 * Following it in place would replace the app - and the bridge the renderer is holding - with
 * whatever page the text named. `target="_blank"` is not the answer either: that still asks
 * Electron to open a window, it just asks for a different one. The href stays on the anchor so
 * the link reads and copies as a link; the click is what is redirected, and main checks the
 * scheme again before anything opens.
 */
export function ExternalLink({
  href,
  children,
  testId = 'chat-message-link',
  ...anchorProps
}: Omit<ComponentPropsWithoutRef<'a'>, 'onClick' | 'target'> & { testId?: string }) {
  const open = (event: MouseEvent<HTMLAnchorElement>) => {
    event.preventDefault();
    if (href && isExternallyOpenable(href)) void window.b4m.shell.openExternal(href);
  };

  return (
    <Box
      component="a"
      {...anchorProps}
      href={href}
      onClick={open}
      data-testid={testId}
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

/**
 * Text drawn exactly as written, with its urls made clickable. For words the user typed, which
 * are never parsed as markdown: see UserTurn.
 */
export function LinkifiedText({ text }: { text: string }) {
  const segments = useMemo(() => splitLinks(text), [text]);
  return (
    <>
      {segments.map((segment, index) =>
        segment.kind === 'link' ? (
          <ExternalLink key={index} href={segment.href}>
            {segment.text}
          </ExternalLink>
        ) : (
          <Fragment key={index}>{segment.text}</Fragment>
        )
      )}
    </>
  );
}
