import { FC, useState } from 'react';
import {
  Alert,
  Box,
  Button,
  Card,
  Checkbox,
  Chip,
  CircularProgress,
  Divider,
  Stack,
  Tab,
  TabList,
  TabPanel,
  Tabs,
  Textarea,
  Typography,
} from '@mui/joy';
import ArrowBackIcon from '@mui/icons-material/ArrowBack';
import CheckIcon from '@mui/icons-material/Check';
import CloseIcon from '@mui/icons-material/Close';
import BlockIcon from '@mui/icons-material/Block';
import RestoreIcon from '@mui/icons-material/Restore';
import FactCheckIcon from '@mui/icons-material/FactCheck';
import { useNavigate } from '@tanstack/react-router';
import { toast } from 'sonner';
import { useDocumentTitle } from '@client/app/hooks/useDocumentTitle';
import { getErrorMessage } from '@client/app/utils/error';
import { scrollbarStyles } from '@client/app/utils/scrollbarStyles';
import {
  useMarketMe,
  useModerateListing,
  useReviewQueue,
  useReviewVersion,
  type ReviewQueueVersionItem,
} from '@client/app/hooks/data/skillMarket';
import { DelistDialog } from '@client/app/components/SkillMarket/ListingDetail';
import {
  BodyBlock,
  BodyDiff,
  FindingsList,
  HonestSummaryPanel,
  MismatchAlert,
  TierChip,
  VisibilityChip,
} from '@client/app/components/SkillMarket/parts';

const Empty: FC<{ text: string }> = ({ text }) => (
  <Card variant="soft" sx={{ p: 4, textAlign: 'center', alignItems: 'center' }}>
    <FactCheckIcon sx={{ fontSize: 36, color: 'text.tertiary' }} />
    <Typography level="body-md">{text}</Typography>
  </Card>
);

const Loading = () => (
  <Stack alignItems="center" sx={{ py: 6 }}>
    <CircularProgress />
  </Stack>
);

