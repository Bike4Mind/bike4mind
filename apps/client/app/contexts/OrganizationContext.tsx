import React, { ReactNode, createContext, useState, useMemo } from 'react';

interface OrganizationContextType {
  selectedOrganization: string[] | null;
  setSelectedOrganization: (organization: string[] | null) => void;
}

export const OrganizationContext = createContext<OrganizationContextType>({
  selectedOrganization: null,
  setSelectedOrganization: () => {},
});

export function useOrganizationContext() {
  const context = React.useContext(OrganizationContext);
  if (!context) {
    throw new Error('useOrganizationContext must be used within an OrganizationProvider');
  }
  return context;
}

interface OrganizationProviderProps {
  children: ReactNode;
}

export const OrganizationProvider: React.FC<OrganizationProviderProps> = ({ children }) => {
  const [selectedOrganization, setSelectedOrganization] = useState<string[] | null>(['all']);

  const contextValue = useMemo(
    () => ({ selectedOrganization, setSelectedOrganization }),
    [selectedOrganization, setSelectedOrganization]
  );

  return <OrganizationContext.Provider value={contextValue}>{children}</OrganizationContext.Provider>;
};
