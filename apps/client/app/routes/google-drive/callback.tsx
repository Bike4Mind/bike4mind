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
    const { code } = search as any;

    api
      .get(`/api/google-drive/callback?code=${code}`)
      .catch(error => {
        console.error('Error connecting to Google Drive:', error);
        toast.error('Error connecting to Google Drive');
      })
      .finally(() => {
        navigate({ to: '/' });
      });
  }, [search, navigate]);

  return <LinearProgress />;
};

export default GoogleDriveCallbackPage;
