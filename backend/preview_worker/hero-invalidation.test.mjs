import assert from 'node:assert/strict'
import test from 'node:test'
import { readFileSync } from 'node:fs'
import { CloudFrontClient } from '@aws-sdk/client-cloudfront'
import { S3Client } from '@aws-sdk/client-s3'
import sharp from 'sharp'
import { invalidateHeroPublication } from './hero-invalidation.mjs'
import { buildHeroManifest, HERO_FORMATS, heroAliasSources, heroCurrentFallbackKey, heroCurrentKey, heroDerivativeKey, heroPaths, heroWidthsFor } from './hero.mjs'

const A = 'a'.repeat(32)
const B = 'b'.repeat(32)
const jobFor = (heroType = 'photo', version = A) => ({ kind: 'hero', heroType, version, sourceKey: heroPaths(heroType).pending })
const quotaError = () => Object.assign(new Error('Wildcard quota'), { name: 'TooManyInvalidationsInProgress', $metadata: { httpStatusCode: 400 } })
const inputFor = (heroType = 'photo', width = 2560, version = A) => {
    const job = jobFor(heroType, version)
    const outputs = heroWidthsFor(width).flatMap(w => HERO_FORMATS.map(format => ({ width: w, height: Math.max(1, Math.round(w * 0.625)), format, key: heroDerivativeKey(version, w, format, heroType) })))
    const manifest = buildHeroManifest({ heroType, version, sourceWidth: width, sourceHeight: Math.max(1, Math.round(width * 0.625)), outputs })
    const currentAliases = HERO_FORMATS.flatMap(format => [...heroAliasSources(manifest.variants[format]).map(v => heroCurrentKey(v.width, format, heroType)), heroCurrentFallbackKey(format, heroType)])
    return { distributionId: 'synthetic-distribution', job, currentAliases, existingAliases: [currentAliases[0], `${heroPaths(heroType).current}/stale.jpg`] }
}

test('three compact paths cover every current and stale alias while excluding other namespaces', async t => {
    for (const heroType of ['photo', 'video']) for (const width of [60, 640, 1600, 2560]) {
        await t.test(`${heroType}-${width}`, async () => {
            const input = inputFor(heroType, width), paths = heroPaths(heroType), requests = []
            await invalidateHeroPublication({ send: async c => { requests.push(c.input); return { accepted: true } } }, input)
            assert.equal(requests.length, 1)
            const batch = requests[0].InvalidationBatch
            assert.equal(requests[0].DistributionId, input.distributionId)
            assert.deepEqual(batch.Paths, { Quantity: 3, Items: [`/${paths.home}`, `/${paths.manifest}`, `/${paths.current}/*`] })
            const covers = p => batch.Paths.Items.some(q => q.endsWith('*') ? p.startsWith(q.slice(0, -1)) : p === q)
            assert.ok([...input.currentAliases, ...input.existingAliases].every(k => covers('/' + k)))
            for (const k of [paths.original, `${paths.versions}/${A}/hero-640.jpg`, `${heroPaths(heroType === 'photo' ? 'video' : 'photo').current}/hero.jpg`, 'site/hero/video/reel.json', 'albums/private/original.jpg', 'public-previews/private/photo.webp']) assert.equal(covers('/' + k), false)
            assert.match(batch.CallerReference, new RegExp(`^responsive-${heroType}-hero-v3-${A}-[a-f0-9]{32}-compact$`))
            assert.ok(batch.CallerReference.length < 128)
        })
    }
})

test('explicit wildcard rejection falls back to the full deduplicated exact set with a distinct identity', async () => {
    const input = inputFor(), calls = [], response = { accepted: true }
    const result = await invalidateHeroPublication({ send: async c => { calls.push(c.input); if (calls.length === 1) throw quotaError(); return response } }, input)
    assert.equal(result, response)
    const paths = heroPaths('photo'), exact = [...new Set([`/${paths.home}`, `/${paths.manifest}`, ...input.currentAliases.map(k => '/' + k), ...input.existingAliases.map(k => '/' + k)])]
    assert.equal(calls.length, 2)
    assert.deepEqual(calls[1].InvalidationBatch.Paths, { Quantity: exact.length, Items: exact })
    assert.equal(calls[0].InvalidationBatch.CallerReference.replace(/-compact$/, ''), calls[1].InvalidationBatch.CallerReference.replace(/-exact$/, ''))
    assert.ok(!exact.some(p => p.includes('*')))
})

