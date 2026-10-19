import { FC, KeyboardEvent, ReactElement, useMemo, useState } from 'react';
import {
  Alert,
  Box,
  Button,
  Card,
  Chip,
  ChipDelete,
  CircularProgress,
  DialogContent,
  DialogTitle,
  FormControl,
  FormHelperText,
  FormLabel,
  Input,
  Modal,
  ModalClose,
  ModalDialog,
  Option,
  Radio,
  RadioGroup,
  Select,
  Stack,
  Typography,
} from '@mui/joy';
import PublicIcon from '@mui/icons-material/Public';
import GroupsIcon from '@mui/icons-material/Groups';
import LinkIcon from '@mui/icons-material/Link';
import ShieldIcon from '@mui/icons-material/Shield';
import { useNavigate } from '@tanstack/react-router';
import type { ISkill, SkillListingVisibility } from '@bike4mind/common';
import { getErrorMessage } from '@client/app/utils/error';
import { useMarketMe, usePublishSkill, useRescanVersion, type SubmitResult } from '@client/app/hooks/data/skillMarket';
import ScanResult from './ScanResult';

const TAG_PATTERN = /^[a-z0-9][a-z0-9-]{0,23}$/;
const MAX_TAGS = 5;

const VISIBILITY_OPTIONS: Array<{ value: SkillListingVisibility; title: string; body: string; icon: ReactElement }> = [
  {
    value: 'public',
    title: 'Public',
    body: 'Anyone on Bike4Mind can find and import it. Held for a reviewer if the scan flags anything.',
    icon: <PublicIcon />,
  },
  {
    value: 'organization',
    title: 'Organization',
    body: 'Only members of the organization you choose can see it.',
    icon: <GroupsIcon />,
  },
  {
    value: 'unlisted',
    title: 'Unlisted link',
    body: 'Hidden from browse and search. Anyone signed in with the link can import it.',
    icon: <LinkIcon />,
  },
];

interface PublishDialogProps {
  onClose: () => void;
  /** Preselected skill (from its detail page); otherwise the user picks one of their own. */
  skill?: ISkill;
  /** The user's own skills, for the picker when `skill` is not given. */
  ownSkills?: ISkill[];
}

/**
 * Publish a skill to the market: choose visibility (and org) and tags, submit, then show the scan
 * verdict inline - live, waiting for review, or what to fix.
 */
const PublishDialog: FC<PublishDialogProps> = ({ onClose, skill, ownSkills = [] }) => {
  const navigate = useNavigate();
  const { data: me } = useMarketMe();
  const publish = usePublishSkill();
  const rescan = useRescanVersion();

  const publishable = useMemo(() => ownSkills.filter(s => !s.importedFrom), [ownSkills]);
  const [skillId, setSkillId] = useState(skill?.id ?? '');
  const [visibility, setVisibility] = useState<SkillListingVisibility>('public');
  const [organizationId, setOrganizationId] = useState('');
  const [tags, setTags] = useState<string[]>([]);
  const [tagDraft, setTagDraft] = useState('');
  const [tagError, setTagError] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<SubmitResult | null>(null);

  const orgs = me?.organizations ?? [];
  const canSubmit =
    Boolean(skillId) && (visibility !== 'organization' || Boolean(organizationId)) && !publish.isPending;

  const addTag = () => {
    const tag = tagDraft.trim().toLowerCase().replace(/^#/, '');
    if (!tag) return;
    if (!TAG_PATTERN.test(tag)) return setTagError('Use 1-24 lowercase letters, digits or hyphens');
    if (tags.length >= MAX_TAGS) return setTagError(`Up to ${MAX_TAGS} tags`);
    if (!tags.includes(tag)) setTags([...tags, tag]);
    setTagDraft('');
    setTagError(null);
  };

  const onTagKey = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter' || e.key === ',') {
      e.preventDefault();
      addTag();
    } else if (e.key === 'Backspace' && !tagDraft && tags.length) {
      setTags(tags.slice(0, -1));
    }
  };

  const submit = async () => {
    setError(null);
    try {
      setResult(
        await publish.mutateAsync({
          skillId,
          visibility,
          ...(visibility === 'organization' ? { organizationId } : {}),
          tags,
        })
      );
    } catch (e) {
      setError(getErrorMessage(e));
    }
  };

  const retryScan = async () => {
    if (!result) return;
    try {
      const { version } = await rescan.mutateAsync(result.version.id);
      setResult({ ...result, version });
    } catch (e) {
      setError(getErrorMessage(e));
    }
  };

  return (
    <Modal open onClose={onClose}>
      <ModalDialog
        sx={{ width: 620, maxWidth: '95vw', maxHeight: '90vh', overflowY: 'auto' }}
        data-testid="market-publish-dialog"
      >
        <ModalClose />
        <DialogTitle>{result ? 'Submission result' : 'Publish to the Skill Market'}</DialogTitle>
        <DialogContent>
          {publish.isPending ? (
            <Stack alignItems="center" spacing={2} sx={{ py: 5 }} data-testid="market-publish-scanning">
              <CircularProgress />
              <Typography level="title-sm">Running the safety scan...</Typography>
              <Typography level="body-sm" textColor="text.tertiary" textAlign="center">
                Checking for prompt injection, hidden content and data exfiltration, and writing an honest summary. This
                usually takes a few seconds.
              </Typography>
            </Stack>
          ) : result ? (
            <Stack spacing={2}>
              <ScanResult
                version={result.version}
                visibility={result.listing.visibility}
                onRescan={retryScan}
                rescanning={rescan.isPending}
              />
              {error ? <Alert color="danger">{error}</Alert> : null}
              <Stack direction="row" spacing={1} justifyContent="flex-end" flexWrap="wrap" useFlexGap>
                <Button variant="plain" color="neutral" onClick={onClose}>
                  Close
                </Button>
                <Button
                  variant="outlined"
                  onClick={() => navigate({ to: '/skills/market/mine' })}
                  data-testid="market-publish-mine-btn"
                >
                  My listings
                </Button>
                {result.listing.status === 'approved' ? (
                  <Button
                    onClick={() =>
                      navigate({ to: '/skills/market/$listingId', params: { listingId: result.listing.id } })
                    }
                    data-testid="market-publish-view-btn"
                  >
                    View listing
                  </Button>
                ) : null}
              </Stack>
            </Stack>
          ) : (
            <Stack spacing={2.5}>
              {!skill ? (
                <FormControl required>
                  <FormLabel>Skill</FormLabel>
                  <Select
                    placeholder={publishable.length ? 'Choose one of your skills' : 'You have no skills to publish yet'}
                    value={skillId || null}
                    onChange={(_e, v) => setSkillId(v ?? '')}
                    disabled={!publishable.length}
                    slotProps={{ button: { 'data-testid': 'market-publish-skill-select' } }}
                  >
                    {publishable.map(s => (
                      <Option key={s.id} value={s.id}>
                        /{s.name}
                      </Option>
                    ))}
                  </Select>
                  <FormHelperText>
                    Only skills you wrote can be published; imported skills can&apos;t be republished.
                  </FormHelperText>
                </FormControl>
              ) : (
                <Typography level="body-md">
                  Publishing <code>/{skill.name}</code>
                </Typography>
              )}

              <FormControl>
                <FormLabel>Who can see it</FormLabel>
                <RadioGroup
                  value={visibility}
                  onChange={e => setVisibility(e.target.value as SkillListingVisibility)}
                  sx={{ gap: 1 }}
                >
                  {VISIBILITY_OPTIONS.map(o => (
                    <Card
                      key={o.value}
                      variant={visibility === o.value ? 'soft' : 'outlined'}
                      color={visibility === o.value ? 'primary' : 'neutral'}
                      orientation="horizontal"
                      sx={{ p: 1.5, gap: 1.5, alignItems: 'flex-start' }}
                    >
                      <Box sx={{ color: 'primary.500', mt: 0.25 }}>{o.icon}</Box>
                      <Box sx={{ flex: 1 }}>
                        <Radio
                          value={o.value}
                          label={o.title}
                          overlay
                          disableIcon
                          slotProps={{ input: { 'data-testid': `market-publish-visibility-${o.value}` } }}
                          sx={{ fontWeight: 'lg' }}
                        />
                        <Typography level="body-sm" textColor="text.tertiary">
                          {o.body}
                        </Typography>
                      </Box>
                    </Card>
                  ))}
                </RadioGroup>
              </FormControl>

              {visibility === 'organization' ? (
                <FormControl required>
                  <FormLabel>Organization</FormLabel>
                  <Select
                    placeholder={orgs.length ? 'Choose an organization' : "You aren't in any organization"}
                    value={organizationId || null}
                    onChange={(_e, v) => setOrganizationId(v ?? '')}
                    disabled={!orgs.length}
                    slotProps={{ button: { 'data-testid': 'market-publish-org-select' } }}
                  >
                    {orgs.map(o => (
                      <Option key={o.id} value={o.id}>
                        {o.name}
                      </Option>
                    ))}
                  </Select>
                </FormControl>
              ) : null}

              <FormControl error={Boolean(tagError)}>
                <FormLabel>Tags (optional)</FormLabel>
                <Input
                  placeholder={
                    tags.length >= MAX_TAGS ? 'Tag limit reached' : 'e.g. writing, code-review - press Enter'
                  }
                  value={tagDraft}
                  onChange={e => setTagDraft(e.target.value)}
                  onKeyDown={onTagKey}
                  onBlur={addTag}
                  disabled={tags.length >= MAX_TAGS}
                  startDecorator={
                    tags.length ? (
                      <Stack direction="row" spacing={0.5} flexWrap="wrap" useFlexGap>
                        {tags.map(t => (
                          <Chip
                            key={t}
                            size="sm"
                            variant="soft"
                            endDecorator={<ChipDelete onDelete={() => setTags(tags.filter(x => x !== t))} />}
                          >
                            #{t}
                          </Chip>
                        ))}
                      </Stack>
                    ) : undefined
                  }
                  slotProps={{ input: { 'data-testid': 'market-publish-tag-input' } }}
                />
                <FormHelperText>{tagError ?? 'Tags help people find your skill. Up to 5.'}</FormHelperText>
              </FormControl>

              <Alert variant="soft" color="neutral" startDecorator={<ShieldIcon />}>
                <Typography level="body-sm">
                  Every submission gets an automated safety scan and an AI-written summary of what it really does, shown
                  next to your description. Skills that use tools which act outside the chat need a reviewer before
                  going live. Future edits are submitted as new versions.
                </Typography>
              </Alert>

              {error ? (
                <Alert color="danger" data-testid="market-publish-error">
                  {error}
                </Alert>
              ) : null}

              <Stack direction="row" justifyContent="flex-end" spacing={1}>
                <Button variant="plain" color="neutral" onClick={onClose}>
                  Cancel
                </Button>
                <Button onClick={() => void submit()} disabled={!canSubmit} data-testid="market-publish-submit-btn">
                  Scan and publish
                </Button>
              </Stack>
            </Stack>
          )}
        </DialogContent>
      </ModalDialog>
    </Modal>
  );
};

export default PublishDialog;