/** One held (or sampled) version: everything a reviewer needs, then the decision controls. */
const VersionReviewCard: FC<{ item: ReviewQueueVersionItem; mode: 'pending' | 'audit' }> = ({ item, mode }) => {
  const review = useReviewVersion();
  const [note, setNote] = useState('');
  const [ackHighRisk, setAckHighRisk] = useState(false);
  const [ackMismatch, setAckMismatch] = useState(false);
  const [showDiff, setShowDiff] = useState(Boolean(item.previous));
  const [delistOpen, setDelistOpen] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const { version, listing, previous } = item;
  const isPublic = listing.visibility === 'public';
  const needsHighAck = isPublic && version.riskTier === 'high';
  const needsMismatchAck = isPublic && version.honestSummary?.descriptionMatches === false;

  const act = async (body: Parameters<ReturnType<typeof useReviewVersion>['mutateAsync']>[0], done: string) => {
    setError(null);
    try {
      await review.mutateAsync(body);
      toast.success(done);
    } catch (e) {
      setError(getErrorMessage(e));
    }
  };

  return (
    <Card variant="outlined" sx={{ gap: 1.5 }} data-testid={`market-review-item-${listing.name}`}>
      <Stack direction="row" justifyContent="space-between" alignItems="flex-start" gap={1} flexWrap="wrap">
        <Box>
          <Stack direction="row" spacing={1} alignItems="center" flexWrap="wrap" useFlexGap>
            <Typography level="title-md" component="code" sx={{ fontFamily: 'code' }}>
              /{version.snapshot.name}
            </Typography>
            <Chip size="sm" variant="outlined">
              v{version.version}
            </Chip>
            <VisibilityChip visibility={listing.visibility} />
            <TierChip tier={version.riskTier} />
          </Stack>
          <Typography level="body-xs" textColor="text.tertiary">
            by {listing.authorName || 'unknown'} - submitted {new Date(version.createdAt).toLocaleString()}
          </Typography>
        </Box>
        <Button
          size="sm"
          variant="plain"
          color="danger"
          startDecorator={<BlockIcon />}
          onClick={() => setDelistOpen(true)}
        >
          Delist listing
        </Button>
      </Stack>

      <Box sx={{ display: 'grid', gap: 2, gridTemplateColumns: { xs: '1fr', lg: '1fr 1fr' } }}>
        <Stack spacing={1.5}>
          <Box>
            <Typography level="title-sm">Author&apos;s description</Typography>
            <Typography level="body-sm">{version.snapshot.description}</Typography>
          </Box>
          {version.honestSummary?.descriptionMatches === false ? (
            <MismatchAlert note={version.honestSummary.mismatchNote} />
          ) : null}
          <HonestSummaryPanel summary={version.honestSummary} tools={version.snapshot.allowedTools} />
          <Box>
            <Typography level="title-sm">Scan findings</Typography>
            <FindingsList findings={version.scanFindings} emptyText="No findings." />
          </Box>
        </Stack>
        <Stack spacing={1}>
          <Stack direction="row" justifyContent="space-between" alignItems="center">
            <Typography level="title-sm">
              {showDiff && previous ? `Changes since v${previous.version}` : 'Instructions'}
            </Typography>
            {previous ? (
              <Button size="sm" variant="plain" onClick={() => setShowDiff(!showDiff)}>
                {showDiff ? 'Show full body' : `Diff vs v${previous.version}`}
              </Button>
            ) : (
              <Chip size="sm" variant="soft">
                First version
              </Chip>
            )}
          </Stack>
          {showDiff && previous ? (
            <BodyDiff before={previous.snapshot.body} after={version.snapshot.body} />
          ) : (
            <BodyBlock body={version.snapshot.body} />
          )}
        </Stack>
      </Box>

      <Divider />
      {!item.canDecide ? (
        <Alert color="neutral" variant="soft">
          {mode === 'audit'
            ? 'Someone else has to audit this one (it is your own listing).'
            : "You can't decide this one (you can't review your own Public listing)."}
        </Alert>
      ) : mode === 'audit' ? (
        <Stack direction="row" spacing={1} justifyContent="flex-end">
          <Button
            startDecorator={<CheckIcon />}
            loading={review.isPending}
            onClick={() => void act({ versionId: version.id, action: 'audit' }, 'Marked as audited')}
            data-testid="market-audit-btn"
          >
            Looks fine - mark audited
          </Button>
        </Stack>
      ) : (
        <Stack spacing={1.5}>
          {needsHighAck ? (
            <Checkbox
              checked={ackHighRisk}
              onChange={e => setAckHighRisk(e.target.checked)}
              label="I checked the high-risk tools and they are needed for what this skill does"
              slotProps={{ input: { 'data-testid': 'market-ack-high-risk' } }}
            />
          ) : null}
          {needsMismatchAck ? (
            <Checkbox
              checked={ackMismatch}
              onChange={e => setAckMismatch(e.target.checked)}
              label="I read the honest summary; the description mismatch is acceptable (it is shown to users)"
              slotProps={{ input: { 'data-testid': 'market-ack-mismatch' } }}
            />
          ) : null}
          <Textarea
            minRows={2}
            placeholder="Note to the author (required to reject)"
            value={note}
            onChange={e => setNote(e.target.value.slice(0, 2000))}
            slotProps={{ textarea: { 'data-testid': 'market-review-note' } }}
          />
          {error ? <Alert color="danger">{error}</Alert> : null}
          <Stack direction="row" spacing={1} justifyContent="flex-end">
            <Button
              variant="outlined"
              color="danger"
              startDecorator={<CloseIcon />}
              disabled={!note.trim() || review.isPending}
              onClick={() =>
                void act(
                  { versionId: version.id, action: 'reject', note: note.trim() },
                  'Rejected; the author was notified'
                )
              }
              data-testid="market-reject-btn"
            >
              Reject
            </Button>
            <Button
              color="success"
              startDecorator={<CheckIcon />}
              disabled={(needsHighAck && !ackHighRisk) || (needsMismatchAck && !ackMismatch) || review.isPending}
              onClick={() =>
                void act(
                  {
                    versionId: version.id,
                    action: 'approve',
                    ackHighRisk,
                    ackMismatch,
                    ...(note.trim() ? { note: note.trim() } : {}),
                  },
                  'Approved and published'
                )
              }
              data-testid="market-approve-btn"
            >
              Approve
            </Button>
          </Stack>
        </Stack>
      )}
      {delistOpen ? (
        <DelistDialog listingId={listing.id} name={listing.name} onClose={() => setDelistOpen(false)} />
      ) : null}
    </Card>
  );
};

