// Empty module for browser polyfills
// Used to stub out Node.js modules like 'fs' and 'path'
// Required by HiGHS WASM loader which contains require('fs') for Node.js paths
export default {};
export const readFileSync = () => {
  throw new Error('fs not available in browser');
};
export const existsSync = () => false;
