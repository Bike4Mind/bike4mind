import { FC, useEffect, useState } from 'react';
import {
  Box,
  Button,
  Card,
  Chip,
  ChipDelete,
  IconButton,
  Input,
  Option,
  Select,
  Skeleton,
  Stack,
  ToggleButtonGroup,
  Typography,
} from '@mui/joy';
import SearchIcon from '@mui/icons-material/Search';
import CloseIcon from '@mui/icons-material/Close';
import StorefrontIcon from '@mui/icons-material/Storefront';
import PublishIcon from '@mui/icons-material/Publish';
import InventoryIcon from '@mui/icons-material/Inventory2';
import GavelIcon from '@mui/icons-material/Gavel';
import ArrowBackIcon from '@mui/icons-material/ArrowBack';
import { useNavigate } from '@tanstack/react-router';
import { useDocumentTitle } from '@client/app/hooks/useDocumentTitle';
import { useGetSkills } from '@client/app/hooks/data/skills';
import { useUser } from '@client/app/contexts/UserContext';
import {
  useMarketListings,
  useMarketMe,
  useRecommendedListings,
  type MarketFilters,
} from '@client/app/hooks/data/skillMarket';
import MarketCard from '@client/app/components/SkillMarket/MarketCard';
import PublishDialog from '@client/app/components/SkillMarket/PublishDialog';
import { scrollbarStyles } from '@client/app/utils/scrollbarStyles';

const GRID_SX = {
  display: 'grid',
  gap: 2,
  gridTemplateColumns: 'repeat(auto-fill, minmax(min(100%, 280px), 1fr))',
};

const DEFAULT_FILTERS: MarketFilters = { q: '', scope: '', tools: '', minRating: 0, sort: 'top', tags: [] };

const CardSkeletons: FC<{ count: number }> = ({ count }) => (
  <Box sx={GRID_SX}>
    {Array.from({ length: count }).map((_, i) => (
      <Card key={i} variant="outlined" sx={{ gap: 1 }}>
        <Skeleton variant="text" level="title-md" width="60%" />
        <Skeleton variant="text" level="body-xs" width="35%" />
        <Skeleton variant="text" level="body-sm" />
        <Skeleton variant="text" level="body-sm" width="80%" />
        <Skeleton variant="rectangular" height={20} width="50%" />
      </Card>
    ))}
  </Box>
);

