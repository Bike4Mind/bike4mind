#!/usr/bin/env node
/**
 * Automated test for WAF auto-reconciliation and auto-recreation.
 *
 * This script tests the Infrastructure as Code (IaC) promise:
 * 1. Resilience Test: Delete WebACL manually -> SST auto-recreates it on next deploy
 * 2. Full Lifecycle Test: `sst remove` -> `sst deploy` recreates everything including WAF
 *
 * Usage:
 *   # Test 1: Delete WebACL and verify SST recreates it
 *   node scripts/test-waf-auto-reconciliation.mjs --stage pr6391 --test delete-webacl
 *
 *   # Test 2: Full infrastructure removal and recreation
 *   node scripts/test-waf-auto-reconciliation.mjs --stage pr6391 --test full-lifecycle
 *
 *   # Dry run (show what would happen without executing)
 *   node scripts/test-waf-auto-reconciliation.mjs --stage pr6391 --test delete-webacl --dry-run
 */

import { CloudFrontClient, GetDistributionCommand, ListDistributionsCommand, ListTagsForResourceCommand } from '@aws-sdk/client-cloudfront';
import { WAFV2Client, ListWebACLsCommand, GetWebACLCommand, DeleteWebACLCommand, ListIPSetsCommand, DeleteIPSetCommand } from '@aws-sdk/client-wafv2';
import { execSync } from 'child_process';
import * as readline from 'readline';

const REGION = 'us-east-1';
const APP_NAME = 'bike4mind';

// Parse CLI args
const args = process.argv.slice(2);
const STAGE = args.find(arg => arg.startsWith('--stage='))?.split('=')[1] || process.env.STAGE || 'pr6391';
const TEST_TYPE = args.find(arg => arg.startsWith('--test='))?.split('=')[1] || 'delete-webacl';
const DRY_RUN = args.includes('--dry-run');

const cloudfront = new CloudFrontClient({ region: 'us-east-1' });
const wafv2 = new WAFV2Client({ region: REGION });

// ANSI colors
const colors = {
  reset: '\x1b[0m',
  bright: '\x1b[1m',
  red: '\x1b[31m',
  green: '\x1b[32m',
  yellow: '\x1b[33m',
  blue: '\x1b[34m',
  cyan: '\x1b[36m',
  magenta: '\x1b[35m',
};

function log(msg, color = colors.reset) {
  console.log(`${color}${msg}${colors.reset}`);
}

function logStep(step, msg) {
  log(`\n${'='.repeat(80)}`, colors.cyan);
  log(`[STEP ${step}] ${msg}`, colors.bright + colors.cyan);
  log('='.repeat(80), colors.cyan);
}

function logSuccess(msg) {
  log(`✅ ${msg}`, colors.green);
}

function logError(msg) {
  log(`❌ ${msg}`, colors.red);
}

function logInfo(msg) {
  log(`ℹ️  ${msg}`, colors.blue);
}

function logWarning(msg) {
  log(`⚠️  ${msg}`, colors.yellow);
}

function logAction(msg) {
  log(`🔧 ${msg}`, colors.magenta);
}

// Helper: Prompt user for confirmation
async function confirmStage(expectedStage, resources) {
  return new Promise((resolve) => {
    const rl = readline.createInterface({
      input: process.stdin,
      output: process.stdout,
    });

    log('\n' + '='.repeat(80), colors.red);
    log('⚠️  DESTRUCTIVE OPERATION CONFIRMATION ⚠️', colors.bright + colors.red);
    log('='.repeat(80), colors.red);
    log('', colors.reset);
    log(`Stage: ${colors.bright}${expectedStage}${colors.reset}`);
    log('', colors.reset);
    log('The following resources will be DELETED:', colors.yellow);
    
    if (resources.webAcl) {
      log(`  • WebACL: ${colors.cyan}${resources.webAcl.name}${colors.reset}`);
      log(`    ARN: ${resources.webAcl.arn}`, colors.blue);
    }
    
    if (resources.ipSet) {
      log(`  • IPSet: ${colors.cyan}${resources.ipSet.name}${colors.reset}`);
    }
    
    if (resources.distribution) {
      log(`  • CloudFront Distribution: ${colors.cyan}${resources.distribution.id}${colors.reset}`, colors.yellow);
      log(`    (WebACL will be detached during deletion)`, colors.yellow);
    }
    
    log('', colors.reset);
    log('These resources will be RECREATED by running `npx sst deploy`.', colors.green);
    log('', colors.reset);
    log('='.repeat(80), colors.red);
    log(`Type "${colors.bright}${expectedStage}${colors.reset}" to confirm, or anything else to cancel:`, colors.yellow);

    rl.question('> ', (answer) => {
      rl.close();
      
      if (answer.trim() === expectedStage) {
        log('', colors.reset);
        logSuccess('Confirmation received. Proceeding with deletion...');
        resolve(true);
      } else {
        log('', colors.reset);
        logError(`Confirmation failed. You typed "${answer}" but expected "${expectedStage}".`);
        logInfo('Aborting test for safety.');
        resolve(false);
      }
    });
  });
}

