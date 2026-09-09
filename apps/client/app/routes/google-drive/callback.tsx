import { api } from '@client/app/contexts/ApiContext';
import { LinearProgress } from '@mui/joy';
import { useNavigate, useSearch } from '@tanstack/react-router';
import { useEffect } from 'react';
import { toast } from 'sonner';

/**
 * Completes the Google Drive connection, then redirects home. Renders no UI of its own.
 */
const GoogleDriveCallbackPage = () => {
  const navigate = useNavigate();
  const search = useSearch({ strict: false });

  useEffect(() => {
    const { code, state, error } = search as any;

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
      .catch(err => {
        console.error('Error connecting to Google Drive:', err);
        toast.error('Error connecting to Google Drive');
      })
      .finally(() => {
        navigate({ to: '/' });
      });
  }, [search, navigate]);

  return <LinearProgress />;
};

export default GoogleDriveCallbackPage;
