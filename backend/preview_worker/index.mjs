import { createHash } from 'node:crypto'
import sharp from 'sharp'
import {
    CopyObjectCommand,
    DeleteObjectCommand,
    DeleteObjectsCommand,
    GetObjectCommand,
    GetObjectTaggingCommand,
    HeadObjectCommand,
    ListObjectsV2Command,
    PutObjectCommand,
    PutObjectTaggingCommand,
    S3Client,
} from '@aws-sdk/client-s3'
import { CloudFrontClient, CreateInvalidationCommand } from '@aws-sdk/client-cloudfront'
import { DynamoDBClient } from '@aws-sdk/client-dynamodb'
import { DynamoDBDocumentClient, GetCommand, PutCommand, UpdateCommand } from '@aws-sdk/lib-dynamodb'

import {
    PREVIEW_QUALITY,
    PREVIEW_VERSION,
    PREVIEW_WIDTHS,
    PREVIOUS_PREVIEW_VERSION,
    SUPPORTED_SOURCE_TYPES,
    isCompletePreview,
    mediaIdForKey,
    parseJob,
    parsePositiveLimit,
    previousPreviewKeysFor,
    previewJobId,
    resolveManifestImage,
} from './contract.mjs'
import {
    EXPLORE_VERSION,
    analyzePixels,
    isCompleteExploreMetadata,
    lensKey,
    normalizeLens,
} from './explore.mjs'
import { syncExploreIndex } from './explore-index.mjs'
import {
    atPreviewStage,
    classifyPreviewObjectFailure,
    previewStageFailure,
    safePreviewFailureTelemetry,
} from './telemetry.mjs'
import { isPreviousPreviewContract, validateReadyOrMarkPending } from './workflow.mjs'
import {
    HERO_CONTENT_TYPES,
    HERO_FORMATS,
    buildHeroManifest,
    heroCurrentFallbackKey,
    heroCurrentKey,
    heroDerivativeKey,
    heroOutputFormatMatches,
    heroPaths,
    heroWidthsFor,
    parseHeroJob,
} from './hero.mjs'

const s3 = new S3Client({})
const cloudfront = new CloudFrontClient({})
const documentClient = DynamoDBDocumentClient.from(new DynamoDBClient({}), {
    marshallOptions: { removeUndefinedValues: true },
})
const MAX_SOURCE_BYTES = parsePositiveLimit(process.env.MAX_PREVIEW_SOURCE_BYTES, 100 * 1024 * 1024, 250 * 1024 * 1024)
const MAX_OUTPUT_BYTES = parsePositiveLimit(process.env.MAX_PREVIEW_OUTPUT_BYTES, 20 * 1024 * 1024, 50 * 1024 * 1024)

function requiredEnvironment(name) {
    const value = process.env[name]?.trim()
    if (!value) throw new Error(`${name} is not configured`)
    return value
}

function errorCode(error) {
    return error?.name || error?.Code || error?.code || ''
}

function isPreconditionFailure(error) {
    return errorCode(error) === 'PreconditionFailed' || error?.$metadata?.httpStatusCode === 412
}

async function albumById(albumId) {
    const response = await documentClient.send(new GetCommand({
        TableName: requiredEnvironment('ALBUMS_TABLE'),
        Key: { albumId },
        ConsistentRead: true,
    }))
    if (!response.Item) throw new Error('Album not found')
    return response.Item
}

async function previewMetadata(albumId, mediaId) {
    const response = await documentClient.send(new GetCommand({
        TableName: requiredEnvironment('PREVIEW_METADATA_TABLE'),
        Key: { albumId, mediaId },
        ConsistentRead: true,
    }))
    return response.Item || null
}

