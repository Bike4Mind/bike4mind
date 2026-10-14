import { FC } from 'react';
import { Box, Card, CardContent, Chip, Stack, Tooltip, Typography } from '@mui/joy';
import DownloadIcon from '@mui/icons-material/Download';
import AutoAwesomeIcon from '@mui/icons-material/AutoAwesome';
import WarningAmberIcon from '@mui/icons-material/WarningAmber';
import BuildIcon from '@mui/icons-material/Build';
import VerifiedUserIcon from '@mui/icons-material/VerifiedUser';
import { useNavigate } from '@tanstack/react-router';
import type { MarketListing } from '@client/app/hooks/data/skillMarket';
import { Stars, VisibilityChip, formatCount } from './parts';

const clamp = (lines: number) => ({
  display: '-webkit-box',
  WebkitLineClamp: lines,
  WebkitBoxOrient: 'vertical' as const,
  overflow: 'hidden',
});

/** One listing in the browse grid, a rail, or "Similar skills". */
const MarketCard: FC<{ listing: MarketListing }> = ({ listing }) => {
  const navigate = useNavigate();
  const open = () => navigate({ to: '/skills/market/$listingId', params: { listingId: listing.id } });

  return (
    <Card
      variant="outlined"
      role="link"
      tabIndex={0}
      onClick={open}
      onKeyDown={e => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          open();
        }
      }}
      data-testid={`market-card-${listing.name}`}
      sx={{
        cursor: 'pointer',
        height: '100%',
        transition: 'border-color 120ms, box-shadow 120ms, transform 120ms',
        '&:hover, &:focus-visible': {
          borderColor: 'primary.outlinedHoverBorder',
          boxShadow: 'sm',
          transform: 'translateY(-1px)',
        },
        '&:focus-visible': { outline: '2px solid', outlineColor: 'primary.500' },
      }}
    >
      <CardContent sx={{ gap: 1 }}>
        {listing.reason ? (
          <Typography level="body-xs" color="primary" fontWeight="md" data-testid="market-card-reason">
            {listing.reason}
          </Typography>
        ) : null}

        <Stack direction="row" justifyContent="space-between" alignItems="flex-start" gap={1}>
          <Box sx={{ minWidth: 0 }}>
            <Typography level="title-md" component="code" sx={{ fontFamily: 'code', wordBreak: 'break-all' }}>
              /{listing.name}
            </Typography>
            <Typography level="body-xs" textColor="text.tertiary" noWrap>
              by {listing.authorName || 'a Bike4Mind user'}
            </Typography>
          </Box>
          {listing.visibility !== 'public' ? <VisibilityChip visibility={listing.visibility} /> : null}
        </Stack>

        <Typography level="body-sm" sx={clamp(2)}>
          {listing.description}
        </Typography>

        {listing.honestSummaryText ? (
          <Stack direction="row" spacing={0.75} alignItems="flex-start" sx={{ color: 'text.secondary' }}>
            <AutoAwesomeIcon sx={{ fontSize: 14, mt: '3px', color: 'primary.400' }} />
            <Typography level="body-xs" sx={clamp(2)} title="AI-generated from the skill content">
              {listing.honestSummaryText}
            </Typography>
          </Stack>
        ) : null}

        <Stack direction="row" spacing={0.5} flexWrap="wrap" useFlexGap>
          {listing.descriptionMatches === false ? (
            <Chip
              size="sm"
              color="warning"
              variant="soft"
              startDecorator={<WarningAmberIcon />}
              data-testid="market-card-mismatch"
            >
              Description may not match behaviour
            </Chip>
          ) : null}
          {listing.usesTools ? (
            <Chip size="sm" variant="soft" startDecorator={<BuildIcon />}>
              Uses tools
            </Chip>
          ) : null}
          {listing.autoChecked ? (
            <Tooltip title="Passed the automated safety scan; not yet reviewed by a person" variant="soft">
              <Chip size="sm" variant="outlined" color="neutral" startDecorator={<VerifiedUserIcon />}>
                Auto-checked
              </Chip>
            </Tooltip>
          ) : (
            <Chip size="sm" variant="soft" color="success" startDecorator={<VerifiedUserIcon />}>
              Reviewed
            </Chip>
          )}
          {listing.tags.slice(0, 3).map(t => (
            <Chip key={t} size="sm" variant="plain" color="neutral" data-market-tag={t} title={`Filter by #${t}`}>
              #{t}
            </Chip>
          ))}
        </Stack>
      </CardContent>

      <Stack direction="row" justifyContent="space-between" alignItems="center" sx={{ mt: 'auto' }}>
        <Stack direction="row" spacing={0.75} alignItems="center">
          <Stars value={listing.ratingAvg} />
          <Typography level="body-xs" textColor="text.tertiary">
            {listing.ratingCount ? `${listing.ratingAvg.toFixed(1)} (${listing.ratingCount})` : 'No ratings yet'}
          </Typography>
        </Stack>
        <Stack direction="row" spacing={0.5} alignItems="center" sx={{ color: 'text.tertiary' }}>
          <DownloadIcon sx={{ fontSize: 16 }} />
          <Typography level="body-xs" textColor="text.tertiary">
            {formatCount(listing.importCount)}
          </Typography>
        </Stack>
      </Stack>
    </Card>
  );
};

export default MarketCard;
