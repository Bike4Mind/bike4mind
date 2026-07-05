import { Component, ErrorInfo, ReactNode } from 'react';

interface Props {
  children: ReactNode;
  fallback?: ReactNode;
}

interface State {
  hasError: boolean;
  error: Error | null;
}

/**
 * Error Boundary for Modal System
 *
 * Catches rendering errors in modal components and displays a fallback UI
 * instead of breaking the entire application.
 *
 * Usage:
 * <ModalErrorBoundary>
 *   <ModalManager />
 * </ModalErrorBoundary>
 */
class ModalErrorBoundary extends Component<Props, State> {
  constructor(props: Props) {
    super(props);
    this.state = {
      hasError: false,
      error: null,
    };
  }

  static getDerivedStateFromError(error: Error): State {
    // Update state so the next render will show the fallback UI
    return {
      hasError: true,
      error,
    };
  }

  componentDidCatch(error: Error, errorInfo: ErrorInfo) {
    // Log error to monitoring service
    console.error('Modal Error Boundary caught an error:', error, errorInfo);

    // TODO: Send to error monitoring service (Sentry, LogRocket, etc.)
    // if (window.errorMonitoring) {
    //   window.errorMonitoring.captureException(error, {
    //     context: 'ModalErrorBoundary',
    //     componentStack: errorInfo.componentStack,
    //   });
    // }
  }

  render() {
    if (this.state.hasError) {
      // Render custom fallback UI or default
      if (this.props.fallback) {
        return this.props.fallback;
      }

      // Default fallback UI - silent failure
      // Modals are not critical to app functionality, so we fail silently
      return null;
    }

    return this.props.children;
  }
}

export default ModalErrorBoundary;
