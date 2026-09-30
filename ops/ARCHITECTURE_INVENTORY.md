# Architecture source inventory

Generated from checked-in source by [build.py](architecture/build.py). Read the [architecture atlas](ARCHITECTURE.md) for relationships. This inventory does not evaluate stack conditions or assert that a resource is deployed.

## Browser routes

| URL | Page component | Access boundary |
|---|---|---|
| `/` | `Home` | Public shell; resource authorization applies |
| `/videos` | `Videos` | Public shell; resource authorization applies |
| `/search` | `Search` | Public shell; resource authorization applies |
| `/explore/*` | `Explore` | Public shell; resource authorization applies |
| `/editor` | `Editor` | Public shell; resource authorization applies |
| `/stats` | `Stats` | Public shell; resource authorization applies |
| `/album/:albumId` | `AlbumGallery` | Public shell; resource authorization applies |
| `/video/:albumId` | `VideoGallery` | Public shell; resource authorization applies |
| `/sharedalbum` | `SharedAlbum` | Public shell; resource authorization applies |
| `/sharedalbum/:code` | `SharedAlbum` | Public shell; resource authorization applies |
| `/contact` | `Contact` | Public shell; resource authorization applies |
| `/privacy` | `Privacy` | Public shell; resource authorization applies |
| `/login` | `Login` | Public shell; resource authorization applies |
| `/admin` | `AdminDashboard` | Admins + UI MFA gate |
| `/admin/security` | `AdminSecurity` | Admins; MFA enrollment allowed |
| `/admin/costs` | `AwsCosts` | Admins + UI MFA gate |
| `/admin/analytics` | `Analytics` | Admins + UI MFA gate |
| `/admin/drive-usage` | `GoogleDriveUsage` | Admins + UI MFA gate |
| `/admin/github-analytics` | `GitHubAnalytics` | Admins + UI MFA gate |
| `/admin/site-health` | `SiteHealth` | Admins + UI MFA gate |
| `/admin/audit-log` | `AuditLog` | Admins + UI MFA gate |
| `/admin/upload` | `Upload` | Admins + UI MFA gate |
| `/admin/upload-video` | `UploadVideo` | Admins + UI MFA gate |
| `/admin/hero` | `ManageHero` | Admins + UI MFA gate |
| `/admin/manage` | `ManageAlbums` | Admins + UI MFA gate |
| `/admin/users` | `ManageUsers` | Admins + UI MFA gate |
| `/admin/users/add` | `AddUser` | Admins + UI MFA gate |
| `/admin/users/delete` | `DeleteUser` | Admins + UI MFA gate |
| `/admin/users/edit` | `EditUser` | Admins + UI MFA gate |
| `/dashboard` | `UserDashboard` | Signed-in client |
| `*` | `NotFound` | Public shell; resource authorization applies |
| `/explore/immersive-gallery` | `Explore` subview | Public discovery |
| `/explore/colors` | `Explore` subview | Public discovery |
| `/explore/lenses` | `Explore` subview | Public discovery |
| `/explore/exposure` | `Explore` subview | Public discovery |
| `/explore/time-of-day` | `Explore` subview | Public discovery |
| `/explore/seasons` | `Explore` subview | Public discovery |
| `/explore/guess-settings` | `Explore` subview | Public discovery |
| `prints.iantruongphotography.com/print.html` | `print-main.js` | Separate origin; scoped print capability |

## HTTP API routes

Paths below are API Gateway paths; browser requests prefix them with `/api`. `JWT` is the default Gateway authorizer. `Handler policy` means the Gateway route is open and the handler still enforces the front door, validation, public/owner/admin/share policy and rate/bot checks as appropriate.

| Method and path | Lambda logical ID | Gateway authentication |
|---|---|---|
| `GET /public/albums` | `GetPublicAlbumsFunction` | Handler policy |
| `GET /public/albums/{albumId}` | `GetPublicAlbumFunction` | Handler policy |
| `GET /public/random-photos` | `GetPublicAlbumFunction` | Handler policy |
| `GET /public/explore` | `GetPublicAlbumFunction` | Handler policy |
| `ANY /public/social/{albumType}/{albumId}` | `GetPublicAlbumFunction` | Handler policy |
| `GET /albums` | `GetAlbumsFunction` | Handler policy |
| `GET /albums/{albumId}` | `GetAlbumFunction` | Handler policy |
| `GET /admin/albums/{albumId}/media` | `GetAdminAlbumMediaFunction` | JWT |
| `GET /shared/{shareCode}` | `GetSharedAlbumFunction` | Handler policy |
| `POST /login` | `LoginFunction` | Handler policy |
| `POST /login/challenge` | `CompleteChallengeFunction` | Handler policy |
| `POST /contact` | `ContactFunction` | Handler policy |
| `POST /albums` | `CreateAlbumFunction` | JWT |
| `PUT /albums/{albumId}` | `UpdateAlbumFunction` | JWT |
| `POST /admin/gallery-order` | `UpdateGalleryOrderFunction` | JWT |
| `DELETE /albums/{albumId}` | `DeleteAlbumFunction` | JWT |
| `POST /albums/{albumId}/images` | `AddImagesFunction` | JWT |
| `POST /albums/{albumId}/zip` | `CreateZipFunction` | Handler policy |
| `POST /shared/{shareCode}/zip` | `CreateZipFunction` | Handler policy |
| `POST /albums/{albumId}/delete-images` | `DeleteImagesFunction` | JWT |
| `POST /albums/{albumId}/download-url` | `GetDownloadUrlFunction` | Handler policy |
| `POST /shared/{shareCode}/download-url` | `GetDownloadUrlFunction` | Handler policy |
| `POST /albums/{albumId}/original-comparison` | `GetDownloadUrlFunction` | Handler policy |
| `POST /shared/{shareCode}/original-comparison` | `GetDownloadUrlFunction` | Handler policy |
| `POST /albums/{albumId}/print` | `PreparePrintFunction` | Handler policy |
| `POST /shared/{shareCode}/print` | `PreparePrintFunction` | Handler policy |
| `POST /print/session` | `PreparePrintFunction` | Handler policy |
| `PATCH /albums/{albumId}/images` | `UpdateImageFunction` | JWT |
| `POST /upload-url` | `GetUploadUrlFunction` | JWT |
| `POST /admin/hero/{operation}` | `HeroCoverFunction` | JWT |
| `POST /users` | `CreateUserFunction` | JWT |
| `GET /users` | `ListUsersFunction` | JWT |
| `GET /admin/costs` | `GetCostReportFunction` | JWT |
| `POST /analytics/events` | `AnalyticsIngestFunction` | Handler policy |
| `GET /admin/analytics` | `GetAnalyticsReportFunction` | JWT |
| `GET /admin/drive-usage` | `GetGoogleDriveUsageFunction` | JWT |
| `GET /public/stats` | `GetPhotographyStatsFunction` | Handler policy |
| `GET /admin/github-analytics` | `GetGitHubAnalyticsFunction` | JWT |
| `GET /admin/site-health` | `GetSiteHealthFunction` | JWT |
| `GET /admin/audit-log` | `GetAuditLogFunction` | JWT |
| `DELETE /users/{email}` | `DeleteUserFunction` | JWT |
| `PUT /users/{email}` | `EditUserFunction` | JWT |

## Every application function