async function readObjectBounded(key, maximumBytes) {
    const bucket = requiredEnvironment('IMAGES_BUCKET')
    const head = await s3.send(new HeadObjectCommand({ Bucket: bucket, Key: key }))
    const length = Number(head.ContentLength)
    if (!Number.isSafeInteger(length) || length < 1 || length > maximumBytes) {
        throw new Error('Media object size is outside the processing limit')
    }
    const getRequest = { Bucket: bucket, Key: key }
    if (head.VersionId && head.VersionId !== 'null') getRequest.VersionId = head.VersionId
    const response = await s3.send(new GetObjectCommand(getRequest))
    const bytes = Buffer.from(await response.Body.transformToByteArray())
    if (bytes.length !== length || bytes.length > maximumBytes || (head.ETag && response.ETag !== head.ETag)) {
        throw new Error('Media object changed while being read')
    }
    return { bytes, head }
}

async function generateOutputs(sourceBytes) {
    const source = sharp(sourceBytes, { failOn: 'warning', limitInputPixels: 100_000_000 }).rotate()
    const metadata = await source.metadata()
    if (!SUPPORTED_SOURCE_TYPES.has(`image/${metadata.format}`)) throw new Error('Unsupported source image type')
    if (!metadata.width || metadata.width < Math.max(...PREVIEW_WIDTHS)) {
        throw new Error('Source is too small for the no-upscale preview contract')
    }

    const outputs = {}
    for (const width of PREVIEW_WIDTHS) {
        const bytes = await sharp(sourceBytes, { failOn: 'warning', limitInputPixels: 100_000_000 })
            .rotate()
            .toColourspace('srgb')
            .resize({ width, withoutEnlargement: true })
            .webp({ quality: PREVIEW_QUALITY })
            .toBuffer()
        if (bytes.length < 1 || bytes.length > MAX_OUTPUT_BYTES) throw new Error('Generated preview size is invalid')
        const outputMetadata = await sharp(bytes, { failOn: 'error' }).metadata()
        if (outputMetadata.format !== 'webp' || outputMetadata.width !== width || !outputMetadata.height) {
            throw new Error('Generated preview failed validation')
        }
        outputs[String(width)] = { bytes, width, height: outputMetadata.height }
    }
    return outputs
}

async function extractExploreMetadata(imageBytes, image) {
    const { data, info } = await sharp(imageBytes, { failOn: 'warning', limitInputPixels: 100_000_000 })
        .rotate()
        .toColourspace('srgb')
        .resize({ width: 64, height: 64, fit: 'inside', withoutEnlargement: true })
        .removeAlpha()
        .raw()
        .toBuffer({ resolveWithObject: true })
    const colors = analyzePixels(data, info.channels)
    const lens = normalizeLens(image?.exif?.lens)
    return {
        exploreVersion: EXPLORE_VERSION,
        ...colors,
        lens,
        lensKey: lensKey(lens),
    }
}

async function generateHeroOutput(sourceBytes, width, format) {
    const image = sharp(sourceBytes, { failOn: 'warning', limitInputPixels: 100_000_000 })
        .rotate()
        .toColourspace('srgb')
        .resize({ width, withoutEnlargement: true })
    if (format === 'avif') image.avif({ quality: 74, effort: 4 })
    else if (format === 'webp') image.webp({ quality: 86, effort: 4 })
    else image.jpeg({ quality: 90, progressive: true, mozjpeg: true })
    const bytes = await image.toBuffer()
    if (bytes.length < 1 || bytes.length > MAX_OUTPUT_BYTES) throw new Error('Generated hero size is invalid')
    const metadata = await sharp(bytes, { failOn: 'error' }).metadata()
    if (!heroOutputFormatMatches(format, metadata.format) || metadata.width !== width || !metadata.height) {
        throw new Error('Generated hero failed validation')
    }
    return { bytes, width, height: metadata.height, format }
}

