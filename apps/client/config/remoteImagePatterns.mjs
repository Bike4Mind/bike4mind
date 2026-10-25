/** @param {Record<string, string | undefined>} environment */
export function buildRemoteImagePatterns(environment) {
  const patterns = [{ protocol: /** @type {const} */ ('https'), hostname: 'avatars.githubusercontent.com' }];
  const region = environment.AWS_REGION || 'us-east-2';
  for (const key of ['GENERATED_IMAGES_BUCKET_NAME', 'FAB_FILES_BUCKET_NAME', 'APP_FILES_BUCKET_NAME']) {
    const bucket = environment[key];
    if (!bucket) continue;
    if (!/^[a-z0-9][a-z0-9.-]*[a-z0-9]$/.test(bucket) || !/^[a-z0-9-]+$/.test(region)) {
      throw new Error(`Invalid image bucket configuration: ${key}`);
    }
    patterns.push({
      protocol: 'https',
      hostname: bucket.endsWith('.amazonaws.com') ? bucket : `${bucket}.s3.${region}.amazonaws.com`,
    });
  }
  const cdn = environment.NEXT_PUBLIC_CDN_URL;
  if (cdn && !cdn.startsWith('/')) {
    const url = new URL(cdn);
    if (url.protocol !== 'https:' || /[*\s;]/.test(url.hostname) || url.username || url.password || url.port) {
      throw new Error('NEXT_PUBLIC_CDN_URL must be an HTTPS origin without credentials or a port');
    }
    patterns.push({ protocol: 'https', hostname: url.hostname });
  }
  return patterns;
}
