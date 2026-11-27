import { useEffect, useRef } from 'react';
import IconButton from '@mui/joy/IconButton';
import Input from '@mui/joy/Input';
import Sheet from '@mui/joy/Sheet';
import Typography from '@mui/joy/Typography';
import { CloseIcon, FindStepIcon, SearchIcon } from './icons';
import { isMac } from './platform';
import type { ThreadFind } from './useThreadFind';

const MOD = isMac ? '\u2318' : 'Ctrl+';

/** The find bar over the open conversation; its state lives in useThreadFind. */
export function FindBar({ find }: { find: ThreadFind }) {
  const input = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (find.focusRequest === 0) return;
    input.current?.focus();
    input.current?.select();
  }, [find.focusRequest]);

  const none = find.total === 0;

  return (
    <Sheet
      variant="outlined"
      role="search"
      aria-label="Find in conversation"
      sx={{
        position: 'absolute',
        top: 8,
        right: 16,
        zIndex: 5,
        display: 'flex',
        alignItems: 'center',
        gap: 0.5,
        pl: 0.5,
        pr: 0.25,
        py: 0.25,
        borderRadius: 'md',
        boxShadow: 'md',
        maxWidth: 'calc(100% - 32px)',
      }}
      data-testid="chat-find-bar"
    >
      <Input
        size="sm"
        variant="plain"
        placeholder="Find in conversation"
        value={find.query}
        onChange={event => find.setQuery(event.target.value)}
        startDecorator={<SearchIcon />}
        slotProps={{ input: { ref: input, 'aria-label': 'Find in conversation', 'data-testid': 'chat-find-input' } }}
        onKeyDown={event => {
          if (event.key === 'Enter') {
            event.preventDefault();
            find.step(event.shiftKey ? -1 : 1);
          } else if (event.key === 'Escape') {
            event.preventDefault();
            // Escape elsewhere can stop a running turn; from here it only closes the bar.
            event.stopPropagation();
            find.close();
          }
        }}
        sx={{ width: 220, minWidth: 0, '--Input-focusedThickness': '0px' }}
      />
      <Typography
        level="body-xs"
        textColor={find.query && none ? 'danger.plainColor' : 'text.tertiary'}
        noWrap
        sx={{ minWidth: 56, textAlign: 'right', fontVariantNumeric: 'tabular-nums' }}
        aria-live="polite"
        data-testid="chat-find-count"
      >
        {find.count}
      </Typography>
      <IconButton
        size="sm"
        variant={find.caseSensitive ? 'soft' : 'plain'}
        color={find.caseSensitive ? 'primary' : 'neutral'}
        aria-pressed={find.caseSensitive}
        aria-label="Match case"
        title="Match case"
        onClick={find.toggleCase}
        sx={{ fontSize: 'xs', fontWeight: 'lg' }}
        data-testid="chat-find-case-toggle"
      >
        Aa
      </IconButton>
      <IconButton
        size="sm"
        variant="plain"
        color="neutral"
        disabled={none}
        aria-label="Previous match"
        title={`Previous match (Shift+Enter, ${MOD}${isMac ? '\u21E7' : 'Shift+'}G)`}
        onClick={() => find.step(-1)}
        data-testid="chat-find-prev-btn"
      >
        <FindStepIcon direction="up" />
      </IconButton>
      <IconButton
        size="sm"
        variant="plain"
        color="neutral"
        disabled={none}
        aria-label="Next match"
        title={`Next match (Enter, ${MOD}G)`}
        onClick={() => find.step(1)}
        data-testid="chat-find-next-btn"
      >
        <FindStepIcon direction="down" />
      </IconButton>
      <IconButton
        size="sm"
        variant="plain"
        color="neutral"
        aria-label="Close find"
        title="Close (Esc)"
        onClick={find.close}
        data-testid="chat-find-close-btn"
      >
        <CloseIcon />
      </IconButton>
    </Sheet>
  );
}
