import { useCallback, useEffect, useRef, useState } from 'react';
import Alert from '@mui/joy/Alert';
import Box from '@mui/joy/Box';
import Button from '@mui/joy/Button';
import Chip from '@mui/joy/Chip';
import CircularProgress from '@mui/joy/CircularProgress';
import IconButton from '@mui/joy/IconButton';
import Input from '@mui/joy/Input';
import Option from '@mui/joy/Option';
import Select from '@mui/joy/Select';
import Sheet from '@mui/joy/Sheet';
import Stack from '@mui/joy/Stack';
import Typography from '@mui/joy/Typography';
import type { SkillMarketFilters, SkillMarketListing, SkillMarketListingRef } from '@shared/skillMarket';
import { CloseIcon, ExternalLinkIcon, SearchIcon } from './icons';
import { columnStackSx, contentColumnSx, scrollingColumnHostSx } from './layout';
import { SkillListingDetail } from './SkillListingDetail';

/** The web market's default (apps/client/app/routes/skills/market/index.tsx). */
const DEFAULT_FILTERS: SkillMarketFilters = { q: '', scope: '', tools: '', minRating: 0, sort: 'top' };

function ListingCard({ listing, onOpen }: { listing: SkillMarketListing; onOpen: () => void }) {
  return (
    <Sheet
      variant="outlined"
      sx={{ borderRadius: 'md', p: 1.5, cursor: 'pointer', '&:hover': { bgcolor: 'background.level1' } }}
      onClick={onOpen}
      role="button"
      tabIndex={0}
      onKeyDown={event => {
        if (event.key === 'Enter') onOpen();
      }}
      data-testid="skill-market-card"
    >
      <Stack spacing={0.5}>
        <Stack direction="row" spacing={0.75} alignItems="center">
          <Typography level="title-sm" noWrap sx={{ flex: 1, minWidth: 0 }}>
            /{listing.name}
          </Typography>
          {listing.visibility !== 'public' && (
            <Chip size="sm" variant="soft" color="neutral">
              {listing.visibility === 'organization' ? 'Org' : 'Unlisted'}
            </Chip>
          )}
          {listing.riskTier === 'high' && (
            <Chip size="sm" variant="soft" color="danger">
              High risk
            </Chip>
          )}
        </Stack>
        <Typography level="body-xs" textColor="text.secondary" sx={{ minHeight: '2.5em' }}>
          {listing.description}
        </Typography>
        <Typography level="body-xs" textColor="text.tertiary">
          {listing.authorName ?? 'Unknown author'} -{' '}
          {listing.ratingCount ? `${listing.ratingAvg.toFixed(1)} stars` : 'unrated'} - {listing.importCount} imports
        </Typography>
        {listing.reason && (
          <Typography level="body-xs" textColor="text.tertiary">
            {listing.reason}
          </Typography>
        )}
      </Stack>
    </Sheet>
  );
}

function Grid({ listings, onOpen }: { listings: SkillMarketListing[]; onOpen: (id: string) => void }) {
  return (
    <Box sx={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(240px, 1fr))', gap: 1.25 }}>
      {listings.map(listing => (
        <ListingCard key={listing.id} listing={listing} onOpen={() => onOpen(listing.id)} />
      ))}
    </Box>
  );
}

/**
 * The Skill Market as a screen beside Artifacts and Customize: browse and search the listings,
 * open one, import it. Rating, reporting, sharing and managing listings stay on the web, one
 * "Open on web" click away. `initial` opens straight onto one listing (an update badge in
 * Customize, or an unlisted share link).
 */
