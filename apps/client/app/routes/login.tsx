import MultiStepLogin from '@client/app/components/MultiStepLogin';
import { clearClientCaches } from '@client/app/utils/clearClientCaches';
import { usePublicConfig } from '@client/app/hooks/data/settings';
import { useQueryClient } from '@tanstack/react-query';
import { useEffect } from 'react';

const LoginPage = () => {
  const queryClient = useQueryClient();
  const { data: publicConfig } = usePublicConfig();

  useEffect(() => {
    // Clear all client-side persistence (IndexedDB) before removing in-memory queries
    // to avoid the persist-after-delete race.
    // Use a cancelled flag so that if the user logs in and navigates away before
    // clearClientCaches() resolves, we don't removeQueries() on the newly-mounted
    // ProviderBundle's queries - which would reset adminSettingsLoading and leave
    // MFAEnforcementWrapper stuck on "Checking security settings...".
    let cancelled = false;
    clearClientCaches().then(() => {
      if (cancelled) return;
      // Preserve server-config-public: it contains only apiUrl + defaultTheme and is not user-specific.
      // The full server-config (auth'd) is intentionally purged on logout to prevent
      // bucket names and the PDF Express key from persisting in memory across sessions.
      queryClient.removeQueries({
        predicate: query => query.queryKey[0] !== 'server-config-public',
      });
    });
    return () => {
      cancelled = true;
    };
  }, [queryClient]);

  return (
    <MultiStepLogin
      enableRegister={publicConfig?.allowOpenRegistration ?? false}
      enableSocials
      enableGithubAuth
      enableOktaAuth
    />
  );
};

export default LoginPage;
