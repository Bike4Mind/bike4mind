import { FC, useState } from 'react';
import {
  Alert,
  Box,
  Button,
  Card,
  Chip,
  CircularProgress,
  DialogContent,
  DialogTitle,
  Divider,
  FormControl,
  FormHelperText,
  FormLabel,
  Input,
  Modal,
  ModalClose,
  ModalDialog,
  Option,
  Select,
  Stack,
  Textarea,
  Typography,
} from '@mui/joy';
import ArrowBackIcon from '@mui/icons-material/ArrowBack';
import DownloadIcon from '@mui/icons-material/Download';
import FlagIcon from '@mui/icons-material/Flag';
import BlockIcon from '@mui/icons-material/Block';
import RestoreIcon from '@mui/icons-material/Restore';
import ContentCopyIcon from '@mui/icons-material/ContentCopy';
import CheckCircleIcon from '@mui/icons-material/CheckCircle';
import OpenInNewIcon from '@mui/icons-material/OpenInNew';
import VerifiedUserIcon from '@mui/icons-material/VerifiedUser';
import TerminalIcon from '@mui/icons-material/Terminal';
import { useNavigate } from '@tanstack/react-router';
import { toast } from 'sonner';
import type { SkillListingReportReason } from '@bike4mind/common';
import { getErrorMessage } from '@client/app/utils/error';
import { scrollbarStyles } from '@client/app/utils/scrollbarStyles';
import ClaudeCodeExportDialog from '@client/app/components/SkillsManagement/ClaudeCodeExportDialog';
import {
  conflictInfo,
  useImportListing,
  useListingDetail,
  useModerateListing,
  useRateListing,
  useReportListing,
  type ListingDetail as ListingDetailData,
} from '@client/app/hooks/data/skillMarket';
import MarketCard from './MarketCard';
import {
  BodyBlock,
  HonestSummaryPanel,
  MismatchAlert,
  StarInput,
  Stars,
  TierChip,
  VisibilityChip,
  formatCount,
} from './parts';

const REPORT_REASONS: Array<{ value: SkillListingReportReason; label: string }> = [
  { value: 'malicious', label: 'Malicious or unsafe behaviour' },
  { value: 'misleading', label: 'Does something other than it says' },
  { value: 'spam', label: 'Spam or low quality' },
  { value: 'abuse', label: 'Abusive or harmful content' },
  { value: 'copyright', label: 'Copied from someone else' },
  { value: 'other', label: 'Something else' },
];

