import { Component, ReactNode, ErrorInfo } from 'react';

interface Props {
  children: ReactNode;
  pluginName?: string;
}

interface State {
  hasError: boolean;
  error: Error | null;
}

/**
 * Error boundary for wrapping individual Lexical plugins. Fails silently
 * (renders nothing) so a plugin crash doesn't disrupt typing, logs to console
 * for debugging, and isolates one plugin's failure from the others.
 */
export class PluginErrorBoundary extends Component<Props, State> {
  constructor(props: Props) {
    super(props);
    this.state = { hasError: false, error: null };
  }

  static getDerivedStateFromError(error: Error): State {
    return { hasError: true, error };
  }

  componentDidCatch(error: Error, errorInfo: ErrorInfo): void {
    const pluginName = this.props.pluginName || 'Unknown Plugin';
    console.error(`[${pluginName}] Plugin error:`, error);
    console.error('Error details:', errorInfo.componentStack);
  }

  render() {
    if (this.state.hasError) {
      // Silent failure: the editor keeps working, just without this plugin.
      return null;
    }

    return this.props.children;
  }
}