const VersionQueue: FC<{ mode: 'pending' | 'audit' }> = ({ mode }) => {
  const { data = [], isLoading } = useReviewQueue(mode);
  if (isLoading) return <Loading />;
  if (!data.length)
    return (
      <Empty text={mode === 'pending' ? 'Nothing is waiting for review.' : 'No sampled listings left to audit.'} />
    );
  return (
    <Stack spacing={2}>
      {mode === 'audit' ? (
        <Typography level="body-sm" textColor="text.tertiary">
          A random sample of listings that went live automatically, plus every listing an org admin approved for
          themselves. Spot-check them and delist anything that slipped through.
        </Typography>
      ) : null}
      {data.map(item => (
        <VersionReviewCard key={item.version.id} item={item} mode={mode} />
      ))}
    </Stack>
  );
};

const ReportsQueue: FC = () => {
  const { data = [], isLoading } = useReviewQueue('reports');
  const moderate = useModerateListing();
  const navigate = useNavigate();
  const [delist, setDelist] = useState<{ id: string; name: string } | null>(null);
  if (isLoading) return <Loading />;
  if (!data.length) return <Empty text="No open reports." />;
  return (
    <Stack spacing={2}>
      {data.map(item => (
        <Card
          key={item.listing.id}
          variant="outlined"
          sx={{ gap: 1 }}
          data-testid={`market-report-item-${item.listing.name}`}
        >
          <Stack direction="row" justifyContent="space-between" alignItems="center" flexWrap="wrap" gap={1}>
            <Stack direction="row" spacing={1} alignItems="center">
              <Typography level="title-md" component="code" sx={{ fontFamily: 'code' }}>
                /{item.listing.name}
              </Typography>
              <Chip size="sm" color="danger" variant="soft">
                {item.count} report{item.count > 1 ? 's' : ''}
              </Chip>
              {item.listing.hiddenByReports ? (
                <Chip size="sm" color="warning" variant="soft">
                  Auto-hidden
                </Chip>
              ) : null}
            </Stack>
            <Stack direction="row" spacing={1}>
              <Button
                size="sm"
                variant="outlined"
                startDecorator={<RestoreIcon />}
                loading={moderate.isPending}
                onClick={() =>
                  void moderate
                    .mutateAsync({ listingId: item.listing.id, action: 'restore' })
                    .then(() => toast.success('Reports dismissed; listing restored'))
                    .catch(e => toast.error(getErrorMessage(e)))
                }
              >
                Dismiss and restore
              </Button>
              <Button
                size="sm"
                color="danger"
                startDecorator={<BlockIcon />}
                onClick={() => setDelist({ id: item.listing.id, name: item.listing.name })}
              >
                Delist
              </Button>
            </Stack>
          </Stack>
          <Typography level="body-sm">{item.listing.description}</Typography>
          <Stack component="ul" spacing={0.5} sx={{ m: 0, pl: 2.5 }}>
            {item.reports.map((r, i) => (
              <Typography key={i} component="li" level="body-sm">
                <b>{r.reason}</b>
                {r.details ? ` - ${r.details}` : ''}{' '}
                <Typography level="body-xs" textColor="text.tertiary">
                  ({new Date(r.createdAt).toLocaleDateString()})
                </Typography>
              </Typography>
            ))}
          </Stack>
          <Button
            size="sm"
            variant="plain"
            sx={{ alignSelf: 'flex-start' }}
            onClick={() => navigate({ to: '/skills/market/$listingId', params: { listingId: item.listing.id } })}
          >
            Open listing
          </Button>
        </Card>
      ))}
      {delist ? <DelistDialog listingId={delist.id} name={delist.name} onClose={() => setDelist(null)} /> : null}
    </Stack>
  );
};

