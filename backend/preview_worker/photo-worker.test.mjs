import assert from 'node:assert/strict'
import { test } from 'node:test'
import sharp from 'sharp'
import { S3Client } from '@aws-sdk/client-s3'
import { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb'
import { PREVIEW_WIDTHS } from './contract.mjs'

const albumId = '11111111-1111-4111-8111-111111111111'
const rawKey = `albums/${albumId}/original/synthetic.jpg`

async function fixture(t, visibility) {
    const env = { ...process.env }
    Object.assign(process.env, { AWS_REGION: 'us-west-2', IMAGES_BUCKET: 'synthetic-bucket', ALBUMS_TABLE: 'synthetic-albums', PREVIEW_METADATA_TABLE: 'synthetic-previews', MEDIA_MUTATION_PROTOCOL: '1' })
    t.after(() => { for (const key of Object.keys(process.env)) if (!(key in env)) delete process.env[key]; Object.assign(process.env, env) })
    const source = await sharp({ create: { width: 1920, height: 1280, channels: 3, background: '#335566' } }).jpeg().toBuffer()
    const objects = new Map([[rawKey, { bytes: source, ContentType: 'image/jpeg', Metadata: {}, tags: [{ Key: 'visibility', Value: visibility }] }]])
    let metadata = null
    const album = { albumId, status: 'active', visibility, type: 'photo', images: [{ rawKey }] }
    const calls = [], leases = []
    t.mock.method(S3Client.prototype, 'send', async command => {
        const input = command.input, type = command.constructor.name
        calls.push({ type, key: input.Key })
        if (type === 'PutObjectCommand') { objects.set(input.Key, { bytes: Buffer.from(input.Body), ContentType: input.ContentType, Metadata: input.Metadata, tags: [{ Key: 'visibility', Value: 'pending' }] }); return {} }
        const object = objects.get(input.Key)
        if (!object) throw Object.assign(new Error('Missing synthetic object'), { name: 'NoSuchKey' })
        if (type === 'HeadObjectCommand') return { ContentLength: object.bytes.length, ContentType: object.ContentType, Metadata: object.Metadata, ETag: 'stable-source' }
        if (type === 'GetObjectCommand') return { ETag: 'stable-source', Body: { transformToByteArray: async () => object.bytes } }
        if (type === 'GetObjectTaggingCommand') return { TagSet: object.tags }
        if (type === 'PutObjectTaggingCommand') { object.tags = input.Tagging.TagSet; return {} }
        throw new Error(`Unexpected provider operation ${type}`)
    })
    t.mock.method(DynamoDBDocumentClient.prototype, 'send', async command => {
        const type = command.constructor.name, input = command.input
        if (type === 'GetCommand') return { Item: structuredClone(input.TableName === 'synthetic-albums' ? album : metadata) }
        if (type === 'PutCommand') { metadata = structuredClone(input.Item); return {} }
        if (type === 'BatchWriteCommand') return { UnprocessedItems: {} }
        if (type === 'UpdateCommand') {
            if (input.TableName === 'synthetic-albums') { leases.push(input); return {} }
            const values = input.ExpressionAttributeValues
            if (input.UpdateExpression.includes('#status = :ready')) {
                metadata.status = 'ready'
                for (const [key, value] of Object.entries(values)) if (![':ready', ':pending', ':version', ':keys', ':jobId'].includes(key)) metadata[key.slice(1)] = value
                delete metadata.jobId
            }
            return {}
        }
        throw new Error(`Unexpected metadata operation ${type}`)
    })
    const { handler } = await import('./index.mjs')
    const run = () => handler({ Records: [{ messageId: 'synthetic-job', body: JSON.stringify({ albumId, rawKey, previewVersion: 3 }) }] })
    return { run, objects, calls, leases, metadata: () => metadata }
}

for (const visibility of ['public', 'private', 'unlisted']) test(`actual photo worker preserves ${visibility} tags, codecs, metadata and duplicate readiness`, async t => {
    const f = await fixture(t, visibility)
    assert.deepEqual(await f.run(), { batchItemFailures: [] })
    const metadata = f.metadata()
    assert.equal(metadata.status, 'ready')
    assert.match(metadata.sourceSha256, /^[a-f0-9]{64}$/)
    assert.equal(metadata.previewVersion, 3)
    assert.ok(metadata.palette.length)
    assert.equal(metadata.temporalVersion, 1)
    for (const width of PREVIEW_WIDTHS) {
        const object = f.objects.get(metadata.previewKeys[String(width)])
        const image = await sharp(object.bytes).metadata()
        assert.equal(image.format, 'webp'); assert.equal(image.width, width)
        assert.equal(object.Metadata['source-sha256'], metadata.sourceSha256)
        assert.ok(object.tags.some(tag => tag.Key === 'visibility' && tag.Value === visibility))
    }
    const puts = f.calls.filter(c => c.type === 'PutObjectCommand').length
    const reads = f.calls.filter(c => c.type === 'GetObjectCommand' && c.key === rawKey).length
    assert.equal(puts, 4)
    assert.deepEqual(await f.run(), { batchItemFailures: [] })
    assert.equal(f.calls.filter(c => c.type === 'PutObjectCommand').length, puts)
    assert.equal(f.calls.filter(c => c.type === 'GetObjectCommand' && c.key === rawKey).length, reads)
    assert.equal(f.leases.filter(c => c.UpdateExpression.startsWith('SET')).length, 3)
    assert.equal(f.leases.filter(c => c.UpdateExpression.startsWith('REMOVE')).length, 3)
})