// Helper: Get WebACL details
async function getWebAcl() {
  const expectedName = STAGE.match(/^pr\d+$/i) 
    ? `bike4mind-api-protection-${STAGE.toLowerCase()}`
    : 'bike4mind-api-protection-dev';
  
  const { WebACLs } = await wafv2.send(new ListWebACLsCommand({ Scope: 'CLOUDFRONT' }));
  return WebACLs.find(acl => acl.Name === expectedName);
}

// Helper: Get IPSet details
async function getEmergencyIpSet() {
  const expectedName = STAGE.match(/^pr\d+$/i)
    ? `emergency-ip-block-${STAGE.toLowerCase()}`
    : 'emergency-ip-block-dev';
  
  const { IPSets } = await wafv2.send(new ListIPSetsCommand({ Scope: 'CLOUDFRONT' }));
  return IPSets.find(ipset => ipset.Name === expectedName);
}

// Helper: Check CloudFront -> WebACL association
async function checkCloudFrontAssociation() {
  let marker;
  
  while (true) {
    const { DistributionList } = await cloudfront.send(new ListDistributionsCommand({ Marker: marker }));
    
    if (!DistributionList?.Items) break;
    
    for (const dist of DistributionList.Items) {
      const arn = `arn:aws:cloudfront::${dist.ARN?.split(':')[4] || ''}:distribution/${dist.Id}`;
      
      try {
        const { Tags } = await cloudfront.send(new ListTagsForResourceCommand({ Resource: arn }));
        const tagMap = Object.fromEntries((Tags?.Items || []).map(t => [t.Key, t.Value]));
        
        if (tagMap['sst:app'] === APP_NAME && tagMap['sst:stage'] === STAGE) {
          const { Distribution } = await cloudfront.send(new GetDistributionCommand({ Id: dist.Id }));
          return {
            id: dist.Id,
            domain: dist.DomainName,
            webAclId: Distribution.DistributionConfig.WebACLId,
          };
        }
      } catch {
        continue;
      }
      
      await new Promise(resolve => setTimeout(resolve, 150));
    }
    
    marker = DistributionList.NextMarker;
    if (!marker) break;
  }
  
  return null;
}

// Helper: Delete WebACL (with retries for lock tokens)
async function deleteWebAcl(webAcl) {
  logAction(`Deleting WebACL: ${webAcl.Name} (${webAcl.Id})`);
  
  if (DRY_RUN) {
    logInfo('[DRY RUN] Would delete WebACL, but skipping');
    return;
  }
  
  // Get fresh lock token
  const { WebACL } = await wafv2.send(new GetWebACLCommand({
    Scope: 'CLOUDFRONT',
    Id: webAcl.Id,
    Name: webAcl.Name,
  }));
  
  await wafv2.send(new DeleteWebACLCommand({
    Scope: 'CLOUDFRONT',
    Id: webAcl.Id,
    Name: webAcl.Name,
    LockToken: WebACL.LockToken,
  }));
  
  logSuccess('WebACL deleted successfully');
}

