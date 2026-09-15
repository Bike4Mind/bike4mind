import { FC, useState } from 'react';
import {
  Alert,
  Box,
  Button,
  Checkbox,
  Chip,
  Divider,
  FormControl,
  FormLabel,
  IconButton,
  Input,
  List,
  ListItem,
  Modal,
  ModalClose,
  ModalDialog,
  Stack,
  Switch,
  Typography,
} from '@mui/joy';
import DeleteIcon from '@mui/icons-material/Delete';
import PersonAddIcon from '@mui/icons-material/PersonAdd';
import { Permission } from '@bike4mind/common';
import { ISkillWithSharing, lookupUserByEmail, useUpdateSkillSharing } from '@client/app/hooks/data/skills';

/** Permissions a user can be granted on a skill, in display order. */
const ASSIGNABLE_PERMISSIONS: Permission[] = [Permission.read, Permission.update, Permission.delete, Permission.share];

const PERMISSION_LABEL: Record<Permission, string> = {
  [Permission.read]: 'View',
  [Permission.update]: 'Edit',
  [Permission.delete]: 'Delete',
  [Permission.share]: 'Share',
  [Permission.create]: 'Create',
};

/** A share row in local editing state - carries display info for newly-added users. */
type ShareRow = {
  userId: string;
  permissions: Permission[];
  /** Human-readable label resolved at add time; existing shares fall back to userId. */
  label: string;
};

interface SkillShareDialogProps {
  /** Called to close the dialog. The parent unmounts on close, so local edits
   *  are discarded on cancel + reopen without an effect to re-seed state. */
  onClose: () => void;
  skill: ISkillWithSharing;
}

