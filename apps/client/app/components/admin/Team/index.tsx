import {
  Grid,
  Typography,
  Stack,
  Alert,
  FormControl,
  FormLabel,
  Input,
  Button,
  Chip,
  ListDivider,
  MenuItem,
} from '@mui/joy';
import React, { useMemo, useState } from 'react';
import AddIcon from '@mui/icons-material/Add';
import {
  useCreateTeamMember,
  useDeleteTeamMember,
  useGetTeamMembers,
  useUpdateTeamMember,
} from '@client/app/hooks/data/admin';
import { IInternalTeamMemberDocument } from '@bike4mind/common';
import ContextHelpButton from '@client/app/components/help/ContextHelpButton';
import {
  ActionDialog,
  AdminDialog,
  AdminDialogFooter,
  AdminPageHeader,
  Dash,
  DataTable,
  type DataColumn,
  EmptyState,
  ErrorState,
  LoadingState,
  RowActionsMenu,
} from '../shared';
import { ADMIN_REGION_GAP } from '../shared/adminStyles';

const columns: DataColumn<IInternalTeamMemberDocument>[] = [
  { id: 'name', label: 'Name', render: member => member.name },
  {
    id: 'phone',
    label: 'Phone',
    width: '11rem',
    render: member => (
      <Typography
        level="body-sm"
        component="a"
        href={`tel:${member.phone}`}
        sx={{ color: 'inherit', textDecoration: 'none', '&:hover': { textDecoration: 'underline' } }}
        data-testid={`team-member-phone-${member.id}`}
      >
        {member.phone}
      </Typography>
    ),
  },
  { id: 'email', label: 'Email', render: member => member.email || <Dash /> },
  {
    id: 'role',
    label: 'Role',
    width: '9rem',
    render: member =>
      member.role ? (
        <Chip
          size="sm"
          variant="soft"
          color="neutral"
          title={member.role}
          sx={{ maxWidth: '100%' }}
          data-testid={`team-member-role-${member.id}`}
        >
          {member.role}
        </Chip>
      ) : (
        <Dash />
      ),
  },
  {
    id: 'department',
    label: 'Department',
    width: '9rem',
    render: member =>
      member.department ? (
        <span data-testid={`team-member-department-${member.id}`}>{member.department}</span>
      ) : (
        <Dash />
      ),
  },
];

const Team: React.FC = () => {
  const { data: teamMembers, isLoading, error, refetch } = useGetTeamMembers();
  const deleteMember = useDeleteTeamMember();
  const [isCreateModalOpen, setCreateModalOpen] = useState(false);
  const [editingMember, setEditingMember] = useState<IInternalTeamMemberDocument | null>(null);
  const [pendingDelete, setPendingDelete] = useState<IInternalTeamMemberDocument | null>(null);
  const [deleteError, setDeleteError] = useState<string | null>(null);

  const sortedMembers = useMemo(
    () => [...(teamMembers ?? [])].sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base' })),
    [teamMembers]
  );
  const openCreateModal = () => setCreateModalOpen(true);

  const closeDeleteDialog = () => {
    if (!deleteMember.isPending) setPendingDelete(null);
  };

  const confirmDelete = async () => {
    if (!pendingDelete) return;
    setDeleteError(null);
    try {
      await deleteMember.mutateAsync(pendingDelete.id);
    } catch (err) {
      setDeleteError(err instanceof Error ? err.message : 'Failed to remove team member.');
    } finally {
      setPendingDelete(null);
    }
  };

  return (
    <Stack sx={{ gap: ADMIN_REGION_GAP, minWidth: 0 }} data-testid="admin-team-tab">
      <AdminPageHeader
        title="Team"
        count={teamMembers?.length}
        description="Internal contact list for User Ops."
        actions={
          <>
            <ContextHelpButton helpId="admin/team" tooltipText="Team help" />
            <Button
              size="sm"
              startDecorator={<AddIcon />}
              onClick={openCreateModal}
              data-testid="create-team-member-btn"
            >
              Create team member
            </Button>
          </>
        }
      />

      {deleteError && (
        <Alert color="danger" variant="soft" data-testid="team-member-delete-error">
          {deleteError}
        </Alert>
      )}

      {isLoading ? (
        <LoadingState label="Loading team members" testId="team-loading" />
      ) : error && !teamMembers ? (
        <ErrorState message="Could not load team members." onRetry={() => void refetch()} />
      ) : sortedMembers.length === 0 ? (
        <EmptyState
          title="No team members yet"
          description="Add a teammate's name and phone number so User Ops can reach them."
          action={
            <Button
              size="sm"
              variant="outlined"
              startDecorator={<AddIcon />}
              onClick={openCreateModal}
              data-testid="team-empty-create-btn"
            >
              Create team member
            </Button>
          }
        />
      ) : (
        <DataTable
          label="Team members"
          testId="team-members-table"
          rowTestId={member => `team-member-row-${member.id}`}
          rows={sortedMembers}
          columns={columns}
          getRowId={member => member.id}
          onRetry={() => void refetch()}
          onRowActivate={setEditingMember}
          minWidth="46rem"
          rowActions={member => (
            <RowActionsMenu
              testId={`team-member-actions-${member.id}`}
              ariaLabel={`Actions for ${member.name}`}
              stopRowClick
            >
              <MenuItem data-testid={`team-member-edit-btn-${member.id}`} onClick={() => setEditingMember(member)}>
                Edit
              </MenuItem>
              <ListDivider />
              <MenuItem
                color="danger"
                data-testid={`team-member-delete-btn-${member.id}`}
                onClick={() => setPendingDelete(member)}
              >
                Remove
              </MenuItem>
            </RowActionsMenu>
          )}
        />
      )}
      <CreateTeamMemberModal open={isCreateModalOpen} onClose={() => setCreateModalOpen(false)} />
      {editingMember && (
        <EditTeamMemberModal
          key={editingMember.id}
          member={editingMember}
          open={!!editingMember}
          onClose={() => setEditingMember(null)}
        />
      )}
      <ActionDialog
        open={!!pendingDelete}
        onClose={closeDeleteDialog}
        title="Remove team member"
        description={pendingDelete ? `Remove ${pendingDelete.name} from the team list?` : undefined}
        reasonPresets={[]}
        reasonRequired={false}
        confirmLabel="Remove"
        tone="danger"
        pending={deleteMember.isPending}
        onConfirm={confirmDelete}
        data-testid="team-member-delete-dialog"
        testIds={{ confirm: 'team-member-delete-confirm-btn' }}
      />
    </Stack>
  );
};

