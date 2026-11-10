import { create } from 'zustand';

/** Inner tab values of the Credit Analytics tab; must match the Tab/TabPanel values in ./index.tsx. */
export type CreditAnalysisTab = 'users' | 'margins' | 'org-usage' | 'api-usage' | 'ledger' | 'adjustments';

/**
 * Inner-tab state for Credit Analytics, sticky for the whole SPA session: leaving Credit Analytics
 * and coming back reopens the last inner tab rather than 'users'.
 */
export const useCreditAnalysisStore = create<{
  activeTab: CreditAnalysisTab;
  setActiveTab: (tab: CreditAnalysisTab) => void;
}>(set => ({
  activeTab: 'users',
  setActiveTab: tab => set({ activeTab: tab }),
}));
