/**
 * CSP Testing Script
 * This script can be added temporarily to your application to help detect CSP issues.
 * Add it to a page, run the app, and check the console for any CSP violations.
 */

console.log('CSP testing script loaded');

// Listen for CSP violations
document.addEventListener('securitypolicyviolation', e => {
  console.error('CSP Violation Detected:', {
    'Blocked URI': e.blockedURI,
    'Violated Directive': e.violatedDirective,
    'Original Policy': e.originalPolicy,
    'Source File': e.sourceFile,
    'Line Number': e.lineNumber,
    'Column Number': e.columnNumber,
    Sample: e.sample,
  });
});

// Test basic functionality to ensure CSP doesn't break critical features
function testBasicFunctionality() {
  // Add any specific tests you want to run
  console.log('Running basic functionality tests');
  // Example: Test that fetch works
  fetch('/api/health')
    .then(() => console.log('Fetch API works correctly'))
    .catch(err => console.error('Fetch API failed:', err));
  // Example: Test that DOM manipulation works
  try {
    const testElement = document.createElement('div');
    testElement.textContent = 'CSP Test Element';
    testElement.style.display = 'none';
    document.body.appendChild(testElement);
    console.log('DOM manipulation works correctly');
    // Clean up
    setTimeout(() => {
      document.body.removeChild(testElement);
    }, 1000);
  } catch (err) {
    console.error('DOM manipulation failed:', err);
  }
}

// Run tests when the page loads
window.addEventListener('load', testBasicFunctionality);

/**
 * Usage:
 * 1. Add this script to your page temporarily:
 *    <script src="/test-csp.js"></script>
 * 2. Check the browser console for any CSP violations
 * 3. Update middleware.ts to fix any legitimate violations
 * 4. Remove this script once testing is complete
 */
