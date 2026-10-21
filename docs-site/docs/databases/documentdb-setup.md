---
sidebar_position: 1
title: "DocumentDB Support for Bike4Mind"
content_type: ["how-to"]
feature_status: stable
audience: ["administrators", "developers"]
spiciness: medium
visibility: public
maturity: approved
related_features: ["databases", "infrastructure"]
tags: ["databases", "security", "performance", "aws", "database", "testing", "deployment", "ai"]
last_reviewed: 2025-06-30
---

# DocumentDB Support for Bike4Mind

This document explains how to configure Bike4Mind to use AWS DocumentDB instead of MongoDB Atlas.

## Overview

Bike4Mind now supports both MongoDB Atlas and AWS DocumentDB as database backends. This is controlled via a feature flag that can be set during deployment.

## How It Works

1. **Certificate Management**: DocumentDB requires a TLS certificate for secure connections. The certificate is embedded in the codebase as a base64-encoded string and written to `/tmp/certs/rds-ca-bundle.pem` at runtime.

2. **Automatic Detection**: The system can automatically detect DocumentDB connections based on the connection string, or you can explicitly set the database type via environment variable.

3. **Connection String Modification**: When DocumentDB is detected, the connection string is automatically modified to include the certificate path.

## Configuration

### Method 1: Environment Variable (Recommended)

Set the `MAIN_DB_TYPE` environment variable when deploying:

```bash
MAIN_DB_TYPE=DocumentDB pnpm sst deploy --stage your-stage
```

Valid values:
- `MongoAtlas` (default)
- `DocumentDB`

### Method 2: Automatic Detection

If `MAIN_DB_TYPE` is not set, the system will automatically detect DocumentDB based on the connection string containing:
- `docdb`
- `documentdb`
- `.rds.amazonaws.com`

### Method 3: Certificate via Environment Variable

For security reasons, you can also provide the certificate via environment variable instead of embedding it:

```bash
# Download and convert the certificate
./scripts/update-documentdb-cert.sh

# Set the environment variable with the certificate content
export DOCUMENTDB_CA_BUNDLE_BASE64=$(cat global-bundle-base64.txt)

# Deploy with the certificate
pnpm sst deploy --stage your-stage
```

## Setting Up DocumentDB

1. **Create DocumentDB Cluster**: Create a DocumentDB cluster in your AWS account with the desired configuration.

2. **Security Group**: Ensure the security group allows connections from your Lambda functions (typically the VPC where your Lambdas run).

3. **Connection String**: Your DocumentDB connection string should look like:
   ```
   mongodb://username:password@docdb-cluster-name.cluster-xxxxx.region.rds.amazonaws.com:27017/database?ssl=true&replicaSet=rs0&readPreference=secondaryPreferred&retryWrites=false
   ```

4. **Store in SST Secrets**: Store the connection string as an SST secret:
   ```bash
   pnpm sst secrets set MONGODB_URI "your-documentdb-connection-string" --stage your-stage
   ```

## Implementation Details

The implementation consists of:

1. **Certificate Manager** (`documentdb-cert-manager.ts`):
   - Writes the AWS certificate to `/tmp/certs/rds-ca-bundle.pem` on Lambda cold start
   - Automatically detects DocumentDB connections
   - Modifies connection strings to include the certificate path and required parameters

2. **MongoDB Connection** (`mongo.ts`):
   - Enhanced to detect and handle DocumentDB connections
   - Automatically applies certificate configuration
   - Maintains backward compatibility with MongoDB Atlas

3. **Environment Variables**:
   - `MAIN_DB_TYPE`: Controls database type (MongoAtlas or DocumentDB)
   - `DOCUMENTDB_CA_BUNDLE_BASE64`: Optional certificate override

## Important Notes

1. **Certificate Updates**: The embedded certificate is AWS's global certificate bundle. If AWS updates this certificate, you'll need to update the base64-encoded certificate in `documentdb-cert-manager.ts`.

2. **Performance**: The certificate file is written once per Lambda cold start to `/tmp`. Subsequent requests reuse the existing file.

3. **Compatibility**: DocumentDB has some MongoDB feature limitations. Ensure your application's MongoDB usage is compatible with DocumentDB.

4. **No Breaking Changes**: This implementation is feature-flagged and won't affect existing MongoDB Atlas deployments.

5. **VPC Requirements**: Unlike MongoDB Atlas, DocumentDB requires your Lambda functions to be in a VPC. Ensure your SST configuration includes VPC settings.

## Troubleshooting

### Common Errors

#### "Unsupported mechanism [ -301 ]"
This error indicates an authentication mechanism mismatch. DocumentDB only supports SCRAM-SHA-1.

**Solution**: The certificate manager now automatically adds these required parameters:
- `authMechanism=SCRAM-SHA-1`
- `authSource=admin`
- `retryWrites=false`

If you're still seeing this error, ensure your connection string doesn't already have a conflicting `authMechanism` parameter.

#### Certificate Not Found
If you see certificate path errors, the certificate manager may not have run yet.

**Solution**: The certificate is written on first connection attempt. Check Lambda logs for certificate creation messages.

#### Connection Timeouts
Ensure your Lambda functions are in the same VPC as your DocumentDB cluster and security groups allow the connection.

## Testing Your Connection

You can test your DocumentDB connection using mongosh:

```bash
mongosh "mongodb://username:password@cluster.region.docdb.amazonaws.com:27017/dbname?authSource=admin&authMechanism=SCRAM-SHA-1&tls=true&tlsCAFile=/path/to/global-bundle.pem&retryWrites=false"
```

## Testing

To test locally with DocumentDB:
1. Set up an SSH tunnel to your DocumentDB cluster
2. Set `MAIN_DB_TYPE=DocumentDB` in your `.env` file
3. Use the tunneled connection string

Example SSH tunnel:
```bash
ssh -i your-key.pem -L 27017:docdb-cluster.cluster-xxxxx.region.rds.amazonaws.com:27017 ec2-user@your-bastion-host
```

Then use `mongodb://username:password@localhost:27017/database` as your connection string.

## Future Improvements

1. **Certificate Rotation**: Implement automatic certificate rotation when AWS updates certificates.
2. **Multi-Region Support**: Add region-specific certificate bundles for optimized performance.
3. **Connection Pooling**: Optimize connection pooling settings for DocumentDB's specific characteristics. 