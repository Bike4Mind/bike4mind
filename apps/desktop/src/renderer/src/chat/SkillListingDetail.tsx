import { useCallback, useEffect, useState } from 'react';
import Alert from '@mui/joy/Alert';
import Box from '@mui/joy/Box';
import Button from '@mui/joy/Button';
import Chip from '@mui/joy/Chip';
import CircularProgress from '@mui/joy/CircularProgress';
import DialogActions from '@mui/joy/DialogActions';
import DialogContent from '@mui/joy/DialogContent';
import DialogTitle from '@mui/joy/DialogTitle';
import Input from '@mui/joy/Input';
import Modal from '@mui/joy/Modal';
import ModalDialog from '@mui/joy/ModalDialog';
import Sheet from '@mui/joy/Sheet';
import Stack from '@mui/joy/Stack';
import Typography from '@mui/joy/Typography';
import type {
  SkillMarketDetail,
  SkillMarketImportRequest,
  SkillMarketListingRef,
  SkillMarketUpdate,
} from '@shared/skillMarket';
import { DiffView } from './DiffView';
import { ArrowLeftIcon, ExternalLinkIcon } from './icons';

const RISK_LABEL = { clean: 'No risks found', review: 'Worth a look', high: 'High risk' } as const;
const RISK_COLOR = { clean: 'success', review: 'warning', high: 'danger' } as const;

/**
 * One listing: what the safety scan says it does, the tools it asks for, and its body, read-only,
 * so the user sees what they import before they import it. Imports and updates go through main;
 * a conflict (name taken, local edits, a newer version) is answered here, in-app.
 */
