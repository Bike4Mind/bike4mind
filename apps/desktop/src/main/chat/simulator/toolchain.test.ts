import { describe, expect, it } from 'vitest';
import { diagnoseToolchainFailure, SimulatorSetupError, ToolchainCommandError } from './toolchain';

describe('diagnoseToolchainFailure', () => {
  it('names the brew command when axe is missing', () => {
    const diagnosis = diagnoseToolchainFailure(new ToolchainCommandError('axe', 'ENOENT', '', ''));
    expect(diagnosis).toBeInstanceOf(SimulatorSetupError);
    expect(diagnosis?.fix).toContain('brew install cameroncooke/axe/axe');
  });

  it('points at the App Store when xcrun is missing', () => {
    const diagnosis = diagnoseToolchainFailure(new ToolchainCommandError('xcrun', 'ENOENT', '', ''));
    expect(diagnosis?.problem).toContain('`xcrun` was not found');
    expect(diagnosis?.fix).toContain('App Store');
  });

  it('asks for the licence to be accepted', () => {
    const stderr = 'You have not agreed to the Xcode license agreements. Please run sudo xcodebuild -license';
    const diagnosis = diagnoseToolchainFailure(new ToolchainCommandError('xcrun', 69, '', stderr));
    expect(diagnosis?.fix).toContain('sudo xcodebuild -license accept');
  });

  it('asks for xcode-select when only the Command Line Tools are active', () => {
    const stderr = 'xcrun: error: unable to find utility "simctl", not a developer tool or in PATH';
    const diagnosis = diagnoseToolchainFailure(new ToolchainCommandError('xcrun', 72, '', stderr));
    expect(diagnosis?.fix).toContain('xcode-select -s');
  });

  it('leaves a failure that is the command own to the caller', () => {
    expect(diagnoseToolchainFailure(new ToolchainCommandError('xcrun', 65, '', 'error: no such scheme'))).toBeNull();
  });

  it('ignores errors that are not toolchain command errors', () => {
    expect(diagnoseToolchainFailure(new Error('ENOENT'))).toBeNull();
    expect(diagnoseToolchainFailure('boom')).toBeNull();
  });

  it('tells the model not to retry', () => {
    const diagnosis = diagnoseToolchainFailure(new ToolchainCommandError('axe', 'ENOENT', '', ''));
    expect(diagnosis?.message).toContain('do not retry');
  });
});
