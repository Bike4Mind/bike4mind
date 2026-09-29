// Stands in for apps/client's generated contract list: it only re-exports the add-on's
// contracts, and premiumContractSources.generated.json beside it names that add-on.
exports.premiumContracts = [...require('./cjsZodAddon.cjs').contracts];
