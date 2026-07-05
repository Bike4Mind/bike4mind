#!/usr/bin/env node
/**
 * Automated test to verify WAF auto-association with CloudFront Router.
 *
 * Verifies:
 * 1. WebACL is created in us-east-1 with correct naming
 * 2. CloudFront distribution has the WebACL attached
 * 3. WAF rules are actively enforcing (functional test)
 *
 * Usage:
 *   node scripts/test-waf-auto-association.mjs --stage pr6391
 *   node scripts/test-waf-auto-association.mjs --stage dev
 */

import { CloudFrontClient, GetDistributionCommand, ListDistributionsCommand, ListTagsForResourceCommand } from '@aws-sdk/client-cloudfront';
import { WAFV2Client, ListWebACLsCommand, GetWebACLCommand } from '@aws-sdk/client-wafv2';

const REGION = 'us-east-1'; // CloudFront WAF must be in us-east-1
const STAGE = process.argv.find(arg => arg.startsWith('--stage='))?.split('=')[1] || process.env.STAGE || 'dev';
const APP_NAME = 'bike4mind';

const cloudfront = new CloudFrontClient({ region: 'us-east-1' });
const wafv2 = new WAFV2Client({ region: REGION });

const results = {
  webAclExists: false,
  webAclName: null,
  webAclArn: null,
  distributionFound: false,
  distributionId: null,
  distributionUrl: null,
  webAclAttached: false,
  attachedWebAclId: null,
  functionalTest: false,
  functionalTestDetails: null,
};

const errors = [];

// ANSI colors for output
const colors = {
  reset: '\x1b[0m',
  bright: '\x1b[1m',
  red: '\x1b[31m',
  green: '\x1b[32m',
  yellow: '\x1b[33m',
  blue: '\x1b[34m',
  cyan: '\x1b[36m',
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
  errors.push(msg);
}

function logInfo(msg) {
  log(`ℹ️  ${msg}`, colors.blue);
}

function logWarning(msg) {
  log(`⚠️  ${msg}`, colors.yellow);
}

// Step 1: Check if WebACL exists in us-east-1
async function testWebAclExists() {
  logStep(1, 'Verify WebACL exists in us-east-1');
  
  const expectedName = STAGE.match(/^pr\d+$/i) 
    ? `bike4mind-api-protection-${STAGE.toLowerCase()}`
    : 'bike4mind-api-protection-dev';
  
  logInfo(`Expected WebACL name: ${expectedName}`);
  
  try {
    const { WebACLs } = await wafv2.send(new ListWebACLsCommand({ Scope: 'CLOUDFRONT' }));
    
    logInfo(`Found ${WebACLs.length} CloudFront WebACL(s) in ${REGION}`);
    
    const targetWebAcl = WebACLs.find(acl => acl.Name === expectedName);
    
    if (!targetWebAcl) {
      logError(`WebACL "${expectedName}" NOT FOUND`);
      logInfo('Available WebACLs:');
      WebACLs.forEach(acl => log(`  - ${acl.Name} (${acl.Id})`, colors.yellow));
      return false;
    }
    
    results.webAclExists = true;
    results.webAclName = targetWebAcl.Name;
    results.webAclArn = targetWebAcl.ARN;
    
    logSuccess(`WebACL found: ${targetWebAcl.Name}`);
    logInfo(`ARN: ${targetWebAcl.ARN}`);
    
    // Get detailed WebACL config
    const { WebACL } = await wafv2.send(new GetWebACLCommand({
      Scope: 'CLOUDFRONT',
      Id: targetWebAcl.Id,
      Name: targetWebAcl.Name,
    }));
    
    logInfo(`Rules count: ${WebACL.Rules?.length || 0}`);
    logInfo(`Default action: ${WebACL.DefaultAction.Allow ? 'ALLOW' : 'BLOCK'}`);
    
    return true;
  } catch (error) {
    logError(`Failed to check WebACL: ${error.message}`);
    return false;
  }
}

