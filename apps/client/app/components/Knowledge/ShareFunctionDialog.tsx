import React, { useState } from 'react';
import {
  Alert,
  Box,
  Button,
  Checkbox,
  Chip,
  ChipDelete,
  FormControl,
  FormLabel,
  Input,
  Modal,
  ModalClose,
  ModalDialog,
  Option,
  Radio,
  RadioGroup,
  Select,
  Skeleton,
  Stack,
  Typography,
} from '@mui/joy';
import {
  CALLABLE_FUNCTION_GRANT_LIMITS,
  type CallableFunctionGrantVisibility,
  type ICallableFunctionPublic,
  type IProjectDocument,
} from '@bike4mind/common';
import type { CallableFunctionShareView } from '@pages/api/callable-functions/[id]/grants';
import {
  callableFunctionErrorMessage,
  useCallableFunctionShare,
  useShareCallableFunction,
} from '@client/app/hooks/data/callableFunctions';
import { lookupUserByEmail } from '@client/app/hooks/data/skills';
import { useGetJoinedProjects } from '@client/app/hooks/data/projects';
import { useGetUserOrganizations } from '@client/app/hooks/data/organizations';
import { useUser } from '@client/app/contexts/UserContext';
import { dangerAlertSx } from './FunctionProblemList';

interface ShareFunctionDialogProps {
  tool: ICallableFunctionPublic;
  /** Names of the data files the live pin reads. */
  dataPins: string[];
  /** Names of the sources the live pin reads. */
  sources: string[];
  onClose: () => void;
}

const VISIBILITY_LABELS: Record<CallableFunctionGrantVisibility, string> = {
  private: 'Only the people named below',
  project: 'Members of a project',
  organization: 'Members of an organization',
};

const listed = (names: string[]) =>
  names.length <= 2 ? names.join(' and ') : `${names.slice(0, -1).join(', ')}, and ${names[names.length - 1]}`;

/** The sentence the owner confirms: what recipients can run, and against which data. */
export function shareDataSentence(dataPins: string[], sources: string[]): string {
  const parts = [
    dataPins.length > 0
      ? `the data ${dataPins.length === 1 ? 'file' : 'files'} ${listed(dataPins)}`
      : 'no pinned data files',
    sources.length > 0 ? `the ${sources.length === 1 ? 'source' : 'sources'} ${listed(sources)}` : 'no sources',
  ];
  const joiner = dataPins.length > 0 && sources.length > 0 ? ', and ' : ' and ';
  return `Recipients can run this function's live version, which reads ${parts.join(joiner)}. They cannot see its code or open the artifact.`;
}

// The server accepts a project the owner owns or is named on with read or write, not one reached only through a group.
const isNamedOnProject = (project: IProjectDocument, userId: string) =>
  project.userId === userId ||
  (project.users ?? []).some(
    user =>
      user.userId === userId &&
      (user.permissions as string[]).some(permission => ['read', 'write'].includes(permission))
  );