const ImportCard: FC<{ data: ListingDetailData; token?: string }> = ({ data, token }) => {
  const navigate = useNavigate();
  const importListing = useImportListing();
  const [rename, setRename] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const { listing, myImport, viewer } = data;

  const run = async (name?: string) => {
    setError(null);
    try {
      const { skill } = await importListing.mutateAsync({ listingId: listing.id, token, ...(name ? { name } : {}) });
      setRename(null);
      toast.success(`Added /${skill.name} to your skills`, {
        action: { label: 'Open', onClick: () => void navigate({ to: '/skills/$id', params: { id: skill.id } }) },
      });
    } catch (e) {
      const conflict = conflictInfo(e);
      if (conflict?.code === 'name_taken') {
        setRename(conflict.suggestedName ?? `${listing.name}-2`);
        return;
      }
      setError(getErrorMessage(e));
    }
  };

  if (viewer.isAuthor) {
    return (
      <Alert color="neutral" variant="soft">
        This is your listing. Edit the source skill, then submit a new version from My listings.
      </Alert>
    );
  }

  return (
    <Stack spacing={1}>
      {myImport?.skill ? (
        <Alert
          color="success"
          variant="soft"
          startDecorator={<CheckCircleIcon />}
          data-testid="market-already-imported"
        >
          <Box sx={{ flex: 1 }}>
            <Typography level="title-sm">In your skills as /{myImport.skill.name}</Typography>
            <Typography level="body-xs">
              Imported v{myImport.version}
              {listing.currentVersion && listing.currentVersion > myImport.version
                ? ` - v${listing.currentVersion} is available`
                : ''}
            </Typography>
          </Box>
          <Button
            size="sm"
            variant="outlined"
            color="success"
            endDecorator={<OpenInNewIcon />}
            onClick={() => navigate({ to: '/skills/$id', params: { id: myImport.skill!.id } })}
          >
            {listing.currentVersion && listing.currentVersion > myImport.version ? 'Review update' : 'Open'}
          </Button>
        </Alert>
      ) : null}

      {viewer.canImport ? (
        <Button
          size="lg"
          startDecorator={<DownloadIcon />}
          loading={importListing.isPending && rename === null}
          onClick={() => void run()}
          data-testid="market-import-btn"
        >
          {myImport?.skill ? 'Import another copy' : 'Import to my skills'}
        </Button>
      ) : null}
      <Typography level="body-xs" textColor="text.tertiary">
        You get your own copy of the reviewed version. Updates are never applied without your OK.
      </Typography>
      {error ? <Alert color="danger">{error}</Alert> : null}

      {rename !== null ? (
        <Modal open onClose={() => setRename(null)}>
          <ModalDialog sx={{ width: 420, maxWidth: '95vw' }} data-testid="market-import-rename-dialog">
            <ModalClose />
            <DialogTitle>Choose a different name</DialogTitle>
            <DialogContent>
              <Typography level="body-sm" sx={{ mb: 1.5 }}>
                You already have a skill called /{listing.name}. Pick a name for the imported copy - it&apos;s the
                command you&apos;ll type in chat.
              </Typography>
              <FormControl>
                <FormLabel>Name</FormLabel>
                <Input
                  value={rename}
                  onChange={e => setRename(e.target.value.toLowerCase())}
                  startDecorator="/"
                  autoFocus
                  slotProps={{ input: { 'data-testid': 'market-import-rename-input' } }}
                />
                <FormHelperText>Lowercase letters, digits and hyphens.</FormHelperText>
              </FormControl>
              <Stack direction="row" justifyContent="flex-end" spacing={1} sx={{ mt: 2 }}>
                <Button variant="plain" color="neutral" onClick={() => setRename(null)}>
                  Cancel
                </Button>
                <Button
                  loading={importListing.isPending}
                  onClick={() => void run(rename)}
                  disabled={!rename.trim()}
                  data-testid="market-import-rename-confirm"
                >
                  Import
                </Button>
              </Stack>
            </DialogContent>
          </ModalDialog>
        </Modal>
      ) : null}
    </Stack>
  );
};

const RateCard: FC<{ data: ListingDetailData; token?: string }> = ({ data, token }) => {
  const rate = useRateListing();
  const [stars, setStars] = useState(data.myImport?.stars ?? 0);
  const [review, setReview] = useState(data.myImport?.review ?? '');
  const [error, setError] = useState<string | null>(null);

  if (!data.viewer.canRate) {
    return data.viewer.isAuthor ? null : (
      <Typography level="body-sm" textColor="text.tertiary">
        Import this skill to rate it.
      </Typography>
    );
  }

  const save = async () => {
    setError(null);
    try {
      await rate.mutateAsync({ listingId: data.listing.id, stars, review: review.trim() || undefined, token });
      toast.success('Thanks for rating!');
    } catch (e) {
      setError(getErrorMessage(e));
    }
  };

  return (
    <Stack spacing={1} data-testid="market-rate-card">
      <Typography level="title-sm">{data.myImport?.stars ? 'Your rating' : 'Rate this skill'}</Typography>
      <StarInput value={stars} onChange={setStars} />
      <Textarea
        minRows={2}
        maxRows={6}
        placeholder="What worked, what didn't? (optional, no links)"
        value={review}
        onChange={e => setReview(e.target.value.slice(0, 1000))}
        slotProps={{ textarea: { 'data-testid': 'market-rate-review' } }}
      />
      {error ? <Alert color="danger">{error}</Alert> : null}
      <Button
        size="sm"
        disabled={!stars}
        loading={rate.isPending}
        onClick={() => void save()}
        sx={{ alignSelf: 'flex-start' }}
        data-testid="market-rate-save"
      >
        {data.myImport?.stars ? 'Update rating' : 'Submit rating'}
      </Button>
    </Stack>
  );
};