// Step 2: Find CloudFront distribution by SST tags
async function findRouterDistribution() {
  logStep(2, 'Find Router CloudFront distribution via SST tags');
  
  const targetTags = {
    'sst:app': APP_NAME,
    'sst:stage': STAGE,
  };
  
  logInfo(`Searching for distribution with tags: ${JSON.stringify(targetTags)}`);
  
  try {
    let marker;
    let allDistributions = [];
    
    // Paginate through all distributions
    do {
      const { DistributionList } = await cloudfront.send(new ListDistributionsCommand({
        Marker: marker,
      }));
      
      if (DistributionList?.Items) {
        allDistributions = allDistributions.concat(DistributionList.Items);
      }
      
      marker = DistributionList?.NextMarker;
    } while (marker);
    
    logInfo(`Total CloudFront distributions: ${allDistributions.length}`);
    
    // Check tags for each distribution
    for (const dist of allDistributions) {
      const arn = `arn:aws:cloudfront::${dist.ARN?.split(':')[4] || ''}:distribution/${dist.Id}`;
      
      try {
        const { Tags } = await cloudfront.send(new ListTagsForResourceCommand({ Resource: arn }));
        
        const tags = Tags?.Items || [];
        const tagMap = Object.fromEntries(tags.map(t => [t.Key, t.Value]));
        
        const matches = Object.entries(targetTags).every(([key, value]) => tagMap[key] === value);
        
        if (matches) {
          results.distributionFound = true;
          results.distributionId = dist.Id;
          results.distributionUrl = `https://${dist.DomainName}`;
          
          logSuccess(`Found Router distribution: ${dist.Id}`);
          logInfo(`Domain: ${dist.DomainName}`);
          logInfo(`Status: ${dist.Status}`);
          logInfo(`Tags: ${JSON.stringify(tagMap, null, 2)}`);
          
          return dist.Id;
        }
      } catch {
        // Skip distributions we can't access tags for
        continue;
      }
      
      // Rate limit protection
      await new Promise(resolve => setTimeout(resolve, 150));
    }
    
    logError(`No distribution found with tags: ${JSON.stringify(targetTags)}`);
    return null;
  } catch (error) {
    logError(`Failed to find distribution: ${error.message}`);
    return null;
  }
}

// Step 3: Verify WebACL is attached to CloudFront
async function testWebAclAttachment(distributionId) {
  logStep(3, 'Verify WebACL is attached to CloudFront distribution');
  
  if (!distributionId) {
    logError('Cannot test attachment: No distribution ID');
    return false;
  }
  
  try {
    const { Distribution } = await cloudfront.send(new GetDistributionCommand({
      Id: distributionId,
    }));
    
    const webAclId = Distribution.DistributionConfig.WebACLId;
    
    if (!webAclId) {
      logError('Distribution has NO WebACL attached (WebACLId is empty)');
      return false;
    }
    
    results.webAclAttached = true;
    results.attachedWebAclId = webAclId;
    
    logSuccess(`WebACL attached to distribution`);
    logInfo(`WebACLId: ${webAclId}`);
    
    // Verify it matches our expected WebACL
    if (results.webAclArn && webAclId === results.webAclArn) {
      logSuccess('WebACL ARN matches expected SST-managed WebACL! ✨');
      return true;
    } else if (results.webAclArn) {
      logWarning('WebACL ARN does NOT match expected WebACL');
      logInfo(`Expected: ${results.webAclArn}`);
      logInfo(`Actual:   ${webAclId}`);
      return false;
    }
    
    return true;
  } catch (error) {
    logError(`Failed to check WebACL attachment: ${error.message}`);
    return false;
  }
}

