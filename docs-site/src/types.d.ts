declare module '*.module.css' {
  const classes: { readonly [key: string]: string };
  export default classes;
}

declare module '@docusaurus/Link' {
  import React from 'react';

  export interface LinkProps extends React.AnchorHTMLAttributes<HTMLAnchorElement> {
    to?: string;
    activeClassName?: string;
    isNavLink?: boolean;
  }

  const Link: React.ComponentType<LinkProps>;
  export default Link;
}

declare module '@docusaurus/useDocusaurusContext' {
  export interface DocusaurusContext {
    siteConfig: {
      title: string;
      tagline: string;
      url: string;
      baseUrl: string;
      favicon: string;
      organizationName: string;
      projectName: string;
    };
    siteMetadata: {
      docusaurusVersion: string;
    };
  }

  export default function useDocusaurusContext(): DocusaurusContext;
}
