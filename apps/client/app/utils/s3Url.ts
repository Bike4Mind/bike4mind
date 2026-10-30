export function getS3Url({ bucket, key, region = 'us-east-2' }: { bucket: string; key: string; region?: string }) {
  return `https://${bucket}.s3.${region}.amazonaws.com/${key}`;
}