test('timeouts, access denial, malformed responses and other provider errors never trigger a second request', async t => {
    for (const error of [new Error('Timeout after acceptance'), Object.assign(new Error('Denied'), { name: 'AccessDenied', $metadata: { httpStatusCode: 403 } }), Object.assign(new Error('Not a provider response'), { name: 'TooManyInvalidationsInProgress' }), Object.assign(new Error('Wrong status'), { name: 'TooManyInvalidationsInProgress', $metadata: { httpStatusCode: 500 } }), Object.assign(new Error('Large batch'), { name: 'BatchTooLarge', $metadata: { httpStatusCode: 413 } })]) {
        await t.test(error.message, async () => {
            let calls = 0
            await assert.rejects(invalidateHeroPublication({ send: async () => { calls++; throw error } }, inputFor()), e => e === error)
            assert.equal(calls, 1)
        })
    }
})

test('a failed exact fallback propagates the original failure without extra retries', async () => {
    const failure = new Error('Exact request unavailable'); let calls = 0
    await assert.rejects(invalidateHeroPublication({ send: async () => { if (++calls === 1) throw quotaError(); throw failure } }, inputFor()), e => e === failure)
    assert.equal(calls, 2)
})

test('duplicate deliveries, changed stale aliases and A-B-A each create a new publication identity', async () => {
    const ledger = new Map(), requests = []
    const client = { send: async c => {
        const b = c.input.InvalidationBatch, value = JSON.stringify(b.Paths)
        if (ledger.has(b.CallerReference)) assert.equal(ledger.get(b.CallerReference), value)
        else ledger.set(b.CallerReference, value)
        requests.push(b); return { accepted: true }
    } }
    ledger.set(`responsive-photo-hero-v2-${A}`, JSON.stringify({ old: 'exact-shape' }))
    for (const version of [A, A, B, A]) await invalidateHeroPublication(client, inputFor('photo', 2560, version))
    const changed = inputFor(); changed.existingAliases.push('site/hero/current/another-old.jpg')
    await invalidateHeroPublication(client, { ...changed, mode: 'exact' })
    assert.equal(new Set(requests.map(r => r.CallerReference)).size, 5)
    assert.equal(ledger.size, 6)
})

test('the actual SDK retries reuse the serialized request identity without network access', async () => {
    const { ConfiguredRetryStrategy } = await import('@smithy/core/retry')
    const bodies = []
    const client = new CloudFrontClient({
        region: 'us-west-2', credentials: { accessKeyId: 'testing', secretAccessKey: 'testing' },
        retryStrategy: new ConfiguredRetryStrategy(2, () => 0),
        requestHandler: { handle: async request => {
            bodies.push(request.body)
            const statusCode = bodies.length === 1 ? 503 : 201
            const body = statusCode === 503
                ? '<ErrorResponse><Error><Code>ServiceUnavailable</Code><Message>Synthetic retry</Message></Error></ErrorResponse>'
                : '<Invalidation><Id>synthetic</Id><Status>InProgress</Status><CreateTime>2026-10-06T00:00:00Z</CreateTime></Invalidation>'
            return { response: { statusCode, headers: { 'content-type': 'text/xml' }, body: Buffer.from(body) } }
        } },
    })
    try {
        const response = await invalidateHeroPublication(client, inputFor())
        assert.equal(response.$metadata.attempts, 2)
        assert.equal(bodies.length, 2)
        assert.equal(bodies[0], bodies[1])
        assert.match(bodies[0], /responsive-photo-hero-v3-/)
    } finally { client.destroy() }
})

