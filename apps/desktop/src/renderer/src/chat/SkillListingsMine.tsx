import { useCallback, useEffect, useState } from 'react';
import Alert from '@mui/joy/Alert';
import Button from '@mui/joy/Button';
import Chip from '@mui/joy/Chip';
import CircularProgress from '@mui/joy/CircularProgress';
import DialogActions from '@mui/joy/DialogActions';
import DialogContent from '@mui/joy/DialogContent';
import DialogTitle from '@mui/joy/DialogTitle';
import Modal from '@mui/joy/Modal';
import ModalDialog from '@mui/joy/ModalDialog';
import Sheet from '@mui/joy/Sheet';
import Stack from '@mui/joy/Stack';
import Typography from '@mui/joy/Typography';
import type { SkillMyListing } from '@shared/skillMarket';
import { ExternalLinkIcon } from './icons';
import { useSkillUpload } from './SkillUploadDialog';

/** The web's My listings chips (apps/client/app/routes/skills/market/mine.tsx). */
const STATUS: Record<string, { label: string; color: 'success' | 'warning' | 'danger' | 'neutral' }> = {
  approved: { label: 'Live', color: 'success' },
  in_review: { label: 'In review', color: 'warning' },
  rejected: { label: 'Not published', color: 'danger' },
  delisted: { label: 'Delisted', color: 'danger' },
  withdrawn: { label: 'Withdrawn', color: 'neutral' },
};

function ListingRow({
  listing,
  onNewVersion,
  onWithdraw,
  onMessage,
}: {
  listing: SkillMyListing;
  onNewVersion: () => void;
  onWithdraw: () => void;
  onMessage: (message: string) => void;
}) {
  const status = listing.hiddenByReports
    ? { label: 'Hidden (reported)', color: 'warning' as const }
    : (STATUS[listing.status] ?? { label: listing.status, color: 'neutral' as const });
  const open = listing.status !== 'withdrawn' && listing.status !== 'delisted';
  const latest = listing.latest;
  const flagged = latest && (latest.reviewStatus === 'rejected' || latest.riskTier === 'high');

  return (
    <Sheet variant="outlined" sx={{ borderRadius: 'md', p: 1.5 }} data-testid="skill-listing-row">
      <Stack spacing={0.75}>
        <Stack direction="row" spacing={1} alignItems="center" flexWrap="wrap" useFlexGap>
          <Typography level="title-sm">/{listing.name}</Typography>
          <Chip size="sm" variant="solid" color={status.color} data-testid="skill-listing-status">
            {status.label}
          </Chip>
          <Chip size="sm" variant="soft" color="neutral">
            {listing.visibility === 'organization' ? 'Org' : listing.visibility === 'unlisted' ? 'Unlisted' : 'Public'}
          </Chip>
          {listing.currentVersion ? (
            <Chip size="sm" variant="outlined">
              live: v{listing.currentVersion}
            </Chip>
          ) : null}
          {listing.pendingVersion ? (
            <Chip size="sm" variant="outlined" color="warning">
              in review: v{listing.pendingVersion}
            </Chip>
          ) : null}
          {listing.tags.map(tag => (
            <Chip key={tag} size="sm" variant="soft">
              #{tag}
            </Chip>
          ))}
        </Stack>
        {flagged && (
          <Typography level="body-sm" color="danger">
            v{latest.version}: {latest.reviewNote ? `Reviewer note: ${latest.reviewNote}` : `risk ${latest.riskTier}`}
          </Typography>
        )}
        {listing.delistedReason && (
          <Typography level="body-sm" color="danger">
            Moderator reason: {listing.delistedReason}
          </Typography>
        )}
        <Stack direction="row" spacing={1} flexWrap="wrap" useFlexGap>
          {open && (
            <Button size="sm" variant="outlined" onClick={onNewVersion} data-testid="skill-listing-new-version-btn">
              Submit new version from a local file...
            </Button>
          )}
          {open && listing.hasShareLink && (
            <Button
              size="sm"
              variant="plain"
              onClick={() =>
                void window.b4m.skillMarket
                  .copyShareLink(listing.id)
                  .then(result => onMessage(result.ok ? 'Share link copied.' : result.error))
              }
              data-testid="skill-listing-copy-link-btn"
            >
              Copy share link
            </Button>
          )}
          <Button
            size="sm"
            variant="plain"
            color="neutral"
            endDecorator={<ExternalLinkIcon />}
            onClick={() => void window.b4m.skillMarket.openOnWeb({ kind: 'listing', id: listing.id })}
            data-testid="skill-listing-web-btn"
          >
            Open on web
          </Button>
          {open && (
            <Button
              size="sm"
              variant="plain"
              color="danger"
              onClick={onWithdraw}
              data-testid="skill-listing-withdraw-btn"
            >
              Withdraw
            </Button>
          )}
        </Stack>
      </Stack>
    </Sheet>
  );
}

/** The user's market listings: status, versions, and the author's actions on each. */
export function SkillListingsMine() {
  const [listings, setListings] = useState<SkillMyListing[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [withdrawing, setWithdrawing] = useState<SkillMyListing | null>(null);

  const load = useCallback(async () => {
    const result = await window.b4m.skillMarket.mine();
    setLoading(false);
    setError(result.error ?? null);
    setListings(result.listings);
  }, []);
  const upload = useSkillUpload(() => void load());

  useEffect(() => {
    void load();
  }, [load]);

  const withdraw = async (listing: SkillMyListing) => {
    setWithdrawing(null);
    const result = await window.b4m.skillMarket.withdraw(listing.id);
    setMessage(result.ok ? `Withdrew /${listing.name}.` : result.error);
    await load();
  };

  if (loading) return <CircularProgress size="sm" />;
  if (error) {
    return (
      <Alert color={/Sign in/.test(error) ? 'neutral' : 'danger'} data-testid="skill-market-mine-error">
        {error}
      </Alert>
    );
  }
  return (
    <Stack spacing={1.25} data-testid="skill-market-mine">
      {message && (
        <Alert color="neutral" variant="soft" data-testid="skill-listing-message">
          {message}
        </Alert>
      )}
      {upload.error && (
        <Alert color="danger" data-testid="skill-upload-pick-error">
          {upload.error}
        </Alert>
      )}
      {listings.length === 0 ? (
        <Typography level="body-sm" textColor="text.tertiary">
          You haven&apos;t published any skills yet.
        </Typography>
      ) : (
        listings.map(listing => (
          <ListingRow
            key={listing.id}
            listing={listing}
            onNewVersion={() =>
              void upload.start(() => window.b4m.skillMarket.pickUploadSource(), { id: listing.id, name: listing.name })
            }
            onWithdraw={() => setWithdrawing(listing)}
            onMessage={text => {
              setMessage(text);
              void load();
            }}
          />
        ))
      )}
      {upload.dialog}
      <Modal open={withdrawing !== null} onClose={() => setWithdrawing(null)}>
        <ModalDialog role="alertdialog" data-testid="skill-listing-withdraw-confirm">
          <DialogTitle>Withdraw listing</DialogTitle>
          <DialogContent>
            Withdraw /{withdrawing?.name} from the market? People who imported it keep their copies.
          </DialogContent>
          <DialogActions>
            <Button
              color="danger"
              onClick={() => withdrawing && void withdraw(withdrawing)}
              data-testid="skill-listing-withdraw-confirm-btn"
            >
              Withdraw
            </Button>
            <Button variant="plain" color="neutral" onClick={() => setWithdrawing(null)}>
              Cancel
            </Button>
          </DialogActions>
        </ModalDialog>
      </Modal>
    </Stack>
  );
}
