import ProfileDataForm from '@client/app/components/ProfileModal/ProfileDataForm';
import SectionContainer from '@client/app/components/ProfileModal/SectionContainer';
import { useGetUser } from '@client/app/hooks/data/user';
import { Avatar, Box, IconButton, Button, Typography, LinearProgress, Tooltip } from '@mui/joy';
import EmailOutlinedIcon from '@mui/icons-material/EmailOutlined';
import LocationOnOutlinedIcon from '@mui/icons-material/LocationOnOutlined';
import LocalPhoneOutlinedIcon from '@mui/icons-material/LocalPhoneOutlined';
import CameraAltOutlinedIcon from '@mui/icons-material/CameraAltOutlined';
import { ReactNode, useState } from 'react';
import UploadProfilePhotoModal from '../ProfileModal/UploadProfilePhotoModal';
import { getAppFileUrl } from '@client/app/utils/s3';
import { useUser } from '@client/app/contexts/UserContext';
import { useTranslation } from 'react-i18next';

interface ProfileDetailSectionProps {
  userId: string;
  extra?: ReactNode;
  canEdit?: boolean;
  email?: string;
}

const ProfileDetailSection = ({ userId, extra, canEdit, email }: ProfileDetailSectionProps) => {
  const user = useGetUser(userId);
  const [isUploadModalOpen, setIsUploadModalOpen] = useState(false);
  const [editing, setEditing] = useState(false);
  const { currentUser } = useUser();
  const { t } = useTranslation();

  // Return loading state if user data is not ready
  if (!userId || user.isPending || user.isLoading) {
    return (
      <SectionContainer>
        <Box sx={{ display: 'flex', justifyContent: 'center', alignItems: 'center', minHeight: '200px' }}>
          <LinearProgress data-testid="profile-detail-loading" />
        </Box>
      </SectionContainer>
    );
  }

  const handleUploadComplete = (photoUrl: string) => {
    // Photo URL will be automatically updated through the API
    setIsUploadModalOpen(false);
  };

  const photoUrl = user.data?.photoUrl ? getAppFileUrl({ key: user.data.photoUrl }) : '';
  const PROFILE_AVATAR_SIZE = '130px';
  // Fallbacks for invited users with no profile data yet
  const displayName = user.data?.name || t('profile.invited_user_placeholder', { defaultValue: 'Invited user' });
  const organizationName = user.data?.organizationId?.name;
  // Only render the role line when there's something to show; avoids a "Role not available yet" placeholder leak
  const roleText = [user.data?.role, organizationName].filter(Boolean).join(' at ');

  const avatarSection = (
    <Box
      className="profile-detail-avatar-container"
      sx={{
        position: 'relative',
        margin: '0 auto',
        width: PROFILE_AVATAR_SIZE,
        minWidth: PROFILE_AVATAR_SIZE,
        height: PROFILE_AVATAR_SIZE,
      }}
    >
      <Avatar
        className="profile-detail-avatar"
        src={photoUrl}
        size="lg"
        alt={displayName}
        sx={{ width: PROFILE_AVATAR_SIZE, height: PROFILE_AVATAR_SIZE }}
      >
        {!photoUrl && displayName ? displayName.charAt(0).toUpperCase() : null}
      </Avatar>
      {currentUser?.id === userId && (
        <IconButton
          className="profile-detail-avatar-upload-button"
          onClick={() => setIsUploadModalOpen(true)}
          size="sm"
          variant="soft"
          sx={{
            position: 'absolute',
            bottom: 0,
            right: 8,
            borderRadius: '50%',
            backgroundColor: 'background.surface',
            zIndex: 2,
            boxShadow: 'sm',
            '&:hover': {
              backgroundColor: 'background.level1',
            },
          }}
        >
          <CameraAltOutlinedIcon sx={{ fontSize: 18 }} />
        </IconButton>
      )}
    </Box>
  );

  return (
    <SectionContainer>
      <Box
        className="profile-detail-main-container"
        sx={{
          display: 'flex',
          justifyContent: 'space-between',
          flexDirection: {
            xs: 'column',
            sm: 'row',
          },
          gap: {
            xs: '20px',
            sm: '0',
          },
        }}
      >
        <Box
          className="profile-detail-content-container"
          sx={{
            display: 'flex',
            gap: '30px',
            flexDirection: {
              xs: 'column',
              sm: 'row',
            },
          }}
        >
          {avatarSection}

          {user.data && editing ? (
            <ProfileDataForm userData={user.data} adminMode={false} onCancel={() => setEditing(false)} />
          ) : (
            <Box
              className="profile-detail-info-container"
              sx={{
                display: 'flex',
                flexDirection: 'column',
                gap: '20px',
                alignItems: {
                  xs: 'center',
                  sm: 'start',
                },
              }}
            >
              <Box className="profile-detail-name-container" sx={{ maxWidth: '100%', minWidth: 0 }}>
                <Tooltip title={displayName} placement="top-start">
                  <Typography
                    className="profile-detail-name"
                    level="h4"
                    sx={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', maxWidth: '420px' }}
                  >
                    {displayName}
                  </Typography>
                </Tooltip>
                {roleText && (
                  <Typography className="profile-detail-role" level="body-md" textColor="text.tertiary">
                    {roleText}
                  </Typography>
                )}
                {!canEdit && !user.data && (
                  <Typography level="body-sm" textColor="neutral.600">
                    {t('profile.invited_user_read_only', {
                      defaultValue:
                        'This is a read-only preview of an invited user. Details will appear once they complete their profile.',
                    })}
                  </Typography>
                )}
              </Box>

              {user.data?.email || user.data?.phone || user.data?.geoLocation || email ? (
                <Box className="profile-detail-contact-container" sx={{ display: 'flex', gap: '30px' }}>
                  {(user.data?.email || email) && (
                    <Typography level="body-md" sx={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
                      <Box
                        className="profile-detail-contact-icon"
                        component="span"
                        sx={{ display: 'flex', flexShrink: 0 }}
                      >
                        <EmailOutlinedIcon />
                      </Box>
                      <Box
                        className="profile-detail-email"
                        component="a"
                        href={`mailto:${user.data?.email || email}`}
                        sx={theme => ({
                          color: theme.palette.text.primary,
                          wordBreak: 'break-word',
                          flexGrow: 1,
                          flexShrink: 1,
                        })}
                      >
                        {user.data?.email || email}
                      </Box>
                    </Typography>
                  )}
                  {user.data?.phone && (
                    <Typography level="body-md" sx={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
                      <LocalPhoneOutlinedIcon />
                      {user.data.phone}
                    </Typography>
                  )}
                  {user.data?.geoLocation && (
                    <Typography level="body-md" sx={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
                      <LocationOnOutlinedIcon /> {user.data.geoLocation}
                    </Typography>
                  )}
                </Box>
              ) : (
                <Typography level="body-sm" textColor="neutral.500">
                  {t('profile.contact_unavailable', { defaultValue: 'No contact info available yet.' })}
                </Typography>
              )}
            </Box>
          )}
        </Box>

        <Box
          className="profile-detail-actions-container"
          sx={{
            display: 'flex',
            gap: '1.25rem',
            alignSelf: {
              xs: 'center',
              sm: 'start',
            },
          }}
        >
          {!editing && canEdit && (
            <Box className="profile-detail-edit-container" sx={{ display: 'flex', gap: '20px' }}>
              <Button
                className="profile-detail-edit-button"
                data-testid="profile-edit-btn"
                variant="outlined"
                color="neutral"
                onClick={() => setEditing(true)}
              >
                {t('profile.edit')}
              </Button>
            </Box>
          )}
          {extra}
        </Box>
      </Box>

      <UploadProfilePhotoModal
        open={isUploadModalOpen}
        onClose={() => setIsUploadModalOpen(false)}
        onUploadComplete={handleUploadComplete}
      />
    </SectionContainer>
  );
};

export default ProfileDetailSection;
