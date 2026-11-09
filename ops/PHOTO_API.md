# Public Photo API operations

The public endpoint is `https://photos-api.iantruongphotography.com/v1/photos/random`. Its reference page is at `/apps/photo-api`.

The `ian-photography-public-photos` stack in `us-east-1` owns the dedicated CloudFront distribution, Free flat-rate subscription, WAF, catalog bucket, publisher, DNS, and bandwidth alarm. The main application stack owns the read grant on the existing media bucket. The grant checks the production distribution ARN and the object's current `visibility=public` tag. CloudFront sends full-size reads to that bucket with origin access control and an uncached image behavior. The publisher signs each image path and the selector verifies the signature before forwarding the request.

The publisher polls the public album index every 15 minutes and confirms visibility against the primary album table. It writes new catalog objects before publishing a selector that references them. The selector draws uniformly across the requested pool. Catalog objects expire after 30 days and the publisher rotates them every 14 days. A stale selector closes both routes three hours after its last successful publication. Existing album visibility changes block full-size delivery as soon as the existing S3 tag changes. JSON fields from the last public snapshot can persist until the next refresh.

## Release

The edge stack is deployed separately from the site's attested `main` release. Use a dedicated AWS profile or verify the caller account first. On a new stack, create and publish a CloudFront Function from `photo_api_selector.js` with runtime `cloudfront-js-2.0`, then pass its ARN as `SelectorArn`. Keep `Traffic=paused` on the initial stack and verify the `FreeSubscription` output and its `FREE` tier before opening traffic. The main application's bucket policy must match the new distribution ID if the distribution is ever recreated.

Build and upload the publisher artifact from the repository root.

```sh
api_stack=ian-photography-public-photos
api_bucket=$(aws cloudformation describe-stacks --region us-east-1 \
  --stack-name "$api_stack" --query 'Stacks[0].Outputs[?OutputKey==`CatalogBucket`].OutputValue | [0]' --output text)
api_build=$(mktemp -d)
zip -j "$api_build/publisher.zip" ops/photo_api_publisher.py ops/photo_api_selector.js
api_digest=$(shasum -a 256 "$api_build/publisher.zip" | cut -d ' ' -f 1)
api_key="deployment/$api_digest.zip"
aws s3 cp "$api_build/publisher.zip" "s3://$api_bucket/$api_key" --region us-east-1

aws cloudformation deploy --region us-east-1 --stack-name "$api_stack" \
  --template-file ops/photo_api_template.yaml --capabilities CAPABILITY_IAM \
  --parameter-overrides PublisherCodeKey="$api_key" Traffic=paused
```

Invoke the publisher while traffic is paused. Check that the returned album and photo totals are plausible and the invocation has no `FunctionError`.

```sh
aws lambda invoke --region us-east-1 --cli-read-timeout 630 \
  --function-name ian-photography-public-photos-publisher "$api_build/result.json"
cat "$api_build/result.json"
```

After the main stack's bucket policy release succeeds, update the edge stack with `Traffic=live`. Check the base pick, a featured pick, both album modes, and a HEAD on a returned image URL. Check that duplicate query parameters fail and a modified image signature is rejected.

## Pause traffic

Update the edge stack with `Traffic=paused` to block all API traffic at WAF and stop scheduled refreshes. The public DNS record remains in place. Before reopening after an extended pause, invoke the publisher once and verify a fresh catalog. The Photo API has its own WAF with an approximate limit of 100 requests per IP per five minutes across both routes. The `ian-photography-public-photos-download-spike` CloudWatch alarm tracks 5 GB of viewer downloads in five minutes. Review that alarm and request metrics in `us-east-1` when diagnosing unexpected traffic.
