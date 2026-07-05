import { useUser } from '@client/app/contexts/UserContext';
import { useGetUserActivityCounters, useUpdateUser } from '@client/app/hooks/data/user';
import { IUserDocument, IUserNote } from '@bike4mind/common';
import DeleteOutline from '@mui/icons-material/DeleteOutline';
import SaveIcon from '@mui/icons-material/Save';
import AdminPanelSettingsIcon from '@mui/icons-material/AdminPanelSettings';
import AddIcon from '@mui/icons-material/Add';
import { Box, Button, Stack, Textarea, Typography, Tooltip } from '@mui/joy';
import Link from 'next/link';
import React, { useEffect, useState } from 'react';
import SectionContainer from '@client/app/components/ProfileModal/SectionContainer';
import { red } from '@client/app/utils/themes/colors';

interface ProfileDataFormProps {
  userData: IUserDocument;
}

const AdminDataForm: React.FC<ProfileDataFormProps> = ({ userData }) => {
  const [editUser, setEditUser] = useState<IUserDocument>({ ...userData });

  const { currentUser, isAdmin, isDeveloper } = useUser();
  const updateUser = useUpdateUser();
  const userActivityCounters = useGetUserActivityCounters(currentUser?.id);

  useEffect(() => {
    setEditUser({ ...userData });
  }, [userData]);

  const handleNoteChange = (index: number, value: string) => {
    const updatedNotes = editUser.userNotes ? [...editUser.userNotes] : [];
    if (updatedNotes[index]) {
      updatedNotes[index].note = value;
    }
    setEditUser(prev => ({ ...prev, userNotes: updatedNotes }));
  };

  const handleDeleteNote = (index: number) => {
    const filteredNotes = editUser.userNotes?.filter((_, noteIndex) => noteIndex !== index) || [];
    setEditUser(prev => ({ ...prev, userNotes: filteredNotes }));
  };

  const handleAddNote = () => {
    const newNote: IUserNote = {
      note: '',
      timestamp: new Date().toISOString(),
      userName: currentUser?.username || 'unknown',
    };
    setEditUser(prev => ({
      ...prev,
      userNotes: [...(prev.userNotes || []), newNote],
    }));
  };

  const handleSave = async () => {
    if (!editUser.id) return;

    // Destructure fields that shouldn't be updated from editUser to avoid sending them
    const { lastCreditsPurchasedAt, lastNotebookId, ...userDataToUpdate } = editUser;

    // Coerce legacy numeric 0/1 flags to real booleans (isAdmin, isBanned, isModerated).
    const booleanFields = ['isAdmin', 'isBanned', 'isModerated'];
    booleanFields.forEach(field => {
      if (typeof (userDataToUpdate as any)[field] === 'number') {
        (userDataToUpdate as any)[field] = (userDataToUpdate as any)[field] === 1;
      }
    });

    // Ensure arrays are initialized
    const dataToUpdate = {
      ...userDataToUpdate,
      userNotes: userDataToUpdate.userNotes || [],
      isAdmin: Boolean(userDataToUpdate.isAdmin),
      isBanned: Boolean(userDataToUpdate.isBanned),
      isModerated: Boolean(userDataToUpdate.isModerated),
    };

    updateUser.mutate({ id: editUser.id, data: dataToUpdate });
  };

  return (
    <Stack spacing={3}>
      <SectionContainer>
        {/* Header Row with Title and Action Buttons */}
        <Box sx={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
          <Typography level="title-md">{editUser.name} Admin Settings</Typography>
          <Box sx={{ display: 'flex', gap: 2, alignItems: 'center' }}>
            {isDeveloper && (
              <Link href="/admin">
                <Button color="primary" startDecorator={<AdminPanelSettingsIcon />}>
                  Admin Dashboard
                </Button>
              </Link>
            )}
          </Box>
        </Box>

        {isAdmin && (
          <Box
            sx={theme => ({
              display: 'flex',
              flexDirection: 'column',
              gap: '20px',
              padding: '1.25rem',
              backgroundColor: theme.palette.mode === 'light' ? '#FFFFFF' : theme.palette.background.body,
              border: '1px solid',
              borderColor: theme.palette.mode === 'light' ? 'rgba(190, 209, 223, 0.7)' : 'border.light',
              borderRadius: '8px',
            })}
          >
            <Box sx={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
              <Typography level="body-md" sx={{ fontSize: '18px', color: 'text.primary' }}>
                Notes
              </Typography>
              <Tooltip title="Save Changes">
                <Button
                  color="success"
                  onClick={handleSave}
                  loading={updateUser.isPending}
                  startDecorator={<SaveIcon />}
                >
                  Save Changes
                </Button>
              </Tooltip>
            </Box>

            {editUser.userNotes?.map((note, index) => (
              <Box
                key={index}
                sx={{
                  display: 'flex',
                  flexDirection: 'column',
                  gap: '8px',
                }}
              >
                <Typography>
                  <Typography component="span" sx={{ color: 'text.primary', fontSize: '14px' }}>
                    Note {index + 1}
                  </Typography>
                  <Typography component="span" sx={{ color: 'text.primary', opacity: 0.5, fontSize: '14px' }}>
                    {' '}
                    (Last updated by {note.userName} on {new Date(note.timestamp).toLocaleString()})
                  </Typography>
                </Typography>

                <Box sx={{ display: 'flex', gap: '12px', alignItems: 'flex-start' }}>
                  <Textarea
                    value={note.note}
                    onChange={e => handleNoteChange(index, e.target.value)}
                    sx={{
                      flex: 1,
                      color: 'text.primary',
                      boxShadow: 'none',
                      '&:hover': {
                        boxShadow: 'none',
                      },
                      '&:focus': {
                        boxShadow: 'none',
                      },
                    }}
                  />
                  <Tooltip title="Delete a Note">
                    <Button
                      color="danger"
                      variant="outlined"
                      onClick={() => handleDeleteNote(index)}
                      sx={{
                        padding: '8px',
                        border: '1px solid',
                        borderColor: 'neutral.outlinedBorder',
                        color: 'neutral.outlinedColor',
                        width: '36px !important',
                        height: '36px !important',
                        minWidth: '36px !important',
                        minHeight: '36px !important',
                        borderRadius: '6px',
                        '&:hover': {
                          backgroundColor: 'neutral.outlinedHoverBg',
                          borderColor: 'neutral.outlinedHoverBorder',
                        },
                      }}
                    >
                      <DeleteOutline sx={{ fontSize: '18px', color: red[400] }} />
                    </Button>
                  </Tooltip>
                </Box>
              </Box>
            ))}

            <Box sx={{ display: 'flex', justifyContent: 'flex-start' }}>
              <Button
                startDecorator={<AddIcon sx={{ fontSize: 16 }} />}
                onClick={handleAddNote}
                variant="outlined"
                color="neutral"
                sx={{
                  color: 'text.primary',
                  '& .MuiButton-startDecorator': {
                    color: 'text.primary',
                  },
                }}
              >
                Add User Note
              </Button>
            </Box>
          </Box>
        )}
      </SectionContainer>

      {/* Separate Counters Frame */}
      {isDeveloper && (
        <SectionContainer>
          <Box sx={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
            <Typography level="title-md">Counters</Typography>
          </Box>

          <Box
            sx={theme => ({
              display: 'flex',
              flexDirection: 'column',
              gap: '20px',
              padding: '1.25rem',
              backgroundColor: theme.palette.mode === 'light' ? '#FFFFFF' : theme.palette.background.body,
              border: '1px solid',
              borderColor: theme.palette.mode === 'light' ? 'rgba(190, 209, 223, 0.7)' : 'border.light',
              borderRadius: '8px',
            })}
          >
            {(userActivityCounters?.data ?? [])?.length > 0 ? (
              <Box
                sx={{
                  display: 'flex',
                  flexWrap: 'wrap',
                  gap: '20px',
                  maxHeight: '40vh',
                  overflow: 'scroll',
                  wordBreak: 'break-word',
                }}
              >
                {(userActivityCounters.data ?? [])?.map((counter, index) => (
                  <Typography key={index} sx={{ color: 'text.primary', fontSize: '14px' }}>
                    <Typography component="span" sx={{ opacity: 0.5 }}>
                      {counter.action}:
                    </Typography>
                    <Typography component="span" sx={{ fontWeight: 600 }}>
                      {' '}
                      {counter.count}
                    </Typography>
                    {counter.tags && counter.tags.length > 0 && (
                      <Typography component="span" sx={{ opacity: 0.5 }}>
                        {' '}
                        ({counter.tags.join(', ')})
                      </Typography>
                    )}
                  </Typography>
                ))}
              </Box>
            ) : (
              <Typography>No counters available</Typography>
            )}
          </Box>
        </SectionContainer>
      )}

      {/* Separate Logins Frame */}
      {isDeveloper && (
        <SectionContainer>
          <Box sx={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
            <Typography level="title-md">Login Records: [{currentUser?.loginRecords?.length}]</Typography>
          </Box>

          <Box
            sx={theme => ({
              display: 'flex',
              flexWrap: 'wrap',
              gap: '20px',
              maxHeight: '75vh',
              overflowY: 'scroll',
              overflowX: 'hidden',
              wordBreak: 'break-word',
              paddingRight: '12px', // Add space between content and scrollbar
              '&::-webkit-scrollbar-thumb': {
                backgroundColor: theme.palette.background.scrollbar,
                border: `2px solid ${theme.palette.background.scrollbarTrack}`,
                borderRadius: '20px',
              },
              '&::-webkit-scrollbar': {
                width: '8px',
              },
              '&::-webkit-scrollbar-track': {
                backgroundColor: theme.palette.background.scrollbarTrack,
              },
            })}
          >
            {currentUser?.loginRecords && currentUser.loginRecords.length > 0 ? (
              currentUser.loginRecords.map((record, index) => (
                <Box
                  key={index}
                  sx={theme => ({
                    display: 'flex',
                    flexDirection: 'column',
                    gap: '20px',
                    padding: '1.25rem',
                    backgroundColor: theme.palette.mode === 'light' ? '#FFFFFF' : theme.palette.background.body,
                    border: '1px solid',
                    borderColor: theme.palette.mode === 'light' ? 'rgba(190, 209, 223, 0.7)' : 'border.light',
                    borderRadius: '8px',
                    minWidth: '300px',
                  })}
                >
                  <Typography level="body-md" sx={{ fontSize: '18px', color: 'text.primary' }}>
                    {record.loginTime ? new Date(record.loginTime).toLocaleString() : 'Unknown Time'}
                  </Typography>

                  <Box sx={{ display: 'flex', flexWrap: 'wrap', gap: '20px' }}>
                    <Typography sx={{ color: 'text.primary', fontSize: '14px' }}>
                      <Typography component="span" sx={{ opacity: 0.5 }}>
                        Screen Resolution:
                      </Typography>
                      <Typography component="span" sx={{ fontWeight: 600 }}>
                        {' '}
                        {record.screenResolution || 'N/A'}
                      </Typography>
                    </Typography>

                    <Typography sx={{ color: 'text.primary', fontSize: '14px' }}>
                      <Typography component="span" sx={{ opacity: 0.5 }}>
                        Location:
                      </Typography>
                      <Typography component="span" sx={{ fontWeight: 600 }}>
                        {' '}
                        {record.location || 'N/A'}
                      </Typography>
                    </Typography>

                    <Typography sx={{ color: 'text.primary', fontSize: '14px' }}>
                      <Typography component="span" sx={{ opacity: 0.5 }}>
                        Logout Time:
                      </Typography>
                      <Typography component="span" sx={{ fontWeight: 600 }}>
                        {' '}
                        {record.logoutTime ? new Date(record.logoutTime).toLocaleString() : 'N/A'}
                      </Typography>
                    </Typography>

                    <Typography sx={{ color: 'text.primary', fontSize: '14px' }}>
                      <Typography component="span" sx={{ opacity: 0.5 }}>
                        Network:
                      </Typography>
                      <Typography component="span" sx={{ fontWeight: 600 }}>
                        {' '}
                        {record.networkType || 'N/A'}
                      </Typography>
                    </Typography>

                    <Typography sx={{ color: 'text.primary', fontSize: '14px' }}>
                      <Typography component="span" sx={{ opacity: 0.5 }}>
                        Device:
                      </Typography>
                      <Typography component="span" sx={{ fontWeight: 600 }}>
                        {' '}
                        {record.deviceType || 'N/A'}
                      </Typography>
                    </Typography>

                    <Typography sx={{ color: 'text.primary', fontSize: '14px' }}>
                      <Typography component="span" sx={{ opacity: 0.5 }}>
                        Browser:
                      </Typography>
                      <Typography component="span" sx={{ fontWeight: 600 }}>
                        {' '}
                        {record.browser || 'N/A'}
                      </Typography>
                    </Typography>

                    <Typography sx={{ color: 'text.primary', fontSize: '14px' }}>
                      <Typography component="span" sx={{ opacity: 0.5 }}>
                        IP:
                      </Typography>
                      <Typography component="span" sx={{ fontWeight: 600 }}>
                        {' '}
                        {record.ip || 'N/A'}
                      </Typography>
                    </Typography>

                    <Typography sx={{ color: 'text.primary', fontSize: '14px' }}>
                      <Typography component="span" sx={{ opacity: 0.5 }}>
                        OS:
                      </Typography>
                      <Typography component="span" sx={{ fontWeight: 600 }}>
                        {' '}
                        {record.operatingSystem || 'N/A'}
                      </Typography>
                    </Typography>
                  </Box>
                </Box>
              ))
            ) : (
              <Typography>No login records available</Typography>
            )}
          </Box>
        </SectionContainer>
      )}
    </Stack>
  );
};

export default AdminDataForm;