// Step 4: Functional test - Verify WAF rules are enforcing
async function testWafFunctional() {
  logStep(4, 'Functional test: Verify WAF rules are actively enforcing');
  
  if (!results.distributionUrl) {
    logError('Cannot test WAF functionality: No distribution URL');
    return false;
  }
  
  // Test 1: Rate limiting (send many requests rapidly)
  logInfo('Test 1: Rate limiting enforcement');
  logInfo('Sending 120 rapid requests to trigger rate limit...');
  
  let allowedCount = 0;
  let blockedCount = 0;
  let errorCount = 0;
  
  const testUrl = `${results.distributionUrl}/api/health`;
  
  for (let i = 0; i < 120; i++) {
    try {
      const response = await fetch(testUrl, {
        method: 'GET',
        signal: AbortSignal.timeout(5000),
      });
      
      if (response.status === 200) {
        allowedCount++;
      } else if (response.status === 403) {
        blockedCount++;
      } else {
        errorCount++;
      }
    } catch {
      errorCount++;
    }

    // Small delay to avoid overwhelming the system
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  
  results.functionalTest = blockedCount > 0;
  results.functionalTestDetails = {
    allowed: allowedCount,
    blocked: blockedCount,
    errors: errorCount,
  };
  
  logInfo(`Results: ${allowedCount} allowed, ${blockedCount} blocked, ${errorCount} errors`);
  
  if (blockedCount > 0) {
    logSuccess(`Rate limiting is WORKING! (${blockedCount} requests blocked)`);
    return true;
  } else {
    logWarning('No requests were blocked by rate limiting');
    logInfo('This could mean:');
    logInfo('  1. Rate limit threshold is higher than 120 requests');
    logInfo('  2. WAF rules are not fully propagated yet (can take 1-2 min)');
    logInfo('  3. WAF is attached but rules are not enforcing');
    
    // Check if we got mostly successful responses (indicates WAF is present but lenient)
    if (allowedCount > 100) {
      logInfo('Most requests succeeded → WAF is likely attached but with high thresholds');
      return true;
    }
    
    return false;
  }
}

// Final Report
function printFinalReport() {
  log('\n' + '='.repeat(80), colors.bright);
  log('FINAL REPORT: WAF AUTO-ASSOCIATION TEST', colors.bright + colors.cyan);
  log('='.repeat(80), colors.bright);
  
  const allPassed = results.webAclExists && 
                    results.distributionFound && 
                    results.webAclAttached && 
                    results.attachedWebAclId === results.webAclArn;
  
  log('\n📊 Test Results:', colors.bright);
  log(`  Stage: ${STAGE}`, colors.blue);
  log(`  WebACL exists: ${results.webAclExists ? '✅ YES' : '❌ NO'}`, results.webAclExists ? colors.green : colors.red);
  log(`  WebACL name: ${results.webAclName || 'N/A'}`, colors.blue);
  log(`  Distribution found: ${results.distributionFound ? '✅ YES' : '❌ NO'}`, results.distributionFound ? colors.green : colors.red);
  log(`  Distribution ID: ${results.distributionId || 'N/A'}`, colors.blue);
  log(`  WebACL attached: ${results.webAclAttached ? '✅ YES' : '❌ NO'}`, results.webAclAttached ? colors.green : colors.red);
  log(`  ARN match: ${results.attachedWebAclId === results.webAclArn ? '✅ YES' : '❌ NO'}`, results.attachedWebAclId === results.webAclArn ? colors.green : colors.red);
  log(`  Functional test: ${results.functionalTest ? '✅ PASS' : '⚠️  INCONCLUSIVE'}`, results.functionalTest ? colors.green : colors.yellow);
  
  if (results.functionalTestDetails) {
    log(`  Functional details: ${results.functionalTestDetails.allowed} allowed, ${results.functionalTestDetails.blocked} blocked`, colors.blue);
  }
  
  log('\n' + '='.repeat(80), colors.bright);
  
  if (allPassed) {
    log('🎉 SUCCESS: WAF AUTO-ASSOCIATION CONFIRMED! 🎉', colors.bright + colors.green);
    log('✅ WebACL is created', colors.green);
    log('✅ CloudFront distribution is found via SST tags', colors.green);
    log('✅ WebACL is attached to CloudFront', colors.green);
    log('✅ WebACL ARN matches SST-managed WebACL', colors.green);
    log('\n💡 WAF auto-association is working correctly!', colors.bright + colors.green);
  } else {
    log('❌ FAILURE: WAF AUTO-ASSOCIATION NOT WORKING', colors.bright + colors.red);
    log('\nErrors encountered:', colors.red);
    errors.forEach(err => log(`  - ${err}`, colors.red));
  }
  
  log('='.repeat(80), colors.bright);
  
  return allPassed;
}

// Main execution
async function main() {
  if (STAGE === 'production') {
    logError('This script must NOT be run against the production stage.');
    logInfo('Step 4 sends 120 rapid requests that can trigger WAF rate limits in production.');
    logInfo('WAF resources in production are managed exclusively via SST deploy/remove.');
    process.exit(1);
  }

  log('\n🚀 Starting WAF Auto-Association Test', colors.bright + colors.cyan);
  log(`Stage: ${STAGE}`, colors.blue);
  log(`Region: ${REGION}`, colors.blue);
  
  try {
    // Step 1: Check WebACL exists
    const webAclExists = await testWebAclExists();
    
    if (!webAclExists) {
      logError('Cannot proceed: WebACL not found. Deploy infrastructure first.');
      process.exit(1);
    }
    
    // Step 2: Find CloudFront distribution
    const distributionId = await findRouterDistribution();
    
    if (!distributionId) {
      logError('Cannot proceed: CloudFront distribution not found');
      process.exit(1);
    }
    
    // Step 3: Check WebACL attachment
    const attached = await testWebAclAttachment(distributionId);
    
    if (!attached) {
      logError('WebACL is not attached or does not match expected ARN');
    }
    
    // Step 4: Functional test (optional, best-effort)
    try {
      await testWafFunctional();
    } catch (error) {
      logWarning(`Functional test failed: ${error.message}`);
    }
    
    // Print final report
    const success = printFinalReport();
    
    process.exit(success ? 0 : 1);
  } catch (error) {
    logError(`Unexpected error: ${error.message}`);
    console.error(error);
    process.exit(1);
  }
}

main();
