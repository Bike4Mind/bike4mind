/** CloudWatch log group of a WebSocket route's handler function; throws when the function has none. */
export function websocketRouteLogGroup(route: ReturnType<sst.aws.ApiGatewayWebSocket['route']>, routeLabel: string) {
  return route.nodes.function
    .apply(fn => fn.nodes.logGroup)
    .apply(logGroup => {
      if (!logGroup) throw new Error(`${routeLabel} function is missing its CloudWatch log group`);
      return logGroup;
    });
}