async function processHeroJob(jobValue) {
    const job = parseHeroJob(jobValue)
    const { bytes: sourceBytes, head } = await readObjectBounded(job.sourceKey, MAX_SOURCE_BYTES)
    const sourceEtag = String(head.ETag || '').replaceAll('"', '').toLowerCase()
    if (sourceEtag !== job.version) return { status: 'superseded', manifest: null }
    const metadata = await sharp(sourceBytes, { failOn: 'warning', limitInputPixels: 100_000_000 })
        .rotate()
        .metadata()
    if (!metadata.width || !metadata.height || !['jpeg', 'png', 'webp', 'avif'].includes(metadata.format)) {
        throw new Error('Unsupported hero source image')
    }
    const sourceWidth = metadata.autoOrient?.width || metadata.width
    const sourceHeight = metadata.autoOrient?.height || metadata.height
    if (head.ContentType && !['image/jpeg', 'image/png', 'image/webp', 'image/avif'].includes(head.ContentType.toLowerCase())) {
        throw new Error('Hero source content type is invalid')
    }

    const outputs = []
    for (const width of heroWidthsFor(sourceWidth)) {
        for (const format of HERO_FORMATS) {
            const output = await generateHeroOutput(sourceBytes, width, format)
            const key = heroDerivativeKey(job.version, width, format, job.heroType)
            await s3.send(new PutObjectCommand({
                Bucket: requiredEnvironment('IMAGES_BUCKET'),
                Key: key,
                Body: output.bytes,
                ContentType: HERO_CONTENT_TYPES[format],
                CacheControl: 'public, max-age=31536000, immutable',
                ServerSideEncryption: 'AES256',
                Tagging: 'visibility=public',
                Metadata: {
                    'hero-version': job.version,
                    'hero-type': job.heroType,
                    'hero-width': String(width),
                    generator: 'responsive-hero-v1',
                },
            }))
            outputs.push({ ...output, key })
        }
    }
    const manifest = buildHeroManifest({
        version: job.version,
        sourceWidth,
        sourceHeight,
        outputs,
        heroType: job.heroType,
    })
    const latest = await s3.send(new HeadObjectCommand({
        Bucket: requiredEnvironment('IMAGES_BUCKET'),
        Key: job.sourceKey,
    }))
    if (String(latest.ETag || '').replaceAll('"', '').toLowerCase() !== job.version) {
        await deleteHeroVersion(job.version, job.heroType)
        return { status: 'superseded', manifest: null }
    }
    await publishHero(job, manifest, head.ContentType || `image/${metadata.format}`)
    return { status: 'completed', manifest }
}

async function currentHeroManifest(heroType) {
    const paths = heroPaths(heroType)
    try {
        const { bytes } = await readObjectBounded(paths.manifest, 64 * 1024)
        const parsed = JSON.parse(bytes.toString('utf8'))
        return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : null
    } catch (error) {
        if (['NoSuchKey', 'NotFound', 'NoSuchKeyException'].includes(errorCode(error)) || error?.$metadata?.httpStatusCode === 404) {
            return null
        }
        if (error instanceof SyntaxError) return null
        throw error
    }
}

async function deleteHeroVersion(version, heroType) {
    const paths = heroPaths(heroType)
    try {
        parseHeroJob({ kind: 'hero', heroType, sourceKey: paths.original, version })
    } catch {
        return
    }
    const bucket = requiredEnvironment('IMAGES_BUCKET')
    const prefix = `${paths.versions}/${version}/`
    let continuationToken
    do {
        const page = await s3.send(new ListObjectsV2Command({
            Bucket: bucket,
            Prefix: prefix,
            MaxKeys: 1000,
            ContinuationToken: continuationToken,
        }))
        if (page.Contents?.length) {
            await s3.send(new DeleteObjectsCommand({
                Bucket: bucket,
                Delete: {
                    Objects: page.Contents.map(({ Key }) => ({ Key })),
                    Quiet: true,
                },
            }))
        }
        continuationToken = page.IsTruncated ? page.NextContinuationToken : undefined
    } while (continuationToken)
}

