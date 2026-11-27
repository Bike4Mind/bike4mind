/** Browser origins allowed by bucket CORS. Localhost is for local dev and previews, never production. */
export function getAllowedOrigins(domain: string | undefined, stage: string): string[] {
  const origins = stage === 'production' ? [] : ['http://localhost:3000', 'https://localhost:3000'];

  if (domain) {
    origins.push(`https://app.${domain}`);
    origins.push(`https://staging.${domain}`);
  }

  return origins;
}