const LegacyQueue: FC = () => {
  const { data = [], isLoading } = useReviewQueue('legacy');
  if (isLoading) return <Loading />;
  if (!data.length) return <Empty text="No legacy global skills." />;
  return (
    <Stack spacing={2}>
      <Alert variant="soft" color="neutral">
        Skills made global before the market existed. They were not scanned and keep working; this list is read-only so
        you can audit them. Owners can still turn global access off.
      </Alert>
      {data.map(s => (
        <Card key={s.id} variant="outlined" sx={{ gap: 1 }} data-testid={`market-legacy-${s.name}`}>
          <Stack direction="row" spacing={1} alignItems="center" flexWrap="wrap" useFlexGap>
            <Typography level="title-md" component="code" sx={{ fontFamily: 'code' }}>
              /{s.name}
            </Typography>
            {s.isGlobalWrite ? (
              <Chip size="sm" color="danger" variant="soft">
                Anyone can edit
              </Chip>
            ) : null}
            {s.allowedTools.map(t => (
              <Chip key={t} size="sm" variant="outlined">
                {t}
              </Chip>
            ))}
          </Stack>
          <Typography level="body-sm">{s.description}</Typography>
          <BodyBlock body={s.body} />
        </Card>
      ))}
    </Stack>
  );
};

const ReviewQueuePage: FC = () => {
  useDocumentTitle('Skill review queue');
  const navigate = useNavigate();
  const { data: me, isLoading } = useMarketMe();
  const [tab, setTab] = useState<string>('pending');

  if (isLoading) return <Loading />;
  if (!me?.isReviewer) {
    return (
      <Stack alignItems="center" spacing={1} sx={{ py: 10 }}>
        <Typography level="title-lg">Reviewers only</Typography>
        <Button variant="outlined" onClick={() => navigate({ to: '/skills/market' })}>
          Back to the market
        </Button>
      </Stack>
    );
  }

  return (
    <Box sx={{ height: '100%', overflowY: 'auto', ...scrollbarStyles }} data-testid="market-review-page">
      <Stack spacing={2} sx={{ p: { xs: 2, md: 3 }, maxWidth: 1280, mx: 'auto' }}>
        <Button
          variant="plain"
          size="sm"
          startDecorator={<ArrowBackIcon />}
          onClick={() => navigate({ to: '/skills/market' })}
          sx={{ alignSelf: 'flex-start' }}
        >
          Skill Market
        </Button>
        <Box>
          <Typography level="h2">Review queue</Typography>
          <Typography level="body-sm" textColor="text.tertiary">
            {me.isAdmin
              ? 'Public and unlisted listings, plus every organization.'
              : 'Organization listings for the organizations you manage.'}
          </Typography>
        </Box>
        <Tabs value={tab} onChange={(_e, v) => setTab(String(v))} sx={{ bgcolor: 'transparent' }}>
          <TabList>
            <Tab value="pending" data-testid="market-review-tab-pending">
              Waiting for review
            </Tab>
            <Tab value="audit" data-testid="market-review-tab-audit">
              Audit sample
            </Tab>
            <Tab value="reports" data-testid="market-review-tab-reports">
              Reports
            </Tab>
            {me.isAdmin ? (
              <Tab value="legacy" data-testid="market-review-tab-legacy">
                Legacy global
              </Tab>
            ) : null}
          </TabList>
          <TabPanel value="pending" sx={{ px: 0 }}>
            <VersionQueue mode="pending" />
          </TabPanel>
          <TabPanel value="audit" sx={{ px: 0 }}>
            <VersionQueue mode="audit" />
          </TabPanel>
          <TabPanel value="reports" sx={{ px: 0 }}>
            <ReportsQueue />
          </TabPanel>
          {me.isAdmin ? (
            <TabPanel value="legacy" sx={{ px: 0 }}>
              <LegacyQueue />
            </TabPanel>
          ) : null}
        </Tabs>
      </Stack>
    </Box>
  );
};

export default ReviewQueuePage;
