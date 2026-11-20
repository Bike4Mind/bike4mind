import { FC, useState } from 'react';
import {
  Alert,
  Autocomplete,
  Button,
  FormControl,
  FormLabel,
  IconButton,
  Input,
  Sheet,
  Stack,
  Typography,
} from '@mui/joy';
import DeleteIcon from '@mui/icons-material/Delete';
import EditIcon from '@mui/icons-material/Edit';
import type { ISkillBundle } from '@bike4mind/common';
import {
  useDeleteSkillBundle,
  useSaveSkillBundle,
  useSkillBundles,
  type SkillBundleInput,
  type SkillBundlesView,
} from '@client/app/hooks/data/skillMarket';
import { getErrorMessage } from '@client/app/utils/error';

type Candidate = SkillBundlesView['listings'][number];

/**
 * Bundles section of the Team marketplace tab: each bundle installs several of the org's approved
 * skills as one Claude Code plugin (server/skillMarket/bundles.ts). Org admins create and edit them.
 */
const ClaudeCodeBundles: FC<{ orgId: string; marketplace: string }> = ({ orgId, marketplace }) => {
  const { data, isPending, isError } = useSkillBundles(orgId);
  const remove = useDeleteSkillBundle(orgId);
  // `null` = closed, `'new'` = creating, else the bundle being edited.
  const [editing, setEditing] = useState<ISkillBundle | 'new' | null>(null);

  if (isPending) return <Typography level="body-xs">Loading bundles...</Typography>;
  if (isError || !data)
    return (
      <Typography level="body-xs" color="danger">
        Could not load bundles.
      </Typography>
    );
  if (!data.bundles.length && !data.canEdit) return null;
  // A member that lost approval or left the org drops out of the zip, so leave it out of the count.
  const memberCount = (bundle: ISkillBundle) =>
    bundle.listingIds.filter(id => data.listings.some(l => l.id === id)).length;

  return (
    <Stack spacing={1} data-testid="skill-claude-code-bundles">
      <Typography level="title-sm">Bundles</Typography>
      <Typography level="body-xs" textColor="text.tertiary">
        A bundle installs several approved skills at once, as one plugin.
      </Typography>
      {remove.isError ? (
        <Alert color="danger" variant="soft" data-testid="skill-claude-code-bundle-delete-error">
          {getErrorMessage(remove.error)}
        </Alert>
      ) : null}
      {data.bundles.map(bundle =>
        editing !== 'new' && editing?.id === bundle.id ? (
          <BundleEditor
            key={bundle.id}
            orgId={orgId}
            bundle={bundle}
            listings={data.listings}
            onDone={() => setEditing(null)}
          />
        ) : (
          <Sheet
            key={bundle.id}
            variant="outlined"
            sx={{ p: 1, borderRadius: 'sm' }}
            data-testid="skill-claude-code-bundle"
          >
            <Stack direction="row" alignItems="center" spacing={1}>
              <Typography level="title-sm" sx={{ flex: 1 }}>
                {bundle.name}
                <Typography level="body-xs" textColor="text.tertiary" sx={{ ml: 1 }}>
                  {memberCount(bundle)} {memberCount(bundle) === 1 ? 'skill' : 'skills'}
                </Typography>
              </Typography>
              {data.canEdit ? (
                <>
                  <IconButton
                    size="sm"
                    aria-label="Edit bundle"
                    onClick={() => setEditing(bundle)}
                    data-testid="skill-claude-code-bundle-edit"
                  >
                    <EditIcon />
                  </IconButton>
                  <IconButton
                    size="sm"
                    color="danger"
                    aria-label="Delete bundle"
                    disabled={remove.isPending}
                    onClick={() => {
                      if (
                        window.confirm(
                          `Delete "${bundle.name}"? It is removed for everyone who installed it, on their next marketplace update.`
                        )
                      ) {
                        remove.mutate(bundle.id);
                      }
                    }}
                    data-testid="skill-claude-code-bundle-delete"
                  >
                    <DeleteIcon />
                  </IconButton>
                </>
              ) : null}
            </Stack>
            <Typography level="body-xs">{bundle.description}</Typography>
            {memberCount(bundle) ? (
              <Typography component="pre" level="body-xs" sx={{ m: 0 }} data-testid="skill-claude-code-bundle-install">
                /plugin install {bundle.pluginName}@{marketplace}
              </Typography>
            ) : (
              <Typography level="body-xs" color="warning" data-testid="skill-claude-code-bundle-not-in-feed">
                Not in the feed: no approved skills.
              </Typography>
            )}
          </Sheet>
        )
      )}
      {editing === 'new' ? (
        <BundleEditor orgId={orgId} listings={data.listings} onDone={() => setEditing(null)} />
      ) : data.canEdit ? (
        <Button
          size="sm"
          variant="outlined"
          sx={{ alignSelf: 'flex-start' }}
          disabled={!data.listings.length}
          onClick={() => setEditing('new')}
          data-testid="skill-claude-code-bundle-new"
        >
          {data.listings.length ? 'New bundle' : 'New bundle (no approved organization skills yet)'}
        </Button>
      ) : null}
    </Stack>
  );
};