const SkillMarketPage: FC = () => {
  useDocumentTitle('Skill Market');
  const navigate = useNavigate();
  const { currentUser } = useUser();
  const { data: me } = useMarketMe();
  const { data: mySkills = [] } = useGetSkills();
  const [publishOpen, setPublishOpen] = useState(false);

  const [draft, setDraft] = useState('');
  const [filters, setFilters] = useState<MarketFilters>(DEFAULT_FILTERS);
  const set = <K extends keyof MarketFilters>(key: K, value: MarketFilters[K]) =>
    setFilters(f => ({ ...f, [key]: value }));

  // Debounce typing so each keystroke doesn't fire a search.
  useEffect(() => {
    const t = setTimeout(
      () =>
        setFilters(f =>
          f.q === draft
            ? f
            : { ...f, q: draft, sort: draft.trim() ? 'relevance' : f.sort === 'relevance' ? 'top' : f.sort }
        ),
      300
    );
    return () => clearTimeout(t);
  }, [draft]);

  const browsing = !filters.q.trim() && !filters.tags.length && !filters.scope && !filters.tools && !filters.minRating;
  const listings = useMarketListings(filters);
  const recommended = useRecommendedListings(browsing);
  const items = listings.data?.pages.flatMap(p => p.data) ?? [];
  const filtered = !browsing || filters.sort !== 'top';
  const ownSkills = mySkills.filter(s => s.userId === currentUser?.id);

  const addTag = (tag: string) => !filters.tags.includes(tag) && set('tags', [...filters.tags, tag].slice(0, 5));

  return (
    <Box sx={{ height: '100%', overflowY: 'auto', ...scrollbarStyles }} data-testid="market-page">
      <Stack spacing={3} sx={{ p: { xs: 2, md: 3 }, maxWidth: 1280, mx: 'auto' }}>
        <Button
          variant="plain"
          size="sm"
          startDecorator={<ArrowBackIcon />}
          onClick={() => navigate({ to: '/skills' })}
          sx={{ alignSelf: 'flex-start' }}
        >
          My skills
        </Button>

        <Stack
          direction={{ xs: 'column', sm: 'row' }}
          justifyContent="space-between"
          alignItems={{ sm: 'flex-end' }}
          gap={2}
        >
          <Box>
            <Stack direction="row" spacing={1} alignItems="center">
              <StorefrontIcon color="primary" />
              <Typography level="h2">Skill Market</Typography>
            </Stack>
            <Typography level="body-sm" textColor="text.tertiary" sx={{ mt: 0.5, maxWidth: 640 }}>
              Discover skills shared by the community. Every listing passes an automated safety scan, and each one shows
              an AI-written summary of what it actually does.
            </Typography>
          </Box>
          <Stack direction="row" spacing={1} flexWrap="wrap" useFlexGap>
            {me?.isReviewer ? (
              <Button
                variant="outlined"
                color="neutral"
                startDecorator={<GavelIcon />}
                onClick={() => navigate({ to: '/skills/market/review' })}
                data-testid="market-review-queue-link"
              >
                Review queue
              </Button>
            ) : null}
            <Button
              variant="outlined"
              color="neutral"
              startDecorator={<InventoryIcon />}
              onClick={() => navigate({ to: '/skills/market/mine' })}
              data-testid="market-my-listings-link"
            >
              My listings
            </Button>
            <Button
              startDecorator={<PublishIcon />}
              onClick={() => setPublishOpen(true)}
              data-testid="market-publish-btn"
            >
              Publish a skill
            </Button>
          </Stack>
        </Stack>

        <Card variant="soft" sx={{ p: 1.5, gap: 1.5 }}>
          <Input
            size="lg"
            startDecorator={<SearchIcon />}
            endDecorator={
              draft ? (
                <IconButton size="sm" variant="plain" aria-label="Clear search" onClick={() => setDraft('')}>
                  <CloseIcon />
                </IconButton>
              ) : null
            }
            placeholder="Search by name, description, tag or what the skill does"
            value={draft}
            onChange={e => setDraft(e.target.value)}
            slotProps={{ input: { 'data-testid': 'market-search-input', 'aria-label': 'Search skills' } }}
          />
          <Stack direction="row" spacing={1} flexWrap="wrap" useFlexGap alignItems="center">
            <Select
              size="sm"
              value={filters.scope}
              onChange={(_e, v) => set('scope', v ?? '')}
              sx={{ minWidth: 150 }}
              slotProps={{ button: { 'data-testid': 'market-filter-scope', 'aria-label': 'Visibility' } }}
            >
              <Option value="">Everything I can see</Option>
              <Option value="public">Public</Option>
              <Option value="org">My organizations</Option>
            </Select>
            <ToggleButtonGroup
              size="sm"
              value={filters.tools || 'any'}
              onChange={(_e, v) => v && set('tools', v === 'any' ? '' : (v as MarketFilters['tools']))}
              aria-label="Tool usage"
            >
              <Button value="any">Any</Button>
              <Button value="without" data-testid="market-filter-no-tools">
                No tools
              </Button>
              <Button value="with">Uses tools</Button>
            </ToggleButtonGroup>
            <Select
              size="sm"
              value={filters.minRating}
              onChange={(_e, v) => set('minRating', v ?? 0)}
              sx={{ minWidth: 120 }}
              slotProps={{ button: { 'aria-label': 'Minimum rating' } }}
            >
              <Option value={0}>Any rating</Option>
              <Option value={3}>3+ stars</Option>
              <Option value={4}>4+ stars</Option>
            </Select>
            <Box sx={{ flex: 1 }} />
            <Select
              size="sm"
              value={filters.sort}
              onChange={(_e, v) => v && set('sort', v)}
              sx={{ minWidth: 160 }}
              slotProps={{ button: { 'data-testid': 'market-sort', 'aria-label': 'Sort by' } }}
            >
              {filters.q.trim() ? <Option value="relevance">Best match</Option> : null}
              <Option value="top">Top rated</Option>
              <Option value="imports">Most imported</Option>
              <Option value="new">Newest</Option>
              <Option value="updated">Recently updated</Option>
            </Select>
          </Stack>
          {filters.tags.length ? (
            <Stack direction="row" spacing={0.5} flexWrap="wrap" useFlexGap alignItems="center">
              <Typography level="body-xs" textColor="text.tertiary">
                Tags:
              </Typography>
              {filters.tags.map(t => (
                <Chip
                  key={t}
                  size="sm"
                  variant="solid"
                  color="primary"
                  endDecorator={
                    <ChipDelete
                      onDelete={() =>
                        set(
                          'tags',
                          filters.tags.filter(x => x !== t)
                        )
                      }
                    />
                  }
                >
                  #{t}
                </Chip>
              ))}
            </Stack>
          ) : null}
        </Card>

        {browsing && (recommended.isLoading || (recommended.data?.length ?? 0) > 0) ? (
          <Box component="section" aria-labelledby="market-recommended-title" data-testid="market-recommended">
            <Typography id="market-recommended-title" level="title-lg" sx={{ mb: 1.5 }}>
              Recommended for you
            </Typography>
            {recommended.isLoading ? (
              <CardSkeletons count={3} />
            ) : (
              <Box
                sx={{
                  display: 'grid',
                  gridAutoFlow: 'column',
                  gridAutoColumns: 'minmax(280px, 320px)',
                  gap: 2,
                  overflowX: 'auto',
                  pb: 1,
                  scrollSnapType: 'x mandatory',
                  '& > *': { scrollSnapAlign: 'start' },
                  ...scrollbarStyles,
                }}
              >
                {recommended.data!.map(l => (
                  <MarketCard key={l.id} listing={l} />
                ))}
              </Box>
            )}
          </Box>
        ) : null}

        <Box component="section" aria-labelledby="market-results-title">
          <Stack direction="row" justifyContent="space-between" alignItems="baseline" sx={{ mb: 1.5 }}>
            <Typography id="market-results-title" level="title-lg">
              {filtered ? 'Results' : 'Top rated'}
            </Typography>
            {filtered ? (
              <Button
                size="sm"
                variant="plain"
                onClick={() => {
                  setDraft('');
                  setFilters(DEFAULT_FILTERS);
                }}
              >
                Reset filters
              </Button>
            ) : null}
          </Stack>

          {listings.isLoading ? (
            <CardSkeletons count={6} />
          ) : listings.isError ? (
            <Card variant="soft" color="danger" sx={{ p: 3, textAlign: 'center' }}>
              <Typography level="title-md">Couldn&apos;t load the market</Typography>
              <Button
                sx={{ mt: 1, alignSelf: 'center' }}
                variant="outlined"
                color="danger"
                onClick={() => void listings.refetch()}
              >
                Try again
              </Button>
            </Card>
          ) : items.length === 0 ? (
            <Card
              variant="soft"
              sx={{ p: 4, textAlign: 'center', alignItems: 'center' }}
              data-testid="market-empty-state"
            >
              <StorefrontIcon sx={{ fontSize: 40, color: 'text.tertiary' }} />
              <Typography level="title-md">{filtered ? 'No skills match' : 'The market is empty so far'}</Typography>
              <Typography level="body-sm" textColor="text.tertiary">
                {filtered ? 'Try different words or loosen the filters.' : 'Be the first: publish one of your skills.'}
              </Typography>
              {!filtered ? (
                <Button sx={{ mt: 1 }} startDecorator={<PublishIcon />} onClick={() => setPublishOpen(true)}>
                  Publish a skill
                </Button>
              ) : null}
            </Card>
          ) : (
            <>
              <Box sx={GRID_SX} data-testid="market-results">
                {items.map(l => (
                  <Box
                    key={l.id}
                    onClickCapture={e => {
                      // A click on a tag chip filters instead of opening the card.
                      const tag = (e.target as HTMLElement)
                        .closest('[data-market-tag]')
                        ?.getAttribute('data-market-tag');
                      if (tag) {
                        e.stopPropagation();
                        addTag(tag);
                      }
                    }}
                  >
                    <MarketCard listing={l} />
                  </Box>
                ))}
              </Box>
              {listings.hasNextPage ? (
                <Stack alignItems="center" sx={{ mt: 2 }}>
                  <Button
                    variant="outlined"
                    loading={listings.isFetchingNextPage}
                    onClick={() => void listings.fetchNextPage()}
                  >
                    Load more
                  </Button>
                </Stack>
              ) : null}
            </>
          )}
        </Box>
      </Stack>

      {publishOpen ? <PublishDialog onClose={() => setPublishOpen(false)} ownSkills={ownSkills} /> : null}
    </Box>
  );
};

export default SkillMarketPage;
