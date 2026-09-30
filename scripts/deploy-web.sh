#!/usr/bin/env bash
# Build the PWA against the deployed API and upload it to the private web bucket.
# Needs AWS credentials that can write the web bucket and create CloudFront invalidations.
# Usage: scripts/deploy-web.sh   (run from the repo root, after `terraform apply` with web_hosting_enabled)
set -euo pipefail
cd "$(dirname "$0")/.."
TF="terraform -chdir=infra/terraform"

API=$($TF output -raw api_endpoint)
BLOB=$($TF output -raw web_blob_origin)
BUCKET=$($TF output -json web_hosting | node -pe 'JSON.parse(require("fs").readFileSync(0,"utf8")).bucket')
DIST=$($TF output -json web_hosting | node -pe 'JSON.parse(require("fs").readFileSync(0,"utf8")).app_distribution_id')

VITE_LOJO_API_URL="$API" VITE_LOJO_BLOB_ORIGIN="$BLOB" npm run build:web

D=packages/web/dist
# Hashed assets are immutable; the shell files must revalidate so a deploy shows up at once.
aws s3 sync "$D/assets" "s3://$BUCKET/app/assets" --delete --cache-control "public,max-age=31536000,immutable"
for f in index.html sw.js manifest.webmanifest icon.svg; do
  case "$f" in
    index.html) type="text/html; charset=utf-8" ;;
    sw.js) type="text/javascript; charset=utf-8" ;;
    manifest.webmanifest) type="application/manifest+json" ;;
    icon.svg) type="image/svg+xml" ;;
  esac
  aws s3 cp "$D/$f" "s3://$BUCKET/app/$f" --content-type "$type" --cache-control "no-cache"
done
# _headers is a Netlify/Cloudflare file; CloudFront takes the same values from Terraform, so it is not uploaded.
aws cloudfront create-invalidation --distribution-id "$DIST" --paths "/index.html" "/sw.js" "/manifest.webmanifest" "/" >/dev/null
echo "deployed to https://app.$($TF output -raw mailbox | cut -d@ -f2)"