function ShareForm({
  tool,
  dataPins,
  sources,
  onClose,
  initial,
}: ShareFunctionDialogProps & { initial: CallableFunctionShareView }) {
  const userId = useUser(s => s.currentUser?.id) ?? '';
  const { data: projects } = useGetJoinedProjects(userId, { enabled: !!userId });
  const { data: organizations } = useGetUserOrganizations(userId);
  const share = useShareCallableFunction();

  const [visibility, setVisibility] = useState<CallableFunctionGrantVisibility>(
    () => initial.grants?.visibility ?? 'private'
  );
  const [projectId, setProjectId] = useState<string | null>(() => initial.grants?.projectId ?? null);
  const [organizationId, setOrganizationId] = useState<string | null>(() => initial.grants?.organizationId ?? null);
  const [people, setPeople] = useState(() => initial.people);
  const [email, setEmail] = useState('');
  const [looking, setLooking] = useState(false);
  const [confirmed, setConfirmed] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const full = people.length >= CALLABLE_FUNCTION_GRANT_LIMITS.maxUserIds;
  const addPerson = async () => {
    const address = email.trim();
    if (!address || full) return;
    setLooking(true);
    setError(null);
    try {
      const found = await lookupUserByEmail(address);
      if (!found) setError(`No account uses ${address}.`);
      else if (found.id === userId) setError('You already own this tool.');
      else {
        setPeople(current =>
          current.some(person => person.id === found.id)
            ? current
            : [...current, { id: found.id, name: found.name || address }]
        );
        setEmail('');
      }
    } catch (lookupError) {
      setError(callableFunctionErrorMessage(lookupError, 'That address could not be looked up.'));
    } finally {
      setLooking(false);
    }
  };

  const target = visibility === 'project' ? projectId : visibility === 'organization' ? organizationId : null;
  const hasRecipients = visibility === 'private' ? people.length > 0 : target !== null;
  const submit = () =>
    share.mutate(
      {
        id: tool.id,
        visibility,
        ...(visibility === 'project' && projectId ? { projectId } : {}),
        ...(visibility === 'organization' && organizationId ? { organizationId } : {}),
        userIds: people.map(person => person.id),
      },
      {
        onSuccess: onClose,
        onError: shareError => setError(callableFunctionErrorMessage(shareError, 'The tool could not be shared.')),
      }
    );

  return (
    <Stack spacing={2}>
      <FormControl>
        <FormLabel>Who can call it</FormLabel>
        <RadioGroup
          value={visibility}
          onChange={event => setVisibility(event.target.value as CallableFunctionGrantVisibility)}
          data-testid="python-function-share-visibility"
        >
          {(Object.keys(VISIBILITY_LABELS) as CallableFunctionGrantVisibility[]).map(value => (
            <Radio
              key={value}
              value={value}
              label={VISIBILITY_LABELS[value]}
              slotProps={{ input: { 'data-testid': `python-function-share-visibility-${value}` } }}
            />
          ))}
        </RadioGroup>
      </FormControl>
      {visibility === 'project' && (
        <Stack spacing={0.5}>
          <Select
            placeholder="Choose a project"
            value={projectId}
            onChange={(_event, value) => setProjectId(value)}
            data-testid="python-function-share-project"
          >
            {(projects ?? [])
              .filter(project => isNamedOnProject(project, userId))
              .map(project => (
                <Option key={project.id} value={project.id}>
                  {project.name}
                </Option>
              ))}
          </Select>
          <Typography level="body-xs" sx={{ color: 'text.secondary' }} data-testid="python-function-share-project-note">
            Reaches the people named on the project, not the groups it is shared with.
          </Typography>
        </Stack>
      )}
      {visibility === 'organization' && (
        <Select
          placeholder="Choose an organization"
          value={organizationId}
          onChange={(_event, value) => setOrganizationId(value)}
          data-testid="python-function-share-organization"
        >
          {(organizations ?? []).map(organization => (
            <Option key={organization.id} value={organization.id}>
              {organization.name}
            </Option>
          ))}
        </Select>
      )}
      <FormControl>
        <FormLabel>
          People ({people.length} of {CALLABLE_FUNCTION_GRANT_LIMITS.maxUserIds})
        </FormLabel>
        <Stack direction="row" spacing={1}>
          <Input
            sx={{ flex: 1 }}
            placeholder="name@example.com"
            value={email}
            disabled={full}
            onChange={event => setEmail(event.target.value)}
            onKeyDown={event => {
              if (event.key === 'Enter') void addPerson();
            }}
            slotProps={{ input: { 'data-testid': 'python-function-share-email' } }}
          />
          <Button
            variant="outlined"
            color="neutral"
            loading={looking}
            disabled={full || !email.trim()}
            onClick={() => void addPerson()}
            data-testid="python-function-share-add-btn"
          >
            Add
          </Button>
        </Stack>
        {people.length > 0 && (
          <Stack direction="row" spacing={0.5} flexWrap="wrap" useFlexGap sx={{ mt: 1 }}>
            {people.map(person => (
              <Chip
                key={person.id}
                variant="soft"
                data-testid="python-function-share-person"
                endDecorator={
                  <ChipDelete
                    onDelete={() => setPeople(current => current.filter(other => other.id !== person.id))}
                    data-testid="python-function-share-person-remove"
                  />
                }
              >
                {person.name}
              </Chip>
            ))}
          </Stack>
        )}
      </FormControl>
      <Stack spacing={0.5} data-testid="python-function-share-data">
        <Typography level="title-sm">Data it reads</Typography>
        {dataPins.length + sources.length === 0 ? (
          <Typography level="body-sm" sx={{ color: 'text.secondary' }}>
            None.
          </Typography>
        ) : (
          <Box component="ul" sx={{ m: 0, pl: 2.5 }}>
            {dataPins.map(name => (
              <li key={`data-${name}`} data-testid="python-function-share-data-item">
                <Typography level="body-sm">Data file: {name}</Typography>
              </li>
            ))}
            {sources.map(name => (
              <li key={`source-${name}`} data-testid="python-function-share-data-item">
                <Typography level="body-sm">Source: {name}</Typography>
              </li>
            ))}
          </Box>
        )}
      </Stack>
      <Typography level="body-sm" data-testid="python-function-share-sentence">
        {shareDataSentence(dataPins, sources)} Each recipient sees it as pending review and cannot call it until they
        review it.
      </Typography>
      <Checkbox
        checked={confirmed}
        onChange={event => setConfirmed(event.target.checked)}
        label="I confirm recipients can run this function against the data above."
        slotProps={{ input: { 'data-testid': 'python-function-share-confirm' } }}
      />
      {error && (
        <Alert color="danger" variant="soft" sx={dangerAlertSx} data-testid="python-function-share-error">
          {error}
        </Alert>
      )}
      <Stack direction="row" spacing={1} justifyContent="flex-end">
        <Button variant="plain" color="neutral" onClick={onClose} data-testid="python-function-share-cancel-btn">
          Cancel
        </Button>
        <Button
          loading={share.isPending}
          disabled={!confirmed || !hasRecipients}
          onClick={submit}
          data-testid="python-function-share-submit-btn"
        >
          Share
        </Button>
      </Stack>
    </Stack>
  );
}

/** Shares a live tool's pin with named people, a project, or an organization, after the owner confirms the data. */
export default function ShareFunctionDialog(props: ShareFunctionDialogProps) {
  const { data, isPending, isError } = useCallableFunctionShare(props.tool.id);
  return (
    <Modal open onClose={props.onClose}>
      <ModalDialog sx={{ width: 520, maxWidth: '95vw' }} data-testid="python-function-share-dialog">
        <ModalClose />
        <Typography level="title-lg">Share {props.tool.slug}</Typography>
        <Typography level="body-sm" sx={{ color: 'text.secondary' }}>
          Shares the live version, now promotion {props.tool.pin.seq ?? ''}; a later promotion is shared too.
        </Typography>
        {isPending && <Skeleton variant="rectangular" height={120} />}
        {isError && (
          <Alert color="danger" variant="soft" sx={dangerAlertSx} data-testid="python-function-share-load-error">
            The share could not be loaded.
          </Alert>
        )}
        {data && <ShareForm {...props} initial={data} />}
      </ModalDialog>
    </Modal>
  );
}
