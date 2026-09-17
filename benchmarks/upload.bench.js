// Manual, loopback-only HTTP benchmark. No AWS calls, tokens or user media.
import { createServer } from 'node:http'
import { Buffer } from 'node:buffer'
import process from 'node:process'
import { afterAll, beforeAll, expect, it, vi } from 'vitest'
import { createMediaUploadSession } from '../src/utils/mediaUpload'
import { createUploadProgress } from '../src/utils/uploadProgress'
import { mapWithConcurrency } from '../src/utils/concurrency'

const transport = vi.hoisted(() => ({ requestUploadUrls: vi.fn(), uploadFileToS3: vi.fn() }))
vi.mock('../src/utils/api', () => transport)
const delay = ms => new Promise(resolve => setTimeout(resolve, ms))
let server, base, ticker
let active = []
let bytesPerSecond = Infinity
let latency = 0
let authorized = 0
let sent = 0
let sequence = 0

beforeAll(async () => {
    server = createServer(async (req, res) => {
        if (req.method === 'POST') {
            authorized += 1
            const chunks = []
            for await (const chunk of req) chunks.push(chunk)
            const body = JSON.parse(Buffer.concat(chunks).toString())
            await delay(latency)
            const sign = file => ({ uploadUrl: `${base}/object/${sequence++}`, key: `albums/test/${file.kind}/${sequence}.jpg` })
            res.setHeader('Content-Type', 'application/json')
            res.end(JSON.stringify(body.files ? { uploads: body.files.map(sign) } : sign(body)))
        } else {
            await delay(latency)
            let remaining = Number(req.headers['content-length'])
            // Read at one shared rate, so four connections cannot invent
            // bandwidth. TCP provides backpressure on the loopback transfers.
            const transfer = { req, res, remaining }
            active.push(transfer)
            req.on('end', () => { active = active.filter(item => item !== transfer); res.end() })
        }
    })
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
    base = `http://127.0.0.1:${server.address().port}`
    ticker = setInterval(() => {
        const budget = Math.floor(bytesPerSecond / 100 / Math.max(1, active.length))
        for (const item of [...active]) {
            const chunk = item.req.read(Math.min(item.remaining, Number.isFinite(budget) ? budget : 65536))
            if (chunk) { item.remaining -= chunk.length; sent += chunk.length }
            if (!item.remaining) item.req.resume()
        }
    }, 10)
    transport.requestUploadUrls.mockImplementation(async (_token, _albumId, files) => {
        const response = await fetch(`${base}/authorize`, { method: 'POST', body: JSON.stringify({ files }) })
        return response.json()
    })
    transport.uploadFileToS3.mockImplementation(async (url, file, _headers, { onProgress } = {}) => {
        const response = await fetch(url, { method: 'PUT', body: file })
        await response.text()
        onProgress?.({ loaded: file.size })
    })
})
afterAll(async () => {
    clearInterval(ticker)
    server.closeAllConnections()
    await new Promise(resolve => server.close(resolve))
})

async function run(modern, sizes, connection) {
    const files = sizes.map((size, index) => new File([new Uint8Array(size)], `${index}.jpg`, { type: 'image/jpeg' }))
    const prepare = async () => ({ thumbnail: new Blob([new Uint8Array(1024)], { type: 'image/jpeg' }), width: 100, height: 100 })
    authorized = sent = 0
    vi.stubGlobal('navigator', { connection })
    const start = performance.now()
    if (modern) {
        const session = createMediaUploadSession({ albumId: 'test', s3Prefix: 'albums/test/', entries: files.map(file => ({ file })) })
        await session.run({ getIdToken: async () => 'synthetic', prepare, transfer: createUploadProgress(files) })
    } else {
        await mapWithConcurrency(files, 2, async file => {
            const { thumbnail } = await prepare(file)
            const uploads = await Promise.all([file, thumbnail].map(async (part, index) => {
                const response = await fetch(`${base}/authorize`, { method: 'POST', body: JSON.stringify({ kind: index ? 'thumbnail' : 'original', size: part.size }) })
                return response.json()
            }))
            await Promise.all(uploads.map((upload, index) => transport.uploadFileToS3(upload.uploadUrl, index ? thumbnail : file)))
        })
    }
    return { milliseconds: Math.round(performance.now() - start), authorizations: authorized, transferredBytes: sent }
}

it('compares the previous uploader with the actual resumable scheduler over 220-file HTTP transfers', async () => {
    const report = []
    for (const profile of [
        { name: 'latency_bound', latency: 35, bandwidth: Infinity, connection: {}, sizes: Array(220).fill(16 * 1024) },
        { name: 'shared_slow_uplink', latency: 5, bandwidth: 1024 * 1024, connection: { effectiveType: '3g' }, sizes: Array(220).fill(32 * 1024) },
        { name: 'slow_uplink_without_network_hint', latency: 5, bandwidth: 1024 * 1024, connection: {}, sizes: Array(220).fill(32 * 1024) },
        { name: 'mixed_file_sizes', latency: 20, bandwidth: Infinity, connection: {}, sizes: Array.from({ length: 220 }, (_, i) => i % 17 === 0 ? 1024 * 1024 : 4096) },
    ]) {
        latency = profile.latency
        bytesPerSecond = profile.bandwidth
        const before = await run(false, profile.sizes, profile.connection)
        const after = await run(true, profile.sizes, profile.connection)
        expect(after.transferredBytes).toBe(before.transferredBytes)
        expect(after.authorizations).toBeLessThan(before.authorizations)
        // Small scheduling/timer variance is unavoidable on a developer machine.
        expect(after.milliseconds).toBeLessThan(before.milliseconds * 1.05)
        report.push({ profile: profile.name, before, after, improvementPercent: +(100 * (1 - after.milliseconds / before.milliseconds)).toFixed(1) })
    }
    process.stdout.write(JSON.stringify({ uploadBenchmark: report }, null, 2) + '\n')
})
