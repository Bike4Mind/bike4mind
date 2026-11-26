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
import React, { useEffect, useMemo, useRef, useState } from 'react';
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
  RowActionsMenu,
} from '../shared';
import { ADMIN_REGION_GAP } from '../shared/adminStyles';

const columns: DataColumn<IInternalTeamMemberDocument>[] = [
  { id: 'name', label: 'Name', wrap: true, render: member => member.name },
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
  { id: 'email', label: 'Email', wrap: true, render: member => member.email || <Dash /> },
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
  const [refocusAfterDelete, setRefocusAfterDelete] = useState<{ id: string; index: number } | null>(null);
  const tableRef = useRef<HTMLDivElement>(null);
  const createButtonRef = useRef<HTMLButtonElement>(null);

  const sortedMembers = useMemo(
    () => [...(teamMembers ?? [])].sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base' })),
    [teamMembers]
  );
  const openCreateModal = () => setCreateModalOpen(true);

  // The removed row held the menu the dialog would return focus to, so move focus to the next row.
  useEffect(() => {
    if (!refocusAfterDelete || sortedMembers.some(member => member.id === refocusAfterDelete.id)) return;
    const rows = tableRef.current?.querySelectorAll<HTMLElement>('tr[data-row-id]');
    const target = rows?.length ? rows[Math.min(refocusAfterDelete.index, rows.length - 1)] : createButtonRef.current;
    target?.focus();
    setRefocusAfterDelete(null);
  }, [refocusAfterDelete, sortedMembers]);

  const openDeleteDialog = (member: IInternalTeamMemberDocument) => {
    setDeleteError(null);
    setPendingDelete(member);
  };

  const closeDeleteDialog = () => {
    if (deleteMember.isPending) return;
    setPendingDelete(null);
    setDeleteError(null);
  };

  const confirmDelete = async () => {
    if (!pendingDelete) return;
    setDeleteError(null);
    try {
      await deleteMember.mutateAsync(pendingDelete.id);
    } catch (err) {
      setDeleteError(err instanceof Error ? err.message : 'Failed to remove team member.');
      return;
    }
    setRefocusAfterDelete({
      id: pendingDelete.id,
      index: sortedMembers.findIndex(member => member.id === pendingDelete.id),
    });
    setPendingDelete(null);
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
              ref={createButtonRef}
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

      <div ref={tableRef} style={{ minWidth: 0 }}>
        <DataTable
          label="Team members"
          testId="team-members-table"
          rowTestId={member => `team-member-row-${member.id}`}
          rows={sortedMembers}
          columns={columns}
          getRowId={member => member.id}
          loading={isLoading}
          error={error && !teamMembers ? 'Could not load team members.' : undefined}
          onRetry={() => void refetch()}
          empty={
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
          }
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
                onClick={() => openDeleteDialog(member)}
              >
                Remove
              </MenuItem>
            </RowActionsMenu>
          )}
        />
      </div>
      <CreateTeamMemberDialog open={isCreateModalOpen} onClose={() => setCreateModalOpen(false)} />
      {editingMember && (
        <EditTeamMemberDialog key={editingMember.id} member={editingMember} onClose={() => setEditingMember(null)} />
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
      >
        {deleteError && (
          <Alert color="danger" variant="soft" data-testid="team-member-delete-error">
            {deleteError}
          </Alert>
        )}
      </ActionDialog>
    </Stack>
  );
};

type TeamMemberFormValues = {
  name: string;
  phone: string;
  email: string;
  role: string;
  department: string;
};

type TeamMemberPayload = {
  name: string;
  phone: string;
  email?: string;
  role?: string;
  department?: string;
};

const EMPTY_FORM: TeamMemberFormValues = { name: '', phone: '', email: '', role: '', department: '' };

const FORM_FIELDS: {
  key: keyof TeamMemberFormValues;
  label: string;
  placeholder: string;
  required?: boolean;
  fullWidth?: boolean;
}[] = [
  { key: 'name', label: 'Name', placeholder: 'Jane Doe', required: true },
  { key: 'phone', label: 'Phone', placeholder: '+1 555 123 4567', required: true },
  { key: 'email', label: 'Email', placeholder: 'name@company.com', fullWidth: true },
  { key: 'role', label: 'Role', placeholder: 'Lead' },
  { key: 'department', label: 'Department', placeholder: 'Ops' },
];