async function publishHero(job, manifest, sourceContentType) {
    const bucket = requiredEnvironment('IMAGES_BUCKET')
    const paths = heroPaths(job.heroType)
    const oldManifest = await currentHeroManifest(job.heroType)
    manifest.previousVersion = typeof oldManifest?.version === 'string' ? oldManifest.version : null
    manifest.publishedAt = new Date().toISOString()

    const currentAliases = []
    for (const format of HERO_FORMATS) {
        for (const variant of manifest.variants[format]) {
            const aliasKey = heroCurrentKey(variant.width, format, job.heroType)
            await s3.send(new CopyObjectCommand({
                Bucket: bucket,
                Key: aliasKey,
                CopySource: `${bucket}/${variant.key}`,
                ContentType: HERO_CONTENT_TYPES[format],
                CacheControl: 'public, max-age=0, must-revalidate',
                MetadataDirective: 'REPLACE',
                Tagging: 'visibility=public',
                TaggingDirective: 'REPLACE',
                ServerSideEncryption: 'AES256',
            }))
            currentAliases.push(aliasKey)
        }
    }

    for (const format of HERO_FORMATS) {
        const candidates = manifest.variants[format]
        const preferred = candidates.find(({ width }) => width >= 1280) || candidates.at(-1)
        const aliasKey = heroCurrentFallbackKey(format, job.heroType)
        await s3.send(new CopyObjectCommand({
            Bucket: bucket,
            Key: aliasKey,
            CopySource: `${bucket}/${preferred.key}`,
            ContentType: HERO_CONTENT_TYPES[format],
            CacheControl: 'public, max-age=0, must-revalidate',
            MetadataDirective: 'REPLACE',
            Tagging: 'visibility=public',
            TaggingDirective: 'REPLACE',
            ServerSideEncryption: 'AES256',
        }))
        currentAliases.push(aliasKey)
    }

    const existingAliases = []
    let aliasContinuationToken
    do {
        const page = await s3.send(new ListObjectsV2Command({
            Bucket: bucket,
            Prefix: `${paths.current}/`,
            MaxKeys: 1000,
            ContinuationToken: aliasContinuationToken,
        }))
        existingAliases.push(...(page.Contents || []).map(({ Key }) => Key).filter(Boolean))
        aliasContinuationToken = page.IsTruncated ? page.NextContinuationToken : undefined
    } while (aliasContinuationToken)
    const retainedAliases = new Set(currentAliases)
    const staleAliases = existingAliases.filter((key) => !retainedAliases.has(key))
    if (staleAliases.length) {
        await s3.send(new DeleteObjectsCommand({
            Bucket: bucket,
            Delete: { Objects: staleAliases.map((Key) => ({ Key })), Quiet: true },
        }))
    }

    await s3.send(new CopyObjectCommand({
        Bucket: bucket,
        Key: paths.original,
        CopySource: `${bucket}/${job.sourceKey}`,
        CopySourceIfMatch: `"${job.version}"`,
        ContentType: sourceContentType,
        CacheControl: 'private, no-store',
        MetadataDirective: 'REPLACE',
        Tagging: 'visibility=private',
        TaggingDirective: 'REPLACE',
        ServerSideEncryption: 'AES256',
    }))
    await s3.send(new CopyObjectCommand({
        Bucket: bucket,
        Key: paths.home,
        CopySource: `${bucket}/${manifest.fallbackKey}`,
        ContentType: 'image/jpeg',
        CacheControl: 'public, max-age=0, must-revalidate',
        MetadataDirective: 'REPLACE',
        Tagging: 'visibility=public',
        TaggingDirective: 'REPLACE',
        ServerSideEncryption: 'AES256',
    }))
    await s3.send(new PutObjectCommand({
        Bucket: bucket,
        Key: paths.manifest,
        Body: JSON.stringify(manifest),
        ContentType: 'application/json',
        CacheControl: 'public, max-age=0, must-revalidate',
        Tagging: 'visibility=public',
        ServerSideEncryption: 'AES256',
    }))
    const invalidationPaths = [...new Set([
        `/${paths.home}`,
        `/${paths.manifest}`,
        ...currentAliases.map((key) => `/${key}`),
        ...existingAliases.map((key) => `/${key}`),
    ])]
    await cloudfront.send(new CreateInvalidationCommand({
        DistributionId: requiredEnvironment('IMAGES_DISTRIBUTION_ID'),
        InvalidationBatch: {
            CallerReference: `responsive-${job.heroType}-hero-v2-${job.version}`,
            Paths: {
                Quantity: invalidationPaths.length,
                Items: invalidationPaths,
            },
        },
    }))
    await deleteHeroVersion(oldManifest?.previousVersion, job.heroType)
    if (job.sourceKey === paths.pending) {
        try {
            await s3.send(new DeleteObjectCommand({
                Bucket: bucket,
                Key: job.sourceKey,
                IfMatch: job.version,
            }))
        } catch (error) {
            if (!isPreconditionFailure(error)) throw error
        }
    }
}

