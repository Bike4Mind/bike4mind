import { Component, type ErrorInfo, type ReactNode } from 'react';
import { AppErrorFallback } from './AppErrorFallback';
import { reportRenderError } from './renderError';

type State = { caught: { error: unknown; componentStack: string | null } | null };

/**
 * The outermost boundary, for render errors outside any route (the theme sync, the router
 * itself). Errors inside a route are caught by the router's own boundary, which router.tsx
 * points at the same fallback and reporter.
 */
export class AppErrorBoundary extends Component<{ children: ReactNode }, State> {
  state: State = { caught: null };

  static getDerivedStateFromError(error: unknown): State {
    return { caught: { error, componentStack: null } };
  }

  componentDidCatch(error: unknown, info: ErrorInfo): void {
    const componentStack = info.componentStack ?? null;
    this.setState({ caught: { error, componentStack } });
    reportRenderError(error, componentStack);
  }

  render(): ReactNode {
    const { caught } = this.state;
    if (!caught) return this.props.children;
    return <AppErrorFallback error={caught.error} componentStack={caught.componentStack} />;
  }
}