HTTP functions map to the route table above. A function with no event mapping is invoked by application code; concurrency `inherited` means no per-function override is declared. Globals set default runtime/environment/logging. Failure paths remain source-specific.

| Logical ID | Handler | Background triggers | Reserved concurrency |
|---|---|---|---|
| `OriginalIndexRefreshFunction` | `original_index_refresh.handler` | Schedule: rate(15 minutes); Enabled=!If [EnableOriginalComparisons, true, false] | 1 |
| `OriginalComparisonWorkerFunction` | `original_comparison_worker.handler` | SQS: !GetAtt OriginalComparisonQueue.Arn; Enabled=!If [EnableOriginalComparisons, true, false] | 2 |
| `GetPublicAlbumsFunction` | `get_public_albums.handler` | HTTP or direct application invocation | 20 |
| `GetPublicAlbumFunction` | `get_public_album.handler` | HTTP or direct application invocation | 20 |
| `CacheInvalidationWorkerFunction` | `cache_invalidation_worker.handler` | SQS: !GetAtt CacheInvalidationQueue.Arn | 2 |
| `HoverPreviewManifestBuilderFunction` | `hover_preview_manifest_builder.handler` | DynamoDB: !GetAtt PreviewMetadataTable.StreamArn<br/>SQS: !GetAtt HoverPreviewRefreshQueue.Arn<br/>Schedule: rate(15 minutes); Enabled=true | 2 |
| `RandomPhotoPoolBuilderFunction` | `random_photo_pool_builder.handler` | DynamoDB: !GetAtt AlbumsTable.StreamArn; Enabled=false<br/>SQS: !GetAtt RandomPhotoRefreshQueue.Arn<br/>Schedule: rate(1 hour); Enabled=true | 1 |
| `GetAlbumsFunction` | `get_albums.handler` | HTTP or direct application invocation | 20 |
| `GetAlbumFunction` | `get_album.handler` | HTTP or direct application invocation | 20 |
| `GetAdminAlbumMediaFunction` | `get_album_media.handler` | HTTP or direct application invocation | 10 |
| `AlbumMediaBackfillFunction` | `backfill_album_media.handler` | Schedule: rate(15 minutes); Enabled=true | 1 |
| `GetSharedAlbumFunction` | `get_shared_album.handler` | HTTP or direct application invocation | 10 |
| `LoginFunction` | `login.handler` | HTTP or direct application invocation | 5 |
| `CompleteChallengeFunction` | `complete_challenge.handler` | HTTP or direct application invocation | 5 |
| `ContactFunction` | `contact.handler` | HTTP or direct application invocation | 3 |
| `GoogleDriveBackupFunction` | `google_drive_sync.handler` | HTTP or direct application invocation | 1 |
| `CreateAlbumFunction` | `create_album.handler` | HTTP or direct application invocation | inherited |
| `UpdateAlbumFunction` | `update_album.handler` | HTTP or direct application invocation | inherited |
| `UpdateGalleryOrderFunction` | `update_gallery_order.handler` | HTTP or direct application invocation | 2 |
| `DeleteAlbumFunction` | `delete_album.handler` | HTTP or direct application invocation | inherited |
| `AddImagesFunction` | `add_images.handler` | HTTP or direct application invocation | inherited |
| `PreviewWorkerFunction` | `index.handler` | SQS: !GetAtt PreviewQueue.Arn | 2 |
| `CreateZipFunction` | `create_zip.handler` | HTTP or direct application invocation | 5 |
| `WorkerZipFunction` | `worker_zip.handler` | HTTP or direct application invocation | 2 |
| `DeleteImagesFunction` | `delete_images.handler` | HTTP or direct application invocation | inherited |
| `TagMediaObjectFunction` | `tag_media_object.handler` | S3: — | 5 |
| `GetDownloadUrlFunction` | `get_download_url.handler` | HTTP or direct application invocation | 10 |
| `PreparePrintFunction` | `prepare_print.handler` | HTTP or direct application invocation | 10 |
| `UpdateImageFunction` | `update_image.handler` | HTTP or direct application invocation | inherited |
| `GetUploadUrlFunction` | `get_upload_url.handler` | HTTP or direct application invocation | 10 |
| `HeroCoverFunction` | `hero_cover.handler` | HTTP or direct application invocation | 2 |
| `CreateUserFunction` | `create_user.handler` | HTTP or direct application invocation | inherited |
| `ListUsersFunction` | `list_users.handler` | HTTP or direct application invocation | inherited |
| `GetCostReportFunction` | `get_cost_report.handler` | HTTP or direct application invocation | inherited |
| `AnalyticsIngestFunction` | `analytics.handler` | HTTP or direct application invocation | 10 |
| `GetAnalyticsReportFunction` | `get_analytics_report.handler` | HTTP or direct application invocation | inherited |
| `GetGoogleDriveUsageFunction` | `get_google_drive_usage.handler` | HTTP or direct application invocation | inherited |
| `GetPhotographyStatsFunction` | `photography_stats.handler` | HTTP or direct application invocation | 5 |
| `RefreshGoogleDriveUsageFunction` | `refresh_google_drive_usage.handler` | Schedule: cron(15 9 * * ? *); Enabled=true | inherited |
| `GetGitHubAnalyticsFunction` | `get_github_analytics.handler` | HTTP or direct application invocation | inherited |
| `GetSiteHealthFunction` | `get_site_health.handler` | HTTP or direct application invocation | inherited |
| `GetAuditLogFunction` | `get_audit_log.handler` | HTTP or direct application invocation | inherited |
| `RefreshGitHubAnalyticsFunction` | `refresh_github_analytics.handler` | Schedule: cron(20 * * * ? *); Enabled=true | inherited |
| `DeleteUserFunction` | `delete_user.handler` | HTTP or direct application invocation | inherited |
| `EditUserFunction` | `edit_user.handler` | HTTP or direct application invocation | inherited |

## Function-to-resource dependencies

These are explicit application-resource references in each function's template block (environment, triggers, IAM permissions and failure routing). A reference is a declared dependency or allowed access, not proof of a runtime call. Shared Globals also wire the Cognito pool/client, frontend origin, release identity, centralized logs and front-door configuration. This table makes the detailed connections inspectable without crowding the diagrams.