const ReportDialog: FC<{ listingId: string; token?: string; onClose: () => void }> = ({
  listingId,
  token,
  onClose,
}) => {
  const report = useReportListing();
  const [reason, setReason] = useState<SkillListingReportReason | null>(null);
  const [details, setDetails] = useState('');
  const [error, setError] = useState<string | null>(null);
  const submit = async () => {
    if (!reason) return;
    setError(null);
    try {
      const res = await report.mutateAsync({ listingId, reason, details: details.trim() || undefined, token });
      toast.success(
        res.alreadyReported
          ? 'You already reported this skill - moderators have it.'
          : 'Report sent to moderators. Thank you.'
      );
      onClose();
    } catch (e) {
      setError(getErrorMessage(e));
    }
  };
  return (
    <Modal open onClose={onClose}>
      <ModalDialog sx={{ width: 460, maxWidth: '95vw' }} data-testid="market-report-dialog">
        <ModalClose />
        <DialogTitle>Report this skill</DialogTitle>
        <DialogContent>
          <Stack spacing={2}>
            <FormControl required>
              <FormLabel>What&apos;s wrong?</FormLabel>
              <Select
                placeholder="Choose a reason"
                value={reason}
                onChange={(_e, v) => setReason(v)}
                slotProps={{ button: { 'data-testid': 'market-report-reason' } }}
              >
                {REPORT_REASONS.map(r => (
                  <Option key={r.value} value={r.value}>
                    {r.label}
                  </Option>
                ))}
              </Select>
            </FormControl>
            <FormControl>
              <FormLabel>Details (optional)</FormLabel>
              <Textarea minRows={3} value={details} onChange={e => setDetails(e.target.value.slice(0, 2000))} />
            </FormControl>
            {error ? <Alert color="danger">{error}</Alert> : null}
            <Stack direction="row" justifyContent="flex-end" spacing={1}>
              <Button variant="plain" color="neutral" onClick={onClose}>
                Cancel
              </Button>
              <Button
                color="danger"
                disabled={!reason}
                loading={report.isPending}
                onClick={() => void submit()}
                data-testid="market-report-submit"
              >
                Send report
              </Button>
            </Stack>
          </Stack>
        </DialogContent>
      </ModalDialog>
    </Modal>
  );
};

/** Moderator takedown with a required reason (shared with the review queue). */
export const DelistDialog: FC<{ listingId: string; name: string; onClose: () => void }> = ({
  listingId,
  name,
  onClose,
}) => {
  const moderate = useModerateListing();
  const [reason, setReason] = useState('');
  const [error, setError] = useState<string | null>(null);
  const submit = async () => {
    setError(null);
    try {
      await moderate.mutateAsync({ listingId, action: 'delist', reason: reason.trim() });
      toast.success(`/${name} was delisted`);
      onClose();
    } catch (e) {
      setError(getErrorMessage(e));
    }
  };
  return (
    <Modal open onClose={onClose}>
      <ModalDialog sx={{ width: 460, maxWidth: '95vw' }} data-testid="market-delist-dialog">
        <ModalClose />
        <DialogTitle>Delist /{name}?</DialogTitle>
        <DialogContent>
          <Typography level="body-sm" sx={{ mb: 1.5 }}>
            It disappears from the market and can&apos;t be imported. Existing copies stay with their owners, marked
            &quot;delisted by moderators&quot;. The author is told the reason.
          </Typography>
          <Textarea
            minRows={3}
            placeholder="Reason (required)"
            value={reason}
            onChange={e => setReason(e.target.value)}
            slotProps={{ textarea: { 'data-testid': 'market-delist-reason' } }}
          />
          {error ? (
            <Alert color="danger" sx={{ mt: 1 }}>
              {error}
            </Alert>
          ) : null}
          <Stack direction="row" justifyContent="flex-end" spacing={1} sx={{ mt: 2 }}>
            <Button variant="plain" color="neutral" onClick={onClose}>
              Cancel
            </Button>
            <Button
              color="danger"
              disabled={!reason.trim()}
              loading={moderate.isPending}
              onClick={() => void submit()}
              data-testid="market-delist-confirm"
            >
              Delist
            </Button>
          </Stack>
        </DialogContent>
      </ModalDialog>
    </Modal>
  );
};

