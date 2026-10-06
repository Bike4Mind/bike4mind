import { useCallback, useLayoutEffect, useMemo, useRef, useState } from 'react';
import Box from '@mui/joy/Box';
import Button from '@mui/joy/Button';
import Chip from '@mui/joy/Chip';
import Sheet from '@mui/joy/Sheet';
import Stack from '@mui/joy/Stack';
import Typography from '@mui/joy/Typography';
import type { DevLogRecord } from '@shared/devLog';
import { MOUNTED_ROWS, clockTime, formatForCopy, visibleRecords } from './devLogView';
import { useDevLog } from './useDevLog';

/** Treated as "at the bottom", so a row arriving mid-pixel does not unstick the tail. */
const BOTTOM_SLACK_PX = 24;

function Row({ record }: { record: DevLogRecord }) {
  const fields = Object.entries(record.fields ?? {});
  return (
    <Box
      data-testid="devlogs-line-row"
      sx={{
        display: 'flex',
        gap: 1,
        alignItems: 'baseline',
        px: 1.5,
        py: 0.25,
        fontFamily: 'code',
        fontSize: 'xs',
        borderBottom: '1px solid',
        borderColor: 'divider',
      }}
    >
      <Box component="span" sx={{ color: 'text.tertiary', flexShrink: 0 }}>
        {clockTime(record.at)}
      </Box>
      <Box sx={{ display: 'flex', gap: 0.5, flexShrink: 0, flexWrap: 'wrap' }}>
        {record.tags.map(tag => (
          <Chip
            key={tag}
            size="sm"
            variant="soft"
            color="neutral"
            sx={{ fontSize: '10px', '--Chip-minHeight': '16px' }}
          >
            {tag}
          </Chip>
        ))}
      </Box>
      <Box component="span" sx={{ color: 'text.primary', wordBreak: 'break-word' }}>
        {record.message}
      </Box>
      {fields.length > 0 && (
        <Box component="span" sx={{ color: 'text.tertiary', wordBreak: 'break-word' }}>
          {fields.map(([key, value]) => `${key}=${value}`).join(' ')}
        </Box>
      )}
    </Box>
  );
}

/**
 * The developer log window: whatever has been published to the sink, newest at the bottom.
 *
 * Nothing here knows what a source is. Tags come from the records themselves, so a source added
 * later shows up, and is filterable, with no change to this file.
 */
export function DevLogsWindow() {
  const { records, tags, dropped, clear } = useDevLog();
  const [selected, setSelected] = useState<ReadonlySet<string>>(new Set());
  const [copied, setCopied] = useState(false);
  const scroller = useRef<HTMLDivElement>(null);
  const stuckToBottom = useRef(true);

  const shown = useMemo(() => visibleRecords(records, selected), [records, selected]);
  const mounted = shown.length > MOUNTED_ROWS ? shown.slice(shown.length - MOUNTED_ROWS) : shown;
  const lastMountedId = mounted.length > 0 ? mounted[mounted.length - 1].id : 0;

  const onScroll = useCallback(() => {
    const element = scroller.current;
    if (!element) return;
    stuckToBottom.current = element.scrollHeight - element.scrollTop - element.clientHeight <= BOTTOM_SLACK_PX;
  }, []);

  // Only when the view was already at the bottom: scrolling someone who is reading further up
  // back down is the one thing a live tail must never do.
  useLayoutEffect(() => {
    const element = scroller.current;
    if (element && stuckToBottom.current) element.scrollTop = element.scrollHeight;
  }, [lastMountedId, mounted.length]);

  const toggleTag = useCallback((tag: string) => {
    setSelected(current => {
      const next = new Set(current);
      if (!next.delete(tag)) next.add(tag);
      return next;
    });
  }, []);

  const copy = useCallback(() => {
    void window.b4m.devLog.copy(formatForCopy(shown));
    setCopied(true);
    setTimeout(() => setCopied(false), 1200);
  }, [shown]);

  return (
    <Box sx={{ height: '100vh', display: 'flex', flexDirection: 'column', bgcolor: 'background.body' }}>
      <Sheet
        variant="outlined"
        sx={{ p: 1.5, borderWidth: '0 0 1px', display: 'flex', flexDirection: 'column', gap: 1 }}
      >
        <Stack direction="row" spacing={1} alignItems="center">
          <Typography level="title-sm">Developer logs</Typography>
          <Typography level="body-xs" textColor="text.tertiary" sx={{ flexGrow: 1 }}>
            {shown.length} of {records.length} lines
            {shown.length > mounted.length ? ` (showing last ${mounted.length})` : ''}
            {dropped > 0 ? ` - ${dropped} dropped` : ''}
          </Typography>
          <Button size="sm" variant="plain" data-testid="devlogs-copy-btn" onClick={copy} disabled={shown.length === 0}>
            {copied ? 'Copied' : 'Copy shown'}
          </Button>
          <Button size="sm" variant="plain" color="danger" data-testid="devlogs-clear-btn" onClick={clear}>
            Clear
          </Button>
        </Stack>
        <Stack direction="row" spacing={0.5} sx={{ flexWrap: 'wrap', gap: 0.5 }}>
          {tags.length === 0 ? (
            <Typography level="body-xs" textColor="text.tertiary">
              No tags yet. Tags appear as lines arrive.
            </Typography>
          ) : (
            tags.map(tag => (
              <Chip
                key={tag}
                size="sm"
                variant={selected.has(tag) ? 'solid' : 'outlined'}
                color={selected.has(tag) ? 'primary' : 'neutral'}
                onClick={() => toggleTag(tag)}
                // On the action, not the root: Joy puts the click handler on an inner button,
                // and a test that clicks the root would pass while toggling nothing.
                slotProps={{ action: { 'data-testid': 'devlogs-filter-chip' } }}
              >
                {tag}
              </Chip>
            ))
          )}
        </Stack>
      </Sheet>
      <Box
        ref={scroller}
        onScroll={onScroll}
        data-testid="devlogs-tail-list"
        sx={{ flexGrow: 1, overflowY: 'auto', overflowX: 'hidden' }}
      >
        {mounted.map(record => (
          <Row key={record.id} record={record} />
        ))}
      </Box>
    </Box>
  );
}