| Function | Declared application-resource dependencies |
|---|---|
| `OriginalIndexRefreshFunction` | `AlbumsTable`, `OriginalComparisonQueue`, `OriginalComparisonTable`, `OriginalPreviewBucket` |
| `OriginalComparisonWorkerFunction` | `AlbumsTable`, `ImagesBucket`, `OriginalComparisonQueue`, `OriginalComparisonTable`, `OriginalPreviewBucket` |
| `GetPublicAlbumsFunction` | `AlbumsTable`, `Api`, `FrontDoorOriginSecretReadPolicy`, `GallerySettingsTable`, `ImagesBucket`, `ImagesCloudFront` |
| `GetPublicAlbumFunction` | `AlbumsTable`, `Api`, `FrontDoorOriginSecretReadPolicy`, `ImagesBucket`, `ImagesCloudFront`, `OriginalComparisonTable`, `OriginalPreviewBucket`, `PreviewMetadataTable` |
| `CacheInvalidationWorkerFunction` | `CacheInvalidationQueue` |
| `HoverPreviewManifestBuilderFunction` | `AlbumMediaTable`, `AlbumsTable`, `AsyncFailureQueue`, `CacheInvalidationQueue`, `HoverPreviewRefreshQueue`, `ImagesBucket`, `ImagesCloudFront`, `PreviewMetadataTable` |
| `RandomPhotoPoolBuilderFunction` | `AlbumsTable`, `AsyncFailureQueue`, `CacheInvalidationQueue`, `ImagesBucket`, `PreviewMetadataTable`, `RandomPhotoRefreshQueue` |
| `GetAlbumsFunction` | `AlbumsTable`, `Api`, `FrontDoorOriginSecretReadPolicy`, `GallerySettingsTable`, `ImagesBucket`, `ImagesCloudFront` |
| `GetAlbumFunction` | `AlbumsTable`, `Api`, `FrontDoorOriginSecretReadPolicy`, `ImagesBucket`, `ImagesCloudFront`, `OriginalComparisonTable`, `OriginalPreviewBucket`, `PreviewMetadataTable`, `UserPool`, `UserPoolClient` |
| `GetAdminAlbumMediaFunction` | `AlbumMediaTable`, `AlbumsTable`, `Api`, `FrontDoorOriginSecretReadPolicy`, `ImagesBucket`, `ImagesCloudFront`, `OriginalComparisonTable`, `OriginalPreviewBucket`, `PreviewMetadataTable` |
| `AlbumMediaBackfillFunction` | `AlbumMediaTable`, `AlbumsTable` |
| `GetSharedAlbumFunction` | `AlbumsTable`, `Api`, `FrontDoorOriginSecretReadPolicy`, `ImagesBucket`, `ImagesCloudFront`, `OriginalComparisonTable`, `OriginalPreviewBucket`, `PreviewMetadataTable`, `RateLimitTable` |
| `LoginFunction` | `Api`, `FrontDoorOriginSecretReadPolicy`, `RateLimitTable`, `UserPool`, `UserPoolClient` |
| `CompleteChallengeFunction` | `Api`, `FrontDoorOriginSecretReadPolicy`, `RateLimitTable`, `UserPool`, `UserPoolClient` |
| `ContactFunction` | `Api`, `FrontDoorOriginSecretReadPolicy`, `RateLimitTable` |
| `GoogleDriveBackupFunction` | `AlbumsTable`, `AsyncFailureQueue`, `ImagesBucket` |
| `CreateAlbumFunction` | `AlbumMediaTable`, `AlbumsTable`, `Api`, `CacheInvalidationQueue`, `FrontDoorOriginSecretReadPolicy`, `GoogleDriveBackupFunction`, `ImagesBucket`, `ImagesCloudFront`, `MediaConvertRole`, `OriginalComparisonQueue`, `OriginalComparisonTable`, `OriginalPreviewBucket`, `PreviewMetadataTable`, `PreviewQueue`, `RandomPhotoRefreshQueue`, `UserPool` |
| `UpdateAlbumFunction` | `AlbumsTable`, `Api`, `CacheInvalidationQueue`, `FrontDoorOriginSecretReadPolicy`, `GoogleDriveBackupFunction`, `HoverPreviewRefreshQueue`, `ImagesBucket`, `ImagesCloudFront`, `PreviewMetadataTable`, `RandomPhotoRefreshQueue` |
| `UpdateGalleryOrderFunction` | `AlbumsTable`, `Api`, `CacheInvalidationQueue`, `FrontDoorOriginSecretReadPolicy`, `GallerySettingsTable` |
| `DeleteAlbumFunction` | `AlbumMediaTable`, `AlbumsTable`, `Api`, `CacheInvalidationQueue`, `FrontDoorOriginSecretReadPolicy`, `ImagesBucket`, `ImagesCloudFront`, `PreviewMetadataTable`, `RandomPhotoRefreshQueue` |
| `AddImagesFunction` | `AlbumMediaTable`, `AlbumsTable`, `Api`, `CacheInvalidationQueue`, `FrontDoorOriginSecretReadPolicy`, `GoogleDriveBackupFunction`, `ImagesBucket`, `MediaConvertRole`, `OriginalComparisonQueue`, `OriginalComparisonTable`, `OriginalPreviewBucket`, `PreviewMetadataTable`, `PreviewQueue`, `RandomPhotoRefreshQueue` |
| `PreviewWorkerFunction` | `AlbumsTable`, `ImagesBucket`, `ImagesCloudFront`, `PreviewMetadataTable`, `PreviewQueue` |
| `CreateZipFunction` | `AlbumsTable`, `Api`, `FrontDoorOriginSecretReadPolicy`, `ImagesBucket`, `RateLimitTable`, `UserPool`, `UserPoolClient`, `WorkerZipFunction` |
| `WorkerZipFunction` | `AlbumsTable`, `AsyncFailureQueue`, `ImagesBucket` |
| `DeleteImagesFunction` | `AlbumMediaTable`, `AlbumsTable`, `Api`, `CacheInvalidationQueue`, `FrontDoorOriginSecretReadPolicy`, `ImagesBucket`, `ImagesCloudFront`, `PreviewMetadataTable`, `RandomPhotoRefreshQueue` |
| `TagMediaObjectFunction` | `AlbumsTable`, `AsyncFailureQueue`, `ImagesBucket` |
| `GetDownloadUrlFunction` | `AlbumsTable`, `Api`, `FrontDoorOriginSecretReadPolicy`, `ImagesBucket`, `OriginalComparisonTable`, `OriginalPreviewBucket`, `RateLimitTable`, `UserPool`, `UserPoolClient` |
| `PreparePrintFunction` | `AlbumsTable`, `Api`, `FrontDoorOriginSecretReadPolicy`, `ImagesBucket`, `ImagesCloudFront`, `PrintSessionSecret`, `RateLimitTable`, `UserPool`, `UserPoolClient` |
| `UpdateImageFunction` | `AlbumMediaTable`, `AlbumsTable`, `Api`, `CacheInvalidationQueue`, `FrontDoorOriginSecretReadPolicy`, `ImagesBucket` |
| `GetUploadUrlFunction` | `Api`, `FrontDoorOriginSecretReadPolicy`, `ImagesBucket` |
| `HeroCoverFunction` | `Api`, `FrontDoorOriginSecretReadPolicy`, `ImagesBucket`, `ImagesCloudFront`, `PreviewQueue` |
| `CreateUserFunction` | `Api`, `FrontDoorOriginSecretReadPolicy`, `UserPool` |
| `ListUsersFunction` | `Api`, `FrontDoorOriginSecretReadPolicy`, `UserPool` |
| `GetCostReportFunction` | `Api`, `CostReportCacheTable`, `FrontDoorOriginSecretReadPolicy` |
| `AnalyticsIngestFunction` | `AlbumsTable`, `AnalyticsTable`, `Api`, `FrontDoorOriginSecretReadPolicy`, `RateLimitTable` |
| `GetAnalyticsReportFunction` | `AlbumsTable`, `AnalyticsTable`, `Api`, `FrontDoorOriginSecretReadPolicy` |
| `GetGoogleDriveUsageFunction` | `Api`, `DriveUsageCacheTable`, `FrontDoorOriginSecretReadPolicy` |
| `GetPhotographyStatsFunction` | `AlbumsTable`, `Api`, `DriveUsageCacheTable`, `FrontDoorOriginSecretReadPolicy` |
| `RefreshGoogleDriveUsageFunction` | `AlbumsTable`, `DriveUsageCacheTable` |
| `GetGitHubAnalyticsFunction` | `Api`, `FrontDoorOriginSecretReadPolicy`, `GitHubAnalyticsCacheTable` |
| `GetSiteHealthFunction` | `Api`, `FrontDoorOriginSecretReadPolicy` |
| `GetAuditLogFunction` | `Api`, `ApplicationLogGroup`, `FrontDoorOriginSecretReadPolicy` |
| `RefreshGitHubAnalyticsFunction` | `GitHubAnalyticsCacheTable` |
| `DeleteUserFunction` | `AlbumsTable`, `Api`, `FrontDoorOriginSecretReadPolicy`, `ImagesBucket`, `UserPool` |
| `EditUserFunction` | `AlbumsTable`, `Api`, `FrontDoorOriginSecretReadPolicy`, `UserPool` |

