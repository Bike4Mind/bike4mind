import { FC, useState } from 'react';
import {
  Accordion,
  AccordionDetails,
  AccordionGroup,
  AccordionSummary,
  Alert,
  Box,
  Button,
  Card,
  Chip,
  CircularProgress,
  Stack,
  Typography,
} from '@mui/joy';
import ArrowBackIcon from '@mui/icons-material/ArrowBack';
import PublishIcon from '@mui/icons-material/Publish';
import ContentCopyIcon from '@mui/icons-material/ContentCopy';
import UploadIcon from '@mui/icons-material/Upload';
import DownloadIcon from '@mui/icons-material/Download';
import { useNavigate } from '@tanstack/react-router';
import { toast } from 'sonner';
import type { ISkillListingVersion, SkillListingStatus } from '@bike4mind/common';
import { useDocumentTitle } from '@client/app/hooks/useDocumentTitle';
import { useGetSkills } from '@client/app/hooks/data/skills';
import { useUser } from '@client/app/contexts/UserContext';
import {
  useMyListings,
  useRescanVersion,
  useSubmitNewVersion,
  useWithdrawListing,
  type MyListing,
} from '@client/app/hooks/data/skillMarket';
import { getErrorMessage } from '@client/app/utils/error';
import { scrollbarStyles } from '@client/app/utils/scrollbarStyles';
import PublishDialog from '@client/app/components/SkillMarket/PublishDialog';
import ScanResult, { versionOutcome } from '@client/app/components/SkillMarket/ScanResult';
import { Stars, VisibilityChip, formatCount } from '@client/app/components/SkillMarket/parts';

const STATUS: Record<SkillListingStatus, { label: string; color: 'success' | 'warning' | 'danger' | 'neutral' }> = {
  approved: { label: 'Live', color: 'success' },
  in_review: { label: 'In review', color: 'warning' },
  rejected: { label: 'Not published', color: 'danger' },
  delisted: { label: 'Delisted', color: 'danger' },
  withdrawn: { label: 'Withdrawn', color: 'neutral' },
};

const VersionRow: FC<{ version: ISkillListingVersion; listing: MyListing }> = ({ version, listing }) => {
  const rescan = useRescanVersion();
  const outcome = versionOutcome(version, listing.visibility);
  return (
    <Accordion>
      <AccordionSummary>
        <Stack direction="row" spacing={1} alignItems="center" sx={{ minWidth: 0 }}>
          <Chip size="sm" variant="outlined">
            v{version.version}
          </Chip>
          <Chip
            size="sm"
            variant="soft"
            color={outcome.color === 'neutral' ? 'neutral' : outcome.color}
            data-testid={`market-mine-version-${version.version}`}
          >
            {outcome.title}
          </Chip>
          <Typography level="body-xs" textColor="text.tertiary" noWrap>
            {new Date(version.createdAt).toLocaleString()}
          </Typography>
        </Stack>
      </AccordionSummary>
      <AccordionDetails>
        <ScanResult
          version={version}
          visibility={listing.visibility}
          rescanning={rescan.isPending}
          onRescan={() => void rescan.mutateAsync(version.id).catch(e => toast.error(getErrorMessage(e)))}
        />
        {version.reviewNote && version.reviewStatus !== 'rejected' ? (
          <Typography level="body-sm" sx={{ mt: 1 }}>
            Reviewer note: {version.reviewNote}
          </Typography>
        ) : null}
      </AccordionDetails>
    </Accordion>
  );
};

