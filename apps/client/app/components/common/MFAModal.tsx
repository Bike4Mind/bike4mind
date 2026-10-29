import { Modal, Typography, Box, Stack, Button, Sheet, IconButton, Input, Checkbox, Divider } from '@mui/joy';
import React, { useState, useEffect, useId } from 'react';
import { toast } from 'sonner';
import Image from 'next/image';
import CloseIcon from '@mui/icons-material/Close';
import FingerprintIcon from '@mui/icons-material/Fingerprint';
import { passkeysSupported } from '@client/app/hooks/data/passkeys';
import type { MfaChallengeMode } from '@client/app/hooks/useMfaChallenge';

interface MFAModalProps {
  open: boolean;
  className?: string;
  onClose: () => void;
  onCancel: () => void;
  onVerify: (code: string, rememberDevice: boolean) => void;
  loading?: boolean;
  /** 'setup' enrolls a new authenticator; 'verify' checks an existing one. */
  mode?: MfaChallengeMode;
  /** Show the "remember this device" opt-in. Verification only - never during setup. */
  allowRememberDevice?: boolean;
  /** Length of the trust window, for the checkbox label. */
  rememberDeviceDays?: number;
  error?: string | null;
  title?: string;
  qrCodeUrl?: string;
  manualEntryKey?: string;
  backupCodes?: string[];
  description?: string;
  showVerify?: boolean;
  isEnforced?: boolean; // If true, hide close button (for enforced MFA)
  /** Offer a passkey as an alternative to the code. Verification only - never during setup. */
  onPasskeyVerify?: (rememberDevice: boolean) => void;
  passkeyLoading?: boolean;
}