async function validateStoredPreview(key, expected, sourceDigest) {
    const { bytes, head } = await readObjectBounded(key, MAX_OUTPUT_BYTES)
    if (head.ContentType !== 'image/webp') throw new Error('Existing preview content type conflicts')
    if (head.Metadata?.['preview-version'] !== String(PREVIEW_VERSION)
        || head.Metadata?.['preview-width'] !== String(expected.width)
        || head.Metadata?.['source-sha256'] !== sourceDigest) {
        throw new Error('Existing preview metadata conflicts')
    }
    const metadata = await sharp(bytes, { failOn: 'error' }).metadata()
    if (metadata.format !== 'webp' || metadata.width !== expected.width || metadata.height !== expected.height) {
        throw new Error('Existing preview bytes conflict')
    }
}

async function ensurePreviewObject(key, output, sourceDigest) {
    const bucket = requiredEnvironment('IMAGES_BUCKET')
    try {
        await s3.send(new PutObjectCommand({
            Bucket: bucket,
            Key: key,
            Body: output.bytes,
            ContentType: 'image/webp',
            CacheControl: 'public, max-age=31536000, immutable',
            ServerSideEncryption: 'AES256',
            IfNoneMatch: '*',
            Tagging: 'visibility=pending',
            Metadata: {
                'preview-version': String(PREVIEW_VERSION),
                'preview-width': String(output.width),
                'source-sha256': sourceDigest,
                generator: 'responsive-preview-v3',
            },
        }))
    } catch (error) {
        if (!isPreconditionFailure(error)) {
            throw previewStageFailure(
                'preview_object_write_failed',
                classifyPreviewObjectFailure(error, 'put'),
            )
        }
    }
    try {
        await validateStoredPreview(key, output, sourceDigest)
    } catch (error) {
        throw previewStageFailure(
            'preview_object_write_failed',
            classifyPreviewObjectFailure(error, 'validate'),
        )
    }
}

async function setVisibilityTag(key, visibility) {
    const bucket = requiredEnvironment('IMAGES_BUCKET')
    const existing = await s3.send(new GetObjectTaggingCommand({ Bucket: bucket, Key: key }))
    const tags = new Map((existing.TagSet || []).map((tag) => [tag.Key, tag.Value]))
    tags.set('visibility', visibility)
    await s3.send(new PutObjectTaggingCommand({
        Bucket: bucket,
        Key: key,
        Tagging: { TagSet: [...tags.entries()].sort().map(([Key, Value]) => ({ Key, Value })) },
    }))
    const verified = await s3.send(new GetObjectTaggingCommand({ Bucket: bucket, Key: key }))
    if (!(verified.TagSet || []).some((tag) => tag.Key === 'visibility' && tag.Value === visibility)) {
        throw new Error('Preview visibility tag verification failed')
    }
}

async function recordPendingMetadata(resolved, jobId) {
    const now = new Date().toISOString()
    const mediaId = mediaIdForKey(resolved.job.rawKey)
    await documentClient.send(new PutCommand({
        TableName: requiredEnvironment('PREVIEW_METADATA_TABLE'),
        Item: {
            albumId: resolved.job.albumId,
            mediaId,
            previewVersion: PREVIEW_VERSION,
            previewKeys: resolved.previewKeys,
            status: 'pending',
            jobId,
            updatedAt: now,
        },
        ConditionExpression: 'attribute_not_exists(albumId) OR (#status = :pending AND #jobId = :jobId AND #previewVersion = :version AND #previewKeys = :keys)',
        ExpressionAttributeNames: {
            '#status': 'status',
            '#jobId': 'jobId',
            '#previewVersion': 'previewVersion',
            '#previewKeys': 'previewKeys',
        },
        ExpressionAttributeValues: {
            ':pending': 'pending',
            ':jobId': jobId,
            ':version': PREVIEW_VERSION,
            ':keys': resolved.previewKeys,
        },
    }))
    return mediaId
}

