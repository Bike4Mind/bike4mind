import { create } from 'zustand';
import { persist } from 'zustand/middleware';

export type Account = {
  id: string;
  name: string;
  personal: boolean;
  credits: number;
  /** Team accounts only. */
  seats?: number;
};

// Apart from AccountSelector so data hooks (useModelInfo) can read it without importing LLMContext.
interface SelectedAccountStore {
  selectedAccount: Account | null;
  setSelectedAccount: (account: Account | null) => void;
}

export const useSelectedAccount = create<SelectedAccountStore>()(
  persist(
    set => ({
      selectedAccount: null,
      setSelectedAccount: account => set({ selectedAccount: account }),
    }),
    {
      name: 'selected-account-storage',
    }
  )
);
