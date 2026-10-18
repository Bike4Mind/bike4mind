// A server that fails the way real ones do: it writes an explanation to stderr and exits
// before the handshake, which is what a missing API key or an unsupported runtime looks like.
process.stderr.write('FATAL: MCP_FIXTURE_TOKEN is not set\n');
process.exit(1);
