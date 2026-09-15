#!/usr/bin/env node

import fs from 'fs';
import path from 'path';
import { execSync } from 'child_process';

const B4M_PACKAGES = [
  '@bike4mind/common',
  '@bike4mind/services',
  '@bike4mind/utils',
  '@bike4mind/mcp'
];

const WORKSPACE_PACKAGES = [
  'packages/client/package.json',
  'packages/database/package.json',
  'packages/scripts/package.json',
  'packages/subscriber-fanout/package.json'
];

/**
 * Get the latest version of a package from npm
 */
function getLatestVersion(packageName) {
  try {
    const result = execSync(`npm view ${packageName} version --silent`, { encoding: 'utf8' });
    return result.trim();
  } catch (error) {
    console.warn(`⚠️  Could not get latest version for ${packageName}: ${error.message}`);
    return null;
  }
}

/**
 * Update package.json file with new versions
 */
function updatePackageFile(filePath, newVersions) {
  const packageJson = JSON.parse(fs.readFileSync(filePath, 'utf8'));
  let updated = false;

  // Update dependencies
  if (packageJson.dependencies) {
    for (const [pkg, newVersion] of Object.entries(newVersions)) {
      if (packageJson.dependencies[pkg]) {
        const oldVersion = packageJson.dependencies[pkg];
        if (oldVersion !== newVersion) {
          console.log(`📦 ${path.dirname(filePath)}: ${pkg} ${oldVersion} → ${newVersion}`);
          packageJson.dependencies[pkg] = newVersion;
          updated = true;
        }
      }
    }
  }

  // Update devDependencies
  if (packageJson.devDependencies) {
    for (const [pkg, newVersion] of Object.entries(newVersions)) {
      if (packageJson.devDependencies[pkg]) {
        const oldVersion = packageJson.devDependencies[pkg];
        if (oldVersion !== newVersion) {
          console.log(`📦 ${path.dirname(filePath)}: ${pkg} ${oldVersion} → ${newVersion} (dev)`);
          packageJson.devDependencies[pkg] = newVersion;
          updated = true;
        }
      }
    }
  }

  if (updated) {
    fs.writeFileSync(filePath, JSON.stringify(packageJson, null, 2) + '\n');
    return true;
  }
  return false;
}

/**
 * Main function
 */
async function main() {
  console.log('🔍 Checking for latest @bike4mind package versions...\n');

  // Get specified versions or latest from npm
  const newVersions = {};
  
  for (const pkg of B4M_PACKAGES) {
    // Check if version specified as argument (e.g., --common=0.0.15)
    const argName = pkg.split('/')[1]; // @bike4mind/common -> common
    const argVersion = process.argv.find(arg => arg.startsWith(`--${argName}=`));
    
    if (argVersion) {
      newVersions[pkg] = argVersion.split('=')[1];
      console.log(`📌 Using specified version: ${pkg}@${newVersions[pkg]}`);
    } else {
      const latestVersion = getLatestVersion(pkg);
      if (latestVersion) {
        newVersions[pkg] = latestVersion;
        console.log(`📋 Latest version: ${pkg}@${latestVersion}`);
      }
    }
  }

  if (Object.keys(newVersions).length === 0) {
    console.log('❌ No versions found. Exiting.');
    return;
  }

  console.log('\n🔄 Updating workspace packages...\n');

  let totalUpdated = 0;
  for (const packageFile of WORKSPACE_PACKAGES) {
    if (fs.existsSync(packageFile)) {
      const wasUpdated = updatePackageFile(packageFile, newVersions);
      if (wasUpdated) totalUpdated++;
    } else {
      console.warn(`⚠️  Package file not found: ${packageFile}`);
    }
  }

  if (totalUpdated > 0) {
    console.log(`\n✅ Updated ${totalUpdated} package(s)!`);
    console.log('\n💡 Next steps:');
    console.log('   1. Run: pnpm install');
    console.log('   2. Test your changes');
    console.log('   3. Commit the updated package.json files');
  } else {
    console.log('\n✨ All packages are already up to date!');
  }
}

main().catch(console.error); 