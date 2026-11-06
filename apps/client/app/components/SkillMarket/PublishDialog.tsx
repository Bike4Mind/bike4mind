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
  Link,
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
import { Link as RouterLink, useNavigate } from '@tanstack/react-router';
import {
  SKILL_LISTING_MAX_TAGS as MAX_TAGS,
  SKILL_LISTING_TAG_PATTERN as TAG_PATTERN,
  type ISkill,
  type SkillListingVisibility,
} from '@bike4mind/common';
import { getErrorMessage } from '@client/app/utils/error';
import {
  useMarketMe,
  useMyListings,
  usePublishSkill,
  useRescanVersion,
  useSubmitNewVersion,
  useSuggestListingTags,
  type SubmitResult,
} from '@client/app/hooks/data/skillMarket';
import ScanResult from './ScanResult';

const MY_LISTINGS = 'My listings';

const MyListingsLink: FC = () => (
  <Link component={RouterLink} to="/skills/market/mine" data-testid="market-publish-mine-link">
    {MY_LISTINGS}
  </Link>
);

/** Renders the server's "...from My listings instead." conflict message with a real link. */
const withMyListingsLink = (message: string) => {
  const [before, ...after] = message.split(MY_LISTINGS);
  if (!after.length) return message;
  return (
    <>
      {before}
      <MyListingsLink />
      {after.join(MY_LISTINGS)}
    </>
  );
};

const VISIBILITY_OPTIONS: Array<{ value: SkillListingVisibility; title: string; body: string; icon: ReactElement }> = [
  {
    value: 'public',
    title: 'Public',
    body: 'Anyone on Bike4Mind can find and import it.',
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
 * verdict inline - live, waiting for review, or what to fix. A skill that already has a live
 * listing submits a new version of it instead, keeping its visibility and tags.
 */
const PublishDialog: FC<PublishDialogProps> = ({ onClose, skill, ownSkills = [] }) => {
  const navigate = useNavigate();
  const { data: me } = useMarketMe();
  const publish = usePublishSkill();
  const submitVersion = useSubmitNewVersion();
  const rescan = useRescanVersion();
  const { data: myListings } = useMyListings();

  const publishable = useMemo(() => ownSkills.filter(s => !s.importedFrom), [ownSkills]);
  const [skillId, setSkillId] = useState(skill?.id ?? '');
  const [visibility, setVisibility] = useState<SkillListingVisibility>('public');
  const [organizationId, setOrganizationId] = useState('');
  const [editedTags, setEditedTags] = useState<string[] | null>(null);
  const [tagDraft, setTagDraft] = useState('');
  const [tagError, setTagError] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<SubmitResult | null>(null);
  // Same "live" rule as the server's ALREADY_LISTED check in pages/api/skills/market/publish.ts. While
  // the listings load, the normal form shows and a conflict still surfaces as the linked error.
  const existing = myListings?.find(
    l => l.sourceSkillId === skillId && l.status !== 'withdrawn' && l.status !== 'delisted'
  );
  // An already-listed skill keeps its tags, so there is nothing to suggest.
  const suggest = useSuggestListingTags(skillId, !result && !existing);
  // The current skill's suggestions stand in for the tags until the author edits them.
  const tagsTouched = editedTags !== null;
  const tags = editedTags ?? suggest.data ?? [];

  const pending = publish.isPending || submitVersion.isPending;

  const orgs = me?.organizations ?? [];
  const canSubmit =
    Boolean(skillId) && (Boolean(existing) || visibility !== 'organization' || Boolean(organizationId)) && !pending;

  const addTag = () => {
    const tag = tagDraft.trim().toLowerCase().replace(/^#/, '');
    if (!tag) return;
    if (!TAG_PATTERN.test(tag)) return setTagError('Use 1-24 lowercase letters, digits or hyphens');
    if (tags.length >= MAX_TAGS) return setTagError(`Up to ${MAX_TAGS} tags`);
    if (!tags.includes(tag)) setEditedTags([...tags, tag]);
    setTagDraft('');
    setTagError(null);
  };

  const onTagKey = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter' || e.key === ',') {
      e.preventDefault();
      addTag();
    } else if (e.key === 'Backspace' && !tagDraft && tags.length) {
      setEditedTags(tags.slice(0, -1));
    }
  };

  const submit = async () => {
    setError(null);
    try {
      setResult(
        existing
          ? await submitVersion.mutateAsync({ listingId: existing.id })
          : await publish.mutateAsync({
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
          {pending ? (
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

              {existing ? (
                <Alert color="primary" variant="soft" data-testid="market-publish-already-listed">
                  <span>
                    Already listed ({existing.visibility}). Publishing submits a new version. Change its visibility or
                    tags in <MyListingsLink />.
                  </span>
                </Alert>
              ) : (
                <>
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
                                data-testid={`market-publish-tag-${t}`}
                                endDecorator={
                                  <ChipDelete
                                    onDelete={() => setEditedTags(tags.filter(x => x !== t))}
                                    data-testid={`market-publish-tag-delete-${t}`}
                                  />
                                }
                              >
                                #{t}
                              </Chip>
                            ))}
                          </Stack>
                        ) : undefined
                      }
                      slotProps={{ input: { 'data-testid': 'market-publish-tag-input' } }}
                    />
                    {!tagError && suggest.isFetching && !tagsTouched ? (
                      <FormHelperText data-testid="market-publish-tags-suggesting">Suggesting tags...</FormHelperText>
                    ) : (
                      <FormHelperText>{tagError ?? 'Tags help people find your skill. Up to 5.'}</FormHelperText>
                    )}
                  </FormControl>
                </>
              )}

              <Alert variant="soft" color="neutral" startDecorator={<ShieldIcon />}>
                <Typography level="body-sm">
                  Every submission gets an automated safety scan and an AI-written summary of what it really does, shown
                  next to your description. At every visibility, the scan can reject a submission or hold it for a
                  reviewer before it goes live. Future edits are submitted as new versions.
                </Typography>
              </Alert>

              {error ? (
                <Alert color="danger" data-testid="market-publish-error">
                  <span>{withMyListingsLink(error)}</span>
                </Alert>
              ) : null}

              <Stack direction="row" justifyContent="flex-end" spacing={1}>
                <Button variant="plain" color="neutral" onClick={onClose}>
                  Cancel
                </Button>
                <Button onClick={() => void submit()} disabled={!canSubmit} data-testid="market-publish-submit-btn">
                  {existing ? 'Scan and submit new version' : 'Scan and publish'}
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
