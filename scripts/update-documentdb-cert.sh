#!/bin/bash
# Script to download and prepare AWS DocumentDB certificate for embedding

echo "🔧 DocumentDB Certificate Update Script"
echo "======================================"
echo ""

# Download the certificate
echo "📥 Downloading AWS DocumentDB global certificate bundle..."
curl -sS "https://truststore.pki.rds.amazonaws.com/global/global-bundle.pem" -o global-bundle.pem

if [ ! -f global-bundle.pem ]; then
    echo "❌ Failed to download certificate!"
    exit 1
fi

echo "✅ Certificate downloaded successfully"

# Convert to base64
echo "🔄 Converting to base64..."
if [[ "$OSTYPE" == "darwin"* ]]; then
    # macOS
    base64 -i global-bundle.pem -o global-bundle-base64.txt
else
    # Linux
    base64 -w 0 global-bundle.pem > global-bundle-base64.txt
fi

echo "✅ Certificate converted to base64"
echo ""

echo "📋 To use this certificate:"
echo "1. Copy the content of global-bundle-base64.txt"
echo "2. Replace the DOCUMENTDB_CA_BUNDLE_BASE64 constant in:"
echo "   packages/database/src/certs/documentdb-cert-manager.ts"
echo ""
echo "Alternatively, set as environment variable:"
echo "   export DOCUMENTDB_CA_BUNDLE_BASE64=\$(cat global-bundle-base64.txt)"
echo ""
echo "🔑 Required Connection String Parameters:"
echo "   authMechanism=SCRAM-SHA-1"
echo "   authSource=admin"
echo "   retryWrites=false"
echo "   tls=true"
echo ""
echo "📝 Example connection string:"
echo "   mongodb://user:pass@cluster.docdb.amazonaws.com:27017/db?authSource=admin&authMechanism=SCRAM-SHA-1&tls=true&retryWrites=false"
echo ""
echo "Note: The certificate manager will automatically add these parameters if missing." 