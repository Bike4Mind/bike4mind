// Stored as {"value": ...} so the app's `Resource.<Name>.value` reads it exactly as a linked secret.
export function ecsResourceSecrets(
  service: string,
  moved: Record<string, sst.Secret>,
  options: { advanced?: string[] } = {}
): Record<string, $util.Output<string>> {
  return Object.fromEntries(
    Object.entries(moved).map(([name, secret]) => {
      const parameter = new aws.ssm.Parameter(`${service}${name}EcsSecret`, {
        name: `/sst/${$app.name}/${$app.stage}/ecs-secrets/${service}/${name}`,
        type: 'SecureString',
        tier: options.advanced?.includes(name) ? 'Advanced' : 'Standard',
        value: $jsonStringify({ value: secret.value }),
      });
      return [`SST_RESOURCE_${name}`, parameter.arn];
    })
  );
}

// Plain env var for a consumer that reads process.env directly, so the value is stored raw.
export function ecsEnvSecret(
  service: string,
  envName: string,
  secret: sst.Secret
): Record<string, $util.Output<string>> {
  const parameter = new aws.ssm.Parameter(`${service}${envName}EcsSecret`, {
    name: `/sst/${$app.name}/${$app.stage}/ecs-secrets/${service}/${envName}`,
    type: 'SecureString',
    value: secret.value,
  });
  return { [envName]: parameter.arn };
}
