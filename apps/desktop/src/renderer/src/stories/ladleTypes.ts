import type { FC, ReactNode } from 'react';

// Declared here instead of imported from '@ladle/react': that package's type entry resolves into
// its own .tsx sources, which skipLibCheck does not cover and which fail under tsgo.

export type LadleTheme = 'light' | 'dark' | 'auto';

export interface StoryDefault {
  title?: string;
}

interface ArgType<Value> {
  options?: readonly Value[];
  control?: { type: 'radio' | 'inline-radio' | 'select' | 'check' | 'boolean' | 'text' | 'number' | 'range' };
  defaultValue?: Value;
}

export type Story<Props = object> = FC<Props> & {
  args?: Partial<Props>;
  argTypes?: { [Key in keyof Props]?: ArgType<Props[Key]> };
  storyName?: string;
};

export type GlobalProvider = FC<{ children: ReactNode; globalState: { theme: LadleTheme } }>;
