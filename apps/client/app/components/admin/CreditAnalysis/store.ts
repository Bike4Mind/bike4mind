import { create } from 'zustand';

/** Inner tab values of the Credit Analytics tab; must match the Tab/TabPanel values in ./index.tsx. */
export type CreditAnalysisTab = 'users' | 'pricing' | 'margins' | 'org-usage' | 'ledger' | 'adjustments';

/**
 * Inner-tab and focus state for Credit Analytics.
 *
 * Its own module, like RegistrationInvites/store.ts, because other admin
 * surfaces drive it: the Model Lifecycle tab (a different sidebar section) jumps
 * straight to Model Pricing, and a discovery price flag jumps to one model.
 * Keep it dependency-light so importing it never drags Credit Analytics into
 * another tab's bundle.
 */
export const useCreditAnalysisStore = create<{
  /**
   * Sticky for the whole SPA session, deliberately: it used to be component state
   * that reset to 'users' on every mount, and a cross-section jump sets it before
   * Credit Analytics has mounted. Leaving Credit Analytics and coming back
   * therefore reopens the last inner tab rather than 'users'.
   */
  activeTab: CreditAnalysisTab;
  /**
   * A model the operator arrived to look at. ModelPricingCatalog seeds its filter
   * from it and clears it, so a later manual visit does not open still filtered.
   */
  pricingModelId: string | null;
  setActiveTab: (tab: CreditAnalysisTab) => void;
  /** Open Model Pricing focused on one model (a discovery price flag's jump). */
  focusPricingModel: (modelId: string) => void;
  clearPricingModelId: () => void;
}>(set => ({
  activeTab: 'users',
  pricingModelId: null,
  setActiveTab: tab => set({ activeTab: tab }),
  focusPricingModel: modelId => set({ activeTab: 'pricing', pricingModelId: modelId }),
  clearPricingModelId: () => set({ pricingModelId: null }),
}));
