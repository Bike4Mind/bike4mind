import { PropsWithChildren, createContext, useContext } from 'react';

type ServerSidePropsContextType = {
  apiUrl: string;
  websocketUrl: string;
  appfileBucketName: string;
  googleClientId: string;
  fabfileBucketName: string;
};

const ServerSidePropsContext = createContext<ServerSidePropsContextType>({
  apiUrl: '',
  websocketUrl: '',
  appfileBucketName: '',
  googleClientId: '',
  fabfileBucketName: '',
});

export const ServerSidePropsProvider = ({ children, ...props }: PropsWithChildren<ServerSidePropsContextType>) => {
  return <ServerSidePropsContext.Provider value={props}>{children}</ServerSidePropsContext.Provider>;
};

export function useServerSideProps() {
  const context = useContext(ServerSidePropsContext);
  if (!context) {
    throw new Error('useServerSideProps must be used within a ServerSidePropsProvider');
  }
  return context;
}