const BundleEditor: FC<{ orgId: string; bundle?: ISkillBundle; listings: Candidate[]; onDone: () => void }> = ({
  orgId,
  bundle,
  listings,
  onDone,
}) => {
  const save = useSaveSkillBundle(orgId);
  const [name, setName] = useState(bundle?.name ?? '');
  const [description, setDescription] = useState(bundle?.description ?? '');
  // A member that lost approval is kept but not shown in the picker.
  const hiddenIds = (bundle?.listingIds ?? []).filter(id => !listings.some(l => l.id === id));
  const [members, setMembers] = useState<Candidate[]>(() =>
    (bundle?.listingIds ?? []).flatMap(id => listings.filter(l => l.id === id))
  );
  const [error, setError] = useState<string | null>(null);

  const submit = () => {
    const input: SkillBundleInput = { name, description, listingIds: [...hiddenIds, ...members.map(m => m.id)] };
    save.mutate({ ...input, id: bundle?.id }, { onSuccess: onDone, onError: e => setError(getErrorMessage(e)) });
  };

  return (
    <Sheet variant="soft" sx={{ p: 1.5, borderRadius: 'sm' }} data-testid="skill-claude-code-bundle-editor">
      <Stack spacing={1}>
        <FormControl required>
          <FormLabel>Name</FormLabel>
          <Input
            value={name}
            onChange={e => setName(e.target.value)}
            slotProps={{ input: { maxLength: 64, 'data-testid': 'skill-claude-code-bundle-name' } }}
          />
          {bundle ? (
            <Typography level="body-xs" textColor="text.tertiary">
              The install name stays {bundle.pluginName}.
            </Typography>
          ) : null}
        </FormControl>
        <FormControl required>
          <FormLabel>Description</FormLabel>
          <Input
            value={description}
            onChange={e => setDescription(e.target.value)}
            slotProps={{ input: { maxLength: 500, 'data-testid': 'skill-claude-code-bundle-description' } }}
          />
        </FormControl>
        <FormControl>
          <FormLabel>Skills</FormLabel>
          <Autocomplete
            multiple
            options={listings}
            value={members}
            onChange={(_e, value) => setMembers(value)}
            getOptionLabel={o => o.name}
            isOptionEqualToValue={(a, b) => a.id === b.id}
            placeholder="Approved organization skills"
            slotProps={{ input: { 'data-testid': 'skill-claude-code-bundle-skills' } }}
          />
        </FormControl>
        {error ? (
          <Alert color="danger" variant="soft" data-testid="skill-claude-code-bundle-error">
            {error}
          </Alert>
        ) : null}
        <Stack direction="row" spacing={1} justifyContent="flex-end">
          <Button size="sm" variant="plain" onClick={onDone}>
            Cancel
          </Button>
          <Button
            size="sm"
            loading={save.isPending}
            disabled={!name.trim() || !description.trim() || !members.length}
            onClick={submit}
            data-testid="skill-claude-code-bundle-save"
          >
            Save
          </Button>
        </Stack>
      </Stack>
    </Sheet>
  );
};

export default ClaudeCodeBundles;
