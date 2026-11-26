// SST's lazy Router keeps its routing table in a CloudFront KeyValueStore it owns. Every route
// (routeBucket, route, a site, a function URL) writes that table through two SST dynamic
// resources, KvKeys and KvRoutesUpdate. Their provider Delete calls the KeyValueStore data
// API (list, describe, read, write) key by key, and each call is billed. SST names them with
// these suffixes on the generic Pulumi dynamic resource type; the platform-source test in
// infra/__tests__/routerKvData.test.ts fails if an SST upgrade changes either.
export const DYNAMIC_RESOURCE_TYPE = 'pulumi-nodejs:dynamic:Resource';
export const ROUTER_KV_DATA_NAME_SUFFIXES = ['.sst.aws.KvKeys', '.sst.aws.KvRoutesUpdate'] as const;

export function isRouterKvDataResource(type: string, name: string): boolean {
  return type === DYNAMIC_RESOURCE_TYPE && ROUTER_KV_DATA_NAME_SUFFIXES.some(suffix => name.endsWith(suffix));
}

type TransformationArgs = {
  type: string;
  name: string;
  props: Record<string, unknown>;
  opts: { deletedWith?: unknown };
};

/**
 * Stack transformation body: marks a router KV data resource `deletedWith` the router that
 * owns the store, so tearing the whole stage down skips the per-key deletes (the store and
 * every key in it go with the router). Deleting a single route while the router stays still
 * runs the provider Delete, so a removed route never lingers in the routing table.
 * Returns undefined (leave unchanged) for every other resource and for one that already
 * names its own `deletedWith`.
 */
export function deleteRouterKvDataWithRouter<TArgs extends TransformationArgs>(
  args: TArgs,
  router: NonNullable<TArgs['opts']['deletedWith']>
): { props: TArgs['props']; opts: TArgs['opts'] } | undefined {
  if (!isRouterKvDataResource(args.type, args.name)) return undefined;
  if (args.opts.deletedWith !== undefined) return undefined;
  return { props: args.props, opts: { ...args.opts, deletedWith: router } };
}
