import React from 'react';
import { Box, Card, DialogContent, Modal, ModalDialog, Typography, Divider, Stack, Avatar } from '@mui/joy';
import { ILoginRecord, IUserDocument, WithOrgRef } from '@bike4mind/common';
import PersonIcon from '@mui/icons-material/Person';
import BusinessIcon from '@mui/icons-material/Business';
import CalendarTodayIcon from '@mui/icons-material/CalendarToday';
import AccessTimeIcon from '@mui/icons-material/AccessTime';
import DevicesIcon from '@mui/icons-material/Devices';
import DesktopWindowsIcon from '@mui/icons-material/DesktopWindows';
import PhoneIphoneIcon from '@mui/icons-material/PhoneIphone';
import AspectRatioIcon from '@mui/icons-material/AspectRatio';
import ViewComfyIcon from '@mui/icons-material/ViewComfy';
import PaletteIcon from '@mui/icons-material/Palette';
import GrainIcon from '@mui/icons-material/Grain';
import PublicIcon from '@mui/icons-material/Public';
import NetworkWifiIcon from '@mui/icons-material/NetworkWifi';
import TranslateIcon from '@mui/icons-material/Translate';
import AlternateEmailIcon from '@mui/icons-material/AlternateEmail';

interface LoginDetailsModalProps {
  open: boolean;
  onClose: () => void;
  user: WithOrgRef<IUserDocument>;
  lastLoginRecord: ILoginRecord | undefined;
}

