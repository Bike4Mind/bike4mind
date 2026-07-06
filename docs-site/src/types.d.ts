declare module '*.module.css' {
  const classes: { readonly [key: string]: string };
  export default classes;
}

declare module '@site/static/img/undraw_docusaurus_mountain.svg' {
  import React from 'react';
  const SVGComponent: React.ComponentType<React.SVGProps<SVGSVGElement>>;
  export default SVGComponent;
}

// Auth types
declare module '@site/src/api/auth' {
  export function isAuthenticated(): boolean;
  export function setAuthToken(token: string, expiryHours?: number): void;
  export function getAuthToken(): string | null;
  export function clearAuthToken(): void;
}

declare module '@site/static/img/undraw_docusaurus_tree.svg' {
  import React from 'react';
  const SVGComponent: React.ComponentType<React.SVGProps<SVGSVGElement>>;
  export default SVGComponent;
}

declare module '@site/static/img/undraw_docusaurus_react.svg' {
  import React from 'react';
  const SVGComponent: React.ComponentType<React.SVGProps<SVGSVGElement>>;
  export default SVGComponent;
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
