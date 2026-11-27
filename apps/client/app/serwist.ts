'use client';

import { createElement, type ComponentProps } from 'react';
import { SerwistProvider as Provider } from '@serwist/turbopack/react';

export function SerwistProvider(props: ComponentProps<typeof Provider>) {
  return createElement(Provider, {
    ...props,
    disable: process.env.NODE_ENV !== 'production' || props.disable,
  });
}
