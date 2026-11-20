import Box from '@mui/joy/Box';
import IconButton from '@mui/joy/IconButton';
import Sheet from '@mui/joy/Sheet';
import Typography from '@mui/joy/Typography';

/**
 * The passage a reply is about, above the composer until the message goes. Sits where the
 * attachment tiles do and is removed the same way, since it is the same kind of thing: something
 * that rides with the next turn without being typed into it.
 */
export function QuoteChip({ quote, onRemove }: { quote: string; onRemove: () => void }) {
  return (
    <Sheet
      variant="outlined"
      data-testid="composer-quote"
      sx={{ position: 'relative', borderRadius: 'sm', py: 0.75, pl: 1.25, pr: 3.5, display: 'flex', gap: 1 }}
    >
      <Box sx={{ width: 3, flexShrink: 0, borderRadius: 2, bgcolor: 'neutral.outlinedBorder' }} />
      <Box sx={{ minWidth: 0 }}>
        <Typography level="body-xs" textColor="text.tertiary" sx={{ fontWeight: 'lg' }}>
          Replying to
        </Typography>
        <Typography
          level="body-sm"
          title={quote}
          data-testid="composer-quote-text"
          sx={{
            display: '-webkit-box',
            WebkitLineClamp: 2,
            WebkitBoxOrient: 'vertical',
            overflow: 'hidden',
            whiteSpace: 'pre-wrap',
            wordBreak: 'break-word',
          }}
        >
          {quote}
        </Typography>
      </Box>
      <IconButton
        size="sm"
        variant="plain"
        color="neutral"
        aria-label="Remove quote"
        onClick={onRemove}
        sx={{ position: 'absolute', top: 2, right: 2, minHeight: 20, minWidth: 20 }}
        data-testid="composer-quote-remove-btn"
      >
        <Typography level="body-xs">x</Typography>
      </IconButton>
    </Sheet>
  );
}