type TeamMemberFormDialogProps = {
  open: boolean;
  onClose: () => void;
  title: string;
  intro: string;
  submitLabel: string;
  pendingLabel: string;
  failureMessage: string;
  initialValues: TeamMemberFormValues;
  pending: boolean;
  onSubmit: (payload: TeamMemberPayload) => Promise<unknown>;
  dialogTestId: string;
  /** Field ids are `<prefix>-<field>-input`, plus `<prefix>-form-error` and `<prefix>-submit-btn`. */
  testIdPrefix: string;
};

const TeamMemberFormDialog: React.FC<TeamMemberFormDialogProps> = ({
  open,
  onClose,
  title,
  intro,
  submitLabel,
  pendingLabel,
  failureMessage,
  initialValues,
  pending,
  onSubmit,
  dialogTestId,
  testIdPrefix,
}) => {
  const [formValues, setFormValues] = useState(initialValues);
  const [formError, setFormError] = useState<string | null>(null);

  const handleInputChange = (field: keyof TeamMemberFormValues) => (event: React.ChangeEvent<HTMLInputElement>) => {
    setFormValues(prev => ({ ...prev, [field]: event.target.value }));
  };

  const handleClose = () => {
    if (pending) return;
    setFormValues(initialValues);
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
      await onSubmit({
        name: formValues.name.trim(),
        phone: formValues.phone.trim(),
        email: formValues.email.trim() || undefined,
        role: formValues.role.trim() || undefined,
        department: formValues.department.trim() || undefined,
      });
      setFormValues(initialValues);
      onClose();
    } catch (err) {
      setFormError(err instanceof Error ? err.message : failureMessage);
    }
  };

  return (
    <AdminDialog
      open={open}
      onClose={handleClose}
      closeDisabled={pending}
      title={title}
      width={500}
      anchorTop
      data-testid={dialogTestId}
    >
      <Typography level="body-sm" sx={{ mb: 2 }}>
        {intro}
      </Typography>
      <form onSubmit={handleSubmit}>
        <Stack spacing={2}>
          <Grid container spacing={2}>
            {FORM_FIELDS.map(field => (
              <Grid key={field.key} xs={12} sm={field.fullWidth ? 12 : 6}>
                <FormControl required={field.required}>
                  <FormLabel>{field.label}</FormLabel>
                  <Input
                    value={formValues[field.key]}
                    onChange={handleInputChange(field.key)}
                    placeholder={field.placeholder}
                    data-testid={`${testIdPrefix}-${field.key}-input`}
                  />
                </FormControl>
              </Grid>
            ))}
          </Grid>
          {formError && (
            <Alert color="danger" variant="soft" data-testid={`${testIdPrefix}-form-error`}>
              {formError}
            </Alert>
          )}
          <AdminDialogFooter>
            <Button variant="outlined" color="neutral" onClick={handleClose} disabled={pending}>
              Cancel
            </Button>
            <Button type="submit" loading={pending} data-testid={`${testIdPrefix}-submit-btn`}>
              {pending ? pendingLabel : submitLabel}
            </Button>
          </AdminDialogFooter>
        </Stack>
      </form>
    </AdminDialog>
  );
};

const CreateTeamMemberDialog: React.FC<{ open: boolean; onClose: () => void }> = ({ open, onClose }) => {
  const createMember = useCreateTeamMember();
  return (
    <TeamMemberFormDialog
      open={open}
      onClose={onClose}
      title="Create team member"
      intro="Fill in the details to add the teammate to the internal contact list."
      submitLabel="Create team member"
      pendingLabel="Creating..."
      failureMessage="Failed to add team member."
      initialValues={EMPTY_FORM}
      pending={createMember.isPending}
      onSubmit={payload => createMember.mutateAsync(payload)}
      dialogTestId="team-member-create-dialog"
      testIdPrefix="team-member"
    />
  );
};

const EditTeamMemberDialog: React.FC<{ member: IInternalTeamMemberDocument; onClose: () => void }> = ({
  member,
  onClose,
}) => {
  const updateMember = useUpdateTeamMember();
  const initialValues = useMemo(
    () => ({
      name: member.name,
      phone: member.phone,
      email: member.email || '',
      role: member.role || '',
      department: member.department || '',
    }),
    [member]
  );
  return (
    <TeamMemberFormDialog
      open
      onClose={onClose}
      title="Edit team member"
      intro="Update the details for this team member."
      submitLabel="Update team member"
      pendingLabel="Updating..."
      failureMessage="Failed to update team member."
      initialValues={initialValues}
      pending={updateMember.isPending}
      onSubmit={payload => updateMember.mutateAsync({ id: member.id, ...payload })}
      dialogTestId="team-member-edit-dialog"
      testIdPrefix="team-member-edit"
    />
  );
};

export default Team;
