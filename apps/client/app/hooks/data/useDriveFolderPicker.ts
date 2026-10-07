import { useEffect, useRef, useState } from 'react';
import { toast } from 'sonner';
import useDrivePicker from 'react-google-drive-picker';
import { api } from '@client/app/contexts/ApiContext';
import { useConfig } from '@client/app/hooks/data/settings';
import { ensureGoogleDrivePickerStyles } from '@client/app/utils/googleDrivePickerStyles';

export type PickedDriveFolder = { driveFolderId: string; folderName?: string };

const PICKER_READY_POLL_MS = 250;
const PICKER_READY_TIMEOUT_MS = 10_000;

const isPickerApiLoaded = () => !!(window as { google?: { picker?: unknown } }).google?.picker;

const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

/** Resolves true once the Google Picker API has loaded, or false after the timeout. */
async function waitForPickerApi(): Promise<boolean> {
  if (isPickerApiLoaded()) return true;
  for (let waited = 0; waited < PICKER_READY_TIMEOUT_MS; waited += PICKER_READY_POLL_MS) {
    await sleep(PICKER_READY_POLL_MS);
    if (isPickerApiLoaded()) {
      await sleep(PICKER_READY_POLL_MS); // let the library's own loaded state render before calling it
      return true;
    }
  }
  return false;
}

function httpStatus(e: unknown): number | undefined {
  return (e as { response?: { status?: number } })?.response?.status;
}

/**
 * Open the Google Picker in folder-select mode, handling the OAuth prelude: redirect to Google's
 * consent screen when Drive was never linked (or the refresh failed), else fetch a token and open
 * the picker. `onPicked` receives the chosen folder; cancel and every failure path clear `isPicking`.
 *
 * Shared by both Drive-connect surfaces - the existing-lake action, which connects immediately, and
 * the create-mode action, which parks the selection in wizard state until the lake exists (#1916).
 * One implementation because the OAuth branches and the picker's z-index workaround are the awkward
 * part, and two copies of them would drift.
 *
 * `busy` folds the caller's own in-flight work (e.g. a connect mutation) into the re-entrancy guard,
 * so a second picker can never open on top of the first.
 *
 * `onBeforeRedirect` runs just before either consent redirect, with the authorize URL, so a caller
 * can save what the user was doing (see driveConnectHandoff). Best-effort: a throw never blocks it.
 */
export function useDriveFolderPicker({
  onPicked,
  busy = false,
  onBeforeRedirect,
}: {
  onPicked: (folder: PickedDriveFolder) => void;
  busy?: boolean;
  onBeforeRedirect?: (authUrl: string) => void;
}): { openFolderPicker: () => Promise<void>; isPicking: boolean } {
  const { data: config } = useConfig();
  const googleClientId = config?.googleClientId;
  const [openPicker] = useDrivePicker();
  // The library's openPicker silently no-ops until its own picker-loaded state flips, so after
  // waiting for the API the call must go through the latest render's openPicker, not this closure's.
  const openPickerRef = useRef(openPicker);
  useEffect(() => {
    openPickerRef.current = openPicker;
  });
  const [isPicking, setIsPicking] = useState(false);

  const redirectToConsent = (authUrl: string) => {
    try {
      onBeforeRedirect?.(authUrl);
    } catch {
      // saving the caller's draft is best-effort; the connect itself must still proceed
    }
    window.location.href = authUrl;
  };

  const openFolderPicker = async () => {
    if (isPicking || busy) return; // re-entrancy guard: never open a second picker
    setIsPicking(true);
    try {
      let token: { accessToken?: string; authUrl?: string };
      try {
        const { data } = await api.get<{ accessToken?: string; authUrl?: string }>('/api/google-drive/token');
        token = data;
      } catch (e) {
        // First-time user: /token 400s ("Google Drive not connected") when Drive was never linked.
        // Send them to Google's consent screen (the same POST /connect the profile flow uses); they
        // come back and can then pick a folder. Any other error falls through to the outer catch.
        if (httpStatus(e) === 400) {
          const { data } = await api.post<{ authUrl: string }>('/api/google-drive/connect');
          redirectToConsent(data.authUrl);
          return;
        }
        throw e;
      }

      // Not connected / refresh failed: /token hands back an authUrl instead of a token.
      if (token.authUrl) {
        redirectToConsent(token.authUrl);
        return;
      }
      if (!token.accessToken || !googleClientId) {
        toast.error('Google Drive is unavailable right now. Please try again.');
        setIsPicking(false);
        return;
      }

      if (!(await waitForPickerApi())) {
        toast.error('Google Drive is still loading. Please try again.');
        setIsPicking(false);
        return;
      }

      ensureGoogleDrivePickerStyles(); // keep the picker above the wizard modal (z-index 1400)
      openPickerRef.current({
        clientId: googleClientId,
        developerKey: '',
        viewId: 'FOLDERS', // folder-first browse; the user selects a folder to ingest
        viewMimeTypes: '',
        token: token.accessToken,
        showUploadFolders: false,
        supportDrives: true,
        multiselect: false,
        setIncludeFolders: true,
        setSelectFolderEnabled: true, // pick a FOLDER, not a file - its id feeds the ingest
        disableDefaultView: false,
        callbackFunction: pick => {
          // Clear the loading state as the picker closes. openPicker() is synchronous, so this must
          // happen in the callback, not right after the call - otherwise the button drops its
          // loading state while the picker is still open and a second click opens a second picker.
          if (pick.action === 'picked' || pick.action === 'cancel') setIsPicking(false);
          if (pick.action !== 'picked') return;
          const folder = pick.docs?.[0];
          if (!folder?.id) return;
          onPicked({ driveFolderId: folder.id, folderName: folder.name });
        },
      });
    } catch {
      toast.error('Could not open Google Drive. Please try again.');
      setIsPicking(false);
    }
  };

  return { openFolderPicker, isPicking };
}
