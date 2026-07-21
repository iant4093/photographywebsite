import { createHash } from 'node:crypto'
import sharp from 'sharp'
import {
    GetObjectCommand,
    GetObjectTaggingCommand,
    HeadObjectCommand,
    PutObjectCommand,
    PutObjectTaggingCommand,
    S3Client,
} from '@aws-sdk/client-s3'
import { DynamoDBClient } from '@aws-sdk/client-dynamodb'
import { DynamoDBDocumentClient, GetCommand, PutCommand, UpdateCommand } from '@aws-sdk/lib-dynamodb'

import {
    PREVIEW_QUALITY,
    PREVIEW_VERSION,
    PREVIEW_WIDTHS,
    SUPPORTED_SOURCE_TYPES,
    isCompletePreview,
    mediaIdForKey,
    parseJob,
    parsePositiveLimit,
    previewJobId,
    resolveManifestImage,
} from './contract.mjs'
import {
    atPreviewStage,
    classifyPreviewObjectFailure,
    previewStageFailure,
    safePreviewFailureTelemetry,
} from './telemetry.mjs'
import { validateReadyOrMarkPending } from './workflow.mjs'

const s3 = new S3Client({})
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
                generator: 'responsive-preview-v2',
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

async function commitPreviewMetadata(resolved, mediaId, jobId, sourceDigest, outputs) {
    await documentClient.send(new UpdateCommand({
        TableName: requiredEnvironment('PREVIEW_METADATA_TABLE'),
        Key: { albumId: resolved.job.albumId, mediaId },
        UpdateExpression: 'SET #status = :ready, sourceSha256 = :sourceSha256, dimensions = :dimensions, completedAt = :completedAt REMOVE #jobId',
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
        },
    }))
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
    if (existingMetadata?.status === 'ready') {
        const accepted = await atPreviewStage('existing_preview_invalid', async () => {
            if (!isCompletePreview(existingMetadata, resolved.previewKeys)) {
                throw new Error('Preview metadata conflicts')
            }
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
            await atPreviewStage(
                'visibility_tag_failed',
                async () => tagUntilVisibilityStable(job, resolved.previewKeys),
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
        async () => commitPreviewMetadata(resolved, mediaId, jobId, sourceDigest, outputs),
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
    const jobs = eventJobs(event)
    if (jobs.length === 1 && !jobs[0].id) {
        const result = await processJob(jobs[0].job)
        console.log(JSON.stringify({ event: 'preview_job_completed', status: result.status, requestId: 'direct' }))
        return result
    }

    const failures = []
    for (const entry of jobs) {
        try {
            const result = await processJob(entry.job)
            console.log(JSON.stringify({
                event: 'preview_job_completed',
                status: result.status,
                requestId: entry.id,
            }))
        } catch (error) {
            const telemetry = safePreviewFailureTelemetry(error)
            console.error(JSON.stringify({
                event: 'preview_job_failed',
                errorType: 'PreviewStageError',
                ...telemetry,
            }))
            failures.push({ itemIdentifier: entry.id })
        }
    }
    return { batchItemFailures: failures }
}
