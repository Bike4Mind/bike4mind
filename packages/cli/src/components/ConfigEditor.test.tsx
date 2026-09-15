/**
 * ConfigEditor plugin auto-discovery: valid installed plugins get a feature
 * toggle row, invalid ones don't, and the built-in Tavern row is never
 * duplicated (reserved keys are rejected at discovery, this guards the render
 * side of that contract).
 */

import { describe, it, expect } from 'vitest';
import React from 'react';
import { render } from 'ink-testing-library';
import { ConfigEditor } from './ConfigEditor';
import type { CliConfig } from '../storage';
import type { PluginDescriptor } from '../plugins/PluginStore';

const config = {
  defaultModel: 'test-model',
  preferences: {},
  features: { tavern: false, greeter: true },
  tools: { enabled: [], disabled: [], config: {} },
} as unknown as CliConfig;

function makeDescriptor(overrides: Partial<PluginDescriptor> = {}): PluginDescriptor {
  // Short name: ink wraps long labels across lines, which would make a
  // substring assertion test the terminal width instead of the row.
  return {
    valid: true,
    name: 'greeter',
    version: '1.0.0',
    description: 'greets',
    packageDir: '/plugins/node_modules/greeter',
    entryAbsPath: '/plugins/node_modules/greeter/index.mjs',
    configKey: 'greeter',
    ...overrides,
  } as PluginDescriptor;
}

describe('ConfigEditor plugin toggles', () => {
  it('renders a toggle row per valid installed plugin', () => {
    const { lastFrame } = render(
      <ConfigEditor
        config={config}
        availableModels={[]}
        pluginDescriptors={[makeDescriptor()]}
        onSave={async () => {}}
        onClose={() => {}}
      />
    );
    expect(lastFrame()).toContain('Plugin: greeter');
  });

  it('does not render invalid plugins', () => {
    const invalid = {
      valid: false,
      name: 'b4m-plugin-broken',
      packageDir: '/x',
      reason: 'entry is required',
    } as PluginDescriptor;
    const { lastFrame } = render(
      <ConfigEditor
        config={config}
        availableModels={[]}
        pluginDescriptors={[invalid]}
        onSave={async () => {}}
        onClose={() => {}}
      />
    );
    expect(lastFrame()).not.toContain('b4m-plugin-broken');
  });

  it('keeps a single Tavern row when plugins are present', () => {
    const { lastFrame } = render(
      <ConfigEditor
        config={config}
        availableModels={[]}
        pluginDescriptors={[makeDescriptor()]}
        onSave={async () => {}}
        onClose={() => {}}
      />
    );
    const frame = lastFrame() ?? '';
    expect(frame.match(/Tavern/g)).toHaveLength(1);
  });
});
