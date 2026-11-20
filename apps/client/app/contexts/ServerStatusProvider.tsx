import { ServerStatusEnum } from '@bike4mind/common';
import B4MComingSoonPage from '@client/app/components/b4m/ComingSoon';
import MaintenanceComingSoonPage from '@client/app/components/common/MaintenanceComingSoonPage';
import { useUser } from '@client/app/contexts/UserContext';
import React, { ReactNode } from 'react';
import { useServerStatus } from '../hooks/data/settings';

export const ServerStatusProvider: React.FC<{ children: ReactNode }> = ({ children }) => {
  const { data } = useServerStatus();
  const { serverStatus } = data || {};

  // Safely get admin status - handle unauthenticated users
  const isAdmin = useUser(s => s.isAdmin ?? false);

  // Check if current route is emergency admin bypass
  // Use window.location.pathname since ServerStatusProvider is rendered before TanStackRouterProvider
  const isEmergencyRoute = typeof window !== 'undefined' && window.location.pathname === '/admin-emergency';

  let content;

  // EMERGENCY BYPASS: Always allow /admin-emergency route regardless of maintenance mode
  if (isEmergencyRoute) {
    console.log('🚨 Emergency route detected - bypassing maintenance mode check');
    content = children;
  } else if ((serverStatus === ServerStatusEnum.Maintenance || serverStatus === ServerStatusEnum.Offline) && !isAdmin) {
    // Non-admins get the maintenance screen for `maintenance` and the coming-soon waitlist page for
    // `offline`: MaintenanceComingSoonPage falls through to customComingSoonContent for any status but
    // maintenance.
    const comingSoonContent = <B4MComingSoonPage />;
    content = <MaintenanceComingSoonPage customComingSoonContent={comingSoonContent} serverStatus={serverStatus} />;
  } else {
    content = children;
  }

  return <>{content}</>;
};