// Helper: Delete IPSet
async function deleteIpSet(ipSet) {
  logAction(`Deleting IPSet: ${ipSet.Name} (${ipSet.Id})`);
  
  if (DRY_RUN) {
    logInfo('[DRY RUN] Would delete IPSet, but skipping');
    return;
  }
  
  // WebACL must be deleted first, then wait for propagation
  logInfo('Waiting 10 seconds for WebACL deletion to propagate...');
  await new Promise(resolve => setTimeout(resolve, 10000));
  
  const { IPSets } = await wafv2.send(new ListIPSetsCommand({ Scope: 'CLOUDFRONT' }));
  const fresh = IPSets.find(s => s.Id === ipSet.Id);
  
  if (!fresh) {
    logInfo('IPSet already deleted');
    return;
  }
  
  await wafv2.send(new DeleteIPSetCommand({
    Scope: 'CLOUDFRONT',
    Id: ipSet.Id,
    Name: ipSet.Name,
    LockToken: fresh.LockToken,
  }));
  
  logSuccess('IPSet deleted successfully');
}

// Helper: Run SST deploy
function runSstDeploy() {
  logAction('Running: npx sst deploy');
  
  if (DRY_RUN) {
    logInfo('[DRY RUN] Would run SST deploy, but skipping');
    return;
  }
  
  try {
    execSync(`npx sst deploy --stage ${STAGE}`, {
      cwd: process.cwd(),
      stdio: 'inherit',
      env: { ...process.env, STAGE },
    });
    logSuccess('SST deploy completed');
  } catch (error) {
    logError(`SST deploy failed: ${error.message}`);
    throw error;
  }
}

// Helper: Run SST remove
function runSstRemove() {
  logAction('Running: npx sst remove');
  
  if (DRY_RUN) {
    logInfo('[DRY RUN] Would run SST remove, but skipping');
    return;
  }
  
  try {
    execSync(`npx sst remove --stage ${STAGE}`, {
      cwd: process.cwd(),
      stdio: 'inherit',
      env: { ...process.env, STAGE },
    });
    logSuccess('SST remove completed');
  } catch (error) {
    logError(`SST remove failed: ${error.message}`);
    throw error;
  }
}

