import { api } from '@client/app/contexts/ApiContext';
import { startGoogleDriveConnect } from '@client/app/hooks/data/googleDrive';
import { GOOGLE_DRIVE_CONNECT_ERROR } from '@client/shared/googleDriveConnectErrors';
import { LinearProgress } from '@mui/joy';
import { useNavigate, useSearch } from '@tanstack/react-router';
import { isAxiosError } from 'axios';
import { useEffect } from 'react';
import { toast } from 'sonner';

const readStringParam = (search: Record<string, unknown>, key: 'code' | 'state' | 'error') => {
  const value = search[key];
  return typeof value === 'string' ? value : undefined;
};

const readErrorCode = (error: unknown): unknown => (isAxiosError(error) ? error.response?.data?.code : undefined);

const connectAgain = () => {
  startGoogleDriveConnect().catch((error: unknown) => {
    console.error('Error restarting Google Drive connection:', error);
    toast.error('Error connecting to Google Drive');
  });
};

type GoogleDriveConnectErrorCode = (typeof GOOGLE_DRIVE_CONNECT_ERROR)[keyof typeof GOOGLE_DRIVE_CONNECT_ERROR];

const CONNECT_FAILURE_MESSAGES: Record<GoogleDriveConnectErrorCode, string> = {
  [GOOGLE_DRIVE_CONNECT_ERROR.expired]: 'That Google Drive connection attempt expired. Please connect again.',
  [GOOGLE_DRIVE_CONNECT_ERROR.invalid]:
    'That Google Drive connection attempt is no longer valid. Please connect again.',
  [GOOGLE_DRIVE_CONNECT_ERROR.failed]: 'Google Drive could not complete the connection. Please connect again.',
};

const isConnectErrorCode = (code: unknown): code is GoogleDriveConnectErrorCode =>
  typeof code === 'string' && Object.hasOwn(CONNECT_FAILURE_MESSAGES, code);

const reportConnectFailure = (error: unknown) => {
  const code = readErrorCode(error);
  if (isConnectErrorCode(code)) {
    toast.error(CONNECT_FAILURE_MESSAGES[code], { action: { label: 'Connect again', onClick: connectAgain } });
    return;
  }
  console.error('Error connecting to Google Drive:', error);
  toast.error('Error connecting to Google Drive');
};

/**
 * Completes the Google Drive connection, then redirects home. Renders no UI of its own.
 */
const GoogleDriveCallbackPage = () => {
  const navigate = useNavigate();
  const search: Record<string, unknown> = useSearch({ strict: false });

  useEffect(() => {
    const code = readStringParam(search, 'code');
    const state = readStringParam(search, 'state');
    const error = readStringParam(search, 'error');

    // Consent denial (or any missing param) returns here with no code/state; bail
    // instead of firing a request that could only fail state verification - and,
    // now that rejection is a server-side security signal, log a cancel as a cancel.
    if (error || !code || !state) {
      toast.error(
        error === 'access_denied' ? 'Google Drive connection cancelled.' : 'Error connecting to Google Drive'
      );
      navigate({ to: '/' });
      return;
    }

    api
      // Forward `state` so the API callback can verify the browser-binding nonce.
      .get(`/api/google-drive/callback?code=${encodeURIComponent(code)}&state=${encodeURIComponent(state)}`)
      .catch(reportConnectFailure)
      .finally(() => {
        navigate({ to: '/' });
      });
  }, [search, navigate]);

  return <LinearProgress />;
};

export default GoogleDriveCallbackPage;
