import { create } from 'zustand';

/** Inner tab values of the Credit Analytics tab; must match the Tab/TabPanel values in ./index.tsx. */
export type CreditAnalysisTab =
  'users' | 'margins' | 'org-usage' | 'api-usage' | 'side-apps' | 'ledger' | 'adjustments' | 'economy';

/**
 * Inner-tab state for Credit Analytics, sticky for the whole SPA session: leaving Credit Analytics
 * and coming back reopens the last inner tab rather than 'users'.
 */
export const useCreditAnalysisStore = create<{
  activeTab: CreditAnalysisTab;
  setActiveTab: (tab: CreditAnalysisTab) => void;
  /** The connected app open in the Side apps drill-down, or null for the list. */
  sideAppClientId: string | null;
  setSideAppClientId: (clientId: string | null) => void;
  openSideApps: (clientId: string) => void;
}>(set => ({
  activeTab: 'users',
  setActiveTab: tab => set({ activeTab: tab }),
  sideAppClientId: null,
  setSideAppClientId: clientId => set({ sideAppClientId: clientId }),
  openSideApps: clientId => set({ activeTab: 'side-apps', sideAppClientId: clientId }),
}));
