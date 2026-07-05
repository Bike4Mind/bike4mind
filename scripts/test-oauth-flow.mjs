#!/usr/bin/env node

/**
 * OAuth Device Flow Test Script
 *
 * This script simulates the CLI behavior and tests the complete OAuth device flow.
 *
 * Usage:
 *   node scripts/test-oauth-flow.mjs
 *   API_BASE=https://staging.bike4mind.com node scripts/test-oauth-flow.mjs
 */

const API_BASE = process.env.API_BASE || 'http://localhost:3000';

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function testOAuthFlow() {
  console.log('🔐 Testing OAuth Device Flow');
  console.log(`📍 API Base: ${API_BASE}\n`);

  // Step 1: Initiate device flow
  console.log('Step 1: Initiating device flow...');
  const initiateRes = await fetch(`${API_BASE}/api/oauth/device/initiate`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ client_id: 'b4m-cli' }),
  });

  if (!initiateRes.ok) {
    console.error('❌ Failed to initiate device flow');
    const error = await initiateRes.text();
    console.error(error);
    process.exit(1);
  }

  const { device_code, user_code, verification_uri_complete, interval, expires_in } = await initiateRes.json();

  console.log(`✓ Device code generated`);
  console.log(`✓ User code: ${user_code}`);
  console.log(`✓ Expires in: ${expires_in} seconds\n`);
  console.log(`👉 Visit: ${verification_uri_complete}\n`);
  console.log('━'.repeat(60));
  console.log('Approve the device in your browser, then press Enter to continue...');
  console.log('━'.repeat(60));

  // Wait for user to press Enter
  await new Promise(resolve => {
    process.stdin.once('data', () => {
      process.stdin.pause();
      resolve();
    });
  });

  // Step 2: Poll for approval
  console.log('\nStep 2: Polling for approval...');
  let attempts = 0;
  const maxAttempts = Math.floor(expires_in / interval); // Don't exceed expiry time

  while (attempts < maxAttempts) {
    await sleep(interval * 1000);
    attempts++;

    process.stdout.write(`  Attempt ${attempts}/${maxAttempts}... `);

    const tokenRes = await fetch(`${API_BASE}/api/oauth/device/token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        grant_type: 'urn:ietf:params:oauth:grant-type:device_code',
        device_code,
        client_id: 'b4m-cli',
      }),
    });

    if (tokenRes.ok) {
      const tokens = await tokenRes.json();
      console.log('✓\n');
      console.log('━'.repeat(60));
      console.log('✅ Success! Tokens received:');
      console.log('━'.repeat(60));
      console.log(`Access Token:  ${tokens.access_token.substring(0, 40)}...`);
      console.log(`Refresh Token: ${tokens.refresh_token.substring(0, 40)}...`);
      console.log(`Type:          ${tokens.token_type}`);
      console.log(`Expires in:    ${tokens.expires_in} seconds (${Math.floor(tokens.expires_in / 86400)} days)`);
      console.log('━'.repeat(60));

      // Step 3: Test token by calling /api/identify
      console.log('\nStep 3: Testing access token...');
      const identifyRes = await fetch(`${API_BASE}/api/identify`, {
        headers: {
          Authorization: `Bearer ${tokens.access_token}`,
        },
      });

      if (identifyRes.ok) {
        const userData = await identifyRes.json();
        console.log(`✓ Token works! Authenticated as: ${userData.user?.username || userData.user?.email || 'Unknown'}`);
      } else {
        console.log(`⚠️  Token validation failed (${identifyRes.status})`);
      }

      console.log('\n🎉 OAuth Device Flow test completed successfully!\n');
      return;
    }

    const error = await tokenRes.json();

    if (error.error === 'authorization_pending') {
      console.log('pending');
      continue;
    } else if (error.error === 'slow_down') {
      console.log('slow_down (increasing interval)');
      // The interval should be increased
      interval += 1;
      continue;
    } else if (error.error === 'access_denied') {
      console.log('❌\n');
      console.log('❌ Authorization denied by user');
      return;
    } else if (error.error === 'expired_token') {
      console.log('❌\n');
      console.log('❌ Device code expired');
      return;
    } else {
      console.log('❌\n');
      console.error(`❌ Unexpected error: ${error.error_description || error.error}`);
      return;
    }
  }

  console.log('\n❌ Timed out waiting for approval');
}

// Run the test
testOAuthFlow().catch(error => {
  console.error('\n❌ Test failed with error:');
  console.error(error);
  process.exit(1);
});
