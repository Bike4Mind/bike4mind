import { api } from '@client/app/contexts/ApiContext';
import { useUser } from '@client/app/contexts/UserContext';
import { activeOrgId } from '@client/app/hooks/data/dataLakes';
import { startGoogleDriveConnect } from '@client/app/hooks/data/googleDrive';
import { useDataLakeWizardStore } from '@client/app/stores/useDataLakeWizardStore';
import {
  consumeDriveConnectHandoff,
  rebindDriveConnectHandoff,
  requestDrivePickerResume,
} from '@client/app/utils/driveConnectHandoff';
import { GOOGLE_DRIVE_CONNECT_ERROR } from '@client/shared/googleDriveConnectErrors';
import { LinearProgress } from '@mui/joy';
import { useNavigate, useSearch } from '@tanstack/react-router';
import { isAxiosError } from 'axios';
import { useEffect, useRef } from 'react';
import { toast } from 'sonner';

const readStringParam = (search: Record<string, unknown>, key: 'code' | 'state' | 'error') => {
  const value = search[key];
  return typeof value === 'string' ? value : undefined;
};

const readErrorCode = (error: unknown): unknown => (isAxiosError(error) ? error.response?.data?.code : undefined);

const currentOwner = () => {
  const userId = useUser.getState().currentUser?.id;
  return userId ? { userId, organizationId: activeOrgId() ?? null } : null;
};

/**
 * Restarts the connect. A wizard or lake handoff saved for the failed attempt moves onto the new
 * attempt's state, so the retry still returns the user to where they started.
 */
const connectAgain = (failedState: string) => {
  startGoogleDriveConnect(authUrl => {
    const owner = currentOwner();
    if (owner) rebindDriveConnectHandoff({ ...owner, fromState: failedState, authUrl });
  }).catch((error: unknown) => {
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

const reportConnectFailure = (error: unknown, failedState: string) => {
  const code = readErrorCode(error);
  if (isConnectErrorCode(code)) {
    toast.error(CONNECT_FAILURE_MESSAGES[code], {
      action: { label: 'Connect again', onClick: () => connectAgain(failedState) },
    });
    return;
  }
  console.error('Error connecting to Google Drive:', error);
  toast.error('Error connecting to Google Drive');
};

/**
 * Puts the user back where the connect started, when that surface saved a handoff for this exact
 * OAuth attempt (see driveConnectHandoff): the Create wizard reopens with the typed-in config and
 * opens the folder picker; an existing lake reopens in the manager, where the user picks the folder.
 */
const resumeDriveConnect = (oauthState: string) => {
  const owner = currentOwner();
  if (!owner) return;
  const handoff = consumeDriveConnectHandoff({ ...owner, oauthState });
  if (!handoff) return;
  if (handoff.kind === 'lake') {
    useDataLakeWizardStore.getState().openManager('mine', handoff.dataLakeId);
    return;
  }
  useDataLakeWizardStore.getState().openWizard();
  useDataLakeWizardStore.setState({
    step: 'source',
    config: handoff.config,
    autoDerivedTagPrefix: handoff.autoDerivedTagPrefix,
    optionalSteps: handoff.optionalSteps,
  });
  requestDrivePickerResume(owner.userId);
};

/**
 * Completes the Google Drive connection, then redirects home (resuming the surface that started it,
 * if any). Renders no UI of its own.
 */
const GoogleDriveCallbackPage = () => {
  const navigate = useNavigate();
  const search: Record<string, unknown> = useSearch({ strict: false });
  // The code and state are single-use, so a StrictMode re-run must not spend them a second time.
  const handled = useRef(false);

  useEffect(() => {
    if (handled.current) return;
    handled.current = true;
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
      .then(
        () => true,
        (e: unknown) => {
          reportConnectFailure(e, state);
          return false;
        }
      )
      .then(connected => {
        navigate({ to: '/' });
        if (!connected) return;
        try {
          resumeDriveConnect(state);
        } catch (e) {
          console.error('Could not resume the Google Drive connect:', e);
        }
      });
  }, [search, navigate]);

  return <LinearProgress />;
};

export default GoogleDriveCallbackPage;
