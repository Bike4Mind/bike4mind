import React, { ComponentType, PropsWithChildren } from 'react';

export type AppPage<P = {}> = ComponentType<P> & {
  Layout?: React.FC<PropsWithChildren>;

  /**
   * Auth configuration for the page.
   */
  auth?: {
    /**
     * Allow unauthenticated users to access the page.
     */
    allowUnauthenticated?: boolean;

    /**
     * If true, the user must be an admin to access the page.
     */
    requireAdmin?: boolean;
  };
};
