import React, { ReactNode } from 'react';
import { InboxProvider } from './InboxContext';
import { LLMProvider } from './LLMContext';
import { OrganizationProvider } from './OrganizationContext';
import { SessionsProvider } from './SessionsContext';
import { UserSettingsProvider } from './UserSettingsContext';
import { AdminSettingsProvider } from './AdminSettingsContext';
import { ProjectAddToModalProvider } from '@client/app/components/Project/ProjectAddToModal';
import { SnackbarProvider } from './SnackbarContext';
import CreateTeamModal from '@client/app/components/organizations/CreateTeamModal';
import { ModalTriggerProvider } from './ModalTriggerContext';
import ModalManager from '@client/app/components/modals/ModalManager';
import ModalErrorBoundary from '@client/app/components/modals/ModalErrorBoundary';
import ReferralModal, { ReferralInviteType } from '@client/app/components/referrals/ReferralModal';
import HelpModal from '@client/app/components/HelpModal';
import PromptMetaInspector from '@client/app/components/Session/PromptMetaInspector';
import FileBrowser from '../components/Files/Browser';
import SendToDataLakeModal from '@client/app/components/DataLakeWizard/SendToDataLakeModal';
import MFAEnforcementWrapper from '../components/auth/MFAEnforcementWrapper';
import EmailVerificationBanner from '@client/app/components/EmailVerificationBanner';
import CommandPalette from '../components/CommandPalette';

interface ProviderBundleProps {
  children: ReactNode;
}

// Core data providers - grouped to reduce cascading re-renders
const CoreDataProviders: React.FC<{ children: ReactNode }> = ({ children }) => (
  <InboxProvider>
    <UserSettingsProvider>
      <AdminSettingsProvider cacheTTL={5 * 60 * 1000} fetchOnMount={true}>
        <LLMProvider />
        {children}
      </AdminSettingsProvider>
    </UserSettingsProvider>
  </InboxProvider>
);

// Session and organization providers - grouped
export const SessionProviders: React.FC<{ children: ReactNode }> = ({ children }) => (
  <SnackbarProvider>
    <SessionsProvider>
      <OrganizationProvider>{children}</OrganizationProvider>
    </SessionsProvider>
  </SnackbarProvider>
);

// UI and modal providers - grouped
export const UIProviders: React.FC<{ children: ReactNode }> = ({ children }) => (
  <ProjectAddToModalProvider>
    <ModalTriggerProvider>{children}</ModalTriggerProvider>
  </ProjectAddToModalProvider>
);

export const ProviderBundle: React.FC<ProviderBundleProps> = ({ children }) => {
  return (
    <CoreDataProviders>
      <SessionProviders>
        <UIProviders>
          <ModalErrorBoundary>
            <ModalManager />
          </ModalErrorBoundary>
          <ReferralModal inviteType={ReferralInviteType.referral} />
          <HelpModal />
          <PromptMetaInspector />
          <CreateTeamModal />
          <FileBrowser />
          <SendToDataLakeModal />
          <CommandPalette />
          <EmailVerificationBanner />
          <MFAEnforcementWrapper>{children}</MFAEnforcementWrapper>
        </UIProviders>
      </SessionProviders>
    </CoreDataProviders>
  );
};