const MFAModal: React.FC<MFAModalProps> = ({
  open,
  onClose,
  onCancel,
  onVerify,
  loading = false,
  mode = 'verify',
  error = null,
  title,
  qrCodeUrl,
  manualEntryKey,
  backupCodes,
  description,
  showVerify = true,
  isEnforced = false,
  allowRememberDevice = false,
  rememberDeviceDays = 30,
  onPasskeyVerify,
  passkeyLoading = false,
}) => {
  const [code, setCode] = useState('');
  const [rememberDevice, setRememberDevice] = useState(false);
  const [pasteHint, setPasteHint] = useState<string | null>(null);
  const titleId = useId();
  const isSetupMode = mode === 'setup';
  // Setup enrolls the second factor; offering to skip it in the same breath makes no
  // sense, so the opt-in is verification-only.
  const showRememberDevice = allowRememberDevice && showVerify && !isSetupMode;
  const showPasskey = !!onPasskeyVerify && showVerify && !isSetupMode && passkeysSupported();
  const busy = loading || passkeyLoading;

  // Clear code input when modal is opened
  useEffect(() => {
    if (open) {
      setCode('');
      setRememberDevice(false);
      setPasteHint(null);
    }
  }, [open]);

  const handleCodeChange = (event: React.ChangeEvent<HTMLInputElement>) => {
    const value = event.target.value.replace(/\s/g, ''); // Remove spaces
    setPasteHint(null);
    if (value.length <= 10) {
      // Allow up to 10 characters for backup codes
      setCode(value);
    }
  };

  const handleCopyBackupCodes = async () => {
    if (backupCodes && backupCodes.length > 0) {
      try {
        await navigator.clipboard.writeText(backupCodes.join('\n'));
        toast.success('Backup codes copied to clipboard');
      } catch {
        toast.error('Could not copy backup codes. Use Download instead.');
      }
    }
  };

  const handlePaste = (e: React.ClipboardEvent<HTMLInputElement>) => {
    e.preventDefault();
    const rawText = e.clipboardData.getData('text');
    // Only space- or hyphen-grouped digits ("123 456", "123-456") are stripped: stripping before the backup match would
    // turn "hello world" into a base32-shaped code. The 6-digit code wins over a 10-letter label word.
    const spacedDigits = rawText.replace(/[\s-]/g, '').match(/^\d{6}$/);
    const embedded =
      spacedDigits ??
      rawText.match(/(?<![A-Za-z0-9])\d{6}(?![A-Za-z0-9])/) ??
      (qrCodeUrl ? null : rawText.match(/(?<![A-Za-z0-9])[A-Za-z2-7]{10}(?![A-Za-z0-9])/));
    if (embedded) {
      setPasteHint(null);
      setCode(embedded[0]);
    } else {
      setPasteHint(
        qrCodeUrl
          ? 'Paste or enter the 6-digit code from your authenticator app.'
          : 'Paste or enter a 6-digit code or 10-character backup code.'
      );
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
    onVerify(code, showRememberDevice && rememberDevice);
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
        p: 2,
      }}
    >
      <Sheet
        className="mfa-modal-content"
        data-testid="mfa-modal-content"
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        variant="outlined"
        sx={{
          width: 400,
          maxWidth: '100%',
          // Setup (QR + key + backup codes) is taller than most viewports; scroll inside the dialog.
          maxHeight: 'calc(100dvh - 32px)',
          overflowY: 'auto',
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
          <Typography id={titleId} className="mfa-modal-title" level="h4">
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
              {showPasskey && (
                <>
                  <Button
                    data-testid="mfa-modal-passkey-btn"
                    startDecorator={<FingerprintIcon />}
                    onClick={() => onPasskeyVerify?.(showRememberDevice && rememberDevice)}
                    loading={passkeyLoading}
                    disabled={busy}
                    fullWidth
                  >
                    Use a passkey
                  </Button>
                  <Divider>or enter a code</Divider>
                </>
              )}
              <Input
                className="mfa-modal-code-input"
                data-testid="mfa-modal-code-input"
                value={code}
                onChange={handleCodeChange}
                placeholder={
                  qrCodeUrl
                    ? 'Enter 6-digit code from your authenticator app'
                    : 'Enter 6-digit code or 10-character backup code'
                }
                sx={{ mb: 1 }}
                disabled={busy}
                onKeyDown={e => {
                  if (e.key === 'Enter' && !busy) {
                    // Setup mode: only 6-digit codes, Verification mode: 6-digit or 10-character backup codes
                    const isValidLength = qrCodeUrl ? code.length === 6 : code.length === 6 || code.length === 10;
                    if (isValidLength) {
                      handleVerify();
                    }
                  }
                }}
                onPaste={handlePaste}
              />
              <Box aria-live="polite">
                {pasteHint && (
                  <Typography data-testid="mfa-modal-paste-hint" level="body-sm" sx={{ mb: 1 }}>
                    {pasteHint}
                  </Typography>
                )}
              </Box>
              {error && (
                <Typography color="danger" sx={{ mb: 1 }}>
                  {error}
                </Typography>
              )}
              {showRememberDevice && (
                <Box>
                  <Checkbox
                    className="mfa-modal-remember-device"
                    data-testid="mfa-modal-remember-device-checkbox"
                    label={`Remember this device for ${rememberDeviceDays} days`}
                    checked={rememberDevice}
                    disabled={busy}
                    onChange={event => setRememberDevice(event.target.checked)}
                  />
                  <Typography level="body-xs" sx={{ mt: 0.5 }}>
                    Skips this code on future sign-ins from this browser. You will still be emailed a one-time code each
                    time. Only do this on a device you control.
                  </Typography>
                </Box>
              )}
              <Button
                className="mfa-modal-verify-button"
                data-testid="mfa-modal-verify-btn"
                onClick={handleVerify}
                color="primary"
                variant="solid"
                loading={loading}
                disabled={(() => {
                  // Setup mode: only 6-digit codes, Verification mode: 6-digit or 10-character backup codes
                  const isValidLength = qrCodeUrl ? code.length === 6 : code.length === 6 || code.length === 10;
                  return !isValidLength || busy;
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