async function markReadyMetadataPending(resolved, mediaId, jobId) {
    await documentClient.send(new UpdateCommand({
        TableName: requiredEnvironment('PREVIEW_METADATA_TABLE'),
        Key: { albumId: resolved.job.albumId, mediaId },
        UpdateExpression: 'SET #status = :pending, #jobId = :jobId, updatedAt = :updatedAt REMOVE sourceSha256, dimensions, completedAt',
        ConditionExpression: '#status = :ready AND #previewVersion = :version AND #previewKeys = :keys',
        ExpressionAttributeNames: {
            '#status': 'status',
            '#jobId': 'jobId',
            '#previewVersion': 'previewVersion',
            '#previewKeys': 'previewKeys',
        },
        ExpressionAttributeValues: {
            ':ready': 'ready',
            ':pending': 'pending',
            ':jobId': jobId,
            ':updatedAt': new Date().toISOString(),
            ':version': PREVIEW_VERSION,
            ':keys': resolved.previewKeys,
        },
    }))
}

async function upgradePreviousReadyMetadataPending(resolved, mediaId, jobId, previousKeys) {
    await documentClient.send(new UpdateCommand({
        TableName: requiredEnvironment('PREVIEW_METADATA_TABLE'),
        Key: { albumId: resolved.job.albumId, mediaId },
        UpdateExpression: 'SET #status = :pending, #jobId = :jobId, #previewVersion = :version, #previewKeys = :newKeys, updatedAt = :updatedAt REMOVE sourceSha256, dimensions, completedAt',
        ConditionExpression: '#status = :ready AND #previewVersion = :previousVersion AND #previewKeys = :previousKeys',
        ExpressionAttributeNames: {
            '#status': 'status',
            '#jobId': 'jobId',
            '#previewVersion': 'previewVersion',
            '#previewKeys': 'previewKeys',
        },
        ExpressionAttributeValues: {
            ':ready': 'ready',
            ':pending': 'pending',
            ':jobId': jobId,
            ':updatedAt': new Date().toISOString(),
            ':version': PREVIEW_VERSION,
            ':previousVersion': PREVIOUS_PREVIEW_VERSION,
            ':newKeys': resolved.previewKeys,
            ':previousKeys': previousKeys,
        },
    }))
}

async function commitPreviewMetadata(resolved, mediaId, jobId, sourceDigest, outputs, exploreMetadata) {
    await documentClient.send(new UpdateCommand({
        TableName: requiredEnvironment('PREVIEW_METADATA_TABLE'),
        Key: { albumId: resolved.job.albumId, mediaId },
        UpdateExpression: 'SET #status = :ready, sourceSha256 = :sourceSha256, dimensions = :dimensions, completedAt = :completedAt, exploreVersion = :exploreVersion, palette = :palette, colorFamilies = :colorFamilies, lens = :lens, lensKey = :lensKey REMOVE #jobId',
        ConditionExpression: '#status = :pending AND #jobId = :jobId AND #previewVersion = :version AND #previewKeys = :keys',
        ExpressionAttributeNames: {
            '#status': 'status',
            '#previewVersion': 'previewVersion',
            '#previewKeys': 'previewKeys',
            '#jobId': 'jobId',
        },
        ExpressionAttributeValues: {
            ':ready': 'ready',
            ':pending': 'pending',
            ':version': PREVIEW_VERSION,
            ':keys': resolved.previewKeys,
            ':jobId': jobId,
            ':sourceSha256': sourceDigest,
            ':dimensions': Object.fromEntries(PREVIEW_WIDTHS.map((width) => [
                String(width),
                { width, height: outputs[String(width)].height },
            ])),
            ':completedAt': new Date().toISOString(),
            ':exploreVersion': exploreMetadata.exploreVersion,
            ':palette': exploreMetadata.palette,
            ':colorFamilies': exploreMetadata.colorFamilies,
            ':lens': exploreMetadata.lens,
            ':lensKey': exploreMetadata.lensKey,
        },
    }))
}

