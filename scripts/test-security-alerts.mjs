#!/usr/bin/env node

/**
 * Test Script: Security Alert Email System
 *
 * This script tests the security alert email system by:
 * 1. Manually invoking the alert processor Lambda function via AWS CLI
 * 2. Displaying execution results
 * 3. Providing instructions for checking CloudWatch logs
 *
 * Prerequisites:
 * - AWS CLI installed and configured
 * - Security alerts infrastructure must be deployed to the target stage
 * - MongoDB must have some failed login attempts in AuthFailLog collection
 * - EventBridge and email system must be configured
 *
 * Usage:
 *   # Deploy infrastructure to target stage first
 *   npx sst deploy --stage pr5613  # or dev
 *
 *   # Then test the Lambda function
 *   npx sst shell --stage pr5613 -- node scripts/test-security-alerts.mjs
 *
 *   # Or invoke directly via AWS CLI (after deployment)
 *   aws lambda invoke \
 *     --function-name bike4mind-pr5613-SecurityAlertsSchedule-job \
 *     --region us-east-2 \
 *     --payload '{}' \
 *     response.json && cat response.json | jq .
 */

import { execSync } from 'child_process';
import { Resource } from 'sst';
import { readFileSync, unlinkSync } from 'fs';

const AWS_REGION = process.env.AWS_REGION || 'us-east-2';

/**
 * Get the Lambda function name for the security alerts processor
 */
function getLambdaFunctionName() {
  const appName = Resource.App.name;
  const stage = Resource.App.stage;
  return `${appName}-${stage}-SecurityAlertsSchedule-job`;
}

/**
 * Invoke the security alert processor Lambda function using AWS CLI
 */
function invokeSecurityAlertProcessor() {
  const functionName = getLambdaFunctionName();
  const responseFile = 'security-alert-test-response.json';

  console.log(`\n🔍 Testing Security Alert Email System`);
  console.log(`==========================================`);
  console.log(`Stage: ${Resource.App.stage}`);
  console.log(`Function: ${functionName}`);
  console.log(`Region: ${AWS_REGION}\n`);

  try {
    console.log('📤 Invoking Lambda function via AWS CLI...');
    
    // Invoke Lambda using AWS CLI
    execSync(
      `aws lambda invoke --function-name ${functionName} --region ${AWS_REGION} --payload '{}' ${responseFile}`,
      { stdio: 'inherit' }
    );

    // Read and parse the response
    const responseContent = readFileSync(responseFile, 'utf-8');
    const payload = JSON.parse(responseContent);
    
    // Clean up response file
    unlinkSync(responseFile);
    
    console.log('\n✅ Lambda invocation successful!');
    console.log('\n📊 Results:');
    console.log(JSON.stringify(payload, null, 2));
    
    if (payload.statusCode === 200) {
      const body = typeof payload.body === 'string' ? JSON.parse(payload.body) : payload.body;
      console.log(`\n📧 Alerts sent: ${body.alertsSent || 0}`);
      console.log(`🔍 Suspicious patterns found: ${body.suspiciousPatterns || 0}`);
      
      if (body.alertsSent > 0) {
        console.log('\n✅ SUCCESS: Email alerts were sent!');
        console.log('📬 Check your email inbox for security alerts.');
      } else {
        console.log('\n⚠️  No alerts sent. This could mean:');
        console.log('   - No suspicious patterns detected in the last 5 minutes');
        console.log('   - No users found for the suspicious patterns');
        console.log('   - Users don\'t have valid email addresses');
        console.log('\n💡 Tip: Try creating some failed login attempts first.');
        console.log('   Make 5+ failed login attempts from the same IP targeting your account.');
      }
    } else {
      console.log('\n❌ Lambda execution failed');
      console.log(`Error: ${payload.error || payload.message || 'Unknown error'}`);
    }
    
    console.log('\n📋 Next steps:');
    console.log(`   # View CloudWatch logs:`);
    console.log(`   aws logs tail /aws/lambda/${functionName} --follow --region ${AWS_REGION}`);
    
    return payload;
  } catch (error) {
    // Clean up response file if it exists
    try {
      unlinkSync(responseFile);
    } catch {
      // Ignore cleanup errors
    }
    
    console.error('\n❌ Failed to invoke Lambda function:');
    console.error(error.message);
    
    if (error.message.includes('Function not found') || error.message.includes('ResourceNotFoundException')) {
      console.error('\n💡 The Lambda function may not be deployed yet.');
      console.error(`   Run: npx sst deploy --stage ${Resource.App.stage}`);
      console.error('\n   Or check if the function exists:');
      console.error(`   aws lambda list-functions --region ${AWS_REGION} | grep SecurityAlertsSchedule`);
    } else if (error.message.includes('aws: command not found')) {
      console.error('\n💡 AWS CLI is not installed or not in PATH.');
      console.error('   Install AWS CLI: https://aws.amazon.com/cli/');
    }
    
    throw error;
  }
}

/**
 * Main execution
 */
function main() {
  try {
    invokeSecurityAlertProcessor();
    console.log('\n✨ Test completed successfully!\n');
    process.exit(0);
  } catch (error) {
    console.error('\n❌ Test failed:', error.message);
    process.exit(1);
  }
}

main();