test('compatible exact rollback skips the wildcard and retains the new reference namespace', async () => {
    const calls = []
    await invalidateHeroPublication({ send: async c => { calls.push(c.input); return {} } }, { ...inputFor('video'), mode: 'exact' })
    assert.equal(calls.length, 1)
    assert.ok(calls[0].InvalidationBatch.Paths.Items.every(p => !p.includes('*')))
    assert.match(calls[0].InvalidationBatch.CallerReference, /^responsive-video-hero-v3-.*-exact$/)
})

test('invalid jobs, namespace, mode and distribution never reach the provider', async () => {
    let calls = 0
    const client = { send: async () => { calls++; return {} } }
    for (const override of [{ job: { ...jobFor(), heroType: 'private' } }, { existingAliases: ['albums/private/source.jpg'] }, { mode: 'unknown' }, { distributionId: '' }]) await assert.rejects(invalidateHeroPublication(client, { ...inputFor(), ...override }))
    assert.equal(calls, 0)
})

// Exercise the real worker and real native encoding with inert SDK boundaries.
async function publisher(t, { heroType = 'photo', failAt = null, invalidate = async () => ({}), sourceKey = heroPaths(heroType).pending, mode } = {}) {
    const env = { ...process.env }
    Object.assign(process.env, { AWS_REGION: 'us-west-2', IMAGES_BUCKET: 'synthetic-bucket', IMAGES_DISTRIBUTION_ID: 'synthetic-distribution' })
    t.after(() => { for (const key of Object.keys(process.env)) if (!(key in env)) delete process.env[key]; Object.assign(process.env, env) })
    const bytes = await sharp({ create: { width: 60, height: 40, channels: 3, background: '#335566' } }).jpeg().toBuffer(), paths = heroPaths(heroType), calls = []
    const oldManifest = Buffer.from(JSON.stringify({ version: B, previousVersion: 'c'.repeat(32) }))
    let publications = 0
    t.mock.method(S3Client.prototype, 'send', async c => {
        const type = c.constructor.name, input = c.input
        calls.push({ type, input })
        if (type === 'HeadObjectCommand') return input.Key === paths.manifest
            ? { ETag: 'old', ContentLength: oldManifest.length, ContentType: 'application/json' }
            : { ETag: A, ContentLength: bytes.length, ContentType: 'image/jpeg' }
        if (type === 'GetObjectCommand') {
            if (input.Key === paths.manifest) return { ETag: 'old', Body: { transformToByteArray: async () => oldManifest } }
            return { ETag: A, Body: { transformToByteArray: async () => bytes } }
        }
        // Count boundaries in publishHero, excluding generated immutable outputs.
        const publication = type !== 'PutObjectCommand' || input.Key === paths.manifest
        if (publication && ++publications === failAt) throw new Error('Publication interruption')
        if (type === 'ListObjectsV2Command') {
            if (input.Prefix === `${paths.current}/`) return input.ContinuationToken ? { Contents: [{ Key: `${paths.current}/stale.jpg` }] } : { Contents: [{ Key: `${paths.current}/hero.jpg` }], IsTruncated: true, NextContinuationToken: 'next' }
            return { Contents: [{ Key: input.Prefix + 'old.jpg' }] }
        }
        return {}
    })
    t.mock.method(CloudFrontClient.prototype, 'send', async c => { calls.push({ type: c.constructor.name, input: c.input }); return invalidate(c) })
    let handler
    if (mode) {
        // Evaluate the exact publisher body with the actual rollback-mode helper.
        const vm = await import('node:vm'), hero = await import('./hero.mjs'), sdk = await import('@aws-sdk/client-s3')
        const source = readFileSync(new URL('./index.mjs', import.meta.url), 'utf8')
        const body = source.slice(source.indexOf('async function publishHero('), source.indexOf('async function validateStoredPreview('))
        const ctx = vm.createContext({ ...hero, ...sdk, Date, Set, requiredEnvironment: () => 'synthetic', currentHeroManifest: async () => null, s3: new S3Client({}), cloudfront: new CloudFrontClient({}), deleteHeroVersion: async () => {}, isPreconditionFailure: () => false, invalidateHeroPublication: (client, input) => invalidateHeroPublication(client, { ...input, mode }) })
        vm.runInContext(body, ctx)
        handler = () => ctx.publishHero(jobFor(heroType), buildHeroManifest({ heroType, version: A, sourceWidth: 60, sourceHeight: 40, outputs: HERO_FORMATS.map(format => ({ width: 60, height: 40, format, key: heroDerivativeKey(A, 60, format, heroType) })) }), 'image/jpeg')
    } else {
        const worker = await import('./index.mjs')
        handler = () => worker.handler({ Records: [{ messageId: 'synthetic-job', body: JSON.stringify({ ...jobFor(heroType), sourceKey }) }] })
    }
    return { calls, run: handler, paths, publications: () => publications }
}

