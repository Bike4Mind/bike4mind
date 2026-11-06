import { useCallback, useEffect, useState, type KeyboardEvent, type ReactNode } from 'react';
import Alert from '@mui/joy/Alert';
import Box from '@mui/joy/Box';
import Button from '@mui/joy/Button';
import Checkbox from '@mui/joy/Checkbox';
import Chip from '@mui/joy/Chip';
import ChipDelete from '@mui/joy/ChipDelete';
import DialogActions from '@mui/joy/DialogActions';
import DialogContent from '@mui/joy/DialogContent';
import DialogTitle from '@mui/joy/DialogTitle';
import FormControl from '@mui/joy/FormControl';
import FormHelperText from '@mui/joy/FormHelperText';
import FormLabel from '@mui/joy/FormLabel';
import Input from '@mui/joy/Input';
import Modal from '@mui/joy/Modal';
import ModalClose from '@mui/joy/ModalClose';
import ModalDialog from '@mui/joy/ModalDialog';
import Option from '@mui/joy/Option';
import Radio from '@mui/joy/Radio';
import RadioGroup from '@mui/joy/RadioGroup';
import Select from '@mui/joy/Select';
import Sheet from '@mui/joy/Sheet';
import Stack from '@mui/joy/Stack';
import Typography from '@mui/joy/Typography';
import { SKILL_LISTING_MAX_TAGS, SKILL_LISTING_TAG_PATTERN, type SkillListingVisibility } from '@bike4mind/common';
import type {
  SkillMarketOrg,
  SkillSubmitResult,
  SkillSubmittedVersion,
  SkillUploadFields,
  SkillUploadPreview,
} from '@shared/skillMarket';
import { ExternalLinkIcon } from './icons';

type Preview = Extract<SkillUploadPreview, { ok: true }>;
type Submitted = Extract<SkillSubmitResult, { ok: true }>;

/** The server's limits (apps/client/server/utils/skillValidation.ts); it stays authoritative. */
const NAME_PATTERN = /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/;
const NAME_MAX = 64;
const DESCRIPTION_MAX = 500;
const BODY_MAX = 50_000;
const ARG_HINT_MAX = 200;

/** The web PublishDialog's copy, so both clients say the same thing. */
const VISIBILITY_OPTIONS: { value: SkillListingVisibility; title: string; body: string }[] = [
  {
    value: 'public',
    title: 'Public',
    body: 'Anyone on Bike4Mind can find and import it.',
  },
  { value: 'organization', title: 'Organization', body: 'Only members of the organization you choose can see it.' },
  {
    value: 'unlisted',
    title: 'Unlisted link',
    body: 'Hidden from browse and search. Anyone signed in with the link can import it.',
  },
];

function fieldErrors(fields: SkillUploadFields): Partial<Record<keyof SkillUploadFields, string>> {
  const name = fields.name.trim();
  return {
    ...(!name
      ? { name: 'A name is required.' }
      : name.length > NAME_MAX
        ? { name: `At most ${NAME_MAX} characters.` }
        : !NAME_PATTERN.test(name)
          ? { name: 'Use kebab-case: lowercase letters, digits and hyphens, not starting or ending with a hyphen.' }
          : {}),
    ...(!fields.description.trim()
      ? { description: 'A description is required.' }
      : fields.description.trim().length > DESCRIPTION_MAX
        ? { description: `At most ${DESCRIPTION_MAX} characters.` }
        : {}),
    ...(!fields.body.trim()
      ? { body: 'The skill has no instructions.' }
      : fields.body.length > BODY_MAX
        ? { body: `At most ${BODY_MAX.toLocaleString()} characters.` }
        : {}),
    ...((fields.argumentHint ?? '').length > ARG_HINT_MAX
      ? { argumentHint: `At most ${ARG_HINT_MAX} characters.` }
      : {}),
  };
}