export function SkillMarketPanel({
  onClose,
  initial,
}: {
  onClose: () => void;
  initial?: SkillMarketListingRef | null;
}) {
  const [filters, setFilters] = useState<SkillMarketFilters>(DEFAULT_FILTERS);
  const [draft, setDraft] = useState('');
  const [listings, setListings] = useState<SkillMarketListing[]>([]);
  const [recommended, setRecommended] = useState<SkillMarketListing[]>([]);
  const [page, setPage] = useState(1);
  const [hasMore, setHasMore] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [selected, setSelected] = useState<SkillMarketListingRef | null>(initial ?? null);

  // Only the latest request lands, so a slow page for old filters cannot overwrite the new ones.
  const latest = useRef(0);
  const load = useCallback(async (next: SkillMarketFilters, nextPage: number) => {
    const request = ++latest.current;
    setLoading(true);
    const result = await window.b4m.skillMarket.browse(next, nextPage);
    if (request !== latest.current) return;
    setLoading(false);
    setError(result.error ?? null);
    setHasMore(result.hasMore);
    setPage(nextPage);
    setListings(previous => (nextPage === 1 ? result.listings : [...previous, ...result.listings]));
  }, []);

  useEffect(() => {
    void load(filters, 1);
  }, [filters, load]);

  useEffect(() => {
    void window.b4m.skillMarket.recommended().then(result => setRecommended(result.listings));
  }, []);

  const set = <K extends keyof SkillMarketFilters>(key: K, value: SkillMarketFilters[K]) =>
    setFilters(previous => ({ ...previous, [key]: value }));
  const browsing = !filters.q && !filters.scope && !filters.tools && !filters.minRating;

  return (
    <Stack sx={{ flex: 1, minWidth: 0, ...columnStackSx }} data-testid="skill-market-panel">
      <Box sx={{ borderBottom: '1px solid', borderColor: 'divider' }}>
        <Stack direction="row" alignItems="center" spacing={1} sx={{ ...contentColumnSx, py: 1.25 }}>
          <Stack sx={{ flex: 1, minWidth: 0 }}>
            <Typography level="title-sm">Skill Market</Typography>
            <Typography level="body-xs" textColor="text.tertiary">
              Skills other people published. Imports run as untrusted instructions.
            </Typography>
          </Stack>
          <Button
            size="sm"
            variant="plain"
            color="neutral"
            endDecorator={<ExternalLinkIcon />}
            onClick={() => void window.b4m.skillMarket.openOnWeb({ kind: 'mine' })}
            data-testid="skill-market-mine-btn"
          >
            My listings
          </Button>
          <IconButton
            size="sm"
            variant="plain"
            color="neutral"
            aria-label="Close skill market"
            onClick={onClose}
            data-testid="skill-market-close-btn"
          >
            <CloseIcon />
          </IconButton>
        </Stack>
      </Box>

      <Box sx={{ flex: 1, ...scrollingColumnHostSx }}>
        <Box sx={{ ...contentColumnSx, py: 2 }}>
          {selected ? (
            <SkillListingDetail listingRef={selected} onBack={() => setSelected(null)} />
          ) : (
            <Stack spacing={2}>
              <form
                onSubmit={event => {
                  event.preventDefault();
                  setFilters(previous => ({
                    ...previous,
                    q: draft.trim(),
                    sort: draft.trim() ? 'relevance' : previous.sort === 'relevance' ? 'top' : previous.sort,
                  }));
                }}
              >
                <Input
                  startDecorator={<SearchIcon />}
                  placeholder="Search by name, description, tag or what the skill does"
                  value={draft}
                  onChange={event => setDraft(event.target.value)}
                  slotProps={{ input: { 'aria-label': 'Search skills', 'data-testid': 'skill-market-search-input' } }}
                />
              </form>
              <Stack direction="row" spacing={1} flexWrap="wrap" useFlexGap>
                <Select
                  size="sm"
                  value={filters.scope}
                  onChange={(_event, value) => set('scope', value ?? '')}
                  slotProps={{ button: { 'aria-label': 'Visibility', 'data-testid': 'skill-market-scope' } }}
                >
                  <Option value="">Everything I can see</Option>
                  <Option value="public">Public</Option>
                  <Option value="org">My organizations</Option>
                </Select>
                <Select
                  size="sm"
                  value={filters.tools}
                  onChange={(_event, value) => set('tools', value ?? '')}
                  slotProps={{ button: { 'aria-label': 'Tool usage', 'data-testid': 'skill-market-tools' } }}
                >
                  <Option value="">Any tools</Option>
                  <Option value="without">No tools</Option>
                  <Option value="with">Uses tools</Option>
                </Select>
                <Select
                  size="sm"
                  value={filters.minRating}
                  onChange={(_event, value) => set('minRating', value ?? 0)}
                  slotProps={{ button: { 'aria-label': 'Minimum rating', 'data-testid': 'skill-market-rating' } }}
                >
                  <Option value={0}>Any rating</Option>
                  <Option value={3}>3+ stars</Option>
                  <Option value={4}>4+ stars</Option>
                </Select>
                <Box sx={{ flex: 1 }} />
                <Select
                  size="sm"
                  value={filters.sort}
                  onChange={(_event, value) => value && set('sort', value)}
                  slotProps={{ button: { 'aria-label': 'Sort by', 'data-testid': 'skill-market-sort' } }}
                >
                  {filters.q ? <Option value="relevance">Best match</Option> : null}
                  <Option value="top">Top rated</Option>
                  <Option value="imports">Most imported</Option>
                  <Option value="new">Newest</Option>
                  <Option value="updated">Recently updated</Option>
                </Select>
              </Stack>

              {error ? (
                <Alert color={/Sign in/.test(error) ? 'neutral' : 'danger'} data-testid="skill-market-error">
                  {error}
                </Alert>
              ) : (
                <>
                  {browsing && recommended.length > 0 && (
                    <Stack spacing={1} data-testid="skill-market-recommended">
                      <Typography level="title-sm">Recommended for you</Typography>
                      <Grid listings={recommended} onOpen={id => setSelected({ id })} />
                    </Stack>
                  )}
                  <Grid listings={listings} onOpen={id => setSelected({ id })} />
                  {!loading && listings.length === 0 && (
                    <Typography level="body-sm" textColor="text.tertiary" data-testid="skill-market-empty">
                      {browsing ? 'No skills have been published yet.' : 'No skills match these filters.'}
                    </Typography>
                  )}
                  {loading ? (
                    <CircularProgress size="sm" />
                  ) : (
                    hasMore && (
                      <Box>
                        <Button
                          variant="outlined"
                          color="neutral"
                          onClick={() => void load(filters, page + 1)}
                          data-testid="skill-market-more-btn"
                        >
                          Load more
                        </Button>
                      </Box>
                    )
                  )}
                </>
              )}
            </Stack>
          )}
        </Box>
      </Box>
    </Stack>
  );
}