async function ensureExploreMetadata(resolved, metadata) {
    if (isCompleteExploreMetadata(metadata)) return metadata
    const { bytes } = await readObjectBounded(resolved.previewKeys['640'], MAX_OUTPUT_BYTES)
    const exploreMetadata = await extractExploreMetadata(bytes, resolved.image)
    await documentClient.send(new UpdateCommand({
        TableName: requiredEnvironment('PREVIEW_METADATA_TABLE'),
        Key: { albumId: resolved.job.albumId, mediaId: mediaIdForKey(resolved.job.rawKey) },
        UpdateExpression: 'SET exploreVersion = :exploreVersion, palette = :palette, colorFamilies = :colorFamilies, lens = :lens, lensKey = :lensKey, updatedAt = :updatedAt',
        ConditionExpression: '#status = :ready AND #previewVersion = :version AND #previewKeys = :keys',
        ExpressionAttributeNames: {
            '#status': 'status',
            '#previewVersion': 'previewVersion',
            '#previewKeys': 'previewKeys',
        },
        ExpressionAttributeValues: {
            ':ready': 'ready',
            ':version': PREVIEW_VERSION,
            ':keys': resolved.previewKeys,
            ':exploreVersion': exploreMetadata.exploreVersion,
            ':palette': exploreMetadata.palette,
            ':colorFamilies': exploreMetadata.colorFamilies,
            ':lens': exploreMetadata.lens,
            ':lensKey': exploreMetadata.lensKey,
            ':updatedAt': new Date().toISOString(),
        },
    }))
    return { ...metadata, ...exploreMetadata }
}

async function tagUntilVisibilityStable(job, previewKeys) {
    for (let attempt = 0; attempt < 5; attempt += 1) {
        const resolved = resolveManifestImage(await albumById(job.albumId), job)
        for (const width of PREVIEW_WIDTHS) {
            await setVisibilityTag(previewKeys[String(width)], resolved.visibility)
        }
        const verified = resolveManifestImage(await albumById(job.albumId), job)
        if (verified.visibility === resolved.visibility) return verified
    }
    throw new Error('Album visibility did not stabilize')
}