const SkillShareDialog: FC<SkillShareDialogProps> = ({ onClose, skill }) => {
  const updateSharing = useUpdateSkillSharing();

  // Seed local editing state from the skill once, at mount. The parent renders
  // this component only while the dialog is open, so reopening remounts with
  // fresh props - no prop->state sync effect needed.
  const [rows, setRows] = useState<ShareRow[]>(() =>
    (skill.users ?? []).map(u => ({
      userId: u.userId,
      permissions: u.permissions ?? [],
      label: u.user?.email ?? u.user?.name ?? u.userId,
    }))
  );
  const [isGlobalRead, setIsGlobalRead] = useState(() => skill.isGlobalRead ?? false);
  const [isGlobalWrite, setIsGlobalWrite] = useState(() => skill.isGlobalWrite ?? false);
  const [email, setEmail] = useState('');
  const [isLooking, setIsLooking] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleAddUser = async () => {
    const trimmed = email.trim();
    if (!trimmed) return;
    setError(null);
    setIsLooking(true);
    try {
      const user = await lookupUserByEmail(trimmed);
      if (!user) {
        setError(`No user found with email "${trimmed}"`);
        return;
      }
      if (user.id === skill.userId) {
        setError('The owner already has full access');
        return;
      }
      if (rows.some(r => r.userId === user.id)) {
        setError('That user is already on the share list');
        return;
      }
      setRows(prev => [
        ...prev,
        { userId: user.id, permissions: [Permission.read], label: user.email ?? user.name ?? user.id },
      ]);
      setEmail('');
    } catch {
      setError('Failed to look up that user. Try again.');
    } finally {
      setIsLooking(false);
    }
  };

  const togglePermission = (userId: string, permission: Permission) => {
    setRows(prev =>
      prev.map(row => {
        if (row.userId !== userId) return row;
        const has = row.permissions.includes(permission);
        return {
          ...row,
          permissions: has ? row.permissions.filter(p => p !== permission) : [...row.permissions, permission],
        };
      })
    );
  };

  const removeUser = (userId: string) => {
    setRows(prev => prev.filter(r => r.userId !== userId));
  };

  const handleSave = async () => {
    setError(null);
    try {
      await updateSharing.mutateAsync({
        id: skill.id,
        // Drop rows with no permissions - the server requires at least one, and
        // an empty row is the user's way of saying "remove this share".
        users: rows.filter(r => r.permissions.length > 0).map(r => ({ userId: r.userId, permissions: r.permissions })),
        isGlobalRead,
        isGlobalWrite,
      });
      onClose();
    } catch {
      setError('Failed to save sharing changes. Try again.');
    }
  };

  return (
    <Modal open onClose={onClose}>
      <ModalDialog sx={{ width: 560, maxWidth: '90vw' }} data-testid="skill-share-dialog">
        <ModalClose />
        <Typography level="h4">Share /{skill.name}</Typography>
        <Typography level="body-sm" textColor="text.tertiary" sx={{ mb: 1 }}>
          Grant other people access to this skill, or make it readable by everyone.
        </Typography>

        <Stack spacing={2}>
          <FormControl>
            <FormLabel>Add a person by email</FormLabel>
            <Stack direction="row" spacing={1}>
              <Input
                value={email}
                onChange={e => setEmail(e.target.value)}
                onKeyDown={e => {
                  if (e.key === 'Enter') {
                    e.preventDefault();
                    void handleAddUser();
                  }
                }}
                placeholder="person@example.com"
                sx={{ flex: 1 }}
                data-testid="skill-share-email-input"
              />
              <Button
                onClick={() => void handleAddUser()}
                loading={isLooking}
                startDecorator={<PersonAddIcon />}
                data-testid="skill-share-add-btn"
              >
                Add
              </Button>
            </Stack>
          </FormControl>

          {error ? (
            <Alert color="danger" size="sm" data-testid="skill-share-error">
              {error}
            </Alert>
          ) : null}

          {rows.length > 0 ? (
            <List sx={{ '--ListItem-paddingY': '8px' }}>
              {rows.map(row => (
                <ListItem key={row.userId} data-testid={`skill-share-user-${row.userId}`}>
                  <Stack spacing={1} sx={{ width: '100%' }}>
                    <Stack direction="row" alignItems="center" justifyContent="space-between">
                      <Typography level="body-sm" sx={{ fontWeight: 'md', wordBreak: 'break-all' }}>
                        {row.label}
                      </Typography>
                      <IconButton
                        size="sm"
                        variant="plain"
                        color="danger"
                        onClick={() => removeUser(row.userId)}
                        data-testid={`skill-share-remove-${row.userId}`}
                      >
                        <DeleteIcon />
                      </IconButton>
                    </Stack>
                    <Stack direction="row" spacing={2} flexWrap="wrap">
                      {ASSIGNABLE_PERMISSIONS.map(permission => (
                        <Checkbox
                          key={permission}
                          size="sm"
                          label={PERMISSION_LABEL[permission]}
                          checked={row.permissions.includes(permission)}
                          onChange={() => togglePermission(row.userId, permission)}
                          data-testid={`skill-share-perm-${row.userId}-${permission}`}
                        />
                      ))}
                    </Stack>
                  </Stack>
                </ListItem>
              ))}
            </List>
          ) : (
            <Typography level="body-sm" textColor="text.tertiary">
              Not shared with anyone yet.
            </Typography>
          )}

          <Divider />

          <Stack spacing={1}>
            <Stack direction="row" alignItems="center" justifyContent="space-between">
              <Box>
                <Typography level="title-sm">Anyone can view</Typography>
                <Typography level="body-xs" textColor="text.tertiary">
                  Every signed-in user can find and run this skill.
                </Typography>
              </Box>
              <Switch
                checked={isGlobalRead}
                onChange={e => {
                  const next = e.target.checked;
                  setIsGlobalRead(next);
                  if (!next) setIsGlobalWrite(false); // write implies read
                }}
                data-testid="skill-share-global-read"
              />
            </Stack>
            <Stack direction="row" alignItems="center" justifyContent="space-between">
              <Box>
                <Typography level="title-sm">Anyone can edit</Typography>
                <Typography level="body-xs" textColor="text.tertiary">
                  Every signed-in user can modify this skill. Use with care.
                </Typography>
              </Box>
              <Switch
                checked={isGlobalWrite}
                onChange={e => {
                  const next = e.target.checked;
                  setIsGlobalWrite(next);
                  if (next) setIsGlobalRead(true); // write implies read
                }}
                data-testid="skill-share-global-write"
              />
            </Stack>
          </Stack>

          {isGlobalWrite ? (
            <Chip size="sm" color="warning" data-testid="skill-share-global-write-warning">
              Global write lets anyone change these skill instructions.
            </Chip>
          ) : null}

          <Stack direction="row" justifyContent="flex-end" spacing={1}>
            <Button variant="plain" color="neutral" onClick={onClose}>
              Cancel
            </Button>
            <Button
              onClick={() => void handleSave()}
              loading={updateSharing.isPending}
              data-testid="skill-share-save-btn"
            >
              Save
            </Button>
          </Stack>
        </Stack>
      </ModalDialog>
    </Modal>
  );
};

export default SkillShareDialog;