/** A version's scan and review state in plain words; mirrors the web's ScanResult versionOutcome. */
export function versionOutcome(
  version: SkillSubmittedVersion,
  visibility: SkillListingVisibility
): { color: 'success' | 'warning' | 'danger' | 'neutral'; title: string; body: string } {
  if (version.scanStatus === 'scanning') return { color: 'neutral', title: 'Scanning...', body: '' };
  if (version.scanStatus === 'error') {
    return {
      color: 'danger',
      title: 'The safety scan could not finish',
      body: 'Nothing was published. Retry the scan from My listings on the web.',
    };
  }
  if (version.scanStatus === 'failed') {
    return {
      color: 'danger',
      title: 'Not published: the safety scan found problems',
      body: 'Fix the issues below in your skill, then submit a new version.',
    };
  }
  switch (version.reviewStatus) {
    case 'auto_approved':
      return {
        color: 'success',
        title: 'Live on the Skill Market',
        body:
          version.riskTier === 'review'
            ? `Passed the automated scan with a note and is live for your ${visibility === 'organization' ? 'organization' : 'link holders'}.`
            : 'Passed the automated safety scan and is live now.',
      };
    case 'approved':
      return { color: 'success', title: 'Approved by a reviewer', body: 'This version is live.' };
    case 'pending':
      return {
        color: 'warning',
        title: 'Waiting for a human reviewer',
        body:
          version.riskTier === 'high'
            ? 'It declares tools that act outside the conversation, so a reviewer must approve it first.'
            : 'Listings with findings are checked by a person before they go live.',
      };
    case 'rejected':
      return {
        color: 'danger',
        title: 'Not approved',
        body: version.reviewNote ? `Reviewer note: ${version.reviewNote}` : '',
      };
    default:
      return { color: 'neutral', title: version.reviewStatus || 'Submitted', body: '' };
  }
}

/** The web PublishDialog's tag input, rule for rule. */
function TagInput({ tags, onChange }: { tags: string[]; onChange: (tags: string[]) => void }) {
  const [draft, setDraft] = useState('');
  const [error, setError] = useState<string | null>(null);
  const full = tags.length >= SKILL_LISTING_MAX_TAGS;

  const add = () => {
    const tag = draft.trim().toLowerCase().replace(/^#/, '');
    if (!tag) return;
    if (!SKILL_LISTING_TAG_PATTERN.test(tag)) return setError('Use 1-24 lowercase letters, digits or hyphens');
    if (full) return setError(`Up to ${SKILL_LISTING_MAX_TAGS} tags`);
    if (!tags.includes(tag)) onChange([...tags, tag]);
    setDraft('');
    setError(null);
  };

  const onKey = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key === 'Enter' || event.key === ',') {
      event.preventDefault();
      add();
    } else if (event.key === 'Backspace' && !draft && tags.length) {
      onChange(tags.slice(0, -1));
    }
  };

  return (
    <FormControl error={Boolean(error)}>
      <FormLabel>Tags (optional)</FormLabel>
      <Input
        placeholder={full ? 'Tag limit reached' : 'e.g. writing, code-review - press Enter'}
        value={draft}
        onChange={event => setDraft(event.target.value)}
        onKeyDown={onKey}
        onBlur={add}
        disabled={full}
        startDecorator={
          tags.length ? (
            <Stack direction="row" spacing={0.5} flexWrap="wrap" useFlexGap>
              {tags.map(tag => (
                <Chip
                  key={tag}
                  size="sm"
                  variant="soft"
                  endDecorator={<ChipDelete onDelete={() => onChange(tags.filter(other => other !== tag))} />}
                  data-testid="skill-publish-tag"
                >
                  #{tag}
                </Chip>
              ))}
            </Stack>
          ) : undefined
        }
        slotProps={{ input: { 'data-testid': 'skill-publish-tag-input' } }}
      />
      <FormHelperText data-testid="skill-publish-tag-helper">
        {error ?? 'Tags help people find your skill. Up to 5.'}
      </FormHelperText>
    </FormControl>
  );
}

