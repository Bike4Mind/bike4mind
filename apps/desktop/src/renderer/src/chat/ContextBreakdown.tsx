import Box from '@mui/joy/Box';
import Stack from '@mui/joy/Stack';
import Typography from '@mui/joy/Typography';
import { contextBreakdown, type ContextCategory } from '@shared/contextBreakdown';
import { describeCompaction, formatTokens, type ComposerUsage } from './statusLine';

const CATEGORIES: Record<ContextCategory | 'reserve' | 'free', { label: string; color: string }> = {
  messages: { label: 'Messages', color: 'var(--joy-palette-primary-500)' },
  'system-tools': { label: 'System tools', color: 'var(--joy-palette-warning-500)' },
  'mcp-tools': { label: 'MCP tools', color: 'var(--joy-palette-success-500)' },
  project: { label: 'Project context', color: 'var(--joy-palette-warning-300)' },
  skills: { label: 'Skills', color: 'var(--joy-palette-neutral-500)' },
  system: { label: 'System prompt', color: 'var(--joy-palette-neutral-400)' },
  reserve: { label: 'Autocompact buffer', color: 'var(--joy-palette-neutral-300)' },
  free: { label: 'Free space', color: 'var(--joy-palette-neutral-softBg)' },
};

export function ContextBreakdown({ context }: { context: ComposerUsage }) {
  const tokens = context.contextSnapshot?.inputTokens ?? context.contextTokens;
  if (tokens === null)
    return <Typography level="body-xs">Not measured yet. Send a message to measure context.</Typography>;
  const snapshot = context.contextSnapshot;
  const data = contextBreakdown(tokens, context.contextLimit, snapshot);
  const { capacity } = data;
  const percent = (count: number) => (capacity === null ? '-' : `${Math.round((count / capacity) * 1000) / 10}%`);
  const share = capacity === null ? `${formatTokens(tokens)} used` : `${percent(tokens)} used`;
  const rows = [
    ...data.slices.map(slice => ({ ...slice, ...CATEGORIES[slice.id] })),
    ...(capacity === null
      ? []
      : [
          { id: 'reserve', tokens: data.reserve, ...CATEGORIES.reserve },
          { id: 'free', tokens: data.free, ...CATEGORIES.free },
        ]),
  ];
  return (
    <Stack spacing={1} data-testid="session-panel-context">
      <Stack direction="row" justifyContent="space-between" spacing={0.5}>
        <Typography level="body-xs">{share}</Typography>
        <Typography level="body-xs" data-testid="session-panel-context-figure">
          {capacity === null
            ? `${formatTokens(tokens)} - model reports no window size`
            : `${formatTokens(tokens)} / ${formatTokens(capacity)}`}
        </Typography>
      </Stack>
      {capacity !== null && (
        <Box
          role="meter"
          aria-label="Context window used"
          aria-valuemin={0}
          aria-valuemax={capacity}
          aria-valuenow={Math.min(tokens, capacity)}
          aria-valuetext={share.replace(' used', '')}
          data-testid="session-panel-context-bar"
          sx={{ display: 'flex', height: 6, borderRadius: 'xs', overflow: 'hidden', bgcolor: 'neutral.softBg' }}
        >
          {rows.map(row => (
            <Box
              key={row.id}
              data-testid={`context-segment-${row.id}`}
              sx={{ width: `${(row.tokens / Math.max(capacity, tokens)) * 100}%`, bgcolor: row.color, flexShrink: 0 }}
            />
          ))}
        </Box>
      )}
      <Stack spacing={0.5}>
        {rows.map(row => (
          <Box key={row.id} data-testid={`context-row-${row.id}`}>
            <Box
              sx={{
                display: 'grid',
                gridTemplateColumns: '8px minmax(0, 1fr) auto 38px',
                gap: 0.75,
                alignItems: 'center',
              }}
            >
              <Box aria-hidden sx={{ width: 8, height: 8, bgcolor: row.color, borderRadius: '2px' }} />
              <Typography level="body-xs" sx={{ minWidth: 0 }}>
                {row.id === 'messages' && !snapshot ? 'Unattributed input' : row.label}
              </Typography>
              <Typography level="body-xs" sx={{ fontVariantNumeric: 'tabular-nums' }}>
                {snapshot && row.id !== 'free' && row.id !== 'reserve' ? '~' : ''}
                {formatTokens(row.tokens)}
              </Typography>
              <Typography
                level="body-xs"
                textColor="text.tertiary"
                sx={{ textAlign: 'right', fontVariantNumeric: 'tabular-nums' }}
              >
                {percent(row.tokens)}
              </Typography>
            </Box>
            {'items' in row && row.items?.length ? (
              <Box
                component="details"
                sx={{ ml: 1.75, fontSize: 'xs', color: 'text.tertiary' }}
                data-testid={`context-inventory-${row.id}`}
              >
                <Box
                  component="summary"
                  sx={{ cursor: 'pointer', '&:focus-visible': { outline: '2px solid', outlineColor: 'focusVisible' } }}
                >
                  {row.items.length} injected {row.id === 'project' ? 'files' : 'tools'}
                </Box>
                {row.items.map(item => (
                  <Box key={item} sx={{ overflowWrap: 'anywhere', py: 0.25 }}>
                    {item}
                  </Box>
                ))}
              </Box>
            ) : null}
          </Box>
        ))}
      </Stack>
      <Typography level="body-xs" textColor="text.tertiary">
        {snapshot
          ? 'Provider-reported total. Category shares (~) are estimates.'
          : 'Provider-reported total; category attribution not recorded.'}
      </Typography>
      <Box component="details" sx={{ fontSize: 'xs', color: 'text.tertiary' }}>
        <Box component="summary" sx={{ cursor: 'pointer' }}>
          About context accounting
        </Box>
        {capacity !== null && (
          <Typography level="body-xs" textColor="text.tertiary">
            {describeCompaction(capacity, context.modelWindow ?? null)}. Buffer is reserved headroom, not injected
            tokens.
          </Typography>
        )}
      </Box>
    </Stack>
  );
}