type CreateTeamMemberModalProps = {
  open: boolean;
  onClose: () => void;
};

const CreateTeamMemberModal: React.FC<CreateTeamMemberModalProps> = ({ open, onClose }) => {
  const createMember = useCreateTeamMember();
  const [formValues, setFormValues] = useState({
    name: '',
    phone: '',
    email: '',
    role: '',
    department: '',
  });
  const [formError, setFormError] = useState<string | null>(null);

  const handleInputChange = (field: keyof typeof formValues) => (event: React.ChangeEvent<HTMLInputElement>) => {
    setFormValues(prev => ({ ...prev, [field]: event.target.value }));
  };

  const resetForm = () => {
    setFormValues({
      name: '',
      phone: '',
      email: '',
      role: '',
      department: '',
    });
  };

  const handleClose = () => {
    if (createMember.isPending) return;
    resetForm();
    setFormError(null);
    onClose();
  };

  const handleSubmit = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setFormError(null);

    if (!formValues.name.trim() || !formValues.phone.trim()) {
      setFormError('Name and phone are required.');
      return;
    }

    try {
      await createMember.mutateAsync({
        name: formValues.name.trim(),
        phone: formValues.phone.trim(),
        email: formValues.email.trim() || undefined,
        role: formValues.role.trim() || undefined,
        department: formValues.department.trim() || undefined,
      });
      handleClose();
    } catch (err) {
      setFormError(err instanceof Error ? err.message : 'Failed to add team member.');
    }
  };

  return (
    <AdminDialog
      open={open}
      onClose={handleClose}
      closeDisabled={createMember.isPending}
      title="Create team member"
      width={500}
      anchorTop
      data-testid="team-member-create-dialog"
    >
      <Typography level="body-sm" sx={{ mb: 2 }}>
        Fill in the details to add the teammate to the internal contact list.
      </Typography>
      <form onSubmit={handleSubmit}>
        <Stack spacing={2}>
          <Grid container spacing={2}>
            <Grid xs={12} sm={6}>
              <FormControl required>
                <FormLabel>Name</FormLabel>
                <Input
                  value={formValues.name}
                  onChange={handleInputChange('name')}
                  placeholder="Jane Doe"
                  data-testid="team-member-name-input"
                />
              </FormControl>
            </Grid>
            <Grid xs={12} sm={6}>
              <FormControl required>
                <FormLabel>Phone</FormLabel>
                <Input
                  value={formValues.phone}
                  onChange={handleInputChange('phone')}
                  placeholder="+1 555 123 4567"
                  data-testid="team-member-phone-input"
                />
              </FormControl>
            </Grid>
            <Grid xs={12}>
              <FormControl>
                <FormLabel>Email</FormLabel>
                <Input
                  value={formValues.email}
                  onChange={handleInputChange('email')}
                  placeholder="name@company.com"
                  data-testid="team-member-email-input"
                />
              </FormControl>
            </Grid>
            <Grid xs={12} sm={6}>
              <FormControl>
                <FormLabel>Role</FormLabel>
                <Input
                  value={formValues.role}
                  onChange={handleInputChange('role')}
                  placeholder="Lead"
                  data-testid="team-member-role-input"
                />
              </FormControl>
            </Grid>
            <Grid xs={12} sm={6}>
              <FormControl>
                <FormLabel>Department</FormLabel>
                <Input
                  value={formValues.department}
                  onChange={handleInputChange('department')}
                  placeholder="Ops"
                  data-testid="team-member-department-input"
                />
              </FormControl>
            </Grid>
          </Grid>
          {formError && (
            <Alert color="danger" variant="soft" data-testid="team-member-form-error">
              {formError}
            </Alert>
          )}
          <AdminDialogFooter>
            <Button variant="outlined" color="neutral" onClick={handleClose} disabled={createMember.isPending}>
              Cancel
            </Button>
            <Button type="submit" loading={createMember.isPending} data-testid="team-member-submit-btn">
              {createMember.isPending ? 'Creating...' : 'Create team member'}
            </Button>
          </AdminDialogFooter>
        </Stack>
      </form>
    </AdminDialog>
  );
};

