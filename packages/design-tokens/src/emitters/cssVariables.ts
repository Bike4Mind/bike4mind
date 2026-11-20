import type { ColorSchemeMode, DesignTokens } from '../schema';
import type { TokenEmitter } from './types';

// Emits the tokens as CSS custom properties (--b4m-*). Optional target: handy
// for non-Joy surfaces (static pages, e-mail templates, the docs site).

const isTokenReference = (value: string): boolean => /^[a-z][a-zA-Z]*\.[a-zA-Z0-9]+$/.test(value);

const toKebab = (name: string): string => name.replace(/([a-z0-9])([A-Z])/g, '$1-$2').toLowerCase();

const collectSchemeVariables = (tokens: DesignTokens, mode: ColorSchemeMode): string[] => {
  const scheme = tokens.color.schemes[mode];
  const lines: string[] = [];
  const push = (path: string[], value: string): void => {
    // Token references (e.g. "neutral.200") need the consuming platform's
    // palette to resolve; they are not valid CSS, so they are not emitted.
    if (isTokenReference(value)) return;
    lines.push(`  --b4m-color-${path.map(toKebab).join('-')}: ${value};`);
  };
  push(['divider'], scheme.divider);
  for (const [group, values] of Object.entries(scheme)) {
    if (typeof values === 'string') continue;
    for (const [name, value] of Object.entries(values)) {
      if (typeof value === 'string') {
        push([group, name], value);
      }
    }
  }
  return lines;
};

const shadowValue = (tokens: DesignTokens, level: keyof DesignTokens['shadows']['levels']): string =>
  tokens.shadows.levels[level]
    .map(
      layer =>
        `${layer.offsetX}px ${layer.offsetY}px ${layer.blur}px ${layer.spread}px ` +
        `rgba(${tokens.shadows.channel} / ${tokens.shadows.opacity})`
    )
    .join(', ');

export const emitCssVariables = (tokens: DesignTokens): string => {
  const globalLines: string[] = [];
  for (const [name, value] of Object.entries(tokens.typography.fontFamily)) {
    globalLines.push(`  --b4m-font-family-${toKebab(name)}: ${value};`);
  }
  for (const [name, value] of Object.entries(tokens.typography.fontSize)) {
    globalLines.push(`  --b4m-font-size-${toKebab(name)}: ${value};`);
  }
  for (const [name, value] of Object.entries(tokens.typography.fontWeight)) {
    globalLines.push(`  --b4m-font-weight-${toKebab(name)}: ${value};`);
  }
  for (const [name, value] of Object.entries(tokens.typography.lineHeight)) {
    globalLines.push(`  --b4m-line-height-${toKebab(name)}: ${value};`);
  }
  globalLines.push(`  --b4m-spacing-unit: ${tokens.spacing.unit}px;`);
  for (const [name, value] of Object.entries(tokens.radii)) {
    globalLines.push(`  --b4m-radius-${toKebab(name)}: ${value}px;`);
  }
  for (const level of Object.keys(tokens.shadows.levels) as Array<keyof DesignTokens['shadows']['levels']>) {
    globalLines.push(`  --b4m-shadow-${level}: ${shadowValue(tokens, level)};`);
  }
  for (const [name, value] of Object.entries(tokens.motion.duration)) {
    globalLines.push(`  --b4m-duration-${toKebab(name)}: ${value}ms;`);
  }

  return [
    ':root {',
    ...globalLines,
    ...collectSchemeVariables(tokens, 'light'),
    '}',
    '',
    '[data-b4m-color-scheme="dark"] {',
    ...collectSchemeVariables(tokens, 'dark'),
    '}',
    '',
  ].join('\n');
};

export const cssVariablesEmitter: TokenEmitter<string> = {
  target: 'css-variables',
  emit: emitCssVariables,
};
