import { ISecurityQuestion, IUserDocument, WithOrgRef } from '@bike4mind/common';
import AddCircleOutlineIcon from '@mui/icons-material/AddCircleOutline';
import DeleteIcon from '@mui/icons-material/Delete';
import LocationOn from '@mui/icons-material/LocationOn';
import { Box, Button, Card, Grid, IconButton, Input, Typography } from '@mui/joy';
import React, { useEffect, useState } from 'react';

import { useUpdateUser } from '@client/app/hooks/data/user';
import SaveAsIcon from '@mui/icons-material/SaveAs';
import Select from '../common/fields/Select';
import SingleOrganizationSelector from '@client/app/components/common/SingleOrganizationSelector';
import SectionContainer from '@client/app/components/ProfileModal/SectionContainer';

interface ProfileDataFormProps {
  userData: WithOrgRef<IUserDocument>;
  adminMode: boolean;
  onCancel?: () => void;
}

const ProfileDataForm: React.FC<ProfileDataFormProps> = ({ userData, adminMode, onCancel }) => {
  const [editUser, setEditUser] = useState<IUserDocument>({ ...userData, organizationId: userData.organizationId?.id });
  const [editing, setEditing] = useState(false);
  const [dirty, setDirty] = useState(false);
  const contactOptions = ['Text', 'Call', 'Email'];
  const shirtOptions = ['XS', 'S', 'M', 'L', 'XL', 'XXL'];
  const updateUser = useUpdateUser();

  useEffect(() => {
    // Skip resetting the form if the user has unsaved edits - a background
    // React Query refetch can update userData while the user is still editing.
    if (!dirty) {
      setEditUser({ ...userData, organizationId: userData.organizationId?.id });
    }
  }, [userData, dirty]);

  const handleChange = (event: React.ChangeEvent<HTMLInputElement>) => {
    const { name, value } = event.target;
    setDirty(true);
    setEditUser(prev => ({ ...prev, [name]: value }));
  };

  const handleGeolocation = () => {
    if (navigator.geolocation) {
      navigator.geolocation.getCurrentPosition(
        async position => {
          const { latitude, longitude } = position.coords;

          const response = await fetch(
            `https://api.bigdatacloud.net/data/reverse-geocode-client?latitude=${latitude}&longitude=${longitude}&localityLanguage=en`
          );
          const data = await response.json();

          setEditUser({ ...editUser, geoLocation: data.locality });
        },
        () => {
          alert('Unable to retrieve your location');
        }
      );
    }
  };

  const handlePhoneChange = (event: React.ChangeEvent<HTMLInputElement>) => {
    const { value } = event.target;
    let formattedInput = value.replace(/\D/g, '');
    if (formattedInput.length > 3) {
      formattedInput = `(${formattedInput.slice(0, 3)}) ${formattedInput.slice(3)}`;
    }
    if (formattedInput.length > 9) {
      formattedInput = `${formattedInput.slice(0, 9)}-${formattedInput.slice(9, 13)}`;
    }

    setDirty(true);
    setEditUser(prev => ({ ...prev, phone: formattedInput }));
  };

  const handlePreferredContact = (event: React.ChangeEvent | null, value: string) => {
    setDirty(true);
    setEditUser(prev => ({ ...prev, preferredContact: value }));
  };

  const handlePreferredShirt = (event: React.ChangeEvent | null, value: string) => {
    setDirty(true);
    setEditUser(prev => ({ ...prev, tshirtSize: value }));
  };

  const handleSecurityQuestionChange = (index: number, key: keyof ISecurityQuestion, value: string) => {
    const updatedQuestions = [...(editUser.securityQuestions || [])];
    if (updatedQuestions[index]) {
      updatedQuestions[index][key] = value;
    }
    setEditUser(prev => ({ ...prev, securityQuestions: updatedQuestions }));
  };

  const handleAddSecurityQuestion = () => {
    const newQuestion: ISecurityQuestion = { question: '', answer: '' };
    setEditUser(prev => ({
      ...prev,
      securityQuestions: [...(prev.securityQuestions || []), newQuestion],
    }));
  };

  const handleDeleteSecurityQuestion = (index: number) => {
    setEditUser(prev => ({
      ...prev,
      securityQuestions: prev.securityQuestions ? prev.securityQuestions?.filter((_, i) => i !== index) : [],
    }));
  };

  const handleSave = async () => {
    try {
      if (!editUser.id) {
        throw new Error('User ID not found');
      }

      // Destructure fields that shouldn't be updated from editUser to avoid sending them
      const { lastCreditsPurchasedAt, lastNotebookId, ...userDataToUpdate } = editUser;

      // Ensure arrays are initialized
      const dataToUpdate = {
        ...userDataToUpdate,
        userNotes: editUser.userNotes || [],
        // Convert boolean fields
        isAdmin: Boolean(editUser.isAdmin),
        isBanned: Boolean(editUser.isBanned),
        isModerated: Boolean(editUser.isModerated),
      };

      setEditing(true);
      setDirty(false);
      updateUser.mutate(
        {
          id: editUser.id,
          data: dataToUpdate,
        },
        { onSettled: () => setEditing(false) }
      );
    } catch (error) {
      console.error('Failed to update user:', error);
    }
  };
  return (
    <>
      <SectionContainer>
        <Grid className="profile-data-form-grid-container" container spacing={2} justifyContent="flex-start">
          <Grid className="profile-data-form-field-container" data-testid="profile-form-field" xs={12} sm={6} md={4}>
            <Typography className="profile-data-form-label" data-testid="profile-form-label">
              Name:
            </Typography>
            <Input
              className="profile-data-form-input"
              data-testid="profile-form-input-name"
              name="name"
              value={editUser.name || ''}
              onChange={handleChange}
              fullWidth
            />
          </Grid>
          <Grid className="profile-data-form-field-container" data-testid="profile-form-field" xs={12} sm={6} md={4}>
            <Typography className="profile-data-form-label" data-testid="profile-form-label">
              Username:
            </Typography>
            <Input
              className="profile-data-form-input"
              data-testid="profile-form-input-username"
              name="username"
              value={editUser.username || ''}
              fullWidth
              disabled
            />
          </Grid>
          {/* Email field removed - users must use ChangeEmailCard component for secure email verification flow */}
          {/* Admins can edit email through AdminProfileModal which uses adminMode={true} */}
          {adminMode && (
            <Grid className="profile-data-form-field-container" data-testid="profile-form-field" xs={12} sm={6} md={4}>
              <Typography className="profile-data-form-label" data-testid="profile-form-label">
                Email:
              </Typography>
              <Input
                className="profile-data-form-input"
                data-testid="profile-form-input-email"
                name="email"
                value={editUser.email || ''}
                onChange={handleChange}
                fullWidth
              />
            </Grid>
          )}
          <Grid className="profile-data-form-field-container" data-testid="profile-form-field" xs={12} sm={6} md={4}>
            <Typography className="profile-data-form-label" data-testid="profile-form-label">
              Organization:
            </Typography>
            <SingleOrganizationSelector
              currentOrgId={editUser.organizationId}
              onChange={orgId => setEditUser(prev => ({ ...prev, organizationId: orgId }))}
            />
          </Grid>
          <Grid className="profile-data-form-field-container" data-testid="profile-form-field" xs={12} sm={6} md={4}>
            <Typography className="profile-data-form-label" data-testid="profile-form-label">
              Team:
            </Typography>
            <Input
              className="profile-data-form-input"
              data-testid="profile-form-input-team"
              name="team"
              value={editUser.team || ''}
              onChange={handleChange}
              fullWidth
            />
          </Grid>
          <Grid className="profile-data-form-field-container" data-testid="profile-form-field" xs={12} sm={6} md={4}>
            <Typography className="profile-data-form-label" data-testid="profile-form-label">
              Role:
            </Typography>
            <Input
              className="profile-data-form-input"
              data-testid="profile-form-input-role"
              name="role"
              value={editUser.role || ''}
              onChange={handleChange}
              fullWidth
            />
          </Grid>
          <Grid className="profile-data-form-field-container" data-testid="profile-form-field" xs={12} sm={6} md={4}>
            <Typography className="profile-data-form-label" data-testid="profile-form-label">
              Phone:
            </Typography>
            <Input
              className="profile-data-form-input"
              data-testid="profile-form-input-phone"
              name="phone"
              value={editUser.phone || ''}
              onChange={handlePhoneChange}
              fullWidth
            />
          </Grid>
          <Grid className="profile-data-form-field-container" data-testid="profile-form-field" xs={12} sm={6} md={4}>
            <Typography className="profile-data-form-label" data-testid="profile-form-label">
              Preferred Contact:
            </Typography>
            <Select
              data-testid="profile-form-select"
              value={editUser.preferredContact}
              onSelect={(value: string | null) => handlePreferredContact(null, value as string)}
              options={contactOptions}
            />
          </Grid>
          <Grid className="profile-data-form-field-container" data-testid="profile-form-field" xs={12} sm={6} md={4}>
            <Typography className="profile-data-form-label" data-testid="profile-form-label">
              T-shirt Size:
            </Typography>
            <Select
              data-testid="profile-form-select"
              value={editUser.tshirtSize}
              onSelect={(value: string | null) => handlePreferredShirt(null, value as string)}
              options={shirtOptions}
            />
          </Grid>
          <Grid className="profile-data-form-field-container" data-testid="profile-form-field" xs={12} sm={6} md={4}>
            <Typography className="profile-data-form-label" data-testid="profile-form-label">
              Geo Location:
            </Typography>
            <Input
              placeholder="Your location"
              name="geoLocation"
              onChange={handleChange}
              fullWidth
              value={editUser.geoLocation || ''}
              startDecorator={
                <Button
                  className="profile-data-form-location-button"
                  variant="soft"
                  color="neutral"
                  startDecorator={<LocationOn sx={{ flexShrink: 0 }} />}
                  onClick={handleGeolocation}
                >
                  <span>Locate</span>
                </Button>
              }
            />
          </Grid>
          <Grid className="profile-data-form-field-container" data-testid="profile-form-field" xs={12}>
            <Typography className="profile-data-form-label" data-testid="profile-form-label">
              Security Questions:
            </Typography>
            <Card className="profile-data-form-security-card">
              <Grid container spacing={2} justifyContent="flex-start">
                {editUser.securityQuestions?.map((question, index) => (
                  <React.Fragment key={index}>
                    <Grid xs={12} sm={6} md={6}>
                      <Typography className="profile-data-form-question-label">Question {index + 1}:</Typography>
                      <Input
                        value={question.question}
                        onChange={e => handleSecurityQuestionChange(index, 'question', e.target.value)}
                        fullWidth
                      />
                    </Grid>
                    <Grid xs={10} sm={5} md={5}>
                      <Typography className="profile-data-form-answer-label">Answer {index + 1}:</Typography>
                      <Input
                        value={question.answer}
                        onChange={e => handleSecurityQuestionChange(index, 'answer', e.target.value)}
                        fullWidth
                      />
                    </Grid>
                    <Grid xs={2} sm={1} md={1} alignContent={'flex-end'}>
                      <IconButton
                        className="profile-data-form-delete-button"
                        color={'danger'}
                        onClick={() => handleDeleteSecurityQuestion(index)}
                      >
                        <DeleteIcon sx={{ flexShrink: 0 }} />
                      </IconButton>
                    </Grid>
                    {/* Button to add a new security question */}
                  </React.Fragment>
                ))}
                <Grid xs={12}>
                  <Button
                    className="profile-data-form-add-button"
                    startDecorator={<AddCircleOutlineIcon />}
                    onClick={handleAddSecurityQuestion}
                  >
                    Add Security Question
                  </Button>
                </Grid>
              </Grid>
            </Card>
          </Grid>
        </Grid>

        <Box
          sx={{
            display: 'flex',
            alignItems: {
              xs: 'stretch',
              sm: 'center',
            },
            gap: '1.25rem',
            justifyContent: 'end',
            flexDirection: {
              xs: 'column',
              sm: 'row',
            },
          }}
        >
          {onCancel && (
            <Button className="profile-data-form-cancel-button" color="neutral" variant="outlined" onClick={onCancel}>
              Cancel
            </Button>
          )}

          {/* Password change hidden - passwordless OTC login, no user passwords */}

          <Button
            className="profile-data-form-save-button"
            data-testid="profile-save-btn"
            disabled={editing}
            loading={updateUser.isPending}
            color="success"
            onClick={handleSave}
            startDecorator={<SaveAsIcon sx={{ flexShrink: 0 }} />}
          >
            Save Changes
          </Button>
        </Box>
      </SectionContainer>

      {/* All modals goes here: */}
    </>
  );
};

export default ProfileDataForm;