type EditTeamMemberModalProps = {
  open: boolean;
  member: IInternalTeamMemberDocument;
  onClose: () => void;
};

const EditTeamMemberModal: React.FC<EditTeamMemberModalProps> = ({ open, onClose, member }) => {
  const updateMember = useUpdateTeamMember();
  const [formValues, setFormValues] = useState({
    name: member.name,
    phone: member.phone,
    email: member.email || '',
    role: member.role || '',
    department: member.department || '',
  });
  const [formError, setFormError] = useState<string | null>(null);

  const handleInputChange = (field: keyof typeof formValues) => (event: React.ChangeEvent<HTMLInputElement>) => {
    setFormValues(prev => ({ ...prev, [field]: event.target.value }));
  };

  const handleClose = () => {
    if (updateMember.isPending) return;
    setFormError(null);
    onClose();
  };

  const handleSubmit = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setFormError(null);

    if (!formValues.name.trim() || !formValues.phone.trim()) {
      setFormError('Name and phone are required.');
      return;
    }

    try {
      await updateMember.mutateAsync({
        id: member.id,
        name: formValues.name.trim(),
        phone: formValues.phone.trim(),
        email: formValues.email.trim() || undefined,
        role: formValues.role.trim() || undefined,
        department: formValues.department.trim() || undefined,
      });
      handleClose();
    } catch (err) {
      setFormError(err instanceof Error ? err.message : 'Failed to update team member.');
    }
  };

  return (
    <AdminDialog
      open={open}
      onClose={handleClose}
      closeDisabled={updateMember.isPending}
      title="Edit team member"
      width={500}
      anchorTop
      data-testid="team-member-edit-dialog"
    >
      <Typography level="body-sm" sx={{ mb: 2 }}>
        Update the details for this team member.
      </Typography>
      <form onSubmit={handleSubmit}>
        <Stack spacing={2}>
          <Grid container spacing={2}>
            <Grid xs={12} sm={6}>
              <FormControl required>
                <FormLabel>Name</FormLabel>
                <Input
                  value={formValues.name}
                  onChange={handleInputChange('name')}
                  placeholder="Jane Doe"
                  data-testid="team-member-edit-name-input"
                />
              </FormControl>
            </Grid>
            <Grid xs={12} sm={6}>
              <FormControl required>
                <FormLabel>Phone</FormLabel>
                <Input
                  value={formValues.phone}
                  onChange={handleInputChange('phone')}
                  placeholder="+1 555 123 4567"
                  data-testid="team-member-edit-phone-input"
                />
              </FormControl>
            </Grid>
            <Grid xs={12}>
              <FormControl>
                <FormLabel>Email</FormLabel>
                <Input
                  value={formValues.email}
                  onChange={handleInputChange('email')}
                  placeholder="name@company.com"
                  data-testid="team-member-edit-email-input"
                />
              </FormControl>
            </Grid>
            <Grid xs={12} sm={6}>
              <FormControl>
                <FormLabel>Role</FormLabel>
                <Input
                  value={formValues.role}
                  onChange={handleInputChange('role')}
                  placeholder="Lead"
                  data-testid="team-member-edit-role-input"
                />
              </FormControl>
            </Grid>
            <Grid xs={12} sm={6}>
              <FormControl>
                <FormLabel>Department</FormLabel>
                <Input
                  value={formValues.department}
                  onChange={handleInputChange('department')}
                  placeholder="Ops"
                  data-testid="team-member-edit-department-input"
                />
              </FormControl>
            </Grid>
          </Grid>
          {formError && (
            <Alert color="danger" variant="soft" data-testid="team-member-edit-form-error">
              {formError}
            </Alert>
          )}
          <AdminDialogFooter>
            <Button variant="outlined" color="neutral" onClick={handleClose} disabled={updateMember.isPending}>
              Cancel
            </Button>
            <Button type="submit" loading={updateMember.isPending} data-testid="team-member-edit-submit-btn">
              {updateMember.isPending ? 'Updating...' : 'Update team member'}
            </Button>
          </AdminDialogFooter>
        </Stack>
      </form>
    </AdminDialog>
  );
};

export default Team;
