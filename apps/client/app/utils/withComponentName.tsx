import React from 'react';

export function withComponentName<P extends object>(WrappedComponent: React.ComponentType<P>, componentName: string) {
  return function WithComponentName(props: P) {
    return (
      <div data-component-name={componentName}>
        <WrappedComponent {...props} />
      </div>
    );
  };
}