function SubmitResultView({ result, onClose }: { result: Submitted; onClose: () => void }) {
  const outcome = versionOutcome(result.version, result.listing.visibility);
  const [copied, setCopied] = useState<string | null>(null);
  return (
    <Stack spacing={1.5} data-testid="skill-publish-result">
      <Alert color={outcome.color} variant="soft">
        <Box sx={{ flex: 1 }}>
          <Stack direction="row" spacing={1} alignItems="center">
            <Typography level="title-sm" data-testid="skill-publish-result-status">
              v{result.version.version}: {outcome.title}
            </Typography>
            {result.version.riskTier && (
              <Chip size="sm" variant="outlined" color={result.version.riskTier === 'high' ? 'danger' : 'neutral'}>
                Risk: {result.version.riskTier}
              </Chip>
            )}
          </Stack>
          {outcome.body && <Typography level="body-sm">{outcome.body}</Typography>}
        </Box>
      </Alert>
      {result.version.findings.length > 0 && (
        <Box data-testid="skill-publish-findings">
          <Typography level="title-sm" sx={{ mb: 0.5 }}>
            What the scan found
          </Typography>
          {result.version.findings.map((finding, index) => (
            <Typography key={index} level="body-sm">
              {finding.severity ? `[${finding.severity}] ` : ''}
              {finding.message}
            </Typography>
          ))}
        </Box>
      )}
      {copied && (
        <Typography level="body-sm" textColor="text.tertiary">
          {copied}
        </Typography>
      )}
      <DialogActions>
        <Button variant="plain" color="neutral" onClick={onClose}>
          Close
        </Button>
        {result.listing.hasShareLink && (
          <Button
            variant="outlined"
            onClick={() =>
              void window.b4m.skillMarket
                .copyShareLink(result.listing.id)
                .then(copy => setCopied(copy.ok ? 'Share link copied.' : copy.error))
            }
            data-testid="skill-listing-copy-link-btn"
          >
            Copy share link
          </Button>
        )}
        <Button
          variant="outlined"
          endDecorator={<ExternalLinkIcon />}
          onClick={() => void window.b4m.skillMarket.openOnWeb({ kind: 'listing', id: result.listing.id })}
          data-testid="skill-publish-open-web-btn"
        >
          Open listing on web
        </Button>
      </DialogActions>
    </Stack>
  );
}

type Step =
  | { kind: 'edit' }
  | { kind: 'conflict'; existing: { id: string; imported: boolean }; then: 'done' | 'publish' }
  | { kind: 'saved'; message: string }
  | { kind: 'publish'; skillId: string; message: string }
  | { kind: 'version'; listingId: string; message: string }
  | { kind: 'result'; result: Submitted };

/**
 * Upload a local SKILL.md: preview and edit what main parsed, save it to the account, and
 * optionally publish it or submit it as a new version of an existing listing (`listing`).
 * Every request runs from a button here; another author's export asks first.
 */
