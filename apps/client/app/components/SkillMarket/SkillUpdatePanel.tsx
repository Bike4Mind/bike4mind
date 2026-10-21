import { FC, useState } from 'react';
import { Alert, Box, Button, Checkbox, Stack, Typography } from '@mui/joy';
import SystemUpdateAltIcon from '@mui/icons-material/SystemUpdateAlt';
import BlockIcon from '@mui/icons-material/Block';
import LinkOffIcon from '@mui/icons-material/LinkOff';
import StorefrontIcon from '@mui/icons-material/Storefront';
import { useNavigate } from '@tanstack/react-router';
import { toast } from 'sonner';
import type { ISkillWithSharing } from '@client/app/hooks/data/skills';
import { conflictInfo, useImportListing, useListingDetail } from '@client/app/hooks/data/skillMarket';
import { getErrorMessage } from '@client/app/utils/error';
import { BodyDiff, HonestSummaryPanel, MismatchAlert } from './parts';

/**
 * Market provenance for an imported skill on its detail page: an update offer (with a diff and an
 * overwrite warning when the copy was edited locally), or a delisted / withdrawn warning.
 */
const SkillUpdatePanel: FC<{ skill: ISkillWithSharing }> = ({ skill }) => {
  const navigate = useNavigate();
  const status = skill.marketStatus;
  const listingId = skill.importedFrom?.listingId;
  const stale = status?.state === 'stale';
  const { data } = useListingDetail({ id: stale ? listingId : undefined });
  const importListing = useImportListing();
  const [showDiff, setShowDiff] = useState(false);
  const [confirmOverwrite, setConfirmOverwrite] = useState(false);
  const [error, setError] = useState<string | null>(null);

  if (!status || !listingId) return null;

  if (status.state === 'delisted') {
    return (
      <Alert color="danger" variant="soft" startDecorator={<BlockIcon />} data-testid="skill-market-delisted">
        <Box>
          <Typography level="title-sm">Delisted by moderators</Typography>
          <Typography level="body-sm">
            Moderators removed this skill from the Skill Market. Your copy still works - read its instructions before
            you keep using it.
          </Typography>
        </Box>
      </Alert>
    );
  }
  if (status.state === 'removed') {
    return (
      <Alert color="neutral" variant="soft" startDecorator={<LinkOffIcon />} data-testid="skill-market-removed">
        No longer available on the Skill Market. Your copy is unaffected.
      </Alert>
    );
  }
  if (!stale) {
    return (
      <Alert
        color="neutral"
        variant="plain"
        startDecorator={<StorefrontIcon />}
        sx={{ p: 0 }}
        endDecorator={
          <Button
            size="sm"
            variant="plain"
            onClick={() => navigate({ to: '/skills/market/$listingId', params: { listingId } })}
          >
            View listing
          </Button>
        }
      >
        <Typography level="body-sm" textColor="text.tertiary">
          Imported from the Skill Market (v{status.importedVersion}){status.locallyModified ? ', edited by you' : ''}.
        </Typography>
      </Alert>
    );
  }

  const latest = data?.version;
  // Tools, description and argument hint change what the copy does as much as the body does.
  const fieldChanges = latest
    ? [
        {
          label: 'Tools',
          before: (skill.allowedTools ?? []).join(', '),
          after: (latest.snapshot.allowedTools ?? []).join(', '),
        },
        { label: 'Description', before: skill.description ?? '', after: latest.snapshot.description },
        { label: 'Argument hint', before: skill.argumentHint ?? '', after: latest.snapshot.argumentHint ?? '' },
      ].filter(c => c.before !== c.after)
    : [];
  const update = async (asNewCopy: boolean) => {
    // The server's version_changed guard only fires when it is sent a version id.
    if (!latest) return;
    setError(null);
    try {
      const { skill: result } = await importListing.mutateAsync(
        asNewCopy
          ? { listingId, name: `${skill.name}-v${status.latestVersion}`, expectedVersionId: latest.id }
          : { listingId, targetSkillId: skill.id, overwrite: confirmOverwrite, expectedVersionId: latest.id }
      );
      toast.success(
        asNewCopy ? `Saved v${status.latestVersion} as /${result.name}` : `Updated to v${status.latestVersion}`
      );
      if (asNewCopy) void navigate({ to: '/skills/$id', params: { id: result.id } });
    } catch (e) {
      const conflict = conflictInfo(e);
      setError(
        conflict?.code === 'name_taken'
          ? `You already have /${skill.name}-v${status.latestVersion}. Rename or delete it first.`
          : conflict?.code === 'version_changed'
            ? 'A newer version was just approved. Review the changes again before updating.'
            : getErrorMessage(e)
      );
    }
  };

  return (
    <Alert
      color="primary"
      variant="soft"
      startDecorator={<SystemUpdateAltIcon />}
      sx={{ alignItems: 'flex-start' }}
      data-testid="skill-market-update-panel"
    >
      <Stack spacing={1.5} sx={{ flex: 1, minWidth: 0 }}>
        <Box>
          <Typography level="title-sm">
            Update available (v{status.importedVersion} {'->'} v{status.latestVersion})
          </Typography>
          <Typography level="body-sm">
            The author published a new version that passed the safety checks. Nothing changes until you update.
          </Typography>
        </Box>

        {showDiff && latest ? (
          <Stack spacing={1.5}>
            {latest.honestSummary?.descriptionMatches === false ? (
              <MismatchAlert note={latest.honestSummary.mismatchNote} />
            ) : null}
            <HonestSummaryPanel summary={latest.honestSummary} tools={latest.snapshot.allowedTools} />
            <Typography level="title-sm">
              Changes to the instructions (your copy {'->'} v{latest.version})
            </Typography>
            <BodyDiff before={skill.body} after={latest.snapshot.body} testId="skill-market-update-diff" />
            {fieldChanges.length > 0 ? (
              <Stack spacing={0.5} data-testid="skill-market-update-field-changes">
                {fieldChanges.map(c => (
                  <Typography key={c.label} level="body-sm">
                    <b>{c.label}:</b> {c.before || '(none)'} {'->'} {c.after || '(none)'}
                  </Typography>
                ))}
              </Stack>
            ) : null}
          </Stack>
        ) : null}

        {status.locallyModified ? (
          <Checkbox
            color="warning"
            checked={confirmOverwrite}
            onChange={e => setConfirmOverwrite(e.target.checked)}
            label="I edited this copy - overwrite my changes"
            slotProps={{ input: { 'data-testid': 'skill-market-confirm-overwrite' } }}
          />
        ) : null}
        {error ? (
          <Typography color="danger" level="body-sm">
            {error}
          </Typography>
        ) : null}

        <Stack direction="row" spacing={1} flexWrap="wrap" useFlexGap>
          <Button
            size="sm"
            variant="outlined"
            onClick={() => setShowDiff(!showDiff)}
            disabled={!latest}
            data-testid="skill-market-show-changes"
          >
            {showDiff ? 'Hide changes' : 'See what changed'}
          </Button>
          <Button
            size="sm"
            loading={importListing.isPending}
            disabled={!latest || (status.locallyModified && !confirmOverwrite)}
            onClick={() => void update(false)}
            data-testid="skill-market-update-btn"
          >
            Update
          </Button>
          {status.locallyModified ? (
            <Button
              size="sm"
              variant="plain"
              loading={importListing.isPending}
              disabled={!latest}
              onClick={() => void update(true)}
              data-testid="skill-market-update-new-copy-btn"
            >
              Keep mine, save update as a new copy
            </Button>
          ) : null}
        </Stack>
      </Stack>
    </Alert>
  );
};

export default SkillUpdatePanel;