const NOT_LIVE: Record<string, string> = {
  in_review: 'Not live yet: waiting for the safety scan or a reviewer. Only you and reviewers can see this page.',
  rejected: 'Not live: the latest submission was not approved. Only you and reviewers can see this page.',
  delisted: 'Delisted by moderators. Only you and reviewers can see this page.',
  withdrawn: 'Withdrawn by the author.',
};

/** Listing page body, used by /skills/market/$listingId and the unlisted /skills/market/u/$token. */
const ListingDetail: FC<{ listingId?: string; token?: string }> = ({ listingId, token }) => {
  const navigate = useNavigate();
  const { data, isLoading, isError } = useListingDetail({ id: listingId, token });
  const [reportOpen, setReportOpen] = useState(false);
  const [delistOpen, setDelistOpen] = useState(false);
  const [claudeCodeOpen, setClaudeCodeOpen] = useState(false);
  const moderate = useModerateListing();

  if (isLoading) {
    return (
      <Stack alignItems="center" sx={{ py: 10 }}>
        <CircularProgress />
      </Stack>
    );
  }
  if (isError || !data) {
    return (
      <Stack
        alignItems="center"
        spacing={1.5}
        sx={{ py: 10, px: 2, textAlign: 'center' }}
        data-testid="market-listing-not-found"
      >
        <Typography level="title-lg">This skill isn&apos;t available</Typography>
        <Typography level="body-sm" textColor="text.tertiary">
          It may have been removed, or it&apos;s shared with a group you&apos;re not part of.
        </Typography>
        <Button variant="outlined" onClick={() => navigate({ to: '/skills/market' })}>
          Browse the market
        </Button>
      </Stack>
    );
  }

  const { listing, version, ratings, viewer, similar } = data;
  const live = listing.status === 'approved' && !listing.hiddenByReports;
  const shareUrl = listing.shareToken ? `${window.location.origin}/skills/market/u/${listing.shareToken}` : null;

  return (
    <Box sx={{ height: '100%', overflowY: 'auto', ...scrollbarStyles }} data-testid="market-listing-page">
      <Stack spacing={3} sx={{ p: { xs: 2, md: 3 }, maxWidth: 1100, mx: 'auto' }}>
        <Button
          variant="plain"
          size="sm"
          startDecorator={<ArrowBackIcon />}
          onClick={() => navigate({ to: '/skills/market' })}
          sx={{ alignSelf: 'flex-start' }}
        >
          Skill Market
        </Button>

        {!live ? (
          <Alert color="warning" variant="soft" data-testid="market-listing-not-live">
            {listing.hiddenByReports
              ? 'Hidden pending moderator review after multiple reports.'
              : (NOT_LIVE[listing.status] ?? '')}
            {listing.delistedReason ? ` Reason: ${listing.delistedReason}` : ''}
          </Alert>
        ) : null}

        <Stack direction={{ xs: 'column', sm: 'row' }} justifyContent="space-between" gap={2}>
          <Box sx={{ minWidth: 0 }}>
            <Typography
              level="h2"
              component="code"
              sx={{ fontFamily: 'code', wordBreak: 'break-all' }}
              data-testid="market-listing-name"
            >
              /{listing.name}
              {version?.snapshot.argumentHint ? (
                <Typography component="span" textColor="text.tertiary" sx={{ fontFamily: 'code' }}>
                  {' '}
                  {version.snapshot.argumentHint}
                </Typography>
              ) : null}
            </Typography>
            <Stack direction="row" spacing={1} alignItems="center" flexWrap="wrap" useFlexGap sx={{ mt: 1 }}>
              <Typography level="body-sm" textColor="text.secondary">
                by {listing.authorName || 'a Bike4Mind user'}
              </Typography>
              <VisibilityChip visibility={listing.visibility} />
              {version ? (
                <Chip size="sm" variant="outlined">
                  v{version.version}
                </Chip>
              ) : null}
              {listing.autoChecked ? (
                <Chip size="sm" variant="outlined" startDecorator={<VerifiedUserIcon />}>
                  Auto-checked
                </Chip>
              ) : live ? (
                <Chip size="sm" variant="soft" color="success" startDecorator={<VerifiedUserIcon />}>
                  Reviewed by a person
                </Chip>
              ) : null}
              {viewer.canReview || viewer.isAuthor ? <TierChip tier={listing.riskTier} /> : null}
            </Stack>
            <Stack direction="row" spacing={2} alignItems="center" sx={{ mt: 1 }}>
              <Stack direction="row" spacing={0.75} alignItems="center">
                <Stars value={listing.ratingAvg} size="md" />
                <Typography level="body-sm">
                  {listing.ratingCount
                    ? `${listing.ratingAvg.toFixed(1)} from ${listing.ratingCount}`
                    : 'No ratings yet'}
                </Typography>
              </Stack>
              <Typography level="body-sm" textColor="text.tertiary" startDecorator={<DownloadIcon fontSize="small" />}>
                {formatCount(listing.importCount)} imports
              </Typography>
            </Stack>
          </Box>
          <Stack direction="row" spacing={1} alignItems="flex-start" flexWrap="wrap" useFlexGap>
            {version?.snapshot ? (
              <Button
                variant="outlined"
                startDecorator={<TerminalIcon />}
                onClick={() => setClaudeCodeOpen(true)}
                data-testid="skill-claude-code-btn"
              >
                Use in Claude Code
              </Button>
            ) : null}
            {shareUrl && listing.visibility === 'unlisted' ? (
              <Button
                variant="outlined"
                color="neutral"
                startDecorator={<ContentCopyIcon />}
                onClick={() => void navigator.clipboard.writeText(shareUrl).then(() => toast.success('Link copied'))}
                data-testid="market-copy-link-btn"
              >
                Copy link
              </Button>
            ) : null}
            {live && !viewer.isAuthor ? (
              <Button
                variant="plain"
                color="neutral"
                startDecorator={<FlagIcon />}
                onClick={() => setReportOpen(true)}
                data-testid="market-report-btn"
              >
                Report
              </Button>
            ) : null}
            {viewer.canDelist && listing.status !== 'delisted' && listing.status !== 'withdrawn' ? (
              <Button
                variant="outlined"
                color="danger"
                startDecorator={<BlockIcon />}
                onClick={() => setDelistOpen(true)}
                data-testid="market-delist-btn"
              >
                Delist
              </Button>
            ) : null}
            {viewer.canRestore ? (
              <Button
                variant="outlined"
                color="success"
                startDecorator={<RestoreIcon />}
                loading={moderate.isPending}
                onClick={() =>
                  moderate
                    .mutateAsync({ listingId: listing.id, action: 'restore' })
                    .then(() => toast.success(`/${listing.name} was restored`))
                    .catch(e => toast.error(getErrorMessage(e)))
                }
                data-testid="market-restore-btn"
              >
                Restore
              </Button>
            ) : null}
          </Stack>
        </Stack>

        <Box sx={{ display: 'grid', gap: 3, gridTemplateColumns: { xs: '1fr', md: 'minmax(0, 1fr) 320px' } }}>
          <Stack spacing={2.5} sx={{ minWidth: 0 }}>
            <Box>
              <Typography level="title-sm" sx={{ mb: 0.5 }}>
                Author&apos;s description
              </Typography>
              <Typography level="body-md">{listing.description}</Typography>
            </Box>
            {version?.honestSummary?.descriptionMatches === false ? (
              <MismatchAlert note={version.honestSummary.mismatchNote} />
            ) : null}
            <HonestSummaryPanel summary={version?.honestSummary} tools={version?.snapshot.allowedTools} />

            {version ? (
              <Box>
                <Typography level="title-sm" sx={{ mb: 1 }}>
                  Instructions
                </Typography>
                <BodyBlock body={version.snapshot.body} testId="market-listing-body" />
              </Box>
            ) : null}

            {listing.tags.length ? (
              <Stack direction="row" spacing={0.5} flexWrap="wrap" useFlexGap>
                {listing.tags.map(t => (
                  <Chip key={t} size="sm" variant="soft">
                    #{t}
                  </Chip>
                ))}
              </Stack>
            ) : null}

            <Divider />
            <Box component="section" aria-labelledby="market-ratings-title">
              <Typography id="market-ratings-title" level="title-md" sx={{ mb: 1 }}>
                Reviews
              </Typography>
              {ratings.length === 0 ? (
                <Typography level="body-sm" textColor="text.tertiary">
                  No reviews yet.
                </Typography>
              ) : (
                <Stack spacing={1.5} data-testid="market-ratings">
                  {ratings.map((r, i) => (
                    <Box key={i}>
                      <Stack direction="row" spacing={1} alignItems="center">
                        <Stars value={r.stars} />
                        <Typography level="body-xs" textColor="text.tertiary">
                          {r.mine ? 'You' : 'Verified importer'} - {new Date(r.ratedAt).toLocaleDateString()}
                        </Typography>
                      </Stack>
                      {r.review ? (
                        <Typography level="body-sm" sx={{ mt: 0.5 }}>
                          {r.review}
                        </Typography>
                      ) : null}
                    </Box>
                  ))}
                </Stack>
              )}
            </Box>
          </Stack>

          <Stack spacing={2}>
            <Card variant="outlined" sx={{ gap: 1.5, position: { md: 'sticky' }, top: { md: 0 } }}>
              {live ? <ImportCard data={data} token={token} /> : null}
              {live ? <Divider /> : null}
              {live ? <RateCard data={data} token={token} /> : null}
              {!live && viewer.isAuthor ? (
                <Button variant="outlined" onClick={() => navigate({ to: '/skills/market/mine' })}>
                  Go to My listings
                </Button>
              ) : null}
            </Card>
            {version?.snapshot.allowedTools?.length ? (
              <Card variant="soft" sx={{ gap: 1 }}>
                <Typography level="title-sm">Tools this skill may use</Typography>
                <Typography level="body-xs" textColor="text.tertiary">
                  Only tools you already have; a skill can never grant itself more.
                </Typography>
                <Stack direction="row" spacing={0.5} flexWrap="wrap" useFlexGap>
                  {version.snapshot.allowedTools.map(t => (
                    <Chip key={t} size="sm" variant="outlined">
                      {t}
                    </Chip>
                  ))}
                </Stack>
              </Card>
            ) : null}
          </Stack>
        </Box>

        {similar.length ? (
          <Box component="section" aria-labelledby="market-similar-title" data-testid="market-similar">
            <Typography id="market-similar-title" level="title-lg" sx={{ mb: 1.5 }}>
              Similar skills
            </Typography>
            <Box
              sx={{ display: 'grid', gap: 2, gridTemplateColumns: 'repeat(auto-fill, minmax(min(100%, 280px), 1fr))' }}
            >
              {similar.map(l => (
                <MarketCard key={l.id} listing={l} />
              ))}
            </Box>
          </Box>
        ) : null}
      </Stack>

      {reportOpen ? <ReportDialog listingId={listing.id} token={token} onClose={() => setReportOpen(false)} /> : null}
      {delistOpen ? (
        <DelistDialog listingId={listing.id} name={listing.name} onClose={() => setDelistOpen(false)} />
      ) : null}
      {claudeCodeOpen && version?.snapshot ? (
        // The share token is left out of the source path so an unlisted link never ends up in a file.
        <ClaudeCodeExportDialog
          onClose={() => setClaudeCodeOpen(false)}
          skill={version.snapshot}
          sourcePath={`/skills/market/${encodeURIComponent(listing.id)}`}
          version={version.version}
          thirdParty
          showImportHint={!data.myImport?.skill}
        />
      ) : null}
    </Box>
  );
};

export default ListingDetail;
