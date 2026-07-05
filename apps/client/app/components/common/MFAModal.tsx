import { Modal, Typography, Box, Stack, Button, Sheet, IconButton, Input } from '@mui/joy';
import React, { useState, useEffect } from 'react';
import { toast } from 'sonner';
import Image from 'next/image';
import CloseIcon from '@mui/icons-material/Close';

interface MFAModalProps {
  open: boolean;
  className?: string;
  onClose: () => void;
  onCancel: () => void;
  onVerify: (code: string) => void;
  loading?: boolean;
  error?: string | null;
  title?: string;
  qrCodeUrl?: string;
  manualEntryKey?: string;
  backupCodes?: string[];
  description?: string;
  showVerify?: boolean;
  isEnforced?: boolean; // If true, hide close button (for enforced MFA)
}

const MFAModal: React.FC<MFAModalProps> = ({
  open,
  onClose,
  onCancel,
  onVerify,
  loading = false,
  error = null,
  title,
  qrCodeUrl,
  manualEntryKey,
  backupCodes,
  description,
  showVerify = true,
  isEnforced = false,
}) => {
  const [code, setCode] = useState('');
  const isSetupMode = title?.includes('Set Up');

  // Clear code input when modal is opened
  useEffect(() => {
    if (open) {
      setCode('');
    }
  }, [open]);

  const handleCodeChange = (event: React.ChangeEvent<HTMLInputElement>) => {
    const value = event.target.value.replace(/\s/g, ''); // Remove spaces
    if (value.length <= 10) {
      // Allow up to 10 characters for backup codes
      setCode(value);
    }
  };

  const handleCopyBackupCodes = () => {
    if (backupCodes && backupCodes.length > 0) {
      navigator.clipboard.writeText(backupCodes.join('\n'));
      toast.success('Backup codes copied to clipboard');
    }
  };

  const handleDownloadBackupCodes = () => {
    if (backupCodes && backupCodes.length > 0) {
      const blob = new Blob([backupCodes.join('\n')], { type: 'text/plain' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = 'backup-codes.txt';
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(url);
    }
  };

  const handleVerify = () => {
    onVerify(code);
  };

  const handleCancel = () => {
    onCancel();
  };

  const handleClose = () => {
    if (!isEnforced) {
      onClose();
    }
  };

  return (
    <Modal
      className="mfa-modal"
      open={open}
      onClose={isEnforced ? undefined : handleClose}
      sx={{
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
      }}
    >
      <Sheet
        className="mfa-modal-content"
        variant="outlined"
        sx={{
          width: 400,
          maxWidth: '100%',
          borderRadius: 'md',
          p: 3,
          boxShadow: 'lg',
          position: 'relative',
        }}
      >
        {!isEnforced && (
          <IconButton
            className="mfa-modal-close-button"
            aria-label={isSetupMode ? 'Cancel MFA setup' : 'Close MFA verification'}
            onClick={isSetupMode ? handleCancel : handleClose}
            sx={{ position: 'absolute', top: 8, right: 8, zIndex: 10 }}
          >
            <CloseIcon />
          </IconButton>
        )}
        <Stack spacing={2}>
          <Typography className="mfa-modal-title" level="h4">
            {title || 'Multi-Factor Authentication'}
          </Typography>
          {description && <Typography>{description}</Typography>}
          {qrCodeUrl && (
            <Box sx={{ textAlign: 'center' }}>
              <Image src={qrCodeUrl} alt="Scan this QR code with your authenticator app" width={180} height={180} />
              <Typography level="body-sm" sx={{ mt: 1 }}>
                Scan this QR code with your authenticator app
              </Typography>
            </Box>
          )}
          {manualEntryKey && (
            <Box>
              <Typography level="body-sm">Manual Entry Key:</Typography>
              <Sheet variant="outlined" sx={{ p: 1, borderRadius: 'sm', wordBreak: 'break-all' }}>
                {manualEntryKey}
              </Sheet>
            </Box>
          )}
          {backupCodes && backupCodes.length > 0 && (
            <Box>
              <Typography level="body-sm">Backup Codes:</Typography>
              <Stack direction="row" spacing={1} sx={{ mb: 1 }}>
                <Button size="sm" variant="outlined" onClick={handleCopyBackupCodes}>
                  Copy All
                </Button>
                <Button size="sm" variant="outlined" onClick={handleDownloadBackupCodes}>
                  Download
                </Button>
              </Stack>
              <Sheet variant="outlined" sx={{ p: 1, borderRadius: 'sm', wordBreak: 'break-all' }}>
                <Box sx={{ display: 'flex', flexWrap: 'wrap', gap: 1 }}>
                  <Box sx={{ flex: 1, minWidth: '120px' }}>
                    {backupCodes
                      .filter((_, i) => i % 2 === 0)
                      .map(code => (
                        <Typography key={code} fontFamily="monospace">
                          {code}
                        </Typography>
                      ))}
                  </Box>
                  <Box sx={{ flex: 1, minWidth: '120px' }}>
                    {backupCodes
                      .filter((_, i) => i % 2 === 1)
                      .map(code => (
                        <Typography key={code} fontFamily="monospace">
                          {code}
                        </Typography>
                      ))}
                  </Box>
                </Box>
              </Sheet>
              <Typography level="body-xs" sx={{ mt: 1 }}>
                Save these codes in a safe place. Each code can be used once if you lose access to your authenticator
                app.
              </Typography>
            </Box>
          )}
          {showVerify && (
            <>
              <Input
                className="mfa-modal-code-input"
                value={code}
                onChange={handleCodeChange}
                placeholder={
                  qrCodeUrl
                    ? 'Enter 6-digit code from your authenticator app'
                    : 'Enter 6-digit code or 10-character backup code'
                }
                sx={{ mb: 1 }}
                disabled={loading}
                onKeyDown={e => {
                  if (e.key === 'Enter' && !loading) {
                    // Setup mode: only 6-digit codes, Verification mode: 6-digit or 10-character backup codes
                    const isValidLength = qrCodeUrl ? code.length === 6 : code.length === 6 || code.length === 10;
                    if (isValidLength) {
                      handleVerify();
                    }
                  }
                }}
                onPaste={e => {
                  e.preventDefault();
                  const pastedText = e.clipboardData.getData('text').replace(/\s/g, '');
                  // Setup mode: only 6-digit codes, Verification mode: allow up to 10 characters
                  const maxLength = qrCodeUrl ? 6 : 10;
                  if (pastedText.length <= maxLength) {
                    setCode(pastedText);
                  }
                }}
              />
              {error && (
                <Typography color="danger" sx={{ mb: 1 }}>
                  {error}
                </Typography>
              )}
              <Button
                className="mfa-modal-verify-button"
                onClick={handleVerify}
                color="primary"
                variant="solid"
                loading={loading}
                disabled={(() => {
                  // Setup mode: only 6-digit codes, Verification mode: 6-digit or 10-character backup codes
                  const isValidLength = qrCodeUrl ? code.length === 6 : code.length === 6 || code.length === 10;
                  return !isValidLength || loading;
                })()}
                fullWidth
                sx={{ mt: 2 }}
              >
                {isSetupMode ? 'Verify & Enable MFA' : 'Verify'}
              </Button>
            </>
          )}
          {!showVerify && !isEnforced && (
            <Button
              className="mfa-modal-close-button"
              onClick={onClose}
              color="primary"
              variant="soft"
              fullWidth
              sx={{ mt: 2 }}
            >
              Close
            </Button>
          )}
        </Stack>
      </Sheet>
    </Modal>
  );
};

export default MFAModal;
