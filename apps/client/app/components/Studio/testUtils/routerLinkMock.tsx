import { forwardRef, type AnchorHTMLAttributes, type ComponentType, type RefAttributes } from 'react';

type StubLinkProps = { to: string; params?: Record<string, string> } & Omit<
  AnchorHTMLAttributes<HTMLAnchorElement>,
  'href'
>;

/** Stand-in for Tanstack's `createLink` that renders a plain anchor with the resolved href. */
export const createLinkStub = (
  Component: ComponentType<AnchorHTMLAttributes<HTMLAnchorElement> & RefAttributes<HTMLAnchorElement>>
) => {
  const StubLink = forwardRef<HTMLAnchorElement, StubLinkProps>(({ to, params, ...rest }, ref) => (
    <Component ref={ref} href={to.replace(/\$(\w+)/g, (_match, key: string) => params?.[key] ?? '')} {...rest} />
  ));
  StubLink.displayName = 'StubLink';
  return StubLink;
};
