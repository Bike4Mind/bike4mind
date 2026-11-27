const net = require('node:net');
const { URL } = require('node:url');
const { syncBuiltinESMExports } = require('node:module');
const allowed = new Set(JSON.parse(process.env.B4M_TEST_ORIGINS));
const connect = net.Socket.prototype.connect;
net.Socket.prototype.connect = function (...args) {
  const first = Array.isArray(args[0]) ? args[0][0] : args[0];
  const options = typeof first === 'object' ? first : { port: first, host: args[1] };
  if (!options.path) {
    const host = options.hostname || options.host || 'localhost';
    if (!allowed.has(`http://${host}:${options.port}`))
      throw new Error(`Acceptance network blocked: ${host}:${options.port}`);
  }
  return connect.apply(this, args);
};
syncBuiltinESMExports();
const realFetch = globalThis.fetch;
globalThis.fetch = (input, init) => {
  const url = new URL(typeof input === 'string' || input instanceof URL ? input : input.url);
  // The CLI has no registry endpoint flag; only this synthetic model's manifest crosses to the fixture.
  if (url.href === 'https://registry.ollama.ai/v2/library/acceptance-tiny/manifests/latest') {
    return realFetch(`${process.env.B4M_TEST_REGISTRY}/registry-manifest`, init);
  }
  if (!allowed.has(url.origin)) return Promise.reject(new Error(`Acceptance network blocked: ${url.origin}`));
  return realFetch(input, init);
};
