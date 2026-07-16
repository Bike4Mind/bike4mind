import { INFINITE_VALUE } from '@client/app/components/FibonacciSlider';
import { create } from 'zustand';

interface State {
  liveAI: boolean;
  setLiveAI: (liveAI: boolean) => void;
  showAdvancedSettings: boolean;
  setShowAdvancedSettings: (showAdvancedSettings: boolean) => void;
  // The per-model settings/details dialog (where image settings + the templates
  // panel live). Lifted here so the composer Templates button can open it directly.
  modelDetailsOpen: boolean;
  setModelDetailsOpen: (open: boolean) => void;
  historyLines: number;
  setHistoryLines: (historyLines: number) => void;
  activeTab: 'ai-settings' | 'research-mode';
  setActiveTab: (tab: 'ai-settings' | 'research-mode') => void;
  openModal: (tab: 'ai-settings' | 'research-mode') => void;
  agentsDropdownOpen: boolean;
  setAgentsDropdownOpen: (open: boolean) => void;
  sessionFilesOpen: boolean;
  setSessionFilesOpen: (open: boolean) => void;
}

export const useAdvancedAISettings = create<State>(set => ({
  liveAI: true,
  setLiveAI: liveAI => set({ liveAI }),
  showAdvancedSettings: false,
  setShowAdvancedSettings: showAdvancedSettings => set({ showAdvancedSettings }),
  modelDetailsOpen: false,
  setModelDetailsOpen: modelDetailsOpen => set({ modelDetailsOpen }),
  historyLines: INFINITE_VALUE,
  setHistoryLines: historyLines => set({ historyLines }),
  activeTab: 'ai-settings',
  setActiveTab: activeTab => set({ activeTab }),
  openModal: (tab: 'ai-settings' | 'research-mode') => set({ activeTab: tab, showAdvancedSettings: true }),
  agentsDropdownOpen: false,
  setAgentsDropdownOpen: (agentsDropdownOpen: boolean) => set({ agentsDropdownOpen }),
  sessionFilesOpen: false,
  setSessionFilesOpen: (sessionFilesOpen: boolean) => set({ sessionFilesOpen }),
}));