test('actual photo/video worker publishes before invalidation and cleans up only after accepted compact/fallback requests', async t => {
    for (const heroType of ['photo', 'video']) for (const fallback of [false, true]) await t.test(`${heroType}-${fallback}`, async child => {
        let requests = 0
        const f = await publisher(child, { heroType, invalidate: async () => { if (++requests === 1 && fallback) throw quotaError(); return {} } })
        assert.deepEqual(await f.run(), { batchItemFailures: [] })
        const manifest = f.calls.findIndex(c => c.type === 'PutObjectCommand' && c.input.Key === f.paths.manifest), invalidation = f.calls.findIndex(c => c.type === 'CreateInvalidationCommand'), cleanup = f.calls.findIndex(c => c.type === 'DeleteObjectCommand' && c.input.Key === f.paths.pending)
        assert.ok(manifest >= 0 && manifest < invalidation && invalidation < cleanup)
        assert.equal(requests, fallback ? 2 : 1)
        assert.equal(f.calls.filter(c => c.type === 'ListObjectsV2Command' && c.input.Prefix === `${f.paths.current}/`).length, 2)
        assert.equal(f.calls.find(c => c.type === 'CopyObjectCommand' && c.input.Key === f.paths.original).input.Tagging, 'visibility=private')
        assert.equal(f.calls.find(c => c.type === 'CopyObjectCommand' && c.input.Key === f.paths.home).input.CacheControl, 'public, max-age=0, must-revalidate')
        assert.equal(f.calls[cleanup].input.IfMatch, A)
    })
})

test('actual worker returns ambiguous/fallback failures to SQS and retains pending source and old versions', async t => {
    for (const fallback of [false, true]) await t.test(`fallback-${fallback}`, async child => {
        let requests = 0
        const f = await publisher(child, { invalidate: async () => { if (++requests === 1 && fallback) throw quotaError(); throw new Error('Timeout after potential acceptance') } })
        assert.deepEqual(await f.run(), { batchItemFailures: [{ itemIdentifier: 'synthetic-job' }] })
        assert.ok(f.calls.some(c => c.type === 'PutObjectCommand' && c.input.Key === f.paths.manifest))
        assert.ok(!f.calls.some(c => c.type === 'DeleteObjectCommand'))
        assert.ok(!f.calls.some(c => c.type === 'ListObjectsV2Command' && c.input.Prefix.includes('/versions/')))
        assert.equal(requests, fallback ? 2 : 1)
    })
})

test('actual publication interruption at every boundary cannot invalidate or clean up early', async t => {
    // 21 copies + two paged alias reads + stale deletion + private/home copies + manifest.
    for (let boundary = 1; boundary <= 27; boundary++) await t.test(`boundary-${boundary}`, async child => {
        const f = await publisher(child, { failAt: boundary })
        assert.deepEqual(await f.run(), { batchItemFailures: [{ itemIdentifier: 'synthetic-job' }] })
        assert.ok(!f.calls.some(c => c.type === 'CreateInvalidationCommand'))
        assert.ok(!f.calls.some(c => c.type === 'DeleteObjectCommand'))
    })
})

test('compatible exact rollback publisher consumes existing hero jobs without wildcard paths', async t => {
    const f = await publisher(t, { mode: 'exact' })
    await f.run()
    const cf = f.calls.find(c => c.type === 'CreateInvalidationCommand')
    assert.ok(cf.input.InvalidationBatch.Paths.Items.every(p => !p.includes('*')))
    assert.match(cf.input.InvalidationBatch.CallerReference, /-hero-v3-.*-exact$/)
})