// TEST 1: Delete WebACL manually, then verify SST recreates it
async function testDeleteWebAcl() {
  log('\n🧪 TEST: Delete WebACL → SST Auto-Recreates', colors.bright + colors.magenta);
  log('This tests SST\'s ability to detect drift and recreate missing resources.', colors.blue);
  
  // Step 1: Verify WebACL exists before deletion
  logStep(1, 'Verify WebACL exists BEFORE deletion');
  const webAclBefore = await getWebAcl();
  
  if (!webAclBefore) {
    logError('WebACL does not exist. Deploy infrastructure first.');
    process.exit(1);
  }
  
  logSuccess(`Found WebACL: ${webAclBefore.Name}`);
  logInfo(`ARN: ${webAclBefore.ARN}`);
  
  // Check CloudFront association before
  const distBefore = await checkCloudFrontAssociation();
  if (distBefore?.webAclId) {
    logSuccess(`CloudFront ${distBefore.id} has WebACL attached`);
  } else {
    logWarning('CloudFront distribution not found or no WebACL attached');
  }
  
  // Step 2: Delete WebACL (and IPSet)
  logStep(2, 'Delete WebACL and IPSet manually');
  
  // Get IPSet info before confirmation
  const ipSet = await getEmergencyIpSet();
  
  if (!DRY_RUN) {
    // Explicit confirmation - user must type the stage name
    const confirmed = await confirmStage(STAGE, {
      webAcl: { name: webAclBefore.Name, arn: webAclBefore.ARN },
      ipSet: ipSet ? { name: ipSet.Name } : null,
      distribution: distBefore ? { id: distBefore.id } : null,
    });
    
    if (!confirmed) {
      log('\n❌ Test aborted by user.', colors.red);
      process.exit(0);
    }
  }
  
  await deleteWebAcl(webAclBefore);
  
  if (ipSet) {
    await deleteIpSet(ipSet);
  }
  
  // Step 3: Verify deletion
  logStep(3, 'Verify WebACL is GONE');
  
  const webAclAfterDelete = await getWebAcl();
  if (webAclAfterDelete && !DRY_RUN) {
    logError('WebACL still exists after deletion! Test failed.');
    process.exit(1);
  }
  
  if (DRY_RUN) {
    logInfo('[DRY RUN] Would verify WebACL is deleted');
  } else {
    logSuccess('WebACL successfully deleted');
  }
  
  // Step 4: Run SST deploy to recreate
  logStep(4, 'Run SST deploy to auto-recreate WebACL');
  
  runSstDeploy();
  
  // Step 5: Verify WebACL is recreated
  logStep(5, 'Verify WebACL is RECREATED');
  
  if (DRY_RUN) {
    logInfo('[DRY RUN] Would verify WebACL is recreated');
    return;
  }
  
  // Wait for propagation
  logInfo('Waiting 5 seconds for resource propagation...');
  await new Promise(resolve => setTimeout(resolve, 5000));
  
  const webAclAfterDeploy = await getWebAcl();
  
  if (!webAclAfterDeploy) {
    logError('WebACL NOT recreated! SST auto-recreation failed.');
    process.exit(1);
  }
  
  logSuccess(`WebACL recreated: ${webAclAfterDeploy.Name}`);
  logInfo(`New ARN: ${webAclAfterDeploy.ARN}`);
  
  // Step 6: Verify CloudFront association is restored
  logStep(6, 'Verify CloudFront → WebACL association is RESTORED');
  
  const distAfter = await checkCloudFrontAssociation();
  
  if (!distAfter) {
    logError('CloudFront distribution not found');
    process.exit(1);
  }
  
  if (!distAfter.webAclId) {
    logError('CloudFront has NO WebACL attached! Auto-association failed.');
    process.exit(1);
  }
  
  if (distAfter.webAclId !== webAclAfterDeploy.ARN) {
    logError('CloudFront WebACL ARN does NOT match recreated WebACL!');
    logInfo(`Expected: ${webAclAfterDeploy.ARN}`);
    logInfo(`Actual:   ${distAfter.webAclId}`);
    process.exit(1);
  }
  
  logSuccess('CloudFront → WebACL association RESTORED!');
  logSuccess('Auto-recreation test PASSED! ✨');
}

