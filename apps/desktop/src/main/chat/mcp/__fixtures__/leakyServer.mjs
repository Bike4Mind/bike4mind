// A server that prints the key it was started with and dies, which real servers do in debug
// output. The app must not pass that line on with the value in it.
process.stderr.write(`starting with token ${process.env.MCP_FIXTURE_TOKEN ?? '(unset)'}\n`);
process.exit(1);