async function processJob(jobValue) {
    const job = await atPreviewStage('job_contract_invalid', async () => parseJob(jobValue))
    let resolved = await atPreviewStage(
        'job_contract_invalid',
        async () => resolveManifestImage(await albumById(job.albumId), job),
    )
    const mediaId = mediaIdForKey(job.rawKey)
    const existingMetadata = await atPreviewStage(
        'metadata_read_failed',
        async () => previewMetadata(job.albumId, mediaId),
    )
    const jobId = previewJobId(job)
    let upgradedPreviousContract = false
    if (existingMetadata?.status === 'ready') {
        if (!isCompletePreview(existingMetadata, resolved.previewKeys)) {
            const previousKeys = previousPreviewKeysFor(job.albumId, job.rawKey)
            if (!isPreviousPreviewContract(existingMetadata, previousKeys)) {
                throw previewStageFailure('existing_preview_invalid')
            }
            await atPreviewStage(
                'metadata_pending_failed',
                async () => upgradePreviousReadyMetadataPending(
                    resolved,
                    mediaId,
                    jobId,
                    previousKeys,
                ),
            )
            upgradedPreviousContract = true
        }
    }
    if (existingMetadata?.status === 'ready' && !upgradedPreviousContract) {
        const accepted = await atPreviewStage('existing_preview_invalid', async () => {
            return validateReadyOrMarkPending({
                metadata: existingMetadata,
                expectedKeys: resolved.previewKeys,
                validateObject: validateStoredPreview,
                tagObject: setVisibilityTag,
                visibility: resolved.visibility,
                markPending: () => markReadyMetadataPending(resolved, mediaId, jobId),
            })
        })
        if (accepted) {
            const completedMetadata = await atPreviewStage(
                'metadata_commit_failed',
                async () => ensureExploreMetadata(resolved, existingMetadata),
            )
            resolved = await atPreviewStage(
                'visibility_tag_failed',
                async () => tagUntilVisibilityStable(job, resolved.previewKeys),
            )
            await atPreviewStage(
                'metadata_commit_failed',
                async () => syncExploreIndex(
                    documentClient,
                    requiredEnvironment('PREVIEW_METADATA_TABLE'),
                    existingMetadata,
                    completedMetadata,
                    resolved.visibility,
                ),
            )
            return { status: 'already-complete' }
        }
    }

    await atPreviewStage('metadata_pending_failed', async () => recordPendingMetadata(resolved, jobId))
    const { bytes: sourceBytes, head } = await atPreviewStage(
        'source_read_failed',
        async () => readObjectBounded(job.rawKey, MAX_SOURCE_BYTES),
    )
    if (head.ContentType && !SUPPORTED_SOURCE_TYPES.has(head.ContentType.toLowerCase())) {
        throw previewStageFailure('source_type_invalid')
    }
    const sourceDigest = createHash('sha256').update(sourceBytes).digest('hex')
    const outputs = await atPreviewStage('source_transform_failed', async () => generateOutputs(sourceBytes))
    const exploreMetadata = await atPreviewStage(
        'source_transform_failed',
        async () => extractExploreMetadata(outputs['640'].bytes, resolved.image),
    )
    for (const width of PREVIEW_WIDTHS) {
        await atPreviewStage(
            'preview_object_write_failed',
            async () => ensurePreviewObject(
                resolved.previewKeys[String(width)],
                outputs[String(width)],
                sourceDigest,
            ),
        )
    }

    // Preview metadata is registered as pending before object creation, so a
    // visibility mutation can discover these deterministic keys. Re-read after
    // each tag pass until album visibility is stable; update_album performs a
    // second preview-only tag pass after its album write for convergence.
    resolved = await atPreviewStage(
        'visibility_tag_failed',
        async () => tagUntilVisibilityStable(job, resolved.previewKeys),
    )
    await atPreviewStage(
        'metadata_commit_failed',
        async () => commitPreviewMetadata(
            resolved,
            mediaId,
            jobId,
            sourceDigest,
            outputs,
            exploreMetadata,
        ),
    )
    resolved = await atPreviewStage(
        'visibility_tag_failed',
        async () => tagUntilVisibilityStable(job, resolved.previewKeys),
    )
    await atPreviewStage(
        'metadata_commit_failed',
        async () => syncExploreIndex(
            documentClient,
            requiredEnvironment('PREVIEW_METADATA_TABLE'),
            existingMetadata,
            {
                albumId: resolved.job.albumId,
                mediaId,
                status: 'ready',
                ...exploreMetadata,
            },
            resolved.visibility,
        ),
    )
    return { status: 'completed' }
}

function eventJobs(event) {
    if (Array.isArray(event?.Records)) {
        return event.Records.map((record) => ({
            id: record.messageId,
            job: JSON.parse(record.body),
        }))
    }
    return [{ id: null, job: event }]
}

export async function handler(event) {
    if (event?.kind === 'hero') {
        const result = await processHeroJob(event)
        console.log(JSON.stringify({ event: 'hero_derivatives_completed', status: result.status }))
        return result
    }
    const jobs = eventJobs(event)
    if (jobs.length === 1 && !jobs[0].id) {
        const result = await processJob(jobs[0].job)
        console.log(JSON.stringify({ event: 'preview_job_completed', status: result.status, requestId: 'direct' }))
        return result
    }

    const failures = []
    for (const entry of jobs) {
        try {
            const isHero = entry.job?.kind === 'hero'
            const result = isHero ? await processHeroJob(entry.job) : await processJob(entry.job)
            console.log(JSON.stringify({
                event: isHero ? 'hero_derivatives_completed' : 'preview_job_completed',
                status: result.status,
                requestId: entry.id,
            }))
        } catch (error) {
            const telemetry = safePreviewFailureTelemetry(error)
            console.error(JSON.stringify({
                event: entry.job?.kind === 'hero' ? 'hero_derivatives_failed' : 'preview_job_failed',
                errorType: 'PreviewStageError',
                ...telemetry,
            }))
            failures.push({ itemIdentifier: entry.id })
        }
    }
    return { batchItemFailures: failures }
}