const ListingRow: FC<{ listing: MyListing }> = ({ listing }) => {
  const navigate = useNavigate();
  const submit = useSubmitNewVersion();
  const withdraw = useWithdrawListing();
  const status = listing.hiddenByReports
    ? { label: 'Hidden (reported)', color: 'warning' as const }
    : STATUS[listing.status];
  const open = listing.status !== 'withdrawn' && listing.status !== 'delisted';
  const waiting = listing.versions.some(v => v.reviewStatus === 'pending');

  const resubmit = async () => {
    try {
      const { version } = await submit.mutateAsync({ listingId: listing.id });
      const outcome = versionOutcome(version, listing.visibility);
      if (outcome.color === 'danger') toast.error(outcome.title);
      else toast.success(`v${version.version}: ${outcome.title}`);
    } catch (e) {
      toast.error(getErrorMessage(e));
    }
  };

  const doWithdraw = async () => {
    if (!window.confirm(`Withdraw /${listing.name} from the market? People who imported it keep their copies.`)) return;
    try {
      await withdraw.mutateAsync(listing.id);
      toast.success('Listing withdrawn');
    } catch (e) {
      toast.error(getErrorMessage(e));
    }
  };

  return (
    <Card variant="outlined" sx={{ gap: 1.5 }} data-testid={`market-mine-${listing.name}`}>
      <Stack direction={{ xs: 'column', sm: 'row' }} justifyContent="space-between" gap={1.5}>
        <Box sx={{ minWidth: 0 }}>
          <Stack direction="row" spacing={1} alignItems="center" flexWrap="wrap" useFlexGap>
            <Typography level="title-md" component="code" sx={{ fontFamily: 'code' }}>
              /{listing.name}
            </Typography>
            <Chip size="sm" color={status.color} variant="solid">
              {status.label}
            </Chip>
            <VisibilityChip visibility={listing.visibility} />
            {listing.currentVersion ? (
              <Chip size="sm" variant="outlined">
                live: v{listing.currentVersion}
              </Chip>
            ) : null}
          </Stack>
          <Stack direction="row" spacing={2} alignItems="center" sx={{ mt: 0.75 }}>
            <Stack direction="row" spacing={0.5} alignItems="center">
              <Stars value={listing.ratingAvg} />
              <Typography level="body-xs" textColor="text.tertiary">
                {listing.ratingCount ? `${listing.ratingAvg.toFixed(1)} (${listing.ratingCount})` : 'No ratings'}
              </Typography>
            </Stack>
            <Typography
              level="body-xs"
              textColor="text.tertiary"
              startDecorator={<DownloadIcon sx={{ fontSize: 14 }} />}
            >
              {formatCount(listing.importCount)} imports
            </Typography>
          </Stack>
          {listing.delistedReason ? (
            <Typography level="body-sm" color="danger" sx={{ mt: 0.5 }}>
              Moderator reason: {listing.delistedReason}
            </Typography>
          ) : null}
        </Box>
        <Stack direction="row" spacing={1} flexWrap="wrap" useFlexGap alignItems="flex-start">
          {listing.status === 'approved' ? (
            <Button
              size="sm"
              variant="plain"
              onClick={() => navigate({ to: '/skills/market/$listingId', params: { listingId: listing.id } })}
            >
              View
            </Button>
          ) : null}
          {listing.visibility === 'unlisted' && listing.shareToken ? (
            <Button
              size="sm"
              variant="plain"
              color="neutral"
              startDecorator={<ContentCopyIcon />}
              onClick={() =>
                void navigator.clipboard
                  .writeText(`${window.location.origin}/skills/market/u/${listing.shareToken}`)
                  .then(() => toast.success('Link copied'))
              }
            >
              Copy link
            </Button>
          ) : null}
          {open ? (
            <Button
              size="sm"
              variant="outlined"
              startDecorator={<UploadIcon />}
              loading={submit.isPending}
              onClick={() => void resubmit()}
              data-testid={`market-mine-resubmit-${listing.name}`}
            >
              Submit new version
            </Button>
          ) : null}
          {open ? (
            <Button
              size="sm"
              variant="plain"
              color="danger"
              loading={withdraw.isPending}
              onClick={() => void doWithdraw()}
            >
              Withdraw
            </Button>
          ) : null}
        </Stack>
      </Stack>
      {open ? (
        <Typography level="body-xs" textColor="text.tertiary">
          {waiting
            ? 'A version is waiting for review; the live version stays available meanwhile. Submitting again replaces the waiting one.'
            : 'Edit the skill in My skills, then submit a new version. Its content is scanned again before going live.'}
        </Typography>
      ) : null}
      {listing.versions.length ? (
        <AccordionGroup size="sm" variant="plain">
          {listing.versions.map(v => (
            <VersionRow key={v.id} version={v} listing={listing} />
          ))}
        </AccordionGroup>
      ) : null}
    </Card>
  );
};

const MyListingsPage: FC = () => {
  useDocumentTitle('My listings');
  const navigate = useNavigate();
  const { currentUser } = useUser();
  const { data: listings = [], isLoading, isError } = useMyListings();
  const { data: skills = [] } = useGetSkills();
  const [publishOpen, setPublishOpen] = useState(false);

  return (
    <Box sx={{ height: '100%', overflowY: 'auto', ...scrollbarStyles }} data-testid="market-mine-page">
      <Stack spacing={3} sx={{ p: { xs: 2, md: 3 }, maxWidth: 960, mx: 'auto' }}>
        <Button
          variant="plain"
          size="sm"
          startDecorator={<ArrowBackIcon />}
          onClick={() => navigate({ to: '/skills/market' })}
          sx={{ alignSelf: 'flex-start' }}
        >
          Skill Market
        </Button>
        <Stack direction="row" justifyContent="space-between" alignItems="flex-end" gap={2} flexWrap="wrap">
          <Box>
            <Typography level="h2">My listings</Typography>
            <Typography level="body-sm" textColor="text.tertiary">
              Status, scan results and reviewer notes for every skill you&apos;ve published.
            </Typography>
          </Box>
          <Button startDecorator={<PublishIcon />} onClick={() => setPublishOpen(true)}>
            Publish a skill
          </Button>
        </Stack>

        {isLoading ? (
          <Stack alignItems="center" sx={{ py: 6 }}>
            <CircularProgress />
          </Stack>
        ) : isError ? (
          <Alert color="danger">Couldn&apos;t load your listings.</Alert>
        ) : listings.length === 0 ? (
          <Card variant="soft" sx={{ p: 4, textAlign: 'center', alignItems: 'center' }}>
            <Typography level="title-md">You haven&apos;t published anything yet</Typography>
            <Typography level="body-sm" textColor="text.tertiary">
              Share a skill with your organization, a link, or everyone.
            </Typography>
            <Button sx={{ mt: 1 }} startDecorator={<PublishIcon />} onClick={() => setPublishOpen(true)}>
              Publish a skill
            </Button>
          </Card>
        ) : (
          <Stack spacing={2}>
            {listings.map(l => (
              <ListingRow key={l.id} listing={l} />
            ))}
          </Stack>
        )}
      </Stack>
      {publishOpen ? (
        <PublishDialog
          onClose={() => setPublishOpen(false)}
          ownSkills={skills.filter(s => s.userId === currentUser?.id)}
        />
      ) : null}
    </Box>
  );
};

export default MyListingsPage;
