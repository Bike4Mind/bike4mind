import {
  Box,
  Card,
  Grid,
  Typography,
  Stack,
  CircularProgress,
  Alert,
  FormControl,
  FormLabel,
  Input,
  Button,
  IconButton,
  Divider,
  Chip,
  Tooltip,
  Modal,
  ModalDialog,
  DialogTitle,
  DialogContent,
  DialogActions,
} from '@mui/joy';
import React, { useMemo, useState } from 'react';
import PhoneIcon from '@mui/icons-material/Phone';
import PersonIcon from '@mui/icons-material/Person';
import DeleteIcon from '@mui/icons-material/Delete';
import EditIcon from '@mui/icons-material/Edit';
import AddIcon from '@mui/icons-material/Add';
import {
  useCreateTeamMember,
  useDeleteTeamMember,
  useGetTeamMembers,
  useUpdateTeamMember,
} from '@client/app/hooks/data/admin';
import { IInternalTeamMemberDocument } from '@bike4mind/common';
import ContextHelpButton from '@client/app/components/help/ContextHelpButton';

const Team: React.FC = () => {
  const { data: teamMembers = [], isLoading, error } = useGetTeamMembers();
  const deleteMember = useDeleteTeamMember();
  const [isCreateModalOpen, setCreateModalOpen] = useState(false);
  const [editingMember, setEditingMember] = useState<IInternalTeamMemberDocument | null>(null);
  const [deleteError, setDeleteError] = useState<string | null>(null);
  const [deletingId, setDeletingId] = useState<string | null>(null);

  const sortedMembers = useMemo(
    () => [...teamMembers].sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base' })),
    [teamMembers]
  );

  const handleDeleteMember = async (id: string, name: string) => {
    const shouldDelete = window.confirm(`Remove ${name} from the team list?`);
    if (!shouldDelete) return;

    setDeletingId(id);
    setDeleteError(null);
    try {
      await deleteMember.mutateAsync(id);
    } catch (err) {
      setDeleteError(err instanceof Error ? err.message : 'Failed to remove team member.');
    } finally {
      setDeletingId(null);
    }
  };

  if (isLoading) {
    return (
      <Box sx={{ p: 3, display: 'flex', justifyContent: 'center', alignItems: 'center', minHeight: '400px' }}>
        <CircularProgress />
      </Box>
    );
  }

  if (error) {
    return (
      <Box sx={{ p: 3 }}>
        <Alert color="danger" variant="soft">
          Failed to load team members. Please try again later.
        </Alert>
      </Box>
    );
  }

  return (
    <Box sx={{ p: 3 }}>
      <Stack direction={{ xs: 'column', sm: 'row' }} spacing={2} justifyContent="space-between" sx={{ mb: 3 }}>
        <Stack direction="row" spacing={1} alignItems="center">
          <Typography level="h2" sx={{ fontWeight: 'bold' }}>
            Team Members
          </Typography>
          <ContextHelpButton helpId="admin/team" tooltipText="Team Help" />
        </Stack>
        <Button
          startDecorator={<AddIcon />}
          onClick={() => setCreateModalOpen(true)}
          color="primary"
          sx={{ minWidth: { xs: '100%', sm: 'auto' } }}
          data-testid="create-team-member-btn"
        >
          Create Team Member
        </Button>
      </Stack>
      <Typography level="body-md" sx={{ mb: 4, color: 'text.secondary' }}>
        Manage the internal contact list for User Ops.
      </Typography>

      {deleteError && (
        <Alert color="danger" variant="soft" sx={{ mb: 3 }} data-testid="team-member-delete-error">
          {deleteError}
        </Alert>
      )}

      {sortedMembers.length === 0 ? (
        <Alert color="neutral" variant="soft">
          No team members found. Use the Create Team Member button to add someone new.
        </Alert>
      ) : (
        <Grid container spacing={2}>
          {sortedMembers.map(member => (
            <Grid xs={12} sm={6} md={4} lg={3} key={member.id}>
              <Card
                variant="outlined"
                sx={{
                  p: 2,
                  height: '100%',
                  display: 'flex',
                  flexDirection: 'column',
                  justifyContent: 'space-between',
                  transition: 'all 0.2s ease',
                  '&:hover': {
                    boxShadow: 'md',
                    transform: 'translateY(-2px)',
                  },
                }}
                data-testid={`team-member-card-${member.id}`}
              >
                <Stack spacing={1.5}>
                  <Stack direction="row" spacing={1} alignItems="center" justifyContent="space-between">
                    <Stack direction="row" spacing={1} alignItems="center">
                      <PersonIcon sx={{ color: 'primary.500', fontSize: 20 }} />
                      <Typography level="title-md" sx={{ fontWeight: 600 }}>
                        {member.name}
                      </Typography>
                    </Stack>
                    <Stack direction="row" spacing={0.5}>
                      <Tooltip title="Edit member">
                        <span>
                          <IconButton
                            size="sm"
                            variant="soft"
                            color="primary"
                            onClick={() => setEditingMember(member)}
                            data-testid={`team-member-edit-btn-${member.id}`}
                          >
                            <EditIcon fontSize="small" />
                          </IconButton>
                        </span>
                      </Tooltip>
                      <Tooltip title="Remove member">
                        <span>
                          <IconButton
                            size="sm"
                            variant="soft"
                            color="danger"
                            onClick={() => handleDeleteMember(member.id, member.name)}
                            disabled={deleteMember.isPending && deletingId === member.id}
                            data-testid={`team-member-delete-btn-${member.id}`}
                          >
                            <DeleteIcon fontSize="small" />
                          </IconButton>
                        </span>
                      </Tooltip>
                    </Stack>
                  </Stack>
                  <Stack direction="row" spacing={1} alignItems="center">
                    <PhoneIcon sx={{ color: 'success.500', fontSize: 18 }} />
                    <Typography
                      level="body-sm"
                      component="a"
                      href={`tel:${member.phone}`}
                      sx={{
                        color: 'text.secondary',
                        textDecoration: 'none',
                        '&:hover': {
                          color: 'primary.500',
                          textDecoration: 'underline',
                        },
                      }}
                      data-testid={`team-member-phone-${member.id}`}
                    >
                      {member.phone}
                    </Typography>
                  </Stack>
                  {(member.email || member.role || member.department) && <Divider />}
                  <Stack spacing={0.5}>
                    {member.email && (
                      <Typography level="body-sm" sx={{ color: 'text.secondary' }}>
                        {member.email}
                      </Typography>
                    )}
                    <Stack direction="row" spacing={1} sx={{ flexWrap: 'wrap' }}>
                      {member.role && (
                        <Chip size="sm" variant="soft" color="primary" data-testid={`team-member-role-${member.id}`}>
                          {member.role}
                        </Chip>
                      )}
                      {member.department && (
                        <Chip
                          size="sm"
                          variant="soft"
                          color="neutral"
                          data-testid={`team-member-department-${member.id}`}
                        >
                          {member.department}
                        </Chip>
                      )}
                    </Stack>
                  </Stack>
                </Stack>
              </Card>
            </Grid>
          ))}
        </Grid>
      )}
      <CreateTeamMemberModal open={isCreateModalOpen} onClose={() => setCreateModalOpen(false)} />
      {editingMember && (
        <EditTeamMemberModal member={editingMember} open={!!editingMember} onClose={() => setEditingMember(null)} />
      )}
    </Box>
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
    <Modal open={open} onClose={handleClose}>
      <ModalDialog sx={{ width: 500 }}>
        <DialogTitle>Create Team Member</DialogTitle>
        <DialogContent>Fill in the details to add the teammate to the internal contact list.</DialogContent>
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
            <DialogActions sx={{ justifyContent: 'flex-end' }}>
              <Button variant="outlined" color="neutral" onClick={handleClose} disabled={createMember.isPending}>
                Cancel
              </Button>
              <Button type="submit" loading={createMember.isPending} data-testid="team-member-submit-btn">
                {createMember.isPending ? 'Creating...' : 'Create Team Member'}
              </Button>
            </DialogActions>
          </Stack>
        </form>
      </ModalDialog>
    </Modal>
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

  React.useEffect(() => {
    setFormValues({
      name: member.name,
      phone: member.phone,
      email: member.email || '',
      role: member.role || '',
      department: member.department || '',
    });
  }, [member]);

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
    <Modal open={open} onClose={handleClose}>
      <ModalDialog sx={{ width: 500 }}>
        <DialogTitle>Edit Team Member</DialogTitle>
        <DialogContent>Update the details for this team member.</DialogContent>
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
            <DialogActions sx={{ justifyContent: 'flex-end' }}>
              <Button variant="outlined" color="neutral" onClick={handleClose} disabled={updateMember.isPending}>
                Cancel
              </Button>
              <Button type="submit" loading={updateMember.isPending} data-testid="team-member-edit-submit-btn">
                {updateMember.isPending ? 'Updating...' : 'Update Team Member'}
              </Button>
            </DialogActions>
          </Stack>
        </form>
      </ModalDialog>
    </Modal>
  );
};

export default Team;
