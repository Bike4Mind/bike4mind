---
sidebar_position: 0
title: "Database Documentation"
content_type: ["conceptual"]
feature_status: stable
audience: ["administrators", "developers"]
spiciness: mild
visibility: public
maturity: approved
related_features: ["databases", "infrastructure"]
tags: ["databases", "aws", "database", "deployment", "ai"]
last_reviewed: 2025-06-30
---

# Database Documentation

Bike4Mind supports multiple database backends to accommodate different deployment scenarios and enterprise requirements.

## Supported Databases

### MongoDB Atlas (Default)
- **Use Case**: Cloud-native deployments, SaaS environments
- **Features**: Fully managed, automatic backups, global clusters
- **Best For**: Most standard deployments

### AWS DocumentDB
- **Use Case**: Enterprise deployments requiring AWS-native solutions
- **Features**: MongoDB-compatible, VPC isolation, AWS integration
- **Best For**: Enterprises with AWS-centric infrastructure
- **Documentation**: [DocumentDB Setup Guide](./documentdb-setup)

## Quick Links

- 📚 [DocumentDB Setup Guide](./documentdb-setup) - How to configure Bike4Mind for DocumentDB

## Choosing a Database

| Feature | MongoDB Atlas | AWS DocumentDB |
|---------|--------------|----------------|
| Hosting | Multi-cloud | AWS only |
| Management | Fully managed | AWS managed |
| Compatibility | Native MongoDB | MongoDB 4.0 compatible |
| Pricing | Usage-based | Instance-based |
| Network | Internet/Peering | VPC only |
| Backup | Continuous | Snapshot-based |
| Best For | SaaS, Multi-cloud | Enterprise AWS |

## Environment Variables

All database connections use the `MONGODB_URI` environment variable:

```bash
# MongoDB Atlas
MONGODB_URI="mongodb+srv://username:password@cluster.mongodb.net/dbname"

# AWS DocumentDB  
MONGODB_URI="mongodb://username:password@cluster.docdb.amazonaws.com:27017/dbname"
```

## Feature Flag Support

The system supports automatic detection of DocumentDB connections or explicit configuration via:

```bash
MAIN_DB_TYPE=DocumentDB  # or MongoAtlas
```

See the [Feature Flags documentation](/features/feature-flags) for more details. 