## Application data and storage

The ten DynamoDB tables are retained, deletion-protected and have PITR. Only AlbumsTable and PreviewMetadataTable are selected by the checked-in daily AWS Backup plan. Table keys below describe storage identity, not authorization grants.

| Resource | Type | Keys or object responsibility |
|---|---|---|
| `OriginalComparisonTable` | `AWS::DynamoDB::Table` | albumId + mediaId; original matching state and private index pointer |
| `OriginalPreviewBucket` | `AWS::S3::Bucket` | index/ private snapshots (7-day expiry); before/ immutable private WebP derivatives; no public CDN alias |
| `AlbumsTable` | `AWS::DynamoDB::Table` | albumId; active status, visibility, ownerSub, share state, legacy manifest; share/visibility/summary/owner GSIs |
| `GallerySettingsTable` | `AWS::DynamoDB::Table` | settingId; gallery order and section presentation |
| `AlbumMediaTable` | `AWS::DynamoDB::Table` | albumId + mediaId; AlbumOrderIndex(albumId, orderKey); normalized media |
| `PreviewMetadataTable` | `AWS::DynamoDB::Table` | albumId + mediaId; previews, Explore refs/markers, hover pointers, random pools; KEYS_ONLY stream |
| `RateLimitTable` | `AWS::DynamoDB::Table` | identifier; TTL ttl; rate limits, challenges and bounded grants |
| `CostReportCacheTable` | `AWS::DynamoDB::Table` | cacheKey; Cost Explorer report cache |
| `AnalyticsTable` | `AWS::DynamoDB::Table` | bucket + metric; TTL ttl; anonymous aggregate telemetry |
| `DriveUsageCacheTable` | `AWS::DynamoDB::Table` | cacheKey; Google Drive usage snapshots |
| `GitHubAnalyticsCacheTable` | `AWS::DynamoDB::Table` | cacheKey; repository analytics snapshots |
| `ImagesBucket` | `AWS::S3::Bucket` | albums/ source and derivatives; site/hero/; temp-zips/; fotomoto/references/; versioning + visibility tags |
| `MediaAccessLogsBucket` | `AWS::S3::Bucket` | S3/media CloudFront access logs; retained, private logging destination |

The existing private frontend S3 bucket belongs to the frontend delivery boundary managed by `ops/cloudfront_frontend.py`, outside the SAM bucket inventory. The release bootstrap and ops stacks own their separate artifact, audit, Config and recovery stores.

## Complete infrastructure inventory

Every explicit CloudFormation/SAM logical resource in the application and supporting templates is listed below, including policies, event mappings, certificates, log groups, alarms, queues, backup resources and security services. SAM-generated implicit resources are not expanded. Conditions are displayed without evaluation.

### backend/template.yaml

| Logical resource | Type | Condition |
|---|---|---|
| [`OriginalComparisonTable`](../backend/template.yaml#L203) | `AWS::DynamoDB::Table` | — |
| [`OriginalPreviewBucket`](../backend/template.yaml#L227) | `AWS::S3::Bucket` | — |
| [`OriginalPreviewBucketPolicy`](../backend/template.yaml#L262) | `AWS::S3::BucketPolicy` | — |
| [`OriginalComparisonDeadLetterQueue`](../backend/template.yaml#L280) | `AWS::SQS::Queue` | — |
| [`OriginalComparisonQueue`](../backend/template.yaml#L287) | `AWS::SQS::Queue` | — |
| [`OriginalIndexRefreshFunction`](../backend/template.yaml#L298) | `AWS::Serverless::Function` | — |
| [`OriginalComparisonWorkerFunction`](../backend/template.yaml#L354) | `AWS::Serverless::Function` | — |
| [`OriginalComparisonFailureAlarm`](../backend/template.yaml#L415) | `AWS::CloudWatch::Alarm` | — |
| [`OriginalIndexRefreshErrorsAlarm`](../backend/template.yaml#L433) | `AWS::CloudWatch::Alarm` | — |
| [`AlbumsTable`](../backend/template.yaml#L451) | `AWS::DynamoDB::Table` | — |
| [`GallerySettingsTable`](../backend/template.yaml#L551) | `AWS::DynamoDB::Table` | — |
| [`AlbumMediaTable`](../backend/template.yaml#L578) | `AWS::DynamoDB::Table` | — |
| [`PreviewMetadataTable`](../backend/template.yaml#L617) | `AWS::DynamoDB::Table` | — |
| [`RateLimitTable`](../backend/template.yaml#L649) | `AWS::DynamoDB::Table` | — |
| [`CostReportCacheTable`](../backend/template.yaml#L681) | `AWS::DynamoDB::Table` | — |
| [`AnalyticsTable`](../backend/template.yaml#L705) | `AWS::DynamoDB::Table` | — |
| [`DriveUsageCacheTable`](../backend/template.yaml#L736) | `AWS::DynamoDB::Table` | — |
| [`GitHubAnalyticsCacheTable`](../backend/template.yaml#L760) | `AWS::DynamoDB::Table` | — |
| [`FrontDoorOriginSecretReadPolicy`](../backend/template.yaml#L788) | `AWS::IAM::ManagedPolicy` | — |
| [`ApiFrontDoorCertificate`](../backend/template.yaml#L802) | `AWS::CertificateManager::Certificate` | ProvisionApiFrontDoorResources |
| [`ApiFrontDoorDomain`](../backend/template.yaml#L819) | `AWS::ApiGatewayV2::DomainName` | ProvisionApiFrontDoorResources |
| [`ApiFrontDoorMapping`](../backend/template.yaml#L834) | `AWS::ApiGatewayV2::ApiMapping` | ProvisionApiFrontDoorResources |
| [`ApiFrontDoorAlias`](../backend/template.yaml#L848) | `AWS::Route53::RecordSet` | ProvisionApiFrontDoorResources |
| [`ImagesBucket`](../backend/template.yaml#L863) | `AWS::S3::Bucket` | — |
| [`ImagesBucketPolicy`](../backend/template.yaml#L959) | `AWS::S3::BucketPolicy` | — |
| [`PrintSessionSecret`](../backend/template.yaml#L1025) | `AWS::SecretsManager::Secret` | — |
| [`PreviewMediaCachePolicy`](../backend/template.yaml#L1043) | `AWS::CloudFront::CachePolicy` | — |
| [`PreviewMediaResponseHeadersPolicy`](../backend/template.yaml#L1062) | `AWS::CloudFront::ResponseHeadersPolicy` | — |
| [`PublicPreviewCachePolicy`](../backend/template.yaml#L1110) | `AWS::CloudFront::CachePolicy` | — |
| [`PublicPreviewResponseHeadersPolicy`](../backend/template.yaml#L1129) | `AWS::CloudFront::ResponseHeadersPolicy` | — |
| [`PublicPreviewRewriteFunction`](../backend/template.yaml#L1172) | `AWS::CloudFront::Function` | — |
| [`HeroMediaCachePolicy`](../backend/template.yaml#L1200) | `AWS::CloudFront::CachePolicy` | — |
| [`HeroMediaResponseHeadersPolicy`](../backend/template.yaml#L1219) | `AWS::CloudFront::ResponseHeadersPolicy` | — |
| [`MediaResponseHeadersPolicy`](../backend/template.yaml#L1267) | `AWS::CloudFront::ResponseHeadersPolicy` | — |
| [`MediaAccessLogsBucket`](../backend/template.yaml#L1315) | `AWS::S3::Bucket` | — |
| [`MediaAccessLogsBucketPolicy`](../backend/template.yaml#L1354) | `AWS::S3::BucketPolicy` | — |
| [`ImagesOriginAccessControl`](../backend/template.yaml#L1394) | `AWS::CloudFront::OriginAccessControl` | — |
| [`ImagesCloudFront`](../backend/template.yaml#L1403) | `AWS::CloudFront::Distribution` | — |
| [`MediaConvertRole`](../backend/template.yaml#L1491) | `AWS::IAM::Role` | — |
| [`UserPool`](../backend/template.yaml#L1530) | `AWS::Cognito::UserPool` | — |
| [`UserPoolClient`](../backend/template.yaml#L1565) | `AWS::Cognito::UserPoolClient` | — |
| [`AdminsGroup`](../backend/template.yaml#L1585) | `AWS::Cognito::UserPoolGroup` | — |
| [`ApiAccessLogGroup`](../backend/template.yaml#L1593) | `AWS::Logs::LogGroup` | — |
| [`ApplicationLogGroup`](../backend/template.yaml#L1604) | `AWS::Logs::LogGroup` | — |
| [`Api`](../backend/template.yaml#L1619) | `AWS::Serverless::HttpApi` | — |
| [`AsyncFailureQueue`](../backend/template.yaml#L1671) | `AWS::SQS::Queue` | — |
| [`PreviewDeadLetterQueue`](../backend/template.yaml#L1685) | `AWS::SQS::Queue` | — |
| [`PreviewQueue`](../backend/template.yaml#L1700) | `AWS::SQS::Queue` | — |
| [`CacheInvalidationQueue`](../backend/template.yaml#L1719) | `AWS::SQS::Queue` | — |
| [`RandomPhotoRefreshQueue`](../backend/template.yaml#L1738) | `AWS::SQS::Queue` | — |
| [`HoverPreviewRefreshQueue`](../backend/template.yaml#L1757) | `AWS::SQS::Queue` | — |
| [`GetPublicAlbumsFunction`](../backend/template.yaml#L1778) | `AWS::Serverless::Function` | — |
| [`GetPublicAlbumFunction`](../backend/template.yaml#L1811) | `AWS::Serverless::Function` | — |
| [`CacheInvalidationWorkerFunction`](../backend/template.yaml#L1886) | `AWS::Serverless::Function` | — |
| [`HoverPreviewManifestBuilderFunction`](../backend/template.yaml#L1909) | `AWS::Serverless::Function` | — |
| [`RandomPhotoPoolBuilderFunction`](../backend/template.yaml#L2000) | `AWS::Serverless::Function` | — |
| [`GetAlbumsFunction`](../backend/template.yaml#L2079) | `AWS::Serverless::Function` | — |
| [`GetAlbumFunction`](../backend/template.yaml#L2122) | `AWS::Serverless::Function` | — |
| [`GetAdminAlbumMediaFunction`](../backend/template.yaml#L2173) | `AWS::Serverless::Function` | — |
| [`AlbumMediaBackfillFunction`](../backend/template.yaml#L2223) | `AWS::Serverless::Function` | — |
| [`GetSharedAlbumFunction`](../backend/template.yaml#L2261) | `AWS::Serverless::Function` | — |
| [`LoginFunction`](../backend/template.yaml#L2330) | `AWS::Serverless::Function` | — |
| [`CompleteChallengeFunction`](../backend/template.yaml#L2383) | `AWS::Serverless::Function` | — |
| [`ContactFunction`](../backend/template.yaml#L2435) | `AWS::Serverless::Function` | — |
| [`GoogleDriveBackupFunction`](../backend/template.yaml#L2491) | `AWS::Serverless::Function` | — |
| [`CreateAlbumFunction`](../backend/template.yaml#L2537) | `AWS::Serverless::Function` | — |
| [`UpdateAlbumFunction`](../backend/template.yaml#L2654) | `AWS::Serverless::Function` | — |
| [`UpdateGalleryOrderFunction`](../backend/template.yaml#L2720) | `AWS::Serverless::Function` | — |
| [`DeleteAlbumFunction`](../backend/template.yaml#L2752) | `AWS::Serverless::Function` | — |
| [`AddImagesFunction`](../backend/template.yaml#L2818) | `AWS::Serverless::Function` | — |
| [`PreviewWorkerFunction`](../backend/template.yaml#L2907) | `AWS::Serverless::Function` | — |
| [`CreateZipFunction`](../backend/template.yaml#L3013) | `AWS::Serverless::Function` | — |
| [`WorkerZipFunction`](../backend/template.yaml#L3086) | `AWS::Serverless::Function` | — |
| [`DeleteImagesFunction`](../backend/template.yaml#L3129) | `AWS::Serverless::Function` | — |
| [`TagMediaObjectFunction`](../backend/template.yaml#L3189) | `AWS::Serverless::Function` | — |
| [`GetDownloadUrlFunction`](../backend/template.yaml#L3230) | `AWS::Serverless::Function` | — |
| [`PreparePrintFunction`](../backend/template.yaml#L3313) | `AWS::Serverless::Function` | — |
| [`UpdateImageFunction`](../backend/template.yaml#L3386) | `AWS::Serverless::Function` | — |
| [`GetUploadUrlFunction`](../backend/template.yaml#L3434) | `AWS::Serverless::Function` | — |
| [`HeroCoverFunction`](../backend/template.yaml#L3461) | `AWS::Serverless::Function` | — |
| [`CreateUserFunction`](../backend/template.yaml#L3496) | `AWS::Serverless::Function` | — |
| [`ListUsersFunction`](../backend/template.yaml#L3521) | `AWS::Serverless::Function` | — |
| [`GetCostReportFunction`](../backend/template.yaml#L3544) | `AWS::Serverless::Function` | — |
| [`AnalyticsIngestFunction`](../backend/template.yaml#L3575) | `AWS::Serverless::Function` | — |
| [`GetAnalyticsReportFunction`](../backend/template.yaml#L3615) | `AWS::Serverless::Function` | — |
| [`GetGoogleDriveUsageFunction`](../backend/template.yaml#L3643) | `AWS::Serverless::Function` | — |
| [`GetPhotographyStatsFunction`](../backend/template.yaml#L3687) | `AWS::Serverless::Function` | — |
| [`RefreshGoogleDriveUsageFunction`](../backend/template.yaml#L3714) | `AWS::Serverless::Function` | — |
| [`GetGitHubAnalyticsFunction`](../backend/template.yaml#L3764) | `AWS::Serverless::Function` | — |
| [`GetSiteHealthFunction`](../backend/template.yaml#L3789) | `AWS::Serverless::Function` | — |
| [`GetAuditLogFunction`](../backend/template.yaml#L3821) | `AWS::Serverless::Function` | — |
| [`RefreshGitHubAnalyticsFunction`](../backend/template.yaml#L3851) | `AWS::Serverless::Function` | — |
| [`DeleteUserFunction`](../backend/template.yaml#L3883) | `AWS::Serverless::Function` | — |
| [`EditUserFunction`](../backend/template.yaml#L3939) | `AWS::Serverless::Function` | — |
| [`AuditDeniedMetricFilter`](../backend/template.yaml#L3977) | `AWS::Logs::MetricFilter` | — |
| [`AuditFailureMetricFilter`](../backend/template.yaml#L3988) | `AWS::Logs::MetricFilter` | — |
| [`PreviewJobFailureMetricFilter`](../backend/template.yaml#L3999) | `AWS::Logs::MetricFilter` | — |
| [`PreviewJobCompletedMetricFilter`](../backend/template.yaml#L4010) | `AWS::Logs::MetricFilter` | — |
| [`HoverPreviewManifestFailureMetricFilter`](../backend/template.yaml#L4021) | `AWS::Logs::MetricFilter` | — |
| [`LoginDeniedMetricFilter`](../backend/template.yaml#L4032) | `AWS::Logs::MetricFilter` | — |
| [`ApiAuthorizationDeniedMetricFilter`](../backend/template.yaml#L4043) | `AWS::Logs::MetricFilter` | — |
| [`FrontDoorDeniedMetricFilter`](../backend/template.yaml#L4054) | `AWS::Logs::MetricFilter` | — |
| [`ApiServerErrorAlarm`](../backend/template.yaml#L4065) | `AWS::CloudWatch::Alarm` | — |
| [`ApiLatencyAlarm`](../backend/template.yaml#L4086) | `AWS::CloudWatch::Alarm` | — |
| [`FrontDoorDeniedAlarm`](../backend/template.yaml#L4107) | `AWS::CloudWatch::Alarm` | — |
| [`AsyncFailureQueueAlarm`](../backend/template.yaml#L4123) | `AWS::CloudWatch::Alarm` | — |
| [`PreviewDeadLetterQueueAlarm`](../backend/template.yaml#L4142) | `AWS::CloudWatch::Alarm` | — |
| [`HoverPreviewRefreshQueueAgeAlarm`](../backend/template.yaml#L4161) | `AWS::CloudWatch::Alarm` | — |
| [`HoverPreviewManifestBuilderErrorsAlarm`](../backend/template.yaml#L4180) | `AWS::CloudWatch::Alarm` | — |
| [`HoverPreviewManifestFailureAlarm`](../backend/template.yaml#L4199) | `AWS::CloudWatch::Alarm` | — |
| [`PreviewQueueAgeAlarm`](../backend/template.yaml#L4215) | `AWS::CloudWatch::Alarm` | — |
| [`PreviewQueueDepthAlarm`](../backend/template.yaml#L4234) | `AWS::CloudWatch::Alarm` | — |
| [`PreviewWorkerFailureAlarm`](../backend/template.yaml#L4251) | `AWS::CloudWatch::Alarm` | — |
| [`PreviewWorkerErrorsAlarm`](../backend/template.yaml#L4265) | `AWS::CloudWatch::Alarm` | — |
| [`PreviewWorkerDurationAlarm`](../backend/template.yaml#L4282) | `AWS::CloudWatch::Alarm` | — |
| [`PreviewWorkerThrottleAlarm`](../backend/template.yaml#L4299) | `AWS::CloudWatch::Alarm` | — |
| [`PreviewMetadataSystemErrorsAlarm`](../backend/template.yaml#L4316) | `AWS::CloudWatch::Alarm` | — |
| [`PreviewMetadataThrottleAlarm`](../backend/template.yaml#L4335) | `AWS::CloudWatch::Alarm` | — |
| [`LoginThrottleAlarm`](../backend/template.yaml#L4352) | `AWS::CloudWatch::Alarm` | — |
| [`AuditFailureAlarm`](../backend/template.yaml#L4369) | `AWS::CloudWatch::Alarm` | — |
| [`LoginDeniedAlarm`](../backend/template.yaml#L4385) | `AWS::CloudWatch::Alarm` | — |
| [`ApiAuthorizationDeniedAlarm`](../backend/template.yaml#L4399) | `AWS::CloudWatch::Alarm` | — |

### ops/ci_bootstrap_template.yaml

| Logical resource | Type | Condition |
|---|---|---|
| [`GitHubOidcProvider`](../ops/ci_bootstrap_template.yaml#L78) | `AWS::IAM::OIDCProvider` | CreateGitHubOidcProvider |
| [`ReleaseArtifactKey`](../ops/ci_bootstrap_template.yaml#L93) | `AWS::KMS::Key` | — |
| [`ReleaseArtifactKeyAlias`](../ops/ci_bootstrap_template.yaml#L118) | `AWS::KMS::Alias` | — |
| [`ReleaseArtifactBucket`](../ops/ci_bootstrap_template.yaml#L126) | `AWS::S3::Bucket` | — |
| [`ReleaseArtifactBucketPolicy`](../ops/ci_bootstrap_template.yaml#L168) | `AWS::S3::BucketPolicy` | — |
| [`ReleaseStorageCleanupRole`](../ops/ci_bootstrap_template.yaml#L208) | `AWS::IAM::Role` | — |
| [`PlanRole`](../ops/ci_bootstrap_template.yaml#L263) | `AWS::IAM::Role` | — |
| [`ExecuteRole`](../ops/ci_bootstrap_template.yaml#L380) | `AWS::IAM::Role` | — |
| [`FrontendRole`](../ops/ci_bootstrap_template.yaml#L430) | `AWS::IAM::Role` | — |
| [`AuditRole`](../ops/ci_bootstrap_template.yaml#L496) | `AWS::IAM::Role` | — |
| [`CloudFormationExecutionRole`](../ops/ci_bootstrap_template.yaml#L698) | `AWS::IAM::Role` | — |
| [`CloudFormationExecutionIdentityAndComputePolicy`](../ops/ci_bootstrap_template.yaml#L723) | `AWS::IAM::ManagedPolicy` | — |
| [`CloudFormationExecutionDataAndMessagingPolicy`](../ops/ci_bootstrap_template.yaml#L850) | `AWS::IAM::ManagedPolicy` | — |
| [`CloudFormationExecutionEdgeAndIdentityPolicy`](../ops/ci_bootstrap_template.yaml#L961) | `AWS::IAM::ManagedPolicy` | — |
| [`CloudFormationExecutionEncryptionAndObservabilityPolicy`](../ops/ci_bootstrap_template.yaml#L1132) | `AWS::IAM::ManagedPolicy` | — |

### ops/dnssec-key-template.yaml

| Logical resource | Type | Condition |
|---|---|---|
| [`DnssecSigningKey`](../ops/dnssec-key-template.yaml#L16) | `AWS::KMS::Key` | — |
| [`DnssecSigningKeyAlias`](../ops/dnssec-key-template.yaml#L56) | `AWS::KMS::Alias` | — |
| [`KeySigningKey`](../ops/dnssec-key-template.yaml#L62) | `AWS::Route53::KeySigningKey` | — |
| [`HostedZoneDnssec`](../ops/dnssec-key-template.yaml#L72) | `AWS::Route53::DNSSEC` | — |

### ops/observability_template.yaml

| Logical resource | Type | Condition |
|---|---|---|
| [`ObservabilityDashboard`](../ops/observability_template.yaml#L35) | `AWS::CloudWatch::Dashboard` | — |

### ops/security_audit_foundation_template.yaml

| Logical resource | Type | Condition |
|---|---|---|
| [`SecurityAuditKey`](../ops/security_audit_foundation_template.yaml#L39) | `AWS::KMS::Key` | — |
| [`SecurityAuditKeyAlias`](../ops/security_audit_foundation_template.yaml#L77) | `AWS::KMS::Alias` | — |
| [`SecurityAuditBucket`](../ops/security_audit_foundation_template.yaml#L85) | `AWS::S3::Bucket` | — |
| [`SecurityAuditBucketPolicy`](../ops/security_audit_foundation_template.yaml#L139) | `AWS::S3::BucketPolicy` | — |
| [`SecurityAuditLogGroup`](../ops/security_audit_foundation_template.yaml#L179) | `AWS::Logs::LogGroup` | — |
| [`CloudTrailLogsRole`](../ops/security_audit_foundation_template.yaml#L194) | `AWS::IAM::Role` | — |
| [`SecurityTrail`](../ops/security_audit_foundation_template.yaml#L226) | `AWS::CloudTrail::Trail` | — |

### ops/security_backup_replica_template.yaml

| Logical resource | Type | Condition |
|---|---|---|
| [`ReplicaVaultKey`](../ops/security_backup_replica_template.yaml#L35) | `AWS::KMS::Key` | CreateReplica |
| [`ReplicaVaultKeyAlias`](../ops/security_backup_replica_template.yaml#L91) | `AWS::KMS::Alias` | CreateReplica |
| [`ReplicaBackupVault`](../ops/security_backup_replica_template.yaml#L100) | `AWS::Backup::BackupVault` | CreateReplica |

### ops/security_backup_template.yaml

| Logical resource | Type | Condition |
|---|---|---|
| [`MetadataBackupVault`](../ops/security_backup_template.yaml#L53) | `AWS::Backup::BackupVault` | CreateBackup |
| [`BackupRole`](../ops/security_backup_template.yaml#L69) | `AWS::IAM::Role` | CreateBackup |
| [`ProtectedDataBackupPlan`](../ops/security_backup_template.yaml#L94) | `AWS::Backup::BackupPlan` | CreateBackup |
| [`ProtectedDataBackupSelection`](../ops/security_backup_template.yaml#L112) | `AWS::Backup::BackupSelection` | CreateBackup |
| [`BackupJobFailureRule`](../ops/security_backup_template.yaml#L124) | `AWS::Events::Rule` | CreateBackupAlerts |
| [`BackupFreshnessLogGroup`](../ops/security_backup_template.yaml#L150) | `AWS::Logs::LogGroup` | CreateBackupAlerts |
| [`BackupFreshnessRole`](../ops/security_backup_template.yaml#L162) | `AWS::IAM::Role` | CreateBackupAlerts |
| [`BackupFreshnessFunction`](../ops/security_backup_template.yaml#L206) | `AWS::Lambda::Function` | CreateBackupAlerts |
| [`BackupFreshnessSchedule`](../ops/security_backup_template.yaml#L319) | `AWS::Events::Rule` | CreateBackupAlerts |
| [`BackupFreshnessInvokePermission`](../ops/security_backup_template.yaml#L331) | `AWS::Lambda::Permission` | CreateBackupAlerts |
| [`BackupFreshnessAlarm`](../ops/security_backup_template.yaml#L341) | `AWS::CloudWatch::Alarm` | CreateBackupAlerts |

### ops/security_budget_template.yaml

| Logical resource | Type | Condition |
|---|---|---|
| [`MonthlySecurityAndObservabilityBudget`](../ops/security_budget_template.yaml#L46) | `AWS::Budgets::Budget` | CreateBudget |

### ops/security_managed_services_template.yaml

| Logical resource | Type | Condition |
|---|---|---|
| [`AccountExternalAccessAnalyzer`](../ops/security_managed_services_template.yaml#L58) | `AWS::AccessAnalyzer::Analyzer` | CreateAccessAnalyzer |
| [`GuardDutyDetector`](../ops/security_managed_services_template.yaml#L72) | `AWS::GuardDuty::Detector` | CreateGuardDuty |
| [`SecurityHub`](../ops/security_managed_services_template.yaml#L99) | `AWS::SecurityHub::Hub` | CreateSecurityHub |
| [`ConfigDeliveryBucket`](../ops/security_managed_services_template.yaml#L114) | `AWS::S3::Bucket` | CreateConfig |
| [`ConfigDeliveryBucketPolicy`](../ops/security_managed_services_template.yaml#L160) | `AWS::S3::BucketPolicy` | CreateConfig |
| [`ConfigDeliveryOrchestratorLogGroup`](../ops/security_managed_services_template.yaml#L215) | `AWS::Logs::LogGroup` | CreateConfig |
| [`ConfigDeliveryOrchestratorRole`](../ops/security_managed_services_template.yaml#L227) | `AWS::IAM::Role` | CreateConfig |
| [`ConfigDeliveryOrchestratorFunction`](../ops/security_managed_services_template.yaml#L279) | `AWS::Lambda::Function` | CreateConfig |
| [`ConfigRecorder`](../ops/security_managed_services_template.yaml#L800) | `AWS::Config::ConfigurationRecorder` | CreateConfig |
| [`ConfigDeliveryChannel`](../ops/security_managed_services_template.yaml#L817) | `Custom::ConfigDeliveryChannel` | CreateConfig |
| [`ConfigCloudTrailEnabled`](../ops/security_managed_services_template.yaml#L843) | `AWS::Config::ConfigRule` | CreateConfig |
| [`ConfigS3PublicReadProhibited`](../ops/security_managed_services_template.yaml#L855) | `AWS::Config::ConfigRule` | CreateConfig |
| [`ConfigS3PublicWriteProhibited`](../ops/security_managed_services_template.yaml#L867) | `AWS::Config::ConfigRule` | CreateConfig |
| [`ConfigS3EncryptionEnabled`](../ops/security_managed_services_template.yaml#L879) | `AWS::Config::ConfigRule` | CreateConfig |
| [`ConfigS3SslOnly`](../ops/security_managed_services_template.yaml#L891) | `AWS::Config::ConfigRule` | CreateConfig |
| [`ConfigDynamoDbPitr`](../ops/security_managed_services_template.yaml#L903) | `AWS::Config::ConfigRule` | CreateConfig |
| [`LambdaPermissionsAuditLogGroup`](../ops/security_managed_services_template.yaml#L915) | `AWS::Logs::LogGroup` | CreateConfig |
| [`LambdaPermissionsAuditRole`](../ops/security_managed_services_template.yaml#L922) | `AWS::IAM::Role` | CreateConfig |
| [`LambdaPermissionsAuditFunction`](../ops/security_managed_services_template.yaml#L954) | `AWS::Lambda::Function` | CreateConfig |
| [`LambdaPermissionsAuditPermission`](../ops/security_managed_services_template.yaml#L1080) | `AWS::Lambda::Permission` | CreateConfig |
| [`ConfigLambdaPermissionsDaily`](../ops/security_managed_services_template.yaml#L1089) | `AWS::Config::ConfigRule` | CreateConfig |
| [`ConfigCmkBackingKeyRotationEnabled`](../ops/security_managed_services_template.yaml#L1104) | `AWS::Config::ConfigRule` | CreateConfig |
| [`ConfigRootAccessKey`](../ops/security_managed_services_template.yaml#L1117) | `AWS::Config::ConfigRule` | CreateConfig |

### ops/security_notifications_template.yaml

| Logical resource | Type | Condition |
|---|---|---|
| [`SecurityNotifications`](../ops/security_notifications_template.yaml#L23) | `AWS::SNS::Topic` | — |
| [`SecurityNotificationsPolicy`](../ops/security_notifications_template.yaml#L33) | `AWS::SNS::TopicPolicy` | — |
| [`SecuritySignalQueue`](../ops/security_notifications_template.yaml#L65) | `AWS::SQS::Queue` | — |
| [`SecuritySignalQueuePolicy`](../ops/security_notifications_template.yaml#L81) | `AWS::SQS::QueuePolicy` | — |
| [`SecurityEventDlq`](../ops/security_notifications_template.yaml#L103) | `AWS::SQS::Queue` | — |
| [`SecurityEventDlqPolicy`](../ops/security_notifications_template.yaml#L115) | `AWS::SQS::QueuePolicy` | — |
| [`SecuritySignalProcessorLogGroup`](../ops/security_notifications_template.yaml#L137) | `AWS::Logs::LogGroup` | — |
| [`SecuritySignalProcessorRole`](../ops/security_notifications_template.yaml#L148) | `AWS::IAM::Role` | — |
| [`SecuritySignalProcessor`](../ops/security_notifications_template.yaml#L192) | `AWS::Lambda::Function` | — |
| [`SecuritySignalProcessorMapping`](../ops/security_notifications_template.yaml#L283) | `AWS::Lambda::EventSourceMapping` | — |
| [`WafAlarmForwardRule`](../ops/security_notifications_template.yaml#L291) | `AWS::Events::Rule` | — |
| [`RootActivityMetric`](../ops/security_notifications_template.yaml#L326) | `AWS::Logs::MetricFilter` | — |
| [`CloudTrailChangeMetric`](../ops/security_notifications_template.yaml#L338) | `AWS::Logs::MetricFilter` | — |
| [`IamChangeMetric`](../ops/security_notifications_template.yaml#L351) | `AWS::Logs::MetricFilter` | — |
| [`KmsChangeMetric`](../ops/security_notifications_template.yaml#L364) | `AWS::Logs::MetricFilter` | — |
| [`SecurityRoutingChangeMetric`](../ops/security_notifications_template.yaml#L377) | `AWS::Logs::MetricFilter` | — |
| [`SecurityServiceChangeMetric`](../ops/security_notifications_template.yaml#L390) | `AWS::Logs::MetricFilter` | — |
| [`DetectionTopologyChangeMetric`](../ops/security_notifications_template.yaml#L403) | `AWS::Logs::MetricFilter` | — |
| [`ManagedSecurityOrganizationChangeMetric`](../ops/security_notifications_template.yaml#L416) | `AWS::Logs::MetricFilter` | — |
| [`DataProtectionChangeMetric`](../ops/security_notifications_template.yaml#L429) | `AWS::Logs::MetricFilter` | — |
| [`BackupProtectionChangeMetric`](../ops/security_notifications_template.yaml#L442) | `AWS::Logs::MetricFilter` | — |
| [`DataRetentionAndOwnershipChangeMetric`](../ops/security_notifications_template.yaml#L455) | `AWS::Logs::MetricFilter` | — |
| [`InfrastructureProtectionChangeMetric`](../ops/security_notifications_template.yaml#L468) | `AWS::Logs::MetricFilter` | — |
| [`InfrastructureExecutionChangeMetric`](../ops/security_notifications_template.yaml#L481) | `AWS::Logs::MetricFilter` | — |
| [`RootActivityAlarm`](../ops/security_notifications_template.yaml#L494) | `AWS::CloudWatch::Alarm` | — |
| [`CloudTrailChangeAlarm`](../ops/security_notifications_template.yaml#L509) | `AWS::CloudWatch::Alarm` | — |
| [`IamChangeAlarm`](../ops/security_notifications_template.yaml#L524) | `AWS::CloudWatch::Alarm` | — |
| [`KmsChangeAlarm`](../ops/security_notifications_template.yaml#L539) | `AWS::CloudWatch::Alarm` | — |
| [`SecurityRoutingChangeAlarm`](../ops/security_notifications_template.yaml#L554) | `AWS::CloudWatch::Alarm` | — |
| [`SecurityServiceChangeAlarm`](../ops/security_notifications_template.yaml#L569) | `AWS::CloudWatch::Alarm` | — |
| [`DataProtectionChangeAlarm`](../ops/security_notifications_template.yaml#L584) | `AWS::CloudWatch::Alarm` | — |
| [`InfrastructureProtectionChangeAlarm`](../ops/security_notifications_template.yaml#L599) | `AWS::CloudWatch::Alarm` | — |
| [`SecurityEventDlqAlarm`](../ops/security_notifications_template.yaml#L614) | `AWS::CloudWatch::Alarm` | — |

### ops/waf_front_door_template.yaml

| Logical resource | Type | Condition |
|---|---|---|
| [`FrontDoorWebAcl`](../ops/waf_front_door_template.yaml#L75) | `AWS::WAFv2::WebACL` | — |
| [`WafLogGroup`](../ops/waf_front_door_template.yaml#L210) | `AWS::Logs::LogGroup` | — |
| [`WafLoggingConfiguration`](../ops/waf_front_door_template.yaml#L226) | `AWS::WAFv2::LoggingConfiguration` | — |
| [`WafBlockedRequestAlarm`](../ops/waf_front_door_template.yaml#L249) | `AWS::CloudWatch::Alarm` | — |
| [`FrontendFiveXxAlarm`](../ops/waf_front_door_template.yaml#L271) | `AWS::CloudWatch::Alarm` | HasFrontendDistribution |
| [`MediaFiveXxAlarm`](../ops/waf_front_door_template.yaml#L292) | `AWS::CloudWatch::Alarm` | HasMediaDistribution |
| [`WafAlarmForwardRole`](../ops/waf_front_door_template.yaml#L313) | `AWS::IAM::Role` | HasSecurityEventBus |
| [`WafAlarmCrossRegionRule`](../ops/waf_front_door_template.yaml#L333) | `AWS::Events::Rule` | HasSecurityEventBus |

## Coverage

- 31 top-level React routes, 7 explicit Explore subroutes, and the isolated print entry.
- 42 HTTP API mappings and 45 application Lambda functions.
- 13 application tables/buckets and 228 explicit resources across 11 infrastructure templates.
- All 12 diagram views share one model; Miro shapes and Mermaid labels/connections are generated from it.
- Full alarm/runbook ownership: [ALARM_REGISTRY.md](ALARM_REGISTRY.md) and [alarm_registry.json](alarm_registry.json).