export function SkillUploadDialog({
  preview,
  listing,
  sessionId,
  onClose,
  onSaved,
}: {
  preview: Preview;
  /** Submit as a new version of this listing instead of saving a new skill. */
  listing?: { id: string; name: string };
  /** The chat session, so a project skill's local copy counts when saying what takes precedence. */
  sessionId?: string | null;
  onClose: () => void;
  /** An account skill or market listing changed, so dependent lists should reload. */
  onSaved?: () => void;
}) {
  const [fields, setFields] = useState<SkillUploadFields>(preview.fields);
  const [step, setStep] = useState<Step>({ kind: 'edit' });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [rename, setRename] = useState('');
  const [confirmed, setConfirmed] = useState(false);
  const [pending, setPending] = useState<(() => Promise<void>) | null>(null);
  const [visibility, setVisibility] = useState<SkillListingVisibility>('public');
  const [orgs, setOrgs] = useState<SkillMarketOrg[]>([]);
  const [organizationId, setOrganizationId] = useState('');
  const [tags, setTags] = useState<string[]>([]);

  const errors = fieldErrors(fields);
  const valid = Object.keys(errors).length === 0;
  const set = <K extends keyof SkillUploadFields>(key: K, value: SkillUploadFields[K]) =>
    setFields(previous => ({ ...previous, [key]: value }));

  useEffect(() => {
    if (step.kind !== 'publish') return;
    let live = true;
    void window.b4m.skillMarket.organizations().then(result => {
      if (!live) return;
      setOrgs(result.organizations);
      if (result.error) setError(result.error);
    });
    return () => {
      live = false;
    };
  }, [step.kind]);

  const run = async (action: () => Promise<void>) => {
    setBusy(true);
    setError(null);
    try {
      await action();
    } finally {
      setBusy(false);
    }
  };

  // Publishing another author's export would list their work as the user's own: ask first.
  const guarded = (action: () => Promise<void>) => {
    if (preview.source?.thirdParty && !confirmed) setPending(() => action);
    else void run(action);
  };

  const save = async (then: 'done' | 'publish', mode: 'create' | 'update' = 'create', target?: string) => {
    const name = fields.name.trim();
    const saved = await window.b4m.skillMarket.saveSkill({
      fields: { ...fields, name, description: fields.description.trim() },
      mode,
      ...(target ? { targetSkillId: target } : {}),
      ...(sessionId ? { sessionId } : {}),
    });
    if (!saved.ok) {
      if (saved.code === 'name_taken' && saved.existing) setStep({ kind: 'conflict', existing: saved.existing, then });
      else setError(saved.error);
      return;
    }
    onSaved?.();
    const message = `Saved /${saved.skill.name} to your account.${
      saved.shadowedByLocal ? ' Your local copy still takes precedence on this machine.' : ''
    }`;
    if (saved.listing) setStep({ kind: 'version', listingId: saved.listing.id, message });
    else if (then === 'publish') setStep({ kind: 'publish', skillId: saved.skill.id, message });
    else setStep({ kind: 'saved', message });
  };

  const submitVersion = async (listingId: string, withFields: boolean) => {
    const result = await window.b4m.skillMarket.submitVersion({
      listingId,
      ...(withFields
        ? { fields: { ...fields, name: fields.name.trim(), description: fields.description.trim() } }
        : {}),
    });
    if (result.ok) {
      onSaved?.();
      setStep({ kind: 'result', result });
      return;
    }
    if (result.skillUpdated) {
      onSaved?.();
      setError(`${result.error} Your account skill was updated; you can retry Submit new version later.`);
    } else setError(result.error);
  };

  const publish = async (skillId: string) => {
    const result = await window.b4m.skillMarket.publish({
      skillId,
      visibility,
      ...(visibility === 'organization' ? { organizationId } : {}),
      tags,
    });
    if (result.ok) {
      onSaved?.();
      setStep({ kind: 'result', result });
    } else if (result.code === 'already_listed' && result.listingId) {
      setStep({ kind: 'version', listingId: result.listingId, message: result.error });
    } else setError(result.error);
  };

  const title =
    step.kind === 'result'
      ? 'Submission result'
      : step.kind === 'publish'
        ? 'Publish to the Skill Market'
        : listing || step.kind === 'version'
          ? 'Submit a new version'
          : 'Upload a skill';

  let content: ReactNode;
  if (step.kind === 'result') {
    content = <SubmitResultView result={step.result} onClose={onClose} />;
  } else if (step.kind === 'saved') {
    content = (
      <Stack spacing={1.5}>
        <Alert color="success" data-testid="skill-upload-saved">
          {step.message}
        </Alert>
        <DialogActions>
          <Button onClick={onClose}>Done</Button>
        </DialogActions>
      </Stack>
    );
  } else if (step.kind === 'conflict') {
    content = (
      <Stack spacing={1.5} data-testid="skill-upload-conflict">
        <Typography level="body-md">
          You already have a skill named <code>/{fields.name.trim()}</code>.
          {step.existing.imported ? ' It came from the Skill Market, so save this one under another name.' : ''}
        </Typography>
        {!step.existing.imported && (
          <Box>
            <Button
              loading={busy}
              onClick={() => void run(() => save(step.then, 'update', step.existing.id))}
              data-testid="skill-upload-update-btn"
            >
              Update existing
            </Button>
          </Box>
        )}
        <FormControl error={!!rename && !NAME_PATTERN.test(rename)}>
          <FormLabel>{step.existing.imported ? 'New name' : 'Or save under a new name'}</FormLabel>
          <Stack direction="row" spacing={1}>
            <Input
              sx={{ flex: 1 }}
              value={rename}
              onChange={event => setRename(event.target.value.trim().toLowerCase())}
              slotProps={{ input: { 'data-testid': 'skill-upload-rename-field' } }}
            />
            <Button
              variant="outlined"
              disabled={busy || !NAME_PATTERN.test(rename) || rename.length > NAME_MAX}
              onClick={() => {
                set('name', rename);
                setStep({ kind: 'edit' });
              }}
              data-testid="skill-upload-rename-btn"
            >
              Rename
            </Button>
          </Stack>
        </FormControl>
      </Stack>
    );
  } else if (step.kind === 'publish') {
    content = (
      <Stack spacing={2}>
        <Alert color="success" variant="soft">
          {step.message}
        </Alert>
        <FormControl>
          <FormLabel>Who can see it</FormLabel>
          <RadioGroup
            value={visibility}
            onChange={event => setVisibility(event.target.value as SkillListingVisibility)}
            sx={{ gap: 1 }}
            data-testid="skill-publish-visibility"
          >
            {VISIBILITY_OPTIONS.map(option => (
              <Sheet key={option.value} variant="outlined" sx={{ borderRadius: 'md', p: 1.25 }}>
                <Radio
                  value={option.value}
                  label={option.title}
                  overlay
                  slotProps={{ input: { 'data-testid': `skill-publish-visibility-${option.value}` } }}
                />
                <Typography level="body-sm" textColor="text.tertiary" sx={{ pl: 3.5 }}>
                  {option.body}
                </Typography>
              </Sheet>
            ))}
          </RadioGroup>
        </FormControl>
        {visibility === 'organization' && (
          <FormControl required>
            <FormLabel>Organization</FormLabel>
            <Select
              placeholder={orgs.length ? 'Choose an organization' : "You aren't in any organization"}
              value={organizationId || null}
              onChange={(_event, value) => setOrganizationId(value ?? '')}
              disabled={!orgs.length}
              slotProps={{ button: { 'data-testid': 'skill-publish-org' } }}
            >
              {orgs.map(org => (
                <Option key={org.id} value={org.id}>
                  {org.name}
                </Option>
              ))}
            </Select>
          </FormControl>
        )}
        <TagInput tags={tags} onChange={setTags} />
        <Alert color="neutral" variant="soft" data-testid="skill-publish-scan-disclosure">
          At every visibility, the scan can reject a submission or hold it for a reviewer before it goes live. Future
          edits are submitted as new versions.
        </Alert>
        <DialogActions>
          <Button
            loading={busy}
            disabled={visibility === 'organization' && !organizationId}
            onClick={() => void run(() => publish(step.skillId))}
            data-testid="skill-publish-submit-btn"
          >
            Scan and publish
          </Button>
          <Button variant="plain" color="neutral" onClick={onClose}>
            Not now
          </Button>
        </DialogActions>
      </Stack>
    );
  } else if (step.kind === 'version') {
    content = (
      <Stack spacing={1.5}>
        <Alert color="neutral" variant="soft">
          {step.message} This skill already has a listing, so it can go out as a new version.
        </Alert>
        <DialogActions>
          <Button
            loading={busy}
            onClick={() => void run(() => submitVersion(step.listingId, false))}
            data-testid="skill-upload-submit-version-btn"
          >
            Submit as new version
          </Button>
          <Button variant="plain" color="neutral" onClick={onClose}>
            Not now
          </Button>
        </DialogActions>
      </Stack>
    );
  } else {
    content = (
      <Stack spacing={1.5}>
        {preview.source && (
          <Alert
            color={preview.source.thirdParty ? 'warning' : 'primary'}
            variant="soft"
            data-testid="skill-upload-from-b4m"
            endDecorator={
              <Button
                size="sm"
                variant="plain"
                endDecorator={<ExternalLinkIcon />}
                onClick={() => void window.b4m.skillMarket.openSource(preview.source!.url)}
                data-testid="skill-upload-source-link"
              >
                Open the original
              </Button>
            }
          >
            {preview.source.thirdParty
              ? "This is another author's Skill Market skill."
              : 'This skill came from Bike4Mind.'}
          </Alert>
        )}
        {preview.dropped.length > 0 && (
          <Alert color="neutral" variant="soft" data-testid="skill-upload-dropped">
            Ignored (not supported in Bike4Mind skills): {preview.dropped.join(', ')}
          </Alert>
        )}
        {fields.files?.length ? (
          <Alert color="neutral" variant="soft" data-testid="skill-upload-files">
            Also uploads {fields.files.length} supporting {fields.files.length === 1 ? 'file' : 'files'}:{' '}
            {fields.files.map(f => f.path).join(', ')}
            {fields.files.some(f => f.path.startsWith('scripts/'))
              ? '. Scripts run on the user\u2019s machine, so a person reviews them before the skill is shared.'
              : ''}
          </Alert>
        ) : null}
        {preview.extraFileCount > 0 && (
          <Alert color="warning" variant="soft" data-testid="skill-upload-extra-files">
            Only SKILL.md, scripts/ and references/ are uploaded; {preview.extraFileCount} other{' '}
            {preview.extraFileCount === 1 ? 'file' : 'files'} in this folder{' '}
            {preview.extraFileCount === 1 ? 'is' : 'are'} not: {preview.extraFiles.join(', ')}
            {preview.extraFileCount > preview.extraFiles.length ? ', ...' : ''}
          </Alert>
        )}
        <FormControl required error={!!errors.name}>
          <FormLabel>Name</FormLabel>
          <Input
            value={fields.name}
            onChange={event => set('name', event.target.value)}
            slotProps={{ input: { 'data-testid': 'skill-upload-name' } }}
          />
          {errors.name && <FormHelperText>{errors.name}</FormHelperText>}
        </FormControl>
        {listing && fields.name.trim() !== listing.name && (
          <Alert color="warning" variant="soft" data-testid="skill-upload-name-mismatch">
            This file is /{fields.name.trim()}, not /{listing.name}. Submitting renames the listing&apos;s skill; check
            you picked the right file.
          </Alert>
        )}
        <FormControl required error={!!errors.description}>
          <FormLabel>Description</FormLabel>
          <Input
            value={fields.description}
            onChange={event => set('description', event.target.value)}
            slotProps={{ input: { 'data-testid': 'skill-upload-description' } }}
          />
          {errors.description && <FormHelperText>{errors.description}</FormHelperText>}
        </FormControl>
        <FormControl error={!!errors.argumentHint}>
          <FormLabel>Argument hint</FormLabel>
          <Input
            value={fields.argumentHint ?? ''}
            onChange={event => set('argumentHint', event.target.value)}
            slotProps={{ input: { 'data-testid': 'skill-upload-argument-hint' } }}
          />
          {errors.argumentHint && <FormHelperText>{errors.argumentHint}</FormHelperText>}
        </FormControl>
        <Checkbox
          label="Hide from model auto-invocation"
          checked={fields.disableModelInvocation === true}
          onChange={event => set('disableModelInvocation', event.target.checked)}
          slotProps={{ input: { 'data-testid': 'skill-upload-disable-invocation' } }}
        />
        <FormControl error={!!errors.body}>
          <FormLabel>Instructions ({fields.body.length.toLocaleString()} characters)</FormLabel>
          <Sheet
            variant="soft"
            sx={{
              borderRadius: 'sm',
              p: 1,
              maxHeight: 220,
              overflow: 'auto',
              fontFamily: 'code',
              fontSize: 'xs',
              whiteSpace: 'pre-wrap',
            }}
            data-testid="skill-upload-body"
          >
            {fields.body}
          </Sheet>
          {errors.body && <FormHelperText>{errors.body}</FormHelperText>}
        </FormControl>
        <DialogActions>
          {listing ? (
            <Button
              loading={busy}
              disabled={!valid}
              onClick={() => guarded(() => submitVersion(listing.id, true))}
              data-testid="skill-upload-submit-version-btn"
            >
              Submit new version
            </Button>
          ) : (
            <>
              <Button
                loading={busy}
                disabled={!valid}
                onClick={() => guarded(() => save('publish'))}
                data-testid="skill-upload-publish-btn"
              >
                Save and publish...
              </Button>
              <Button
                variant="outlined"
                disabled={!valid || busy}
                onClick={() => guarded(() => save('done'))}
                data-testid="skill-upload-save-btn"
              >
                Save to account
              </Button>
            </>
          )}
          <Button variant="plain" color="neutral" onClick={onClose}>
            Cancel
          </Button>
        </DialogActions>
      </Stack>
    );
  }

  return (
    <>
      <Modal open onClose={onClose}>
        <ModalDialog
          sx={{ width: 620, maxWidth: '95vw', maxHeight: '90vh', overflowY: 'auto' }}
          data-testid="skill-upload-dialog"
        >
          <ModalClose />
          <DialogTitle>
            {title}
            {listing && step.kind === 'edit' ? ` of /${listing.name}` : ''}
          </DialogTitle>
          <DialogContent>
            <Stack spacing={1.5}>
              {content}
              {error && (
                <Alert color="danger" data-testid="skill-upload-error">
                  {error}
                </Alert>
              )}
            </Stack>
          </DialogContent>
        </ModalDialog>
      </Modal>
      <Modal open={pending !== null} onClose={() => setPending(null)}>
        <ModalDialog role="alertdialog" data-testid="skill-upload-thirdparty-confirm">
          <DialogTitle>Upload another author&apos;s skill?</DialogTitle>
          <DialogContent>
            This file is another author&apos;s Skill Market skill. Saving or publishing it puts their work under your
            name.
          </DialogContent>
          <DialogActions>
            <Button
              color="warning"
              onClick={() => {
                const action = pending;
                setPending(null);
                setConfirmed(true);
                if (action) void run(action);
              }}
              data-testid="skill-upload-thirdparty-confirm-btn"
            >
              Continue
            </Button>
            <Button variant="plain" color="neutral" onClick={() => setPending(null)}>
              Cancel
            </Button>
          </DialogActions>
        </ModalDialog>
      </Modal>
    </>
  );
}

/**
 * Open the upload dialog from a read (a Customize row or the native picker). A failed read
 * surfaces as `error`; a cancelled pick does nothing.
 */
export function useSkillUpload(onSaved?: () => void, sessionId?: string | null) {
  const [open, setOpen] = useState<{ preview: Preview; listing?: { id: string; name: string } } | null>(null);
  const [error, setError] = useState<string | null>(null);

  const start = useCallback(async (load: () => Promise<SkillUploadPreview>, listing?: { id: string; name: string }) => {
    setError(null);
    const preview = await load();
    if (preview.ok) setOpen({ preview, ...(listing ? { listing } : {}) });
    else if (!preview.canceled) setError(preview.error);
  }, []);

  const dialog = open ? (
    <SkillUploadDialog
      preview={open.preview}
      listing={open.listing}
      sessionId={sessionId}
      onClose={() => setOpen(null)}
      onSaved={onSaved}
    />
  ) : null;
  return { start, error, dialog };
}
