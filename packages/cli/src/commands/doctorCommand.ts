/**
 * External doctor command (b4m doctor)
 * Runs diagnostic checks on the CLI installation.
 * Runs outside the interactive CLI session.
 */

import { execSync } from 'child_process';
import { existsSync } from 'fs';
import path from 'path';
import { homedir } from 'os';
import packageJson from '../../package.json';
import { fetchLatestVersion, compareSemver, isNpmPrefixWritable } from '../utils/updateChecker.js';
import { checkRipgrep } from '../utils/ripgrepCheck.js';

interface DiagnosticResult {
  name: string;
  status: 'pass' | 'warn' | 'fail';
  message: string;
}

export async function handleDoctorCommand(): Promise<void> {
  console.log('B4M CLI Doctor\n');
  console.log('Running diagnostics...\n');

  const results: DiagnosticResult[] = [];

  // 1. Node.js version
  const nodeVersion = process.version;
  const nodeMajor = parseInt(nodeVersion.slice(1).split('.')[0], 10);
  if (nodeMajor >= 18) {
    results.push({ name: 'Node.js version', status: 'pass', message: `${nodeVersion} (>= 18 required)` });
  } else {
    results.push({
      name: 'Node.js version',
      status: 'fail',
      message: `${nodeVersion} (>= 18 required, please upgrade)`,
    });
  }

  // 2. NPM registry accessibility (and version comparison if reachable)
  const currentVersion = packageJson.version;
  const latestVersion = await fetchLatestVersion();
  if (latestVersion) {
    results.push({ name: 'NPM registry', status: 'pass', message: `Accessible (latest: v${latestVersion})` });

    if (compareSemver(latestVersion, currentVersion) > 0) {
      results.push({
        name: 'Version',
        status: 'warn',
        message: `v${currentVersion} installed, v${latestVersion} available. Run: b4m update`,
      });
    } else {
      results.push({ name: 'Version', status: 'pass', message: `v${currentVersion} (latest)` });
    }
  } else {
    results.push({ name: 'NPM registry', status: 'fail', message: 'Not accessible — check your internet connection' });
  }

  // 4. Global npm prefix and write permissions
  try {
    const npmPrefix = execSync('npm config get prefix', { encoding: 'utf-8', timeout: 10_000 }).trim();
    if (await isNpmPrefixWritable(npmPrefix)) {
      results.push({ name: 'Global npm path', status: 'pass', message: `${npmPrefix} (writable)` });
    } else {
      results.push({
        name: 'Global npm path',
        status: 'warn',
        message: `${npmPrefix} (not writable — may need sudo for updates)`,
      });
    }
  } catch {
    results.push({ name: 'Global npm path', status: 'warn', message: 'Could not determine npm prefix' });
  }

  // 5. ripgrep (powers the grep_search tool)
  const rg = await checkRipgrep();
  if (rg.available) {
    results.push({ name: 'ripgrep (grep_search)', status: 'pass', message: rg.path! });
  } else {
    results.push({
      name: 'ripgrep (grep_search)',
      status: 'warn',
      message: `${rg.error ?? 'not found'} — run: b4m update`,
    });
  }

  // 6. Config file
  const configFile = path.join(homedir(), '.bike4mind', 'config.json');
  if (existsSync(configFile)) {
    results.push({ name: 'Config file', status: 'pass', message: configFile });
  } else {
    results.push({ name: 'Config file', status: 'warn', message: `Not found at ${configFile}` });
  }

  // Display results
  console.log('Results:\n');
  for (const result of results) {
    const icon =
      result.status === 'pass'
        ? '\x1b[32m✓\x1b[0m'
        : result.status === 'warn'
          ? '\x1b[33m!\x1b[0m'
          : '\x1b[31m✗\x1b[0m';
    console.log(`  ${icon} ${result.name}: ${result.message}`);
  }

  const failures = results.filter(r => r.status === 'fail');
  const warnings = results.filter(r => r.status === 'warn');
  console.log('');

  if (failures.length > 0) {
    console.log(`${failures.length} issue(s) found.`);
  } else if (warnings.length > 0) {
    console.log(`All checks passed with ${warnings.length} warning(s).`);
  } else {
    console.log('All checks passed.');
  }
}