const LoginDetailsModal: React.FC<LoginDetailsModalProps> = ({ open, onClose, user, lastLoginRecord }) => {
  return (
    <Modal open={open} onClose={onClose}>
      <ModalDialog
        sx={{
          maxWidth: 1200,
          width: { xs: '95vw', sm: '100vw' },
          aspectRatio: { sm: '16/9' },
          maxHeight: '90vh',
          overflowY: 'auto',
        }}
      >
        <DialogContent>
          <Box sx={{ display: 'flex', flexDirection: { xs: 'column', sm: 'row' }, gap: 1 }}>
            <Card variant="outlined" sx={{ flex: { sm: '1 1 30%' } }}>
              <Box sx={{ display: 'flex', alignItems: 'center', gap: 2, p: 2 }}>
                <Avatar variant="solid" size="sm" sx={{ bgcolor: 'primary.main' }}>
                  <PersonIcon />
                </Avatar>
                <Box>
                  <Typography level="h3">{user.name}</Typography>
                  <Typography level="body-md" sx={{ mt: 0.5, color: 'text.secondary' }}>
                    {user.email}
                  </Typography>
                </Box>
              </Box>
              <Divider />
              <Stack spacing={2} sx={{ p: 2 }}>
                <Box sx={{ display: 'flex', alignItems: 'center', gap: 1 }}>
                  <BusinessIcon fontSize="small" sx={{ color: 'text.secondary' }} />
                  <Typography level="body-md">Organization: {user.organizationId?.name}</Typography>
                </Box>
                <Box sx={{ display: 'flex', alignItems: 'center', gap: 1 }}>
                  <CalendarTodayIcon fontSize="small" sx={{ color: 'text.secondary' }} />
                  <Typography level="body-md">Created: {new Date(user.createdAt).toDateString()}</Typography>
                </Box>
              </Stack>
            </Card>

            {lastLoginRecord && (
              <Card variant="outlined" sx={{ flex: { sm: '1 1 70%' } }}>
                <Box sx={{ p: 2 }}>
                  <Typography level="h4" sx={{ mb: 1 }}>
                    Last Login Details
                  </Typography>
                  <Stack spacing={2}>
                    <Box sx={{ display: 'flex', alignItems: 'center', gap: 1 }}>
                      <AccessTimeIcon fontSize="small" sx={{ color: 'text.secondary' }} />
                      <Typography level="body-md">
                        Login Time: {new Date(lastLoginRecord.loginTime).toLocaleString()}
                      </Typography>
                    </Box>
                    <Box sx={{ display: 'flex', alignItems: 'center', gap: 1 }}>
                      <AlternateEmailIcon fontSize="small" sx={{ color: 'text.secondary' }} />
                      <Typography level="body-md">IP Address: {lastLoginRecord.ip}</Typography>
                    </Box>
                    <Box sx={{ display: 'flex', alignItems: 'center', gap: 1 }}>
                      <AspectRatioIcon fontSize="small" sx={{ color: 'text.secondary' }} />
                      <Typography level="body-md">Screen Resolution: {lastLoginRecord.screenResolution}</Typography>
                    </Box>
                    <Box sx={{ display: 'flex', alignItems: 'center', gap: 1 }}>
                      {lastLoginRecord.deviceType === 'Mobile' ? (
                        <PhoneIphoneIcon fontSize="small" sx={{ color: 'text.secondary' }} />
                      ) : (
                        <DesktopWindowsIcon fontSize="small" sx={{ color: 'text.secondary' }} />
                      )}
                      <Typography level="body-md">Device Type: {lastLoginRecord.deviceType}</Typography>
                    </Box>
                    <Box sx={{ display: 'flex', alignItems: 'center', gap: 1 }}>
                      <TranslateIcon fontSize="small" sx={{ color: 'text.secondary' }} />
                      <Typography level="body-md">Browser: {lastLoginRecord.browser}</Typography>
                    </Box>
                    <Box sx={{ display: 'flex', alignItems: 'center', gap: 1 }}>
                      <DesktopWindowsIcon fontSize="small" sx={{ color: 'text.secondary' }} />
                      <Typography level="body-md">Operating System: {lastLoginRecord.operatingSystem}</Typography>
                    </Box>
                    <Box sx={{ display: 'flex', alignItems: 'center', gap: 1 }}>
                      <DevicesIcon fontSize="small" sx={{ color: 'text.secondary' }} />
                      <Typography level="body-md">User Agent: {lastLoginRecord.userAgent}</Typography>
                    </Box>
                    <Box sx={{ display: 'flex', alignItems: 'center', gap: 1 }}>
                      <ViewComfyIcon fontSize="small" sx={{ color: 'text.secondary' }} />
                      <Typography level="body-md">Viewport Size: {lastLoginRecord.viewportSize}</Typography>
                    </Box>
                    <Box sx={{ display: 'flex', alignItems: 'center', gap: 1 }}>
                      <PaletteIcon fontSize="small" sx={{ color: 'text.secondary' }} />
                      <Typography level="body-md">Color Depth: {lastLoginRecord.colorDepth}</Typography>
                    </Box>
                    <Box sx={{ display: 'flex', alignItems: 'center', gap: 1 }}>
                      <GrainIcon fontSize="small" sx={{ color: 'text.secondary' }} />
                      <Typography level="body-md">Pixel Depth: {lastLoginRecord.pixelDepth}</Typography>
                    </Box>
                    {lastLoginRecord.location && (
                      <Box sx={{ display: 'flex', alignItems: 'center', gap: 1 }}>
                        <PublicIcon fontSize="small" sx={{ color: 'text.secondary' }} />
                        <Typography level="body-md">Location: {lastLoginRecord.location}</Typography>
                      </Box>
                    )}

                    {lastLoginRecord.networkType && (
                      <Box sx={{ display: 'flex', alignItems: 'center', gap: 1 }}>
                        <NetworkWifiIcon fontSize="small" sx={{ color: 'text.secondary' }} />
                        <Typography level="body-md">Network Type: {lastLoginRecord.networkType}</Typography>
                      </Box>
                    )}
                  </Stack>
                </Box>
              </Card>
            )}
          </Box>
        </DialogContent>
      </ModalDialog>
    </Modal>
  );
};
export default LoginDetailsModal;
