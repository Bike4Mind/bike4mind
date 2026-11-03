export interface EcsSecrets {
  ssm: Record<string, $util.Output<string>>;
  versions: $util.Output<number>[];
}

// Parameter ARNs never change, so a value update alone leaves the task definition untouched; this
// fingerprint (versions only, no values) goes in plain environment to force a new revision.
export function ecsSecretsVersion(...groups: EcsSecrets[]): $util.Output<string> {
  return groups
    .flatMap(g => g.versions)
    .reduce<$util.Output<string>>((acc, v) => $interpolate`${acc}.${v}`, $output('v'));
}

// Stored as {"value": ...} so the app's `Resource.<Name>.value` reads it exactly as a linked secret.
export function ecsResourceSecrets(
  service: string,
  moved: Record<string, sst.Secret>,
  options: { advanced?: string[] } = {}
): EcsSecrets {
  const versions: $util.Output<number>[] = [];
  const ssm = Object.fromEntries(
    Object.entries(moved).map(([name, secret]) => {
      const parameter = new aws.ssm.Parameter(`${service}${name}EcsSecret`, {
        name: `/sst/${$app.name}/${$app.stage}/ecs-secrets/${service}/${name}`,
        type: 'SecureString',
        tier: options.advanced?.includes(name) ? 'Advanced' : 'Standard',
        value: $jsonStringify({ value: secret.value }),
      });
      versions.push(parameter.version);
      return [`SST_RESOURCE_${name}`, parameter.arn];
    })
  );
  return { ssm, versions };
}

// Plain env var for a consumer that reads process.env directly, so the value is stored raw.
export function ecsEnvSecret(service: string, envName: string, secret: sst.Secret): EcsSecrets {
  const parameter = new aws.ssm.Parameter(`${service}${envName}EcsSecret`, {
    name: `/sst/${$app.name}/${$app.stage}/ecs-secrets/${service}/${envName}`,
    type: 'SecureString',
    value: secret.value,
  });
  return { ssm: { [envName]: parameter.arn }, versions: [parameter.version] };
}