// TEST 2: Full infrastructure lifecycle (remove + deploy)
async function testFullLifecycle() {
  log('\n🧪 TEST: Full Infrastructure Lifecycle', colors.bright + colors.magenta);
  log('This tests `sst remove` → `sst deploy` to verify complete recreation.', colors.blue);
  
  // Step 1: Verify current infrastructure exists
  logStep(1, 'Verify infrastructure EXISTS before removal');
  
  const webAclBefore = await getWebAcl();
  const distBefore = await checkCloudFrontAssociation();
  
  if (!webAclBefore) {
    logWarning('WebACL does not exist. Will create on deploy.');
  } else {
    logSuccess(`Found WebACL: ${webAclBefore.Name}`);
  }
  
  if (!distBefore) {
    logWarning('CloudFront distribution not found');
  } else {
    logSuccess(`Found distribution: ${distBefore.id}`);
    if (distBefore.webAclId) {
      logSuccess('WebACL is attached');
    }
  }
  
  // Step 2: Remove all infrastructure
  logStep(2, 'Remove ALL infrastructure for stage');
  
  if (!DRY_RUN) {
    // Explicit confirmation - user must type the stage name
    const confirmed = await confirmStage(STAGE, {
      webAcl: webAclBefore ? { name: webAclBefore.Name, arn: webAclBefore.ARN } : null,
      ipSet: null, // Will be removed as part of SST remove
      distribution: distBefore ? { id: distBefore.id } : null,
    });
    
    if (!confirmed) {
      log('\n❌ Test aborted by user.', colors.red);
      process.exit(0);
    }
    
    log('', colors.reset);
    logWarning('⚠️  ALL INFRASTRUCTURE WILL BE REMOVED!');
    logWarning('Press Ctrl+C within 5 seconds for final chance to cancel...');
    await new Promise(resolve => setTimeout(resolve, 5000));
  }
  
  runSstRemove();
  
  // Step 3: Verify everything is gone
  logStep(3, 'Verify infrastructure is REMOVED');
  
  if (DRY_RUN) {
    logInfo('[DRY RUN] Would verify infrastructure is removed');
  } else {
    // Wait for AWS propagation
    logInfo('Waiting 10 seconds for AWS propagation...');
    await new Promise(resolve => setTimeout(resolve, 10000));
    
    const webAclAfterRemove = await getWebAcl();
    const distAfterRemove = await checkCloudFrontAssociation();
    
    if (webAclAfterRemove) {
      logWarning('WebACL still exists (retainOnDelete=true is working)');
    } else {
      logSuccess('WebACL removed');
    }
    
    if (distAfterRemove) {
      logWarning('CloudFront distribution still exists');
    } else {
      logSuccess('CloudFront distribution removed');
    }
  }
  
  // Step 4: Deploy fresh infrastructure
  logStep(4, 'Deploy fresh infrastructure');
  
  runSstDeploy();
  
  // Step 5: Verify everything is recreated
  logStep(5, 'Verify infrastructure is RECREATED');
  
  if (DRY_RUN) {
    logInfo('[DRY RUN] Would verify infrastructure is recreated');
    return;
  }
  
  // Wait for propagation
  logInfo('Waiting 10 seconds for resource propagation...');
  await new Promise(resolve => setTimeout(resolve, 10000));
  
  const webAclAfterDeploy = await getWebAcl();
  const distAfterDeploy = await checkCloudFrontAssociation();
  
  if (!webAclAfterDeploy) {
    logError('WebACL NOT created! Deploy failed.');
    process.exit(1);
  }
  
  logSuccess(`WebACL created: ${webAclAfterDeploy.Name}`);
  
  if (!distAfterDeploy) {
    logError('CloudFront distribution NOT created!');
    process.exit(1);
  }
  
  logSuccess(`Distribution created: ${distAfterDeploy.id}`);
  
  if (!distAfterDeploy.webAclId) {
    logError('WebACL NOT attached to CloudFront!');
    process.exit(1);
  }
  
  if (distAfterDeploy.webAclId !== webAclAfterDeploy.ARN) {
    logError('WebACL ARN mismatch!');
    logInfo(`Expected: ${webAclAfterDeploy.ARN}`);
    logInfo(`Actual:   ${distAfterDeploy.webAclId}`);
    process.exit(1);
  }
  
  logSuccess('CloudFront → WebACL association CONFIRMED!');
  logSuccess('Full lifecycle test PASSED! 🎉');
}

// Main
async function main() {
  // Hard guard: never allow destructive operations against production.
  if (STAGE === 'production') {
    logError('This script must NOT be run against the production stage.');
    logInfo('WAF resources in production are managed exclusively via SST deploy/remove.');
    process.exit(1);
  }

  log('\n🚀 WAF Auto-Reconciliation & Auto-Recreation Test', colors.bright + colors.cyan);
  log(`Stage: ${STAGE}`, colors.blue);
  log(`Test: ${TEST_TYPE}`, colors.blue);
  log(`Dry run: ${DRY_RUN ? 'YES' : 'NO'}`, DRY_RUN ? colors.yellow : colors.green);
  
  if (DRY_RUN) {
    logWarning('DRY RUN MODE: No changes will be made');
  }
  
  try {
    if (TEST_TYPE === 'delete-webacl') {
      await testDeleteWebAcl();
    } else if (TEST_TYPE === 'full-lifecycle') {
      await testFullLifecycle();
    } else {
      logError(`Unknown test type: ${TEST_TYPE}`);
      logInfo('Valid test types: delete-webacl, full-lifecycle');
      process.exit(1);
    }
    
    log('\n' + '='.repeat(80), colors.bright);
    log('🎉 TEST PASSED: WAF auto-reconciliation is working! 🎉', colors.bright + colors.green);
    log('='.repeat(80), colors.bright);
    
    process.exit(0);
  } catch (error) {
    logError(`Test failed: ${error.message}`);
    console.error(error);
    process.exit(1);
  }
}

main();