export function SkillListingDetail({ listingRef, onBack }: { listingRef: SkillMarketListingRef; onBack: () => void }) {
  const [detail, setDetail] = useState<SkillMarketDetail | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<{ color: 'success' | 'warning' | 'danger'; text: string } | null>(null);
  const [rename, setRename] = useState<string | null>(null);
  const [confirmOverwrite, setConfirmOverwrite] = useState<SkillMarketImportRequest | null>(null);

  const load = useCallback(async () => {
    const result = await window.b4m.skillMarket.listing(listingRef);
    setDetail(result.detail ?? null);
    setError(result.error ?? null);
  }, [listingRef]);

  useEffect(() => {
    void load();
  }, [load]);

  const run = async (request: SkillMarketImportRequest) => {
    setBusy(true);
    setNotice(null);
    const result = await window.b4m.skillMarket.importListing(request);
    setBusy(false);
    if (result.ok) {
      setRename(null);
      setNotice(
        result.shadowedByLocal
          ? {
              color: 'warning',
              text: `Imported as /${result.skill.name}, but a local skill named ${result.skill.name} takes precedence and runs instead.`,
            }
          : { color: 'success', text: `${request.targetSkillId ? 'Updated' : 'Imported as'} /${result.skill.name}.` }
      );
      await load();
      return;
    }
    if (result.code === 'name_taken') {
      setRename(result.suggestedName ?? '');
      setNotice({ color: 'warning', text: result.error });
    } else if (result.code === 'local_changes') {
      setConfirmOverwrite(request);
    } else if (result.code === 'version_changed') {
      setNotice({ color: 'warning', text: 'A newer version was approved since this one was shown. Review it below.' });
      await load();
    } else {
      setNotice({ color: 'danger', text: result.error });
    }
  };

  const applyUpdate = (update: SkillMarketUpdate) => {
    const request: SkillMarketImportRequest = {
      listingId: detail?.listing.id ?? '',
      ...(listingRef.token ? { token: listingRef.token } : {}),
      targetSkillId: update.skillId,
      expectedVersionId: update.versionId,
    };
    // Known up front, so the user is asked before the request rather than after a refusal.
    if (update.locallyModified) setConfirmOverwrite(request);
    else void run(request);
  };

  const header = (
    <Stack direction="row" spacing={1} alignItems="center">
      <Button
        size="sm"
        variant="plain"
        color="neutral"
        startDecorator={<ArrowLeftIcon />}
        onClick={onBack}
        data-testid="skill-market-back-btn"
      >
        Back
      </Button>
      <Box sx={{ flex: 1 }} />
      {detail && (
        <Button
          size="sm"
          variant="plain"
          color="neutral"
          endDecorator={<ExternalLinkIcon />}
          onClick={() => void window.b4m.skillMarket.openOnWeb({ kind: 'listing', id: detail.listing.id })}
          data-testid="skill-listing-web-btn"
        >
          Rate, report or share on web
        </Button>
      )}
    </Stack>
  );

  if (!detail) {
    return (
      <Stack spacing={2} data-testid="skill-listing-detail">
        {header}
        {error ? (
          <Alert color="danger" data-testid="skill-listing-error">
            {error}
          </Alert>
        ) : (
          <CircularProgress size="sm" />
        )}
      </Stack>
    );
  }

  const { listing, version, myImport, update } = detail;
  const tools = version?.snapshot.allowedTools ?? [];
  const summary = version?.honestSummary;
  const tier = version?.riskTier ?? listing.riskTier;

  return (
    <Stack spacing={2} data-testid="skill-listing-detail">
      {header}
      <Stack spacing={0.5}>
        <Stack direction="row" spacing={1} alignItems="center" flexWrap="wrap" useFlexGap>
          <Typography level="h4">/{listing.name}</Typography>
          {version && (
            <Chip size="sm" variant="soft" color="neutral">
              v{version.version}
            </Chip>
          )}
          {tier && (
            <Chip size="sm" variant="soft" color={RISK_COLOR[tier]} data-testid="skill-listing-risk">
              {RISK_LABEL[tier]}
            </Chip>
          )}
        </Stack>
        <Typography level="body-sm" textColor="text.secondary">
          {listing.description}
        </Typography>
        <Typography level="body-xs" textColor="text.tertiary">
          {listing.authorName ? `by ${listing.authorName} - ` : ''}
          {listing.importCount} imports -{' '}
          {listing.ratingCount ? `${listing.ratingAvg.toFixed(1)} stars` : 'not rated yet'}
        </Typography>
      </Stack>

      {notice && (
        <Alert color={notice.color} data-testid="skill-listing-notice">
          {notice.text}
        </Alert>
      )}

      {update && (
        <Sheet variant="outlined" sx={{ borderRadius: 'md', p: 1.5 }} data-testid="skill-update-offer">
          <Stack spacing={1}>
            <Typography level="title-sm">
              Update available: v{update.fromVersion ?? '?'} to v{update.toVersion}
            </Typography>
            {update.locallyModified && (
              <Typography level="body-xs" color="warning">
                You edited your copy since importing it. Updating replaces those edits.
              </Typography>
            )}
            {(update.toolsAdded.length > 0 || update.toolsRemoved.length > 0) && (
              <Typography level="body-xs" data-testid="skill-update-tools">
                Requested tools:{' '}
                {[...update.toolsAdded.map(tool => `+${tool}`), ...update.toolsRemoved.map(tool => `-${tool}`)].join(
                  ', '
                )}
              </Typography>
            )}
            <DiffView diff={update.diff} />
            <Box>
              <Button size="sm" loading={busy} onClick={() => applyUpdate(update)} data-testid="skill-update-apply-btn">
                Apply update
              </Button>
            </Box>
          </Stack>
        </Sheet>
      )}

      {detail.canImport && !myImport?.skill && (
        <Stack direction="row" spacing={1} alignItems="center">
          {rename === null ? (
            <Button
              loading={busy}
              onClick={() =>
                void run({ listingId: listing.id, ...(listingRef.token ? { token: listingRef.token } : {}) })
              }
              data-testid="skill-listing-import-btn"
            >
              Import
            </Button>
          ) : (
            <>
              <Input
                size="sm"
                value={rename}
                onChange={event => setRename(event.target.value)}
                slotProps={{ input: { 'aria-label': 'New skill name', 'data-testid': 'skill-listing-rename-input' } }}
              />
              <Button
                size="sm"
                loading={busy}
                disabled={!rename.trim()}
                onClick={() =>
                  void run({
                    listingId: listing.id,
                    ...(listingRef.token ? { token: listingRef.token } : {}),
                    name: rename.trim(),
                  })
                }
                data-testid="skill-listing-rename-btn"
              >
                Import as /{rename.trim() || '...'}
              </Button>
            </>
          )}
        </Stack>
      )}
      {myImport?.skill && !update && (
        <Typography level="body-sm" data-testid="skill-listing-imported">
          In your skills as /{myImport.skill.name}.
        </Typography>
      )}

      {summary && (
        <Sheet variant="soft" sx={{ borderRadius: 'md', p: 1.5 }} data-testid="skill-listing-summary">
          <Stack spacing={0.75}>
            <Typography level="title-sm">What the safety check found</Typography>
            <Typography level="body-sm">{summary.whatItDoes}</Typography>
            {summary.dataItTouches && <Typography level="body-xs">Data it touches: {summary.dataItTouches}</Typography>}
            {!summary.descriptionMatches && (
              <Typography level="body-xs" color="warning">
                The description does not match what the skill does
                {summary.mismatchNote ? `: ${summary.mismatchNote}` : '.'}
              </Typography>
            )}
            {summary.riskNotes.map(note => (
              <Typography key={note} level="body-xs" color="warning">
                {note}
              </Typography>
            ))}
          </Stack>
        </Sheet>
      )}

      <Stack spacing={0.5} data-testid="skill-listing-tools">
        <Typography level="title-sm">Requested tools (not enforced)</Typography>
        <Typography level="body-xs" textColor="text.tertiary">
          The skill asks to use only these. It is guidance to the model, not a limit.
        </Typography>
        <Stack direction="row" spacing={0.5} flexWrap="wrap" useFlexGap>
          {tools.length === 0 ? (
            <Typography level="body-sm">None</Typography>
          ) : (
            tools.map(tool => (
              <Chip key={tool} size="sm" variant="outlined">
                {tool}
              </Chip>
            ))
          )}
        </Stack>
      </Stack>

      {version && (
        <Stack spacing={0.5}>
          <Typography level="title-sm">Skill body</Typography>
          <Sheet
            variant="outlined"
            component="pre"
            sx={{ borderRadius: 'md', p: 1.5, m: 0, fontSize: 'xs', whiteSpace: 'pre-wrap', overflowX: 'auto' }}
            data-testid="skill-listing-body"
          >
            {version.snapshot.body}
          </Sheet>
        </Stack>
      )}

      <Modal open={!!confirmOverwrite} onClose={() => setConfirmOverwrite(null)}>
        <ModalDialog role="alertdialog" data-testid="skill-overwrite-dialog">
          <DialogTitle>Replace your edits?</DialogTitle>
          <DialogContent>
            You changed your copy of /{listing.name} since importing it. Updating replaces it with the new version.
          </DialogContent>
          <DialogActions>
            <Button
              color="danger"
              onClick={() => {
                const request = confirmOverwrite;
                setConfirmOverwrite(null);
                if (request) void run({ ...request, overwrite: true });
              }}
              data-testid="skill-overwrite-confirm-btn"
            >
              Replace my edits
            </Button>
            <Button variant="plain" color="neutral" onClick={() => setConfirmOverwrite(null)}>
              Cancel
            </Button>
          </DialogActions>
        </ModalDialog>
      </Modal>
    </Stack>
  );
}
