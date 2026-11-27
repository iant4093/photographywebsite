import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { readFile, stat, mkdir, writeFile } from 'node:fs/promises'
import { resolve, extname, sep } from 'node:path'
import { gzipSync } from 'node:zlib'
import { createHash } from 'node:crypto'
import { chromium, firefox, webkit } from 'playwright'

// Local production builds and synthetic public data only. Every API/media
// request is intercepted; unexpected external traffic is rejected.
const root = resolve(process.env.VISITOR_BUILD_ROOT || 'dist')
const baselineRoot = process.env.VISITOR_BASELINE_ROOT && resolve(process.env.VISITOR_BASELINE_ROOT)
const evidence = process.env.VISITOR_EVIDENCE_DIR && resolve(process.env.VISITOR_EVIDENCE_DIR)
const engine = process.env.VISITOR_BROWSER || 'chromium'
const mediaDomain = process.env.VISITOR_MEDIA_DOMAIN || 'd1twwtwfz1yeo4.cloudfront.net'
const apiPrefix = new URL(process.env.VISITOR_API_BASE || '/api', 'https://visitor.invalid').pathname.replace(/\/+$/, '')
const types = { '.html': 'text/html', '.js': 'application/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.woff2': 'font/woff2', '.json': 'application/json' }
let fixtureDownload
const server = createServer(async (req, res) => {
    try {
        const url = new URL(req.url, 'http://local')
        if (url.pathname === '/fixture-download.webp') {
            res.writeHead(200, { 'content-type': 'image/webp', 'content-disposition': 'attachment; filename="fixture-photo.webp"' })
            return res.end(fixtureDownload)
        }
        const folder = url.pathname.startsWith('/baseline/') ? baselineRoot : root
        const pathname = url.pathname.replace(/^\/baseline/, '')
        if (!folder) return res.writeHead(404).end()
        let path = resolve(folder, '.' + decodeURIComponent(pathname))
        if (path !== folder && !path.startsWith(folder + sep)) return res.writeHead(403).end()
        try { if (!(await stat(path)).isFile()) path = resolve(folder, 'index.html') }
        catch { if (extname(path)) return res.writeHead(404).end(); path = resolve(folder, 'index.html') }
        const body = await readFile(path)
        const compress = ['.html', '.js', '.css'].includes(extname(path))
        res.writeHead(200, { 'content-type': types[extname(path)] || 'application/octet-stream', ...(compress ? { 'content-encoding': 'gzip' } : {}) })
        res.end(compress ? gzipSync(body) : body)
    } catch { res.writeHead(500).end() }
})
await new Promise(done => server.listen(0, '127.0.0.1', done))
const origin = `http://127.0.0.1:${server.address().port}`
const browser = await ({ chromium, firefox, webkit })[engine].launch({ headless: true })
const outcomes = []
if (evidence) await mkdir(evidence, { recursive: true })

function fixture(count) {
    const items = Array.from({ length: count }, (_, index) => {
        const albumId = `11111111-1111-4111-8111-${String(index + 1).padStart(12, '0')}`
        return {
            albumId, type: 'photo', visibility: 'public', title: `Album ${index + 1}`, description: `Photographs from visit ${index + 1}.`,
            createdAt: `${Math.floor(index / 10) % 2 ? '2025' : '2026'}-06-01T12:00:00Z`, category: `Category ${index % 10}`,
            uploadedAt: '2026-06-02T12:00:00Z', imageCount: 6,
            coverImageUrl: `https://${mediaDomain}/albums/${albumId}/photo.jpg`,
            coverThumbnailUrl: `https://${mediaDomain}/albums/${albumId}/thumb.webp`,
            coverBlurhash: 'LEHV6nWB2yk8pyo0adR*.7kCMdnj',
            qrCodeUrl: `https://${mediaDomain}/album-qr.png`,
        }
    })
    const photos = Array.from({ length: 6 }, (_, index) => ({
        id: createHash('sha256').update(`photo-${index}`).digest('hex').slice(0, 24),
        albumId: items[0].albumId, albumTitle: 'Fixture photographs', altText: `Fixture photograph ${index + 1}`,
        url: `https://${mediaDomain}/photos/photo-${index}-w1920.webp`,
        thumbnailUrl: `https://${mediaDomain}/photos/photo-${index}-w640.webp`,
        downloadUrl: `https://${mediaDomain}/albums/${items[0].albumId}/original/photo-${index}.jpg`,
        width: 1920, height: 1280, isFavorite: true,
        before: { status: 'unavailable' },
        exif: { model: 'Fixture Camera', lens: 'Fixture Lens', focalLength: '50 mm', focalRatio: 'f/2.8', shutterSpeed: '1/250', iso: '100' },
        previewSrcSet: [640, 960, 1440, 1920].map(width => ({ width, url: `https://${mediaDomain}/photos/photo-${index}-w${width}.webp` })),
    }))
    return { items, photos }
}

const generation = await browser.newPage()
const encoded = await generation.evaluate(async () => {
    const canvas = document.createElement('canvas'); canvas.width = 1920; canvas.height = 1280
    const context = canvas.getContext('2d'), gradient = context.createLinearGradient(0, 0, 1920, 1280)
    gradient.addColorStop(0, '#487e83'); gradient.addColorStop(1, '#e6b77c'); context.fillStyle = gradient; context.fillRect(0, 0, 1920, 1280)
    let seed = 42
    const random = () => ((seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0) / 4294967296)
    for (let i = 0; i < 4000; i++) { context.fillStyle = `rgba(${Math.floor(random() * 255)},${Math.floor(random() * 255)},${Math.floor(random() * 255)},.3)`; context.fillRect(random() * 1920, random() * 1280, 5 + random() * 40, 5 + random() * 40) }
    const result = {}
    for (const width of [640, 960, 1440, 1920]) {
        const image = document.createElement('canvas'); image.width = width; image.height = Math.round(width * 2 / 3)
        image.getContext('2d').drawImage(canvas, 0, 0, image.width, image.height)
        const blob = await new Promise(done => image.toBlob(done, 'image/webp', .82))
        result[width] = Array.from(new Uint8Array(await blob.arrayBuffer()))
    }
    return result
})
await generation.close()
const images = Object.fromEntries(Object.entries(encoded).map(([width, bytes]) => [width, Buffer.from(bytes)]))
fixtureDownload = images[1920]

async function openCase({ width, count = 85, baseline = false, moduleDelay = 0, failModule = false, imageDelay = 0, detailDelay = 0, titleSuffix = '', albumPreview = false }) {
    const context = await browser.newContext({ viewport: { width, height: 900 }, deviceScaleFactor: width < 500 ? 3 : 1,
        ...(engine !== 'firefox' ? { isMobile: width < 500, hasTouch: width < 500 } : {}), serviceWorkers: 'block' })
    const data = fixture(count), traffic = [], errors = []
    if (titleSuffix) data.items.forEach(album => { album.title += titleSuffix })
    const albumId = data.items[0].albumId
    const version = 'a'.repeat(24)
    const previewRoot = `https://${mediaDomain}/public-previews/${albumId}/v3`
    const manifestUrl = `${previewRoot}/hover-${version}.json`
    if (albumPreview) Object.assign(data.items[0], {
        hoverPreviewStatus: 'ready', hoverPreviewVersion: version, hoverPreviewManifestUrl: manifestUrl,
    })
    await context.addInitScript(({ items }) => {
        if (window.top !== window || !['http:', 'https:'].includes(location.protocol)) return
        localStorage.setItem('ian-photography-analytics', 'disabled')
        sessionStorage.setItem('ian-photography-featured-seed', 'visitor-regression-fixed-seed')
        sessionStorage.setItem('ian:public-catalog:v6:public-photos', JSON.stringify({ version: 6, savedAt: Date.now(), items, nextCursor: null }))
        window.__visitor = { tasks: [] }
        Object.defineProperty(navigator, 'share', { configurable: true, value: undefined })
        Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: async text => { window.__visitor.sharedUrl = text } } })
        try { new PerformanceObserver(list => window.__visitor.tasks.push(...list.getEntries().map(task => ({ start: task.startTime, duration: task.duration })))).observe({ type: 'longtask' }) } catch { /* Not implemented in every engine. */ }
    }, { items: data.items })
    let moduleFailures = 0
    await context.route('**/*', async route => {
        const request = route.request(), url = new URL(request.url())
        traffic.push({ path: url.pathname, type: request.resourceType(), method: request.method() })
        if (url.pathname.startsWith(apiPrefix + '/') || url.pathname.includes('/public/')) {
            const headers = { 'access-control-allow-origin': '*', 'access-control-allow-methods': 'GET,HEAD,POST,OPTIONS', 'access-control-allow-headers': '*' }
            if (request.method() === 'OPTIONS') return route.fulfill({ status: 204, headers })
            if (!['GET', 'HEAD', 'POST'].includes(request.method()) || (request.method() === 'POST' && !/\/(download-url|original-comparison)$/.test(url.pathname))) {
                errors.push(`Blocked unexpected API action: ${request.method()} ${url.pathname}`)
                return route.abort()
            }
            let body = { items: [], images: [], nextCursor: null }
            if (url.pathname.endsWith('/download-url')) body = { downloadUrl: origin + '/fixture-download.webp' }
            else if (url.pathname.includes('/random-photos') || url.pathname.includes('/featured-photos')) body = { images: data.photos, totalPhotos: 6 }
            else if (/\/public\/albums\/[^/]+$/.test(url.pathname)) {
                const album = data.items.find(item => item.albumId === url.pathname.split('/').pop()) || data.items[0]
                body = { album: { ...album, images: data.photos }, images: data.photos }
            } else if (url.pathname.endsWith('/public/albums')) body = { items: data.items, nextCursor: null }
            else if (url.pathname.endsWith('/public/stats')) body = {
                calendar: {
                    albums: data.items.slice(0, 2).map(album => album.albumId),
                    days: [['2026-06-01', 12874, 490, [0]], ['2026-06-02', 24, 0, [1]], ['2025-09-01', 289, 2]],
                },
            }
            return route.fulfill({ contentType: 'application/json', headers, body: JSON.stringify(body) })
        }
        if (url.origin === origin && url.pathname === '/fixture-download.webp') return route.continue()
        if (request.resourceType() === 'document' && url.origin === 'https://www.pictorem.com' && url.pathname === '/order.html') return route.fulfill({ contentType: 'text/html', body: '<!doctype html><title>Fixture checkout</title><h1>Fixture print options</h1>' })
        if (url.protocol === 'blob:') return route.continue()
        if (url.hostname === mediaDomain && /\/original\/photo-\d+\.jpg$/.test(url.pathname)) {
            if (detailDelay) await new Promise(done => setTimeout(done, detailDelay))
            return route.fulfill({ contentType: 'image/webp', headers: { 'access-control-allow-origin': '*' }, body: images[1920] }).catch(() => {})
        }
        if (request.resourceType() === 'image') {
            if (imageDelay) await new Promise(done => setTimeout(done, imageDelay))
            const width = Number(url.pathname.match(/-w(\d+)/)?.[1] || url.pathname.match(/hero-(\d+)/)?.[1] || 640)
            return route.fulfill({ contentType: 'image/webp', headers: { 'access-control-allow-origin': '*' }, body: images[width] || images[1920] }).catch(() => {})
        }
        if (url.hostname === mediaDomain && url.pathname.endsWith('.json')) {
            if (albumPreview && url.href === manifestUrl) return route.fulfill({
                headers: { 'access-control-allow-origin': '*' },
                json: {
                    schemaVersion: 1, albumId, version,
                    images: ['b', 'c', 'd'].map(key => ({ url: `${previewRoot}/${key.repeat(24)}-w640.webp`, width: 640, height: 427 })),
                },
            })
            return route.fulfill({ status: 404, contentType: 'application/json', headers: { 'access-control-allow-origin': '*' }, body: '{}' })
        }
        if (/\/PhotoLightbox-[^/]+\.js$/.test(url.pathname)) {
            if (failModule && moduleFailures++ === 0) return route.abort()
            if (moduleDelay) await new Promise(done => setTimeout(done, moduleDelay))
        }
        if (url.origin !== origin || !['GET', 'HEAD'].includes(request.method())) {
            errors.push(`Blocked unexpected request: ${request.method()} ${url.origin}${url.pathname}`)
            return route.abort()
        }
        // Baseline absolute asset paths need to resolve to the baseline build.
        if (baseline) return route.fulfill({ response: await route.fetch({ url: origin + '/baseline' + url.pathname + url.search }) })
        return route.continue()
    })
    const page = await context.newPage()
    page.on('pageerror', error => errors.push(error.message))
    let cdp
    if (engine === 'chromium') {
        cdp = await context.newCDPSession(page)
        await cdp.send('Performance.enable')
        await cdp.send('Emulation.setCPUThrottlingRate', { rate: 4 })
    }
    await page.goto(origin + '/', { waitUntil: 'domcontentloaded' })
    await page.locator('.catalog-section .album-card').first().waitFor()
    await page.waitForTimeout(1800)
    return { context, page, traffic, errors, cdp }
}

async function photoDetailCase(width) {
    const { context, page, traffic, errors } = await openCase({ width, detailDelay: 1800 })
    try {
        const albumId = '11111111-1111-4111-8111-000000000001'
        const photoId = fixture(1).photos[0].id
        const photo = page.locator('.linen-lightbox-photo-frame.is-loaded:not(.is-outgoing) img.linen-lightbox-edited')
        await page.goto(origin + '/album/' + albumId + '?photo=' + photoId)
        await photo.waitFor()
        // The next photo starts downloading on dwell. Leaving that photo
        // should stop the transfer and the third should upgrade on its own.
        const detailRequest = page.waitForRequest(request => new URL(request.url()).pathname.endsWith('/original/photo-1.jpg'))
        await page.keyboard.press('ArrowRight')
        const request = await detailRequest
        assert.equal(request.resourceType(), 'fetch')
        assert.equal(traffic.some(entry => entry.path.endsWith('/original/photo-0.jpg')), false)
        const aborted = page.waitForEvent('requestfailed', { predicate: failed => failed.url() === request.url() })
        await page.keyboard.press('ArrowRight')
        await aborted
        await photo.and(page.locator('[src^="blob:"]:not([srcset])')).waitFor()
        const target = await photo.evaluate(async image => {
            await image.decode()
            const rect = image.getBoundingClientRect()
            return {
                hit: document.elementFromPoint(rect.left + rect.width / 2, rect.top + rect.height / 2) === image,
                width: image.naturalWidth,
            }
        })
        assert.deepEqual(target, { hit: true, width: 1920 }, 'The full-resolution file must be the image under the pointer')
        assert.deepEqual(errors, [])
        const result = { engine, width, check: 'photo dwell upgrades the save target and aborts skipped transfers', passed: true }
        outcomes.push(result); console.log(JSON.stringify(result))
    } finally { await context.close() }
}

async function performanceCase(options) {
    const test = await openCase(options), { page, context, cdp, traffic, errors } = test
    try {
        if (!options.baseline) assert.equal(traffic.some(request => /\/PhotoLightbox-/.test(request.path)), false, 'Closed explorers must not download the viewer')
        const initialScripts = [...new Set(traffic.filter(request => request.type === 'script').map(request => request.path))]
        const initialBlockingMs = await page.evaluate(() => window.__visitor.tasks.reduce((sum, task) => sum + Math.max(0, task.duration - 50), 0))
        const before = cdp && Object.fromEntries((await cdp.send('Performance.getMetrics')).metrics.map(metric => [metric.name, metric.value]))
        const measured = await page.evaluate(async () => {
            const gaps = [], start = window.__visitor.tasks.length
            let blankCoverFrames = 0, visibleCoverSamples = 0
            let previous = performance.now(), frame
            const tick = now => {
                gaps.push(now - previous); previous = now
                let blank = false
                for (const cover of document.querySelectorAll('.catalog-section .album-card-image')) {
                    const rect = cover.getBoundingClientRect()
                    if (rect.right <= 0 || rect.left >= innerWidth || rect.bottom <= 0 || rect.top >= innerHeight) continue
                    visibleCoverSamples++
                    const image = cover.querySelector('img')
                    const ready = image?.complete && image.naturalWidth > 0 && Number(getComputedStyle(image).opacity) > .95
                    if (!ready && !cover.querySelector('.progressive-image-placeholder, canvas')) blank = true
                }
                if (blank) blankCoverFrames++
                frame = requestAnimationFrame(tick)
            }
            frame = requestAnimationFrame(tick)
            for (let step = 0; step < 32; step++) { scrollBy({ top: 160, behavior: 'instant' }); await new Promise(done => setTimeout(done, 80)) }
            await new Promise(done => setTimeout(done, 350)); cancelAnimationFrame(frame)
            gaps.sort((a, b) => a - b)
            return { p95FrameGapMs: gaps[Math.floor(gaps.length * .95)], maxFrameGapMs: Math.max(...gaps),
                blockingMs: window.__visitor.tasks.slice(start).reduce((sum, task) => sum + Math.max(0, task.duration - 50), 0),
                cards: document.querySelectorAll('.catalog-section .album-card').length, height: document.documentElement.scrollHeight,
                blankCoverFrames, visibleCoverSamples }
        })
        const after = cdp && Object.fromEntries((await cdp.send('Performance.getMetrics')).metrics.map(metric => [metric.name, metric.value]))
        const build = options.baseline ? baselineRoot : root
        let initialScriptGzipBytes = 0
        for (const path of initialScripts) {
            try { initialScriptGzipBytes += gzipSync(await readFile(resolve(build, '.' + path))).length } catch { /* Only built local scripts are counted. */ }
        }
        assert.equal(measured.cards, options.count)
        assert.deepEqual(errors, [])
        const result = { check: 'production-build scrolling comparison', engine, ...options, ...measured, initialBlockingMs, initialScriptGzipBytes,
            taskMs: cdp ? (after.TaskDuration - before.TaskDuration) * 1000 : null }
        outcomes.push(result); console.log(JSON.stringify(result))
    } finally { await context.close() }
}

async function stressCase(width, baseline = false) {
    const { page, context, errors, cdp } = await openCase({ width, count: 300, imageDelay: 60, baseline })
    try {
        const section = page.locator('.catalog-section').first(), row = section.locator('[data-scroll-row]')
        await section.scrollIntoViewIfNeeded()
        await page.waitForTimeout(900)
        const geometry = await page.evaluate(() => [...document.querySelectorAll('.catalog-section')].map(section => ({ y: section.offsetTop, height: section.offsetHeight, width: section.querySelector('[data-scroll-row]').scrollWidth })))
        // Deliberately jump entire rows, reverse repeatedly, and traverse both
        // axes. Keep all targets/geometry available even before images load.
        await page.evaluate(async () => {
            const sections = [...document.querySelectorAll('.catalog-section')]
            for (let round = 0; round < 2; round++) {
                for (const section of [...sections, ...sections.toReversed()]) {
                    section.scrollIntoView({ block: 'center', behavior: 'instant' })
                    const row = section.querySelector('[data-scroll-row]')
                    for (const left of [row.scrollWidth, 0, row.scrollWidth / 2, 0]) {
                        row.scrollLeft = left
                        await new Promise(done => requestAnimationFrame(done))
                    }
                }
            }
        })
        await page.waitForTimeout(500)
        assert.deepEqual(await page.evaluate(() => [...document.querySelectorAll('.catalog-section')].map(section => ({ y: section.offsetTop, height: section.offsetHeight, width: section.querySelector('[data-scroll-row]').scrollWidth }))), geometry, 'Fast swipes must not change row geometry')
        await section.scrollIntoViewIfNeeded()
        await row.evaluate(node => { node.scrollLeft = 0 })
        const bounds = await row.boundingBox()
        const point = { x: Math.min(width - 30, bounds.x + bounds.width / 2), y: Math.min(850, bounds.y + bounds.height / 2) }
        if (cdp) {
            for (const distance of [-1800, 1800]) await cdp.send('Input.synthesizeScrollGesture', {
                ...point, xDistance: distance, yDistance: 0, speed: 6000, preventFling: true,
                gestureSourceType: width < 500 ? 'touch' : 'mouse',
            })
        } else if (engine === 'webkit' && width < 500) {
            // Playwright does not expose mouse wheel input on mobile WebKit.
            // Exercise its native smooth scrolling and snapping; Chromium
            // separately covers real synthesized high-speed touch gestures.
            await row.evaluate(node => node.scrollBy({ left: 1800, behavior: 'smooth' }))
            await page.waitForTimeout(300)
            await row.evaluate(node => node.scrollBy({ left: -1800, behavior: 'smooth' }))
            await page.waitForTimeout(300)
        } else {
            await page.mouse.move(point.x, point.y)
            await page.mouse.wheel(1800, 0); await page.mouse.wheel(-1800, 0)
        }
        await row.evaluate(node => { node.scrollLeft = 0 })
        await page.waitForFunction(() => {
            const image = document.querySelector('.catalog-section .album-card-image img')
            return image?.complete && image.naturalWidth > 0
        })
        await page.waitForTimeout(250)
        assert.equal(await page.evaluate(() => [...document.querySelectorAll('.catalog-section .album-card-image')].filter(cover => {
            const rect = cover.getBoundingClientRect()
            if (rect.right <= 0 || rect.left >= innerWidth || rect.bottom <= 0 || rect.top >= innerHeight) return false
            const image = cover.querySelector('img')
            return !(image?.complete && image.naturalWidth) && !cover.querySelector('.progressive-image-placeholder, canvas')
        }).length), 0, 'Visible cards must retain an image or visual fallback after rapid reversals')
        if (evidence) await page.screenshot({ path: resolve(evidence, `${engine}-${width}-${baseline ? 'baseline' : 'candidate'}-gallery.png`), animations: 'disabled' })
        // Filter and sorting remain immediately usable, with exactly the same
        // albums; missing dates and curated ordering are covered in unit tests.
        await page.getByRole('combobox', { name: 'Filter Category 0 albums by year' }).click()
        await page.getByRole('option', { name: '2026', exact: true }).click()
        assert.equal(await section.locator('.album-card').count(), 15)
        await page.getByRole('combobox', { name: 'Sort sections' }).click()
        await page.getByRole('option', { name: 'Title: Z–A', exact: true }).click()
        assert.match(await page.locator('.catalog-section h3').first().innerText(), /Category 9/)
        await page.getByRole('combobox', { name: 'Sort sections' }).click()
        await page.getByRole('option', { name: 'Curated order', exact: true }).click()
        // Focus on an offscreen card must reveal and navigate it normally.
        await row.evaluate(node => { node.scrollLeft = node.scrollWidth })
        const link = section.locator('.album-card').last()
        await link.focus()
        await page.waitForTimeout(400)
        const saved = await page.evaluate(() => ({ y: scrollY, x: document.querySelector('.catalog-section [data-scroll-row]').scrollLeft }))
        await link.press('Enter')
        await page.waitForURL('**/album/**')
        await page.getByRole('heading', { name: /Album / }).first().waitFor()
        await page.goBack()
        await page.locator('.catalog-section').first().waitFor()
        await page.waitForTimeout(800)
        const restored = await page.evaluate(() => ({ y: scrollY, x: document.querySelector('.catalog-section [data-scroll-row]').scrollLeft }))
        assert.ok(Math.abs(restored.x - saved.x) <= 2, `Horizontal restoration ${saved.x} → ${restored.x}`)
        assert.ok(Math.abs(restored.y - saved.y) <= 2, `Vertical restoration ${saved.y} → ${restored.y}`)
        assert.deepEqual(errors, [])
        const result = { engine, width, baseline, check: '300 albums: rapid two-axis reversal, stable geometry, filters, sort, offscreen focus and history restoration', passed: true }
        outcomes.push(result); console.log(JSON.stringify(result))
    } finally { await context.close() }
}

async function viewerCase(width, failModule = false, kind = 'random') {
    const exerciseActions = !failModule && kind === 'random'
    const { page, context, errors, traffic } = await openCase({ width, moduleDelay: exerciseActions ? 3000 : 1800, failModule })
    try {
        const trigger = page.getByRole('button', { name: kind === 'random' ? 'Explore Random Photos' : 'Explore Featured Photos', exact: true })
        // A first real click has only pointer/focus lead time; the artificial
        // module delay keeps the cold-loading path exercised regardless.
        await trigger.click()
        const dialog = page.getByRole('dialog', { name: `${kind === 'random' ? 'Random' : 'Featured'} photos from Ian Truong Photography` })
        await dialog.waitFor()
        await page.getByRole('img', { name: 'Fixture photograph 1', exact: true }).waitFor()
        await page.waitForFunction(() => [...document.querySelectorAll('[role="dialog"] img')].some(image => image.complete && image.naturalWidth > 0))
        const frame = dialog.locator('.linen-lightbox-photo-frame:not(.is-outgoing):not(.is-hidden)')
        if (width < 500) {
            await frame.and(page.locator('.is-loaded')).evaluate(element => Promise.allSettled(
                element.getAnimations().filter(animation => animation.transitionProperty === 'transform').map(animation => animation.finished),
            ))
        }
        const pendingBounds = await frame.boundingBox()
        assert.equal(await page.getByRole('button', { name: 'Close photo viewer', exact: true }).evaluate(node => node === document.activeElement), true)
        await page.keyboard.press('ArrowRight'); await page.keyboard.press('ArrowLeft')
        if (!failModule && kind === 'featured') {
            await page.locator('.linen-lightbox-photo-frame:not(.is-outgoing)').first().click()
            await page.waitForTimeout(2200)
            assert.equal(await page.locator('.linen-lightbox-photo-frame.is-zoomed').count(), 1)
            await page.locator('.linen-lightbox-photo-frame.is-zoomed').click()
            await page.getByRole('button', { name: 'Share photo', exact: true }).click()
            await page.waitForFunction(() => window.__visitor.sharedUrl?.includes('?photo='))
            // Mobile intentionally hides the toolbar's text labels; the
            // copied feedback state still must hold enhancement until reset.
            await page.waitForFunction(() => document.querySelector('.linen-lightbox-share')?.textContent.includes('Link Copied'))
            // No download, checkout or keyboard event should be needed to
            // enhance the viewer once copied-link feedback has finished.
            await page.locator('.explorer-viewer-pending').waitFor({ state: 'hidden' })
        }
        if (exerciseActions) {
            await page.locator('.linen-lightbox-photo-frame:not(.is-outgoing)').first().click()
            await page.waitForTimeout(3250)
            assert.equal(await page.locator('.linen-lightbox-photo-frame.is-zoomed').count(), 1, 'Code readiness must not reset an active zoom')
            await page.locator('.linen-lightbox-photo-frame.is-zoomed').click()
            await page.getByRole('button', { name: 'Share photo', exact: true }).click()
            await page.waitForFunction(() => window.__visitor.sharedUrl?.includes('?photo='))
            const downloadPromise = page.waitForEvent('download')
            await page.getByRole('button', { name: 'Download photo', exact: true }).click()
            assert.equal(await (await downloadPromise).failure(), null)
            assert.equal(await page.locator('.explorer-viewer-pending').count(), 1, 'Print must exercise the cold-code path')
            const printLink = page.getByRole('link', { name: 'Order a print of this photo', exact: true })
            const expectedCheckout = await printLink.getAttribute('href')
            const popup = page.waitForEvent('popup')
            await printLink.click()
            const orderPage = await popup
            await orderPage.getByRole('heading', { name: 'Fixture print options' }).waitFor()
            assert.equal(orderPage.url(), expectedCheckout)
            const checkout = new URL(orderPage.url())
            assert.equal(checkout.searchParams.get('apiid'), 'HQ1RAJ10HOD')
            assert.match(checkout.searchParams.get('import'), /\/albums\/.+\/original\/photo-\d+\.jpg$/)
            await orderPage.close()
            assert.equal(await page.getByRole('dialog').isVisible(), true)
        }
        if (failModule) {
            await page.getByRole('alert').filter({ hasText: 'Photo controls could not be loaded' }).waitFor()
            await page.getByRole('button', { name: 'Try again', exact: true }).click()
        }
        await page.locator('.explorer-viewer-pending').waitFor({ state: 'hidden' })
        await page.getByRole('button', { name: 'Download photo', exact: true }).waitFor()
        const readyBounds = await frame.boundingBox()
        for (const dimension of ['x', 'y', 'width', 'height']) assert.ok(Math.abs(pendingBounds[dimension] - readyBounds[dimension]) <= 2, `Photo ${dimension} shifted on viewer handoff`)
        if (exerciseActions && width < 500) {
            const original = page.viewportSize()
            for (const viewport of [{ width: 320, height: 568 }, { width: 844, height: 390 }]) {
                await page.setViewportSize(viewport)
                const [print, share, download] = await dialog.evaluate(element => ['print', 'share', 'download'].map(action => {
                    const rect = element.querySelector(`.linen-lightbox-${action}`).getBoundingClientRect()
                    return [rect.width, rect.height, rect.top].map(Math.round)
                }))
                assert.deepEqual(print, share, 'Print matches the size and alignment of Share')
                assert.deepEqual(print, download, 'Print matches the size and alignment of Download')
                assert.ok(print[0] >= 44 && print[1] >= 44, 'Print has a 44px touch target')
            }
            await page.setViewportSize(original)
        }
        for (let step = 0; step < 12; step++) await page.keyboard.press(step % 2 ? 'ArrowLeft' : 'ArrowRight')
        await page.keyboard.press('Tab')
        assert.equal(await dialog.evaluate(node => node.contains(document.activeElement)), true, 'Focus remains in the viewer after the code handoff')
        await page.keyboard.press('Escape'); await dialog.waitFor({ state: 'hidden' })
        assert.equal(await trigger.evaluate(node => node === document.activeElement), true, 'Closing restores the trigger focus')
        await trigger.click(); await page.getByRole('button', { name: 'Download photo', exact: true }).waitFor()
        await page.keyboard.press('Escape')
        assert.deepEqual(errors, [])
        const result = { engine, width, failModule, kind, pendingBounds, readyBounds,
            check: 'cold click: delayed/failed module, photo display, rapid navigation, handoff focus, escape and reopen', passed: true }
        outcomes.push(result); console.log(JSON.stringify(result))
    } finally { await context.close() }
}

async function slowPhotoCardMotionCase(width, delay) {
    const { context, page, cdp } = await openCase({ width })
    let release
    try {
        if (cdp) await cdp.send('Emulation.setCPUThrottlingRate', { rate: 1 })
        const { items: [album], photos: [photo] } = fixture(1)
        if (delay === 'photo') {
            photo.url = `https://${mediaDomain}/slow-viewer-photo.webp`
            delete photo.previewSrcSet
            await page.route(`**/public/albums/${album.albumId}`, route => route.fulfill({ json: { album, images: [photo] } }))
        }
        const delayed = delay === 'photo' ? /\/slow-viewer-photo\.webp$/ : /\/lightboxMotion-[^/]+\.js$/
        const pending = new Promise(resolve => { release = resolve })
        await page.route(delayed, async route => {
            await pending
            await route.fallback()
        })
        await page.goto(origin + '/album/' + album.albumId)
        const tile = page.locator('[data-lightbox-item]').first()
        await tile.evaluate(element => element.scrollIntoView({ block: 'center', behavior: 'instant' }))
        const request = page.waitForRequest(request => delayed.test(new URL(request.url()).pathname))
        await tile.click()
        await request
        const dialog = page.getByRole('dialog')
        await dialog.waitFor()
        // Hold the request longer than the previous cutoff for this phase.
        await page.waitForTimeout(delay === 'photo' ? 1500 : 400)
        const waiting = await dialog.evaluate(element => element.hasAttribute('data-lightbox-awaiting'))
        assert.ok(waiting, `The viewer preserves the transition while the ${delay} is still loading`)
        const flight = dialog.locator('.lightbox-motion-flight')
        if (delay === 'motion module') {
            await dialog.getByRole('button', { name: 'Close photo viewer' }).click()
            await dialog.waitFor({ state: 'detached' })
            await tile.click()
            await dialog.waitFor()
        }
        release()
        await flight.waitFor()
        assert.ok(await flight.evaluate(element => element.getAnimations().some(animation => {
            const frames = animation.effect.getKeyframes()
            return frames[0].transform && frames[0].transform !== frames.at(-1).transform
        })), 'The photo travels from its card when the viewer is ready')
        await flight.waitFor({ state: 'detached' })
        await page.keyboard.press('Escape')
        await flight.waitFor()
        await dialog.waitFor({ state: 'detached' })
        assert.ok(await tile.evaluate(element => document.activeElement === element), 'Closing returns focus to the card')
        const result = { engine, width, check: `photo card opens and returns after a slow ${delay} request`, passed: true }
        outcomes.push(result); console.log(JSON.stringify(result))
    } finally { release?.(); await context.close() }
}

async function lightboxStabilityCase(width) {
    const { context, page, cdp } = await openCase({ width })
    try {
        if (cdp) await cdp.send('Emulation.setCPUThrottlingRate', { rate: 1 })
        const { items } = fixture(85)
        const dialog = page.getByRole('dialog')
        const flight = page.locator('.lightbox-motion-flight')
        await page.goto(origin + '/album/' + items[0].albumId)
        const tiles = page.locator('[data-lightbox-item]')
        const tile = tiles.nth(3)
        const hiddenTiles = page.locator('[data-lightbox-item][data-lightbox-motion-source]')
        await tile.evaluate(element => element.scrollIntoView({ block: 'center', behavior: 'instant' }))
        await page.waitForFunction(() => {
            const tiles = document.querySelectorAll('[data-lightbox-item]')
            return [2, 3, 4].every(index => tiles[index]?.matches('.editorial-timeline, .is-motion-visible'))
        })
        // Sample adjacent tiles. The activated tile has its own hover and morph.
        const pose = () => page.evaluate(() => {
            const tiles = document.querySelectorAll('[data-lightbox-item]')
            return {
                scroll: window.scrollY,
                tiles: [2, 4].map(index => {
                    const { x, y } = tiles[index].getBoundingClientRect()
                    return { x, y }
                }),
            }
        })
        if (width >= 500) await tile.hover()
        await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))))
        const before = await pose()
        assert.ok(before.scroll > 0, 'The gallery must be scrolled to exercise scroll restoration')
        if (width < 500 && engine !== 'firefox') await tile.tap()
        else {
            // Use the existing pointer position so the automation does not scroll the transformed tile again.
            const { x, y, width, height } = await tile.boundingBox()
            await page.mouse.click(x + width / 2, y + height / 2)
        }
        await dialog.waitFor()
        await flight.waitFor()
        const entrance = await flight.evaluate(element => {
            const animation = element.getAnimations().find(item => item.effect.getKeyframes()[0].transform)
            const image = element.querySelector('.lightbox-motion-crop > img')
            const imageAnimation = image?.getAnimations()[0]
            if (!animation || !image) return null
            const readScale = node => {
                const transform = getComputedStyle(node).transform
                return transform === 'none' ? new DOMMatrixReadOnly() : new DOMMatrixReadOnly(transform)
            }
            const transforms = [animation, imageAnimation].filter(Boolean)
            const originalTimes = transforms.map(item => item.currentTime)
            transforms.forEach(item => item.pause())
            const sizes = [.15, .45, .8, 1].map(progress => {
                transforms.forEach(item => { item.currentTime = item.effect.getTiming().duration * progress })
                const shellScale = readScale(element)
                const imageScale = readScale(image)
                return {
                    layout: [element.offsetWidth, element.offsetHeight],
                    distortion: Math.abs((shellScale.a * imageScale.a) / (shellScale.d * imageScale.d) - 1),
                }
            })
            transforms.forEach((item, index) => { item.currentTime = originalTimes[index]; item.play() })
            return { sizes, frames: animation.effect.getKeyframes() }
        })
        assert.ok(entrance, 'The photo entrance uses a fixed-size crop and moves with transforms')
        assert.ok(entrance.frames.every(frame => ['width', 'height', 'top', 'left'].every(key => !(key in frame))))
        assert.equal(new Set(entrance.sizes.map(({ layout }) => layout.join('x'))).size, 1,
            'The viewer does not lay out the photo at a different size each frame')
        assert.ok(entrance.sizes.every(({ distortion }) => distortion < .01), 'The changing crop keeps the photo in proportion')
        assert.equal(await hiddenTiles.count(), 0, 'The dimmed grid stays intact during the opening motion')
        const controls = await dialog.evaluate(element => {
            const reveal = element.getAnimations().find(animation => animation.effect.getKeyframes()
                .some(frame => '--lightbox-controls-opacity' in frame))
            const { delay, duration } = reveal.effect.getTiming()
            reveal.pause()
            const sample = () => [...element.querySelectorAll('.linen-lightbox-previous, .linen-lightbox-next, .linen-lightbox-metadata, .linen-lightbox-actions')]
                .map(control => Number(getComputedStyle(control).opacity))
            reveal.currentTime = delay / 2
            const early = sample()
            reveal.currentTime = delay + duration / 2
            const during = sample()
            reveal.finish()
            return { early, during }
        })
        assert.equal(controls.early.length, 4, 'Exercise both arrows, EXIF, and the action row')
        assert.ok(controls.early.every(value => value === 0), 'Viewer controls stay hidden while the photo moves')
        assert.ok(controls.during.every(value => value > 0 && value < 1), 'Viewer controls fade in together')
        if (engine !== 'webkit' || width >= 500) await page.mouse.wheel(0, 320)
        await flight.waitFor({ state: 'detached' })
        const opened = await pose()
        assert.equal(opened.scroll, before.scroll, 'The modal lock preserves the viewport scroll offset')
        for (const [index, position] of opened.tiles.entries()) {
            const xShift = Math.abs(position.x - before.tiles[index].x)
            const yShift = Math.abs(position.y - before.tiles[index].y)
            assert.ok(xShift < 1 && yShift < 1, `Neighboring card shifted by ${xShift}px horizontally and ${yShift}px vertically`)
        }
        await page.keyboard.press('ArrowRight')
        await dialog.getByText('5 / 6', { exact: true }).waitFor()
        const crossfade = await page.waitForFunction(() => {
            const frames = document.querySelectorAll('.linen-photo-lightbox .linen-lightbox-photo-frame')
            const fades = [...frames].map(frame => frame.getAnimations().find(animation => animation.transitionProperty === 'opacity'))
            if (fades.length === 2 && fades.every(Boolean)) {
                return {
                    fades: fades.map(animation => ({ duration: animation.effect.getTiming().duration, start: animation.startTime })),
                    isolation: getComputedStyle(frames[0].parentElement).isolation,
                    blend: getComputedStyle(frames[1]).mixBlendMode,
                }
            }
        })
        const { fades: [outgoingFade, incomingFade], isolation, blend } = await crossfade.jsonValue()
        assert.equal(outgoingFade.duration, 400)
        assert.equal(incomingFade.duration, outgoingFade.duration)
        assert.equal(incomingFade.start, outgoingFade.start, 'The two fades start together')
        assert.equal(isolation, 'isolate')
        assert.equal(blend, 'plus-lighter', 'The photo opacities add together without blending with the gallery underneath')
        assert.equal(await hiddenTiles.count(), 0, 'Navigating leaves the background thumbnails in place')
        await page.keyboard.press('ArrowLeft')
        await dialog.getByText('4 / 6', { exact: true }).waitFor()
        assert.equal(await hiddenTiles.count(), 0)
        await dialog.locator('.linen-lightbox-photo-frame.is-loaded:not(.is-outgoing)').waitFor()
        await dialog.locator('.linen-lightbox-photo-frame.is-outgoing').waitFor({ state: 'detached' })
        await page.keyboard.press('Escape')
        await flight.waitFor()
        const landing = await flight.evaluate(element => {
            const animations = element.getAnimations().map(animation => ({
                frames: animation.effect.getKeyframes(), duration: animation.effect.getTiming().duration,
            }))
            const movement = animations.find(animation => 'width' in animation.frames[0] || 'transform' in animation.frames[0])
            const fade = animations.find(animation => animation.frames[0].opacity !== undefined)
            const { left, top, width, height, transform } = movement.frames.at(-1)
            const matrix = transform && new DOMMatrixReadOnly(transform)
            const { style } = element
            const rect = matrix ? [
                parseFloat(style.left) + matrix.e, parseFloat(style.top) + matrix.f,
                parseFloat(style.width) * matrix.a, parseFloat(style.height) * matrix.d,
            ] : [left, top, width, height].map(Number.parseFloat)
            return { rect, transformOnly: Boolean(transform) && movement.frames.every(frame => !('width' in frame || 'height' in frame)),
                stillMs: fade.duration - movement.duration, opacity: fade.frames.map(frame => Number(frame.opacity)) }
        })
        const crop = await tile.locator('img').evaluate(element => {
            const { left, top, width, height } = element.getBoundingClientRect()
            return [left, top, width, height]
        })
        assert.ok(landing.rect.every((value, index) => Math.abs(value - crop[index]) < 1), 'The return lands on the thumbnail crop inside the card')
        if (width < 500 && engine !== 'firefox') assert.ok(landing.transformOnly, 'Touch returns do not resize the photo layer')
        assert.ok(landing.stillMs >= 80, 'The thumbnail stays at its final size through the last part of the dissolve')
        assert.deepEqual(landing.opacity, [1, 1, 0], 'The returning photo and frame dissolve together onto the existing thumbnail')
        assert.equal(await hiddenTiles.count(), 0)
        await dialog.waitFor({ state: 'hidden' })
        assert.equal(await hiddenTiles.count(), 0)
        assert.equal((await pose()).scroll, before.scroll)

        if (width < 500) {
            const offscreenTile = tiles.nth(5)
            await offscreenTile.evaluate(async element => {
                const offset = Math.min(0, element.getBoundingClientRect().top - innerHeight - 24)
                if (offset) window.scrollBy({ top: offset, behavior: 'instant' })
                await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))
            })
            const offscreenPose = await pose()
            await tile.tap()
            await dialog.locator('.linen-lightbox-photo-frame.is-loaded').waitFor()
            await flight.waitFor({ state: 'detached' })
            await page.keyboard.press('ArrowRight')
            await page.keyboard.press('ArrowRight')
            await dialog.getByText('6 / 6', { exact: true }).waitFor()
            assert.ok(await offscreenTile.evaluate(element => element.getBoundingClientRect().top >= innerHeight),
                'The selected thumbnail is fully below the viewport')
            await dialog.locator('.linen-lightbox-photo-frame.is-loaded:not(.is-outgoing)').waitFor()
            await dialog.locator('.linen-lightbox-photo-frame.is-outgoing').waitFor({ state: 'detached' })
            await page.keyboard.press('Escape')
            const dissolve = dialog.and(page.locator('[data-lightbox-dissolving]'))
            await dissolve.waitFor({ state: 'attached' })
            const fadeDuration = await dissolve.evaluate(element => element.getAnimations()
                .find(animation => animation.effect.getKeyframes().some(frame => Number(frame.opacity) === 0)).effect.getTiming().duration)
            assert.equal(fadeDuration, 360, 'An offscreen thumbnail gets the softer dissolve')
            assert.equal(await flight.count(), 0)
            await dialog.waitFor({ state: 'hidden' })
            assert.equal((await pose()).scroll, offscreenPose.scroll)
        }

        await page.goto(origin + '/')
        const featured = page.getByRole('button', { name: 'Explore Featured Photos', exact: true })
        await featured.hover()
        await featured.click()
        const assertPhotoOnly = async (closing = false) => {
            await flight.waitFor()
            const layers = await flight.evaluate(element => {
                const animations = element.getAnimations()
                const fade = animations.find(animation => animation.effect.getKeyframes()[0].opacity !== undefined)
                return {
                    label: element.querySelector('span')?.textContent,
                    keyframes: animations.flatMap(animation => animation.effect.getKeyframes()),
                    surface: getComputedStyle(element.querySelector('.lightbox-motion-crop') ?? element).backgroundColor,
                    fade: fade.effect.getTiming(),
                }
            })
            assert.equal(layers.label, undefined, 'The button label should stay on the page')
            assert.ok(layers.keyframes.some(frame => Number(frame.opacity) === 0), 'The entire image frame fades with the picture')
            const surfaces = [layers.surface, ...layers.keyframes.filter(frame => 'backgroundColor' in frame).map(frame => frame.backgroundColor)]
            assert.ok(surfaces.every(color => color === 'rgba(0, 0, 0, 0)'), 'A text button has no filled flying box')
            if (closing) {
                assert.ok(layers.fade.duration >= 400 && layers.fade.delay === 0, 'Button launches close with an immediate, gradual fade')
                const hiddenAt = layers.keyframes.find(frame => Number(frame.opacity) === 0)?.computedOffset
                assert.ok(hiddenAt > .85 && hiddenAt < 1, 'The photo stays visible through the return')
            }
        }
        await assertPhotoOnly()
        await flight.waitFor({ state: 'detached' })
        await page.keyboard.press('Escape')
        await assertPhotoOnly(true)
        await dialog.waitFor({ state: 'hidden' })
        const result = { engine, width, check: 'lightbox keeps the grid intact, blends the photo back, and animates photo-only button morphs', passed: true }
        outcomes.push(result); console.log(JSON.stringify(result))
    } finally { await context.close() }
}

async function videoLightboxFrameCase(width) {
    const { context, page, cdp } = await openCase({ width })
    let releaseVideo
    try {
        if (cdp) await cdp.send('Emulation.setCPUThrottlingRate', { rate: 1 })
        const { items, photos } = fixture(1)
        const album = { ...items[0], type: 'video', imageCount: 2 }
        const clips = photos.slice(0, 2).map(clip => ({ ...clip, width: 1920, height: 1080, url: `https://${mediaDomain}/fixture-video.mp4` }))
        await page.route(`**/public/albums/${album.albumId}`, route => route.fulfill({ json: { album, images: clips } }))
        const pendingMedia = new Promise(resolve => { releaseVideo = resolve })
        await page.route('**/fixture-video.mp4', async route => { await pendingMedia; await route.abort() })
        await page.goto(`${origin}/video/${album.albumId}`)
        const tile = page.locator('main [data-lightbox-item]').first()
        await tile.locator('img.progressive-image-ready').waitFor({ state: 'attached' })
        await tile.evaluate(element => element.scrollIntoView({ block: 'center', behavior: 'instant' }))
        await tile.click()
        const flight = page.locator('.linen-video-lightbox .lightbox-motion-flight')
        await flight.waitFor({ state: 'attached' })
        const landing = await flight.evaluate((element, ratio) => {
            const dialog = element.closest('.linen-video-lightbox')
            const video = dialog.querySelector('video')
            const box = video.getBoundingClientRect()
            const width = Math.min(box.width, box.height * ratio)
            const height = Math.min(box.height, box.width / ratio)
            const animations = element.getAnimations()
            const travel = animations.find(animation => animation.effect.getKeyframes()[0].width !== undefined)
            const chrome = dialog.getAnimations().find(animation => animation.effect.getKeyframes()[0]['--lightbox-controls-opacity'] !== undefined)
            const close = dialog.querySelector('.linen-lightbox-close')
            const closeFade = close.getAnimations().find(animation => animation.effect.getKeyframes()[0].opacity !== undefined)
            const chromeTiming = chrome.effect.getTiming()
            const controls = ['.site-video-controls', '.linen-lightbox-actions', '.linen-lightbox-previous', '.linen-lightbox-next']
                .map(selector => dialog.querySelector(selector)).concat(close)
            const originalChromeTime = chrome.currentTime
            const originalCloseTime = closeFade.currentTime
            const sample = time => {
                chrome.currentTime = closeFade.currentTime = time
                return controls.map(control => Number(getComputedStyle(control).opacity))
            }
            const beforeChrome = sample(chromeTiming.delay - 1)
            const earlyChrome = sample(chromeTiming.delay + chromeTiming.duration / 4)
            const endChrome = sample(chromeTiming.delay + chromeTiming.duration)
            chrome.currentTime = originalChromeTime
            closeFade.currentTime = originalCloseTime
            const end = travel.effect.getKeyframes().at(-1)
            return { actual: [end.left, end.top, end.width, end.height].map(Number.parseFloat), nativeWidth: video.videoWidth,
                fitted: [box.left + (box.width - width) / 2, box.top + (box.height - height) / 2, width, height],
                slot: [box.width, box.height], travel: travel.effect.getTiming().duration, chromeTiming, beforeChrome, earlyChrome, endChrome }
        }, clips[0].width / clips[0].height)
        assert.equal(landing.nativeWidth, 0, 'The fixture arrives before playback metadata')
        assert.ok(landing.fitted[2] < landing.slot[0] || landing.fitted[3] < landing.slot[1], 'The fixture exercises letterboxing')
        assert.ok(landing.actual.every((value, index) => Math.abs(value - landing.fitted[index]) < .25), JSON.stringify(landing))
        assert.ok(landing.chromeTiming.delay > landing.travel && landing.chromeTiming.duration >= 230,
            'Controls ease in after the still lands')
        assert.ok(landing.beforeChrome.every(value => value === 0), JSON.stringify(landing))
        assert.ok(landing.earlyChrome.every(value => value > 0 && value < .25), JSON.stringify(landing))
        assert.ok(landing.endChrome.every(value => value === 1), JSON.stringify(landing))
        await page.waitForFunction(() => getComputedStyle(document.querySelector('.site-video-controls')).opacity === '1')
        assert.equal(await flight.evaluate(element => getComputedStyle(element).opacity), '1', 'The still holds while the video buffers')
        const video = page.locator('.linen-video-lightbox video')
        assert.equal(await video.evaluate(element => getComputedStyle(element).opacity), '0')
        const handoff = await flight.evaluate(async element => {
            const video = element.parentElement.querySelector('video')
            Object.defineProperty(video, 'readyState', { configurable: true, value: video.HAVE_CURRENT_DATA })
            video.dispatchEvent(new Event('loadeddata'))
            await Promise.resolve()
            const still = element.getAnimations().find(animation => animation.effect.getKeyframes()[0].opacity !== undefined)
            const playback = video.getAnimations().find(animation => animation.effect.getKeyframes()[0].opacity !== undefined)
            const image = element.querySelector('img')
            const soften = image.getAnimations().find(animation => animation.effect.getKeyframes()[0].filter !== undefined)
            const duration = still.effect.getTiming().duration
            const samples = [0, .15, .35, .5, .7, .9, 1].map(progress => {
                still.currentTime = playback.currentTime = soften.currentTime = duration * progress
                return { still: Number(getComputedStyle(element).opacity), video: Number(getComputedStyle(video).opacity),
                    blur: Number.parseFloat(getComputedStyle(image).filter.match(/blur\(([\d.]+)/)?.[1] ?? 0) }
            })
            still.currentTime = playback.currentTime = soften.currentTime = 0
            return samples
        })
        assert.deepEqual(handoff[0], { still: 1, video: 1, blur: 0 })
        assert.ok(handoff.every(sample => sample.video === 1), 'An opaque video covers the player background throughout the dissolve')
        assert.ok(handoff.some(sample => sample.still > .2 && sample.still < .8 && sample.blur > 3),
            'The still softens while blending into playback')
        assert.equal(handoff.at(-1).still, 0)
        await flight.waitFor({ state: 'detached' })
        assert.equal(await video.evaluate(element => getComputedStyle(element).opacity), '1')

        await page.keyboard.press('Escape')
        await video.waitFor({ state: 'detached' })
        await tile.click()
        await flight.waitFor({ state: 'attached' })
        await page.getByRole('button', { name: 'Next video' }).click()
        await flight.waitFor({ state: 'detached' })
        assert.equal(await video.getAttribute('aria-label'), clips[1].altText, 'Switching videos cancels a waiting handoff')
        const result = { engine, width, check: 'video handoff keeps the fitted frame covered as the still softens into playback', passed: true }
        outcomes.push(result); console.log(JSON.stringify(result))
    } finally { releaseVideo?.(); await context.close() }
}

async function exploreHandoffCase(width) {
    const { context, page, cdp } = await openCase({ width })
    let releaseThumbnail
    let releaseInitialResults
    try {
        if (cdp) await cdp.send('Emulation.setCPUThrottlingRate', { rate: 1 })
        const { photos } = fixture(1)
        const initialResults = new Promise(resolve => { releaseInitialResults = resolve })
        const headers = { 'access-control-allow-origin': '*' }
        await page.route('**/public/explore?*', async route => {
            const query = new URL(route.request().url()).searchParams
            if (query.get('mode') === 'times') {
                return route.fulfill({ headers, json: { items: ['dawn', 'evening', 'night'].map(id => ({ id, photos: 1 })),
                    initialPage: { value: 'dawn', items: [photos[0]], nextCursor: null } } })
            }
            if (query.get('value') === 'night') {
                await initialResults
                return route.fulfill({ headers, json: { items: [photos[0]], nextCursor: null } })
            }
            return route.fulfill({ headers, json: { items: [photos[1]], nextCursor: null } })
        })
        const blockedThumbnail = new Promise(resolve => { releaseThumbnail = resolve })
        await page.route('**/photos/photo-1-*.webp', async route => { await blockedThumbnail; await route.fallback() })
        await page.goto(`${origin}/explore/time-of-day?period=night`)
        await page.getByText('Updating photographs…').waitFor({ state: 'attached' })
        assert.equal(await page.locator('.explore-loading, .explore-results-note').count(), 0, 'The first pending results have no visible loading text or panel')
        releaseInitialResults()
        await page.locator('.explore-grid--current img.progressive-image-ready').waitFor({ state: 'attached' })

        await page.goto(`${origin}/explore/time-of-day?period=dawn`)
        const current = page.locator('.explore-grid--current')
        const staged = page.locator('.explore-grid--staged')
        await current.locator('img.progressive-image-ready').waitFor({ state: 'attached' })
        const top = locator => locator.evaluate(element => element.getBoundingClientRect().top + scrollY)
        const before = await top(current)
        await page.getByRole('button', { name: /^Evening/ }).click()
        await staged.waitFor({ state: 'attached' })
        await current.evaluate(element => element.scrollIntoView({ block: 'center', behavior: 'instant' }))
        const loading = await current.evaluate(element => ({ opacity: getComputedStyle(element).opacity,
            stagedVisibility: getComputedStyle(element.parentElement.querySelector('.explore-grid--staged')).visibility,
            photo: element.firstElementChild.getAttribute('data-lightbox-item') }))
        assert.deepEqual(loading, { opacity: '1', stagedVisibility: 'hidden', photo: photos[0].id })
        assert.equal(await page.locator('.explore-results-note').count(), 0, 'Filtering retains the results without inserting a loading panel')
        assert.equal((await page.locator('.explore-result-label > span').innerText()).toLowerCase(), 'dawn')
        assert.ok(Math.abs(await top(current) - before) < 1)
        releaseThumbnail()
        const dissolve = current.locator('.explore-photo-image > .explore-photo-dissolve')
        await dissolve.waitFor({ state: 'attached' })
        assert.equal(await page.locator('.explore-results-stage > .explore-grid').count(), 1, 'Only one card frame is painted during the dissolve')
        assert.equal(await current.locator('.progressive-image-ready').count(), 1, 'The photo dissolves directly into its decoded replacement')
        assert.equal(await current.evaluate(element => getComputedStyle(element).opacity), '1')
        await dissolve.waitFor({ state: 'detached' })
        assert.equal(await current.locator('[data-lightbox-item]').getAttribute('data-lightbox-item'), photos[1].id)
        assert.ok(Math.abs(await top(current) - before) < 1)

        await page.route(url => url.pathname.endsWith('/public/random-photos'), route => route.fulfill({ headers, json: {
            images: [photos[0], { ...photos[1], width: 1280, height: 1920 }],
        } }))
        await page.addInitScript(() => { Math.random = () => .55 })
        await page.goto(`${origin}/explore/guess-settings`)
        const choice = page.locator('.explore-game-options button').first()
        await choice.scrollIntoViewIfNeeded()
        const skip = page.getByRole('button', { name: 'Skip photograph' })
        const skipGap = await skip.evaluate(element =>
            element.getBoundingClientRect().top - document.querySelector('.explore-game-options').getBoundingClientRect().bottom)
        assert.ok(skipGap >= 0 && skipGap <= 20, 'Skip photograph sits directly below the choices')
        const beforeSkip = await top(skip)
        assert.match(await page.locator('.explore-game-prompt h2').innerText(), /Which ISO/)
        await page.evaluate(() => { Math.random = () => .3 })
        const departure = await skip.evaluate(button => {
            const round = document.querySelector('.explore-game-round')
            button.click()
            return round.getAnimations().some(animation => animation.effect.getKeyframes().at(-1)?.opacity === '0')
        })
        assert.ok(departure, 'The outgoing question and choices fade out before replacement')
        const newRound = page.locator('.explore-game-round[data-round="1"]')
        await newRound.waitFor({ state: 'attached' })
        const arrival = await newRound.evaluate(element => element.getAnimations()
            .find(animation => animation.animationName === 'explore-round-in')?.effect.getKeyframes()[0]?.opacity)
        assert.equal(arrival, '0')
        assert.match(await newRound.locator('h2').innerText(), /Which shutter speed/)
        assert.ok(Math.abs(await top(skip) - beforeSkip) < 1, 'Skip stays put across prompts of different lengths and different photo orientations')
        await newRound.evaluate(element => Promise.allSettled(element.getAnimations().map(animation => animation.finished)))
        const sample = () => page.evaluate(() => [...document.querySelectorAll('.explore-game-score, .explore-game-question h2, .explore-game-options')]
            .map(element => element.getBoundingClientRect().top + scrollY))
        const beforeGuess = await sample()
        await choice.click()
        const answer = page.locator('.explore-game-answer')
        await answer.waitFor()
        assert.ok((await sample()).every((position, i) => Math.abs(position - beforeGuess[i]) < 1),
            'The score, question and choices stay in place when the answer appears')
        const reveal = await answer.evaluate(element => {
            const animation = element.getAnimations().find(entry => entry.animationName === 'explore-answer-in')
            return animation && { timing: animation.effect.getTiming().duration, from: animation.effect.getKeyframes()[0].opacity }
        })
        assert.equal(reveal?.from, '0')
        assert.ok(reveal.timing >= 300)
        const result = { engine, width, check: 'Explore suppresses loading flashes, dissolves decoded photos, and transitions quiz rounds with a fixed Skip position', passed: true }
        outcomes.push(result); console.log(JSON.stringify(result))
    } finally { releaseInitialResults?.(); releaseThumbnail?.(); await context.close() }
}

async function mobileAlbumHeaderCase() {
    const { context, page } = await openCase({ width: 390 })
    try {
        await page.setViewportSize({ width: 390, height: 635 })
        const album = fixture(1).items[0]
        for (const route of ['album', 'video']) {
            await page.goto(origin + '/' + route + '/' + album.albumId)
            await page.getByRole('heading', { name: album.title, exact: true }).waitFor()
            const details = page.locator('details.linen-album-details')
            assert.equal(await details.evaluate(element => element.open), false)
            const firstMedia = page.locator('[data-lightbox-grid] [data-lightbox-item]').first()
            await firstMedia.locator('img').evaluate(image => image.decode())
            assert.ok(await firstMedia.evaluate(element => element.getBoundingClientRect().bottom <= innerHeight),
                'The first media card fits in the initial small phone viewport')
            const share = page.getByRole('button', { name: 'Share Album' })
            assert.equal(await share.count(), 0)
            await details.locator('summary').click()
            await share.waitFor({ state: 'visible' })
            await page.getByRole('button', { name: 'Download All', exact: true }).waitFor({ state: 'visible' })
            await details.locator('summary').click()
            await share.waitFor({ state: 'hidden' })
        }
        outcomes.push({ name: 'mobile-album-header', width: 390 })
    } finally { await context.close() }
}

async function mobileScrollAndAutoplayCase() {
    const { context, page, cdp, traffic, errors } = await openCase({ width: 390, albumPreview: true })
    try {
        if (cdp) await cdp.send('Emulation.setCPUThrottlingRate', { rate: 1 })
        const albumId = fixture(1).items[0].albumId
        const card = page.locator(`.catalog-section .album-card[href="/album/${albumId}"]`)
        const centered = () => card.evaluate(node => node.scrollIntoView({ block: 'center', inline: 'center', behavior: 'instant' }))
        await centered()
        await page.waitForFunction(() => [...document.querySelectorAll('.catalog-section .album-card')]
            .some(node => node.matches('.editorial-timeline, .is-motion-visible')))
        const before = await card.evaluate(node => getComputedStyle(node).transform)
        await page.evaluate(() => scrollBy({ top: 135, behavior: 'instant' }))
        await page.waitForFunction(({ href, previous }) => {
            const node = document.querySelector(`.catalog-section .album-card[href="${href}"]`)
            const transform = node && getComputedStyle(node).transform
            return transform && transform !== 'none' && transform !== previous
        }, { href: '/album/' + albumId, previous: before })
        await centered()

        const preview = card.locator('.album-card-photo-preview')
        await preview.first().waitFor({ state: 'attached' })
        const firstSource = await preview.first().getAttribute('src')
        await page.waitForFunction(firstSource => [...document.querySelectorAll('.album-card-photo-preview')]
            .some(image => image.src !== firstSource && Number(getComputedStyle(image).opacity) > .4), firstSource)
        await page.evaluate(() => scrollBy({ top: 50, behavior: 'instant' }))
        await preview.first().waitFor({ state: 'detached' })
        assert.ok(traffic.some(request => /\/hover-[a-f0-9]+\.json$/.test(request.path)))
        assert.ok(!traffic.some(request => request.path.endsWith('/public/albums/' + albumId)),
            'Autoplay uses the small manifest without fetching the full album')
        assert.deepEqual(errors, [])
        const result = { engine, width: 390, check: 'phone catalog scroll motion and idle slideshow, with immediate cancellation on scroll', passed: true }
        outcomes.push(result); console.log(JSON.stringify(result))
    } finally { await context.close() }
}

async function mobileMediaMotionCase() {
    const { context, page, cdp, traffic } = await openCase({ width: 390 })
    let releasePreview
    try {
        if (cdp) await cdp.send('Emulation.setCPUThrottlingRate', { rate: 1 })
        const { items, photos } = fixture(85)
        const album = items[25]
        const preview = await page.evaluate(() => {
            const canvas = document.createElement('canvas')
            canvas.width = 96
            canvas.height = 64
            canvas.getContext('2d').fillRect(0, 0, 96, 64)
            return canvas.toDataURL().split(',')[1]
        })
        const pendingPreview = new Promise(resolve => { releasePreview = resolve })
        await page.route('**/photos/photo-{0,1}-w1920.webp', async route => {
            await pendingPreview
            return route.fulfill({ contentType: 'image/png', body: Buffer.from(preview, 'base64') })
        })
        await page.route(`**/public/albums/${album.albumId}`, route => route.fulfill({ json: {
            album, images: [
                { ...photos[0], width: 2400, height: 1600, previewSrcSet: undefined },
                { ...photos[1], width: 96, height: 64, previewSrcSet: undefined },
            ],
        } }))
        const card = page.locator(`.catalog-section a[href="/album/${album.albumId}"]`).first()
        const viewportFade = page.locator('.route-page-touch-fade')
        const returning = page.locator('main[data-route-page-motion="return"]')
        const flight = page.locator('.lightbox-motion-flight')
        const opacityOnly = node => node.getAnimations().some(animation =>
            animation.effect.getKeyframes().every(frame => 'opacity' in frame && !('transform' in frame)))
        await card.evaluate(node => node.scrollIntoView({ block: 'center', inline: 'center', behavior: 'instant' }))
        await page.waitForFunction(() => document.querySelector('.linen-nav').getBoundingClientRect().bottom <= .5)
        const scroll = () => card.evaluate(node => [scrollY, node.closest('[data-scroll-row]').scrollLeft])
        const from = await scroll()
        await card.tap()
        await viewportFade.waitFor({ state: 'attached' })
        assert.ok(await viewportFade.evaluate(opacityOnly), 'Touch route entry animates a viewport overlay')
        assert.equal(await page.locator('main[data-route-page-motion="enter"] .linen-gallery-header h1').count(), 1,
            'The album fade and title motion start after the album is mounted')
        assert.equal(await page.locator('[data-route-card-morph]').count(), 0)
        await viewportFade.waitFor({ state: 'detached' })

        const dialog = page.locator('.linen-photo-lightbox')
        const photo = dialog.locator('.is-loaded:not(.is-outgoing) img.linen-lightbox-edited')
        const tile = page.locator('main [data-lightbox-item]').first()
        await tile.tap()
        assert.ok(await dialog.evaluate(opacityOnly), 'The phone opens the live photo viewer with an opacity fade')
        assert.equal(await flight.count(), 0)
        await dialog.evaluate(async node => {
            node.addEventListener('transitionrun', event => {
                if (event.propertyName === 'transform' && event.target.matches('.linen-lightbox-photo-frame')) {
                    window.__visitor.photoRoseIntoPlace = true
                }
            })
            await Promise.allSettled(node.getAnimations().map(animation => animation.finished))
        })
        releasePreview()
        await page.waitForFunction(() => window.__visitor.photoRoseIntoPlace)
        const checkSize = async () => {
            await photo.waitFor()
            const size = await photo.evaluate(node => ({
                natural: node.naturalWidth, image: node.offsetWidth,
                frame: node.closest('.linen-lightbox-photo-frame').offsetWidth,
                stage: node.closest('.linen-lightbox-media').clientWidth,
            }))
            assert.equal(size.natural, 96)
            assert.equal(size.image, size.frame, 'A small preview fills its fitted frame')
            assert.ok(size.frame >= size.stage - 1, JSON.stringify(size))
        }
        await checkSize()
        await dialog.getByRole('button', { name: 'Next photo' }).tap()
        await dialog.getByText('2 / 2', { exact: true }).waitFor()
        await checkSize()
        await dialog.getByRole('button', { name: 'Close photo viewer' }).tap()
        assert.ok(await dialog.evaluate(opacityOnly), 'Closing uses the same opacity-only path')
        assert.equal(await flight.count(), 0)
        await dialog.waitFor({ state: 'detached' })

        await page.goBack()
        await returning.waitFor({ state: 'attached' })
        assert.ok(await viewportFade.evaluate(opacityOnly), 'Browser Back uses the phone route fade')
        await viewportFade.waitFor({ state: 'detached' })
        await returning.waitFor({ state: 'detached' })
        assert.ok((await scroll()).every((value, index) => Math.abs(value - from[index]) <= 1), 'Phone Back restores page and row scroll')

        await page.goto(`${origin}/video/${album.albumId}`)
        await page.locator('main [data-lightbox-item]').first().tap()
        const video = page.locator('.linen-video-lightbox')
        assert.ok(await video.evaluate(opacityOnly))
        assert.equal(await flight.count(), 0)
        await page.keyboard.press('Escape')
        await video.waitFor({ state: 'detached' })
        assert.ok(!traffic.some(entry => /\/lightboxMotion-[^/]+\.js$/.test(entry.path)), 'Phone photo and video taps skip the morph code')
        outcomes.push({ engine, check: 'phone route Back, photo and video fades, and a small source filling the photo frame', passed: true })
    } finally { releasePreview?.(); await context.close() }
}

async function qrMotionCase(width) {
    const { context, page, cdp } = await openCase({ width })
    let releaseAsset
    try {
        if (cdp) await cdp.send('Emulation.setCPUThrottlingRate', { rate: 1 })
        const hold = new Promise(resolve => { releaseAsset = resolve })
        await page.route('**/album-qr.png', async route => { await hold; await route.fallback() })
        await page.goto(origin + '/album/' + fixture(1).items[0].albumId)
        if (width < 768) await page.getByText('Album details', { exact: true }).click()
        const trigger = page.locator('button[aria-label^="Show QR code"]')
        const dialog = page.locator('.linen-qr-lightbox')
        const card = dialog.locator('[data-lightbox-panel]')
        const qr = dialog.locator('[data-lightbox-qr]')
        const visibleButton = () => trigger.evaluate(element => Number(getComputedStyle(element).opacity) === 1
            && !element.hasAttribute('data-lightbox-motion-source'))
        const size = () => card.evaluate(element => {
            const slot = element.querySelector('.linen-qr-slot')
            return [element.offsetWidth, element.offsetHeight, slot.offsetWidth, slot.offsetHeight]
        })
        await trigger.click()
        await dialog.and(page.locator('[data-qr-opening]')).waitFor({ state: 'attached' })
        const original = await size()
        assert.equal(original[2], original[3], 'The image has a square before it loads')
        assert.ok(await visibleButton())
        assert.equal(await qr.evaluate(el => getComputedStyle(el).opacity), '0')
        await page.locator('[data-qr-opening]').waitFor({ state: 'detached' })
        assert.deepEqual(await size(), original)
        await qr.evaluate(element => {
            element.addEventListener('transitionrun', event => {
                if (event.propertyName === 'opacity') window.__visitor.qrFadingIn = true
            }, { once: true })
        })
        releaseAsset()
        await page.waitForFunction(() => window.__visitor.qrFadingIn)
        await page.waitForFunction(() => getComputedStyle(document.querySelector('[data-qr-ready]')).opacity === '1')
        assert.deepEqual(await size(), original, 'Loading the QR does not change the panel or image slot')
        assert.equal(await dialog.locator('.lightbox-motion-flight').count(), 0, 'The real panel owns the motion')
        assert.ok(await visibleButton())

        await dialog.getByRole('button', { name: 'Close QR code' }).click()
        await dialog.and(page.locator('[data-qr-closing]')).waitFor({ state: 'attached' })
        assert.ok(await visibleButton())
        const fade = await qr.evaluate(element => {
            const animation = element.getAnimations().find(entry => entry.effect.getKeyframes()[0].opacity !== undefined)
            return { duration: animation.effect.getTiming().duration, frames: animation.effect.getKeyframes().map(frame => Number(frame.opacity)) }
        })
        assert.ok(fade.duration >= 160)
        assert.deepEqual(fade.frames, [1, 0])
        await dialog.waitFor({ state: 'detached' })
        assert.ok(await visibleButton())
        assert.ok(await trigger.evaluate(element => document.activeElement === element))
        const result = { engine, width, check: 'cold QR opens at a stable size and fades smoothly while the launch button stays visible', passed: true }
        outcomes.push(result); console.log(JSON.stringify(result))
    } finally { releaseAsset?.(); await context.close() }
}

async function observeLiveTitleHandoff(page, motion = 'return', navbarBottom) {
    await page.evaluate(({ expectedMotion, navbarBottom }) => {
        const main = document.getElementById('main-content')
        window.__visitor.liveTitleHandoff = new Promise(resolve => {
            const observer = new MutationObserver(() => {
                if (main.dataset.routePageMotion !== expectedMotion) return
                observer.disconnect()
                const copy = document.querySelector('.route-card-title:last-child')
                const live = main.querySelector('[data-route-title-landing]')
                const leaving = copy?.getAnimations().find(animation => animation.effect.getTiming().delay > 0)
                const moving = copy?.getAnimations().find(animation => animation.effect.getKeyframes()[0].transform !== undefined)
                const reveal = main.getAnimations()[0]
                if (!leaving || !moving || !live || !reveal) {
                    clearTimeout(timeout)
                    resolve('No matching title morph')
                    return
                }
                const { delay, duration } = moving.effect.getTiming()
                const fadeTiming = reveal.effect.getTiming()
                const handoffTiming = leaving.effect.getTiming()
                const travelsBeforeHandoff = delay + duration < handoffTiming.delay
                const handsOffBeforeFadeEnds = handoffTiming.delay + handoffTiming.duration < fadeTiming.delay + fadeTiming.duration
                const moduleTitle = live.closest('[data-route-card="app"], [data-route-card="explore"]')
                const pageStartsEarly = fadeTiming.delay === 0 && fadeTiming.duration <= (moduleTitle ? 420 : duration >= 350 ? 455 : 350)
                    && fadeTiming.easing === 'ease-out'
                const titleMovesOrChangesColor = () => live.getAnimations().some(animation => animation.effect.getKeyframes().some(frame =>
                    frame.transform !== undefined || frame.translate !== undefined || frame.scale !== undefined || frame.color !== undefined))
                const glyphTop = () => {
                    const range = document.createRange()
                    range.selectNodeContents(live)
                    return range.getBoundingClientRect().top
                }
                const initialTop = glyphTop()
                const initialColor = getComputedStyle(live).color
                const animatedTitle = titleMovesOrChangesColor()
                let overlappedText = false
                let navbarShifted = false
                const navbar = document.querySelector('.linen-nav')
                let frame
                const checkLayer = () => {
                    if (!copy.isConnected) return
                    if (Number(getComputedStyle(live).opacity) > 0) overlappedText = true
                    if (navbarBottom !== undefined && Math.abs(navbar.getBoundingClientRect().bottom - navbarBottom) > 1) {
                        navbarShifted = true
                    }
                    frame = requestAnimationFrame(checkLayer)
                }
                checkLayer()
                leaving.finished.then(() => {
                    clearTimeout(timeout)
                    cancelAnimationFrame(frame)
                    resolve([handsOffBeforeFadeEnds, copy.isConnected, getComputedStyle(live).opacity,
                        travelsBeforeHandoff, animatedTitle || titleMovesOrChangesColor(), Math.abs(glyphTop() - initialTop) < .5,
                        overlappedText, getComputedStyle(live).color === initialColor, pageStartsEarly, navbarShifted])
                }, () => {
                    clearTimeout(timeout)
                    cancelAnimationFrame(frame)
                    resolve('Title transition was interrupted')
                })
            })
            const timeout = setTimeout(() => {
                observer.disconnect()
                resolve('Timed out waiting for the title handoff')
            }, 6000)
            observer.observe(main, { attributes: true, attributeFilter: ['data-route-page-motion'] })
        })
    }, { expectedMotion: motion, navbarBottom })
}

async function assertLiveTitleHandoff(page, motion = 'return') {
    const handoff = await page.evaluate(() => window.__visitor.liveTitleHandoff)
    assert.deepEqual(handoff, [true, false, '1', true, false, true, false, true, motion === 'return', false],
        'The live text takes over in place and the navbar stays parked during an album return')
}

function restingTitleBounds(element) {
    return element.getBoundingClientRect().toJSON()
}

async function routeCardMotionCase(width) {
    const { context, page, cdp } = await openCase({ width })
    try {
        if (cdp) await cdp.send('Emulation.setCPUThrottlingRate', { rate: 1 })
        const entering = page.locator('main[data-route-page-motion="enter"]')
        const returning = page.locator('main[data-route-page-motion="return"]')
        const morph = page.locator('[data-route-card-morph]')
        const album = page.locator('.catalog-section [data-route-card="album"]').nth(25)
        await album.evaluate(card => card.scrollIntoView({ block: 'center', inline: 'center', behavior: 'instant' }))
        const masthead = page.locator('.linen-nav')
        await page.waitForFunction(() => document.querySelector('.linen-nav').getBoundingClientRect().bottom <= .5)
        if (width >= 1080) {
            // Reproduce a visible masthead over the scrolled gallery by
            // reversing scroll direction before opening the album.
            await page.evaluate(() => scrollBy({ top: -54, behavior: 'instant' }))
            await page.waitForFunction(() => document.querySelector('.linen-nav').getBoundingClientRect().top >= -.5)
        }
        const navbarBottom = await masthead.evaluate(nav => nav.getBoundingClientRect().bottom)
        await album.locator('img').evaluate(image => image.decode())
        const catalogScroll = await album.evaluate(card => ({ top: scrollY, left: card.closest('[data-scroll-row]').scrollLeft }))
        assert.ok(catalogScroll.top > 0)
        await observeLiveTitleHandoff(page, 'enter')
        if (width >= 1080) {
            const { x, y, width, height } = await album.boundingBox()
            await page.mouse.click(x + width / 2, y + height / 2)
        } else await album.tap()
        await entering.waitFor({ state: 'attached' })
        const opacity = await entering.evaluate(main => main.getAnimations().flatMap(animation => animation.effect.getKeyframes())
            .map(frame => Number(frame.opacity)))
        assert.deepEqual(opacity, [0, 1], 'The destination page starts hidden')
        assert.equal(await page.locator('[data-route-card-flight]').count(), 0)
        await page.waitForURL('**/album/**')
        await assertLiveTitleHandoff(page, 'enter')
        await entering.waitFor({ state: 'detached' })
        await page.evaluate(mobile => {
            const main = document.querySelector('main')
            const observer = new MutationObserver(() => {
                if (location.pathname !== '/' || !main.hasAttribute('data-route-page-staged')) return
                observer.disconnect()
                window.dispatchEvent(new WheelEvent('wheel', { deltaX: -120, deltaY: 3 }))
                if (mobile) {
                    const move = new Event('touchmove', { bubbles: true })
                    Object.defineProperty(move, 'touches', { value: [{ identifier: 1, clientX: 160, clientY: 400 }] })
                    main.dispatchEvent(move)
                    window.dispatchEvent(new Event('resize'))
                }
            })
            observer.observe(main, { attributes: true, attributeFilter: ['data-route-page-staged'] })
        }, width < 500)
        await observeLiveTitleHandoff(page, 'return', navbarBottom)
        await page.goBack()
        await returning.waitFor({ state: 'attached' })
        const title = album.locator('h3')
        await assertLiveTitleHandoff(page)
        const landing = await title.evaluate(restingTitleBounds)
        await returning.waitFor({ state: 'detached' })
        const completed = await title.evaluate(restingTitleBounds)
        assert.ok(Object.keys(landing).every(key => Math.abs(landing[key] - completed[key]) < 1),
            'The album title stays put through the end of the return')
        assert.ok(Math.abs(await masthead.evaluate(nav => nav.getBoundingClientRect().bottom) - navbarBottom) < 1,
            'The navbar keeps its original visibility after scrolling the gallery back into place')
        const afterBack = await album.evaluate(card => ({ top: scrollY, left: card.closest('[data-scroll-row]').scrollLeft }))
        assert.ok(Math.abs(afterBack.top - catalogScroll.top) <= 1, 'Browser Back restores the catalog scroll offset')
        assert.ok(Math.abs(afterBack.left - catalogScroll.left) <= 1, 'Browser Back restores the row scroll offset')
        await page.goForward()
        await entering.waitFor({ state: 'attached' })
        await entering.waitFor({ state: 'detached' })
        await page.evaluate(() => {
            const main = document.querySelector('main')
            window.__visitor.interruptedReturn = new Promise(resolve => {
                const observer = new MutationObserver(() => {
                    if (main.dataset.routePageMotion !== 'return') return
                    observer.disconnect()
                    clearTimeout(timeout)
                    const stage = document.querySelector('[data-route-card-morph]')
                    window.dispatchEvent(new WheelEvent('wheel', { deltaY: -180 }))
                    window.scrollBy({ top: -180, behavior: 'instant' })
                    resolve(Boolean(stage && !stage.isConnected))
                })
                const timeout = setTimeout(() => { observer.disconnect(); resolve(false) }, 6000)
                observer.observe(main, { attributes: true, attributeFilter: ['data-route-page-motion'] })
            })
        })
        await page.goBack()
        assert.ok(await page.evaluate(() => window.__visitor.interruptedReturn), 'Scrolling interrupts the active morph')
        assert.equal(await page.locator('[data-route-title-landing]').count(), 0)
        await page.waitForFunction(top => scrollY < top, catalogScroll.top)

        await page.goForward()
        await entering.waitFor({ state: 'attached' })
        await entering.waitFor({ state: 'detached' })
        await page.locator('.linen-brand').click()
        await page.waitForURL(origin + '/')
        await entering.waitFor({ state: 'attached' })
        assert.equal(await morph.count(), 0, 'The IT logo starts a regular Home fade without an album title overlay')
        await page.waitForFunction(() => scrollY < 1)
        await entering.waitFor({ state: 'detached' })

        await page.goto(origin + '/apps')
        const app = page.locator('[data-route-card="app"][href="/apps/truongcam"]')
        await app.click()
        const staged = page.locator('main[data-route-page-staged]')
        await staged.waitFor({ state: 'attached' })
        assert.equal(await staged.evaluate(main => Number(getComputedStyle(main).opacity)), 0)
        await entering.waitFor({ state: 'attached' })
        await morph.waitFor({ state: 'attached' })
        assert.equal(await morph.locator('img, svg, video').count(), 0, 'Media stays in the page layout')
        assert.deepEqual(await morph.locator('.route-card-title').allTextContents(), ['TruongCam', 'TruongCam'])
        assert.deepEqual(await morph.locator('.route-card-title').evaluateAll(titles => titles.map(title =>
            title.getAnimations().flatMap(animation => animation.effect.getKeyframes()).some(frame => frame.transform))), [true, true])
        const { delay, duration, travel, outlineGone, outlinePeak, outlineBackground, firstOpacity, laterOpacity } = await entering.evaluate(main => {
            const reveal = main.getAnimations()[0]
            const { delay, duration } = reveal.effect.getTiming()
            const outline = document.querySelector('.route-card-outline')
            const outlineFade = outline.getAnimations()
                .find(animation => Number(animation.effect.getKeyframes().at(-1).opacity) === 0)
            const outlineGone = outlineFade.effect.getTiming().duration
            const outlinePeak = Math.max(...outlineFade.effect.getKeyframes().map(frame => Number(frame.opacity)))
            const originalTime = reveal.currentTime
            reveal.pause()
            reveal.currentTime = delay + 75
            const firstOpacity = Number(getComputedStyle(main).opacity)
            reveal.currentTime = delay + duration * .72
            const laterOpacity = Number(getComputedStyle(main).opacity)
            reveal.currentTime = originalTime
            reveal.play()
            const outlineMove = outline.getAnimations()
                .find(animation => animation.effect.getKeyframes()[0].transform !== undefined)
            return { delay, duration, outlineGone, outlinePeak, outlineBackground: getComputedStyle(outline).backgroundColor,
                firstOpacity, laterOpacity, travel: outlineMove.effect.getTiming().duration }
        })
        assert.ok(delay >= travel * .8, 'The page stays hidden until the title is nearly at the heading')
        assert.ok(duration >= 340 && duration <= 365, 'The entry reveal is shorter')
        assert.ok(outlineGone < delay, 'The outline has dissolved before the page starts to appear')
        assert.ok(outlinePeak <= .4 && outlineBackground === 'rgba(0, 0, 0, 0)', 'The card travels with a faint unfilled outline')
        assert.ok(firstOpacity > 0 && firstOpacity < .1, 'The first 75 ms of the reveal ease in gradually')
        assert.ok(laterOpacity > .7 && laterOpacity < .9, 'The page keeps easing toward full opacity after most of the fade')
        await entering.waitFor({ state: 'detached' })
        assert.equal(await staged.count(), 0, 'The page is restored after the handoff')
        await observeLiveTitleHandoff(page)
        await page.locator('main .explore-back').click()
        await returning.waitFor({ state: 'attached' })
        await morph.waitFor({ state: 'attached' })
        assert.deepEqual(await morph.locator('.route-card-title').allTextContents(), ['TruongCam', 'TruongCam'])
        assert.equal(await morph.locator('.route-card-outline').count(), 0, 'The app title returns on its own')
        await assertLiveTitleHandoff(page)
        await returning.waitFor({ state: 'detached' })

        await page.locator('[data-route-card="app"][href="/editor"]').click()
        await entering.waitFor({ state: 'attached' })
        assert.deepEqual(await morph.locator('.route-card-title').allTextContents(), ['Web Editor', 'Photo Editor'])
        await entering.waitFor({ state: 'detached' })
        await observeLiveTitleHandoff(page)
        await page.getByRole('link', { name: /All apps/ }).click()
        await page.waitForURL('**/apps')
        await returning.waitFor({ state: 'attached' })
        assert.deepEqual(await morph.locator('.route-card-title').allTextContents(), ['Photo Editor', 'Web Editor'])
        await assertLiveTitleHandoff(page)
        await returning.waitFor({ state: 'detached' })

        await page.goto(origin + '/explore')
        const explorer = page.locator('[data-route-card="explore"][href="/explore/exposure"]')
        await explorer.click()
        await entering.waitFor({ state: 'attached' })
        const heading = page.getByRole('heading', { name: 'Exposure Explorer', exact: true })
        const before = await heading.evaluate(element => {
            const { x, y } = element.getBoundingClientRect()
            return { x, y, opacity: getComputedStyle(element).opacity, frame: getComputedStyle(element.parentElement).transform }
        })
        assert.equal(before.opacity, '0', 'Only the moving title is painted during the handoff')
        assert.equal(before.frame, 'none', 'The module heading is outside the scroll transforms')
        await entering.waitFor({ state: 'detached' })
        const after = await heading.evaluate(element => {
            const { x, y } = element.getBoundingClientRect()
            return { x, y, opacity: getComputedStyle(element).opacity }
        })
        assert.equal(after.opacity, '1')
        assert.ok(Math.hypot(before.x - after.x, before.y - after.y) < 1, 'The real title stays at the same coordinates')
        await observeLiveTitleHandoff(page)
        await page.goBack()
        await returning.waitFor({ state: 'attached' })
        assert.deepEqual(await morph.locator('.route-card-title').allTextContents(), ['Exposure Explorer', 'Exposure Explorer'])
        assert.equal(await morph.locator('.route-card-outline').count(), 0, 'The Explore title returns on its own')
        await assertLiveTitleHandoff(page)
        await returning.waitFor({ state: 'detached' })

        await page.evaluate(() => {
            const getContext = HTMLCanvasElement.prototype.getContext
            HTMLCanvasElement.prototype.getContext = function (type, ...options) {
                return type === 'webgl2' ? null : getContext.call(this, type, ...options)
            }
            window.__visitor.immersiveMorph = false
            new MutationObserver(records => {
                if (records.some(record => [...record.addedNodes].some(node => node.matches?.('[data-route-card-morph]')))) {
                    window.__visitor.immersiveMorph = true
                }
            }).observe(document.body, { childList: true, subtree: true })
        })
        const immersive = page.locator('.explore-module-card--immersive')
        await page.locator('html[data-route-scroll-restoring]').waitFor({ state: 'detached' })
        await immersive.evaluate(card => card.scrollIntoView({ block: 'center', behavior: 'instant' }))
        await immersive.click()
        await page.waitForURL('**/explore/immersive-gallery')
        await entering.waitFor({ state: 'attached' })
        const immersiveFade = await entering.evaluate(main => main.getAnimations()[0].effect.getKeyframes().map(frame => frame.opacity))
        assert.deepEqual(immersiveFade, ['0', '1'])
        await entering.waitFor({ state: 'detached' })
        await page.goBack()
        await returning.waitFor({ state: 'attached' })
        await returning.waitFor({ state: 'detached' })
        assert.equal(await page.evaluate(() => window.__visitor.immersiveMorph), false, 'The immersive gallery fades in both directions without staging the card title')

        await page.goto(origin + '/apps')
        await page.emulateMedia({ reducedMotion: 'reduce' })
        await app.click()
        await page.waitForURL('**/apps/truongcam')
        assert.equal(await entering.count(), 0)
        const result = { engine, width, check: 'album history motion and title-only returns for Apps and Explore', passed: true }
        outcomes.push(result); console.log(JSON.stringify(result))
    } finally { await context.close() }
}

async function wrappedAlbumTitleMotionCase(width) {
    const { context, page, cdp } = await openCase({ width, titleSuffix: ' — A late afternoon walk through the old city streets' })
    try {
        if (cdp) await cdp.send('Emulation.setCPUThrottlingRate', { rate: 1 })
        await page.addStyleTag({ content: '.catalog-section .album-card h3 { max-width: 15ch }' })
        const card = page.locator('.catalog-section [data-route-card="album"]').nth(25)
        await card.evaluate(element => element.scrollIntoView({ block: 'center', inline: 'center', behavior: 'instant' }))
        const checkTravel = async mode => {
            const main = page.locator(`main[data-route-page-motion="${mode}"]`)
            await main.waitFor({ state: 'attached' })
            const travel = await main.evaluate(element => {
                const copies = [...element.parentElement.querySelectorAll('.route-card-title')]
                const animation = copies[1].getAnimations().find(item => item.effect.getKeyframes()[0].transform)
                const { duration } = animation.effect.getTiming()
                const motions = copies.flatMap(copy => copy.getAnimations())
                const times = motions.map(item => item.currentTime)
                motions.forEach(item => item.pause())
                const firstLetter = node => {
                    const range = document.createRange()
                    const text = document.createTreeWalker(node, NodeFilter.SHOW_TEXT).nextNode()
                    const start = text.data.search(/\S/)
                    range.setStart(text, start)
                    range.setEnd(text, start + 1)
                    const { left, top } = range.getBoundingClientRect()
                    return [left, top]
                }
                const sample = ms => {
                    motions.forEach(item => { item.currentTime = ms })
                    return copies.map(copy => ({ point: firstLetter(copy), opacity: Number(getComputedStyle(copy).opacity) }))
                }
                const distance = ([x1, y1], [x2, y2]) => Math.hypot(x1 - x2, y1 - y2)
                const start = sample(0)[0].point
                const early = sample(32)[0].point
                const differences = []
                for (let step = 1; step < 20; step++) {
                    const [from, to] = sample(duration * step / 20)
                    if (from.opacity >= .15 && to.opacity >= .15) differences.push(distance(from.point, to.point))
                }
                const end = sample(duration)[1].point
                const landing = firstLetter(element.querySelector('[data-route-title-landing]'))
                motions.forEach((item, index) => { item.currentTime = times[index]; item.play() })
                return { distance: distance(start, end), earlyFraction: distance(start, early) / distance(start, end),
                    overlap: differences.length, separation: Math.max(...differences), landingGap: distance(end, landing) }
            })
            assert.ok(travel.distance > 180 && travel.overlap > 0, `Exercise a long flight and its crossfade (${JSON.stringify(travel)})`)
            assert.ok(travel.separation < 2, `The text copies follow the same path during ${mode} (${JSON.stringify(travel)})`)
            assert.ok(travel.earlyFraction < .21, `The title eases out of its starting position (${JSON.stringify(travel)})`)
            assert.ok(travel.landingGap < 2, `The travelling text meets the live text in place (${JSON.stringify(travel)})`)
            await main.waitFor({ state: 'detached' })
            return travel
        }
        await card.click()
        const entry = await checkTravel('enter')
        await page.goBack()
        const back = await checkTravel('return')
        const result = { engine, width, check: 'wrapped album titles stay aligned in flight and ease into movement on open and Back', entry, back, passed: true }
        outcomes.push(result); console.log(JSON.stringify(result))
    } finally { await context.close() }
}

async function slowAlbumTitleMotionCase(width, type, viewportEdge = false) {
    const { context, page, cdp } = await openCase({ width })
    let releaseDetail, releaseCatalog
    try {
        if (cdp) await cdp.send('Emulation.setCPUThrottlingRate', { rate: 1 })
        const video = type === 'video'
        const { items, photos } = fixture(85)
        const album = video ? { ...items[0], type: 'video', imageCount: 2 } : items[0]
        const catalogPath = video ? '/videos' : '/'
        const detailPath = `/${video ? 'video' : 'album'}/${album.albumId}`
        const pendingDetail = new Promise(resolve => { releaseDetail = resolve })
        const pendingCatalog = new Promise(resolve => { releaseCatalog = resolve })
        let returning = false
        await page.route(new RegExp(`/public/albums\\?[^#]*type=${type}(?:&|$)`), async route => {
            if (returning) await pendingCatalog
            await route.fulfill({ json: { items: video ? [album] : items, nextCursor: null } })
        })
        await page.route(`**/public/albums/${album.albumId}`, async route => {
            await pendingDetail
            await route.fulfill({ json: { album, images: video ? [] : photos } })
        })
        if (video) await page.goto(origin + catalogPath)
        const card = page.locator(`.catalog-section [data-route-card="album"][href="${detailPath}"]`)
        await card.evaluate(element => element.scrollIntoView({ block: 'center', inline: 'center', behavior: 'instant' }))
        const edgeClick = viewportEdge && await card.evaluate(async element => {
            const title = element.querySelector('h3')
            scrollBy({ top: title.getBoundingClientRect().top - innerHeight - 80, behavior: 'instant' })
            await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))
            const tile = element.getBoundingClientRect()
            return { x: tile.left + tile.width / 2, y: (tile.top + innerHeight) / 2,
                hidden: title.getBoundingClientRect().top >= innerHeight + 40 }
        })
        await page.evaluate(() => {
            const main = document.getElementById('main-content')
            window.__visitor.albumTitleMotions = {}
            new MutationObserver((_, observer) => {
                const preview = document.querySelector('.route-card-preview')
                if (!preview) return
                observer.disconnect()
                window.__visitor.previewTraveled = [...document.querySelectorAll('.route-card-title')].some(title =>
                    title.getAnimations().some(animation => {
                        const frames = animation.effect.getKeyframes()
                        return frames[0].transform && frames[0].transform !== frames.at(-1).transform
                    }))
            }).observe(main.parentElement, { childList: true, subtree: true })
            new MutationObserver(() => {
                const mode = main.dataset.routePageMotion
                if (!mode) return
                window.__visitor.albumTitleMotions[mode] = [...document.querySelectorAll('.route-card-title')].some(title =>
                    title.getAnimations().some(animation => {
                        const frames = animation.effect.getKeyframes()
                        return frames[0].transform && frames[0].transform !== frames.at(-1).transform
                    }))
            }).observe(main, { attributes: true, attributeFilter: ['data-route-page-motion'] })
        })
        const detailRequest = page.waitForRequest(request => new URL(request.url()).pathname.endsWith(`/public/albums/${album.albumId}`))
        if (edgeClick) {
            assert.ok(edgeClick.hidden, 'The photo is clickable with its title entirely below the viewport')
            await page.mouse.click(edgeClick.x, edgeClick.y)
        } else await card.click()
        await page.waitForURL(origin + detailPath)
        await detailRequest
        const preview = page.locator('.route-card-preview h1:not([data-route-title-landing])')
        await preview.waitFor({ state: 'visible', timeout: 3000 })
        assert.equal(await preview.textContent(), album.title)
        assert.equal(await page.evaluate(() => window.__visitor.previewTraveled), true, 'The title moves before the album response')
        const parked = await preview.boundingBox()
        const overlay = page.locator('[data-route-card-morph]')
        assert.equal(await overlay.textContent(), album.title)
        assert.equal(await overlay.locator('.route-card-progress').count(), 0)
        assert.equal(await page.locator('main').evaluate(main => getComputedStyle(main).opacity), '0', 'The skeleton stays hidden')
        releaseDetail()
        const heading = page.locator('main .linen-gallery-header h1')
        await heading.waitFor()
        await page.waitForFunction(() => 'enter' in window.__visitor.albumTitleMotions)
        const reveal = await page.locator('main').evaluate(main => {
            const movement = document.querySelector('.route-card-title').getAnimations()
                .find(animation => animation.effect.getKeyframes()[0].transform)
            return { delay: main.getAnimations()[0].effect.getTiming().delay, travel: movement.effect.getTiming().duration }
        })
        assert.ok(reveal.delay >= reveal.travel, 'The gallery only starts fading in after the title travel finishes')
        await page.locator('main[data-route-page-motion]').waitFor({ state: 'detached' })
        const landed = await heading.boundingBox()
        assert.ok(Math.hypot(parked.x - landed.x, parked.y - landed.y) < 65, 'The preview hands off near the real album heading')

        // Expire the in-memory and stored catalog so history restoration must
        // wait for the cards to arrive again.
        await page.evaluate(() => {
            const now = Date.now.bind(Date)
            Date.now = () => now() + 31 * 60_000
        })
        returning = true
        const catalogRequest = page.waitForRequest(request => {
            const url = new URL(request.url())
            return url.pathname.endsWith('/public/albums') && url.searchParams.get('type') === type
        })
        if (video) await page.getByRole('button', { name: 'Back to Videos' }).click()
        else await page.goBack()
        await catalogRequest
        await page.waitForTimeout(850)
        assert.match(await overlay.textContent(), /^Album 1$/)
        assert.equal(await overlay.locator('.route-card-progress').count(), 0)
        assert.equal(await page.locator('main').evaluate(main => getComputedStyle(main).opacity), '0', 'The catalog skeleton stays hidden')
        releaseCatalog()
        await card.waitFor()
        await page.waitForFunction(() => 'return' in window.__visitor.albumTitleMotions)
        await page.locator('main[data-route-page-motion]').waitFor({ state: 'detached' })
        assert.deepEqual(await page.evaluate(() => window.__visitor.albumTitleMotions), { enter: true, return: true })
        assert.equal(await page.locator('[data-route-title-landing], [data-route-card-morph]').count(), 0)
        const result = { engine, width, check: `${type} album title travels after slow album and catalog responses${viewportEdge ? ' from below the viewport' : ''}`, passed: true }
        outcomes.push(result); console.log(JSON.stringify(result))
    } finally { releaseDetail?.(); releaseCatalog?.(); await context.close() }
}

async function routeSectionMotionCase(width) {
    const { context, page, cdp } = await openCase({ width })
    try {
        if (cdp) await cdp.send('Emulation.setCPUThrottlingRate', { rate: 1 })
        const section = page.locator('main [data-route-card="section"]').first()
        await section.evaluate(link => link.scrollIntoView({ block: 'center', behavior: 'instant' }))
        const category = await section.locator('[data-route-title]').textContent()
        const entering = page.locator('main[data-route-page-motion="enter"]')
        const returning = page.locator('main[data-route-page-motion="return"]')
        const morph = page.locator('[data-route-card-morph]')
        const titles = morph.locator('.route-card-title')
        await section.click()
        await page.waitForURL('**/sections/photo/**')
        await entering.waitFor({ state: 'attached' })
        assert.deepEqual(await titles.allTextContents(), [category, category])
        assert.ok(await titles.evaluateAll(labels => parseFloat(labels[1].style.fontSize) > parseFloat(labels[0].style.fontSize)))
        assert.equal(await morph.locator('.route-card-outline').count(), 0)
        const landingDifference = await titles.nth(1).evaluate(copy => {
            const live = document.querySelector('[data-route-title-landing]')
            const travel = copy.getAnimations().find(animation => animation.effect.getKeyframes()[0].transform !== undefined)
            const time = travel.currentTime
            travel.pause()
            travel.currentTime = travel.effect.getTiming().duration
            const bounds = element => {
                const range = document.createRange()
                range.selectNodeContents(element)
                return range.getBoundingClientRect()
            }
            const renderedCopy = bounds(copy), renderedHeading = bounds(live)
            const difference = Math.max(...['x', 'y', 'width', 'height'].map(key => Math.abs(renderedCopy[key] - renderedHeading[key])))
            travel.currentTime = time
            travel.play()
            return difference
        })
        assert.ok(landingDifference < 1, `Section title glyphs match the live heading within a pixel (${landingDifference}px)`)
        await entering.waitFor({ state: 'detached' })
        await observeLiveTitleHandoff(page)
        await page.getByRole('button', { name: 'All photo albums' }).click()
        await returning.waitFor({ state: 'attached' })
        assert.deepEqual(await titles.allTextContents(), [category, category])
        await assertLiveTitleHandoff(page)
        await returning.waitFor({ state: 'detached' })
        const result = { engine, width, check: 'section title enlarges into the page heading and returns to the gallery', passed: true }
        outcomes.push(result); console.log(JSON.stringify(result))
    } finally { await context.close() }
}

async function routeTimelineLandingCase(width) {
    const { context, page, cdp } = await openCase({ width })
    try {
        if (cdp) await cdp.send('Emulation.setCPUThrottlingRate', { rate: 1 })
        await page.locator('.linen-desktop-links').getByRole('link', { name: 'Stats', exact: true }).click()
        await page.locator('.photo-stats-timeline-scroll').evaluate(row => row.scrollIntoView({ block: 'center', behavior: 'instant' }))
        const visibleTitle = await page.waitForFunction(() => {
            for (const title of document.querySelectorAll('[data-route-card="timeline"] strong')) {
                const rect = title.getBoundingClientRect()
                const x = rect.left + rect.width / 2, y = rect.top + rect.height / 2
                if (document.elementFromPoint(x, y) === title) return { x, y, href: title.parentElement.getAttribute('href') }
            }
            return false
        }, null, { timeout: 8000 })
        const { x, y, href } = await visibleTitle.jsonValue()
        const card = page.locator(`[data-route-card="timeline"][href="${href}"]`)
        await page.mouse.click(x, y)
        await page.waitForURL('**/album/**')
        const staged = page.locator('main[data-route-page-staged]')
        await staged.waitFor({ state: 'attached' })
        await staged.waitFor({ state: 'detached' })

        await observeLiveTitleHandoff(page)
        await page.goBack()
        const returning = page.locator('main[data-route-page-motion="return"]')
        await returning.waitFor({ state: 'attached' })
        const statsContent = page.locator('.photo-stats-content')
        assert.equal(await statsContent.evaluate(element => getComputedStyle(element).animationName), 'none', 'Stats uses the shared return fade')
        await assertLiveTitleHandoff(page)
        const during = await card.locator('strong').evaluate(restingTitleBounds)
        await returning.waitFor({ state: 'detached' })
        const after = await card.locator('strong').evaluate(restingTitleBounds)
        assert.ok(Object.keys(during).every(key => Math.abs(during[key] - after[key]) < 1), 'The timeline title lands without a final hover offset')
        await page.mouse.move(after.x + 20, after.y + after.height / 2)
        await card.evaluate(element => {
            if (element.hasAttribute('data-route-card-resting')) throw new Error('Pointer movement should restore normal card hover')
        })
        const result = { engine, width, check: 'Stats timeline title holds its position through the return handoff', passed: true }
        outcomes.push(result); console.log(JSON.stringify(result))
    } finally { await context.close() }
}

async function calendarYearCase(width) {
    const { context, page, cdp } = await openCase({ width })
    try {
        if (cdp) await cdp.send('Emulation.setCPUThrottlingRate', { rate: 1 })
        await page.goto(origin + '/stats')
        const calendar = page.locator('.shooting-calendar')
        const summary = calendar.locator('.shooting-calendar-summary')
        const heatmap = calendar.locator('.shooting-calendar-grid')
        const position = () => calendar.evaluate(element => {
            const summary = element.querySelector('dl')
            const grid = element.querySelector('.shooting-calendar-scroll')
            return [summary.offsetHeight, grid.offsetTop - summary.offsetTop, grid.offsetHeight, scrollY]
        })
        const year2026 = calendar.getByRole('button', { name: '2026', exact: true })
        const year2025 = calendar.getByRole('button', { name: '2025', exact: true })
        await year2025.evaluate(button => {
            button.scrollIntoView({ block: 'center', inline: 'nearest', behavior: 'instant' })
            return new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))
        })
        await calendar.evaluate(element => {
            window.__visitor.calendarTransitions = []
            const animate = element.querySelector('.shooting-calendar-grid').animate.bind(element.querySelector('.shooting-calendar-grid'))
            element.querySelector('.shooting-calendar-grid').animate = (keyframes, options) => {
                window.__visitor.calendarTransitions.push(options.duration)
                return animate(keyframes, options)
            }
        })
        const before = await position()
        assert.equal(await year2026.getAttribute('aria-pressed'), 'true')
        await year2025.click()
        assert.ok(await heatmap.getByRole('group', { name: 'Shooting days in 2025' }).count())
        assert.ok(await summary.getByText('289 photos · 2 videos', { exact: true }).isVisible())
        const positionAfter = await position()
        assert.deepEqual(positionAfter, before, 'The summary, heatmap and viewport stay at the same position')
        const timings = await page.evaluate(() => window.__visitor.calendarTransitions)
        assert.equal(timings.length, 1, 'The year switch animates the heatmap')
        await year2026.click()
        const after = await position()
        assert.deepEqual(after, before)
        const dayResults = calendar.locator('.shooting-calendar-day')
        await dayResults.evaluate(panel => {
            window.__visitor.dayReveals = []
            const watch = (element, property) => {
                const animate = element.animate.bind(element)
                element.animate = (frames, options) => {
                    window.__visitor.dayReveals.push([property, frames])
                    return animate(frames, options)
                }
            }
            watch(panel, 'resize')
            watch(panel.firstElementChild, 'fade')
        })
        const firstDay = calendar.getByRole('button', { name: 'Jun 1', exact: true })
        await firstDay.click()
        assert.equal(await dayResults.locator('strong').textContent(), 'Album 1')
        const opening = await page.evaluate(() => window.__visitor.dayReveals)
        assert.ok(opening.some(([kind, frames]) => kind === 'resize' && frames[0].height !== frames[1].height))
        await calendar.getByRole('button', { name: /June 2, 2026/ }).click()
        assert.equal(await dayResults.locator('strong').textContent(), 'Album 2')
        const selectedDays = await page.evaluate(() => window.__visitor.dayReveals.filter(([kind]) => kind === 'fade'))
        assert.equal(selectedDays.length, 2, 'Opening and changing the selected day both animate the live results')
        await dayResults.evaluate(panel => Promise.allSettled(panel.getAnimations({ subtree: true }).map(animation => animation.finished)))
        await firstDay.click()
        await dayResults.evaluate(panel => Promise.allSettled(panel.getAnimations({ subtree: true }).map(animation => animation.finished)))
        const card = calendar.locator('[data-route-card="calendar"]')
        await card.evaluate(async element => {
            element.scrollIntoView({ block: 'center', behavior: 'instant' })
            const paint = () => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))
            await paint()
            scrollBy({ top: -15, behavior: 'instant' })
            await paint()
        })
        const nav = page.locator('.linen-nav')
        await nav.evaluate(async element => {
            await Promise.allSettled(element.getAnimations().map(animation => animation.finished))
        })
        const navbarBottom = await nav.evaluate(element => element.getBoundingClientRect().bottom)
        assert.ok(navbarBottom > 10, 'The navbar is visible when opening the calendar album')
        const mobile = width < 500
        if (!mobile) await observeLiveTitleHandoff(page, 'enter')
        await card.click()
        const entering = page.locator('main[data-route-page-motion="enter"]')
        await entering.waitFor({ state: 'attached' })
        const phoneFade = page.locator('.route-page-touch-fade')
        if (mobile) await phoneFade.waitFor({ state: 'attached' })
        else await assertLiveTitleHandoff(page, 'enter')
        await entering.waitFor({ state: 'detached' })
        if (!mobile) await observeLiveTitleHandoff(page, 'return', navbarBottom)
        await page.goBack()
        await page.locator('main[data-route-page-motion="return"]').waitFor({ state: 'attached' })
        if (mobile) await phoneFade.waitFor({ state: 'attached' })
        else await assertLiveTitleHandoff(page)
        assert.equal(await card.locator('strong').textContent(), 'Album 1')
        const result = { engine, width, check: 'calendar year and day animations, stable heatmap, and album navigation', passed: true }
        outcomes.push(result); console.log(JSON.stringify(result))
    } finally { await context.close() }
}

async function pageFadeCase(width) {
    const { context, page, cdp } = await openCase({ width })
    try {
        if (cdp) await cdp.send('Emulation.setCPUThrottlingRate', { rate: 1 })
        const fade = page.locator('#main-content[data-route-page-motion]')
        await page.evaluate(() => {
            const main = document.getElementById('main-content')
            window.__visitor.pageFades = []
            new MutationObserver(() => {
                const motion = main.dataset.routePageMotion
                const surface = main.parentElement.querySelector('.route-page-touch-fade') || main
                const animation = surface.getAnimations()[0]
                if (!motion || !animation) return
                window.__visitor.pageFades.push({
                    motion,
                    duration: animation.effect.getTiming().duration,
                    from: Number(animation.effect.getKeyframes()[0].opacity),
                    loading: Boolean(main.querySelector('[data-route-loading]')),
                    duplicate: main.firstElementChild.getAnimations().some(entry => entry.animationName === 'fade-in'),
                })
            }).observe(main, { attributes: true, attributeFilter: ['data-route-page-motion'] })
            document.addEventListener('transitionrun', event => {
                if (event.target.id === 'nav-dropdown-apps' && event.propertyName === 'opacity') window.__visitor.navRevealed = true
                if (event.target.matches('.site-select-menu') && event.propertyName === 'opacity') {
                    window.__visitor[event.target.hasAttribute('data-open') ? 'menuRevealed' : 'menuDismissed'] = true
                }
            })
        })
        const desktop = width >= 1080
        const appsLink = page.locator(desktop ? '.linen-desktop-links' : '#site-menu')
            .getByRole('link', { name: 'Apps', exact: true })
        if (desktop) {
            await appsLink.hover()
            await page.waitForFunction(() => window.__visitor.navRevealed)
            await page.locator('#nav-dropdown-apps').getByRole('link', { name: 'TruongCam', exact: false }).waitFor()
        }
        const sort = page.getByRole('combobox', { name: 'Sort sections', exact: true })
        const list = page.getByRole('listbox', { name: 'Sort sections', exact: true })
        await sort.scrollIntoViewIfNeeded()
        await sort.focus()
        await sort.press('ArrowDown')
        await page.waitForFunction(() => window.__visitor.menuRevealed)
        await list.waitFor()
        assert.ok(await list.evaluate(menu => parseFloat(getComputedStyle(menu).transitionDuration)) >= .45,
            'Dropdown options ease in over at least 450 ms')
        await list.evaluate(menu => Promise.allSettled(menu.getAnimations().map(motion => motion.finished)))
        await sort.press('Escape')
        assert.equal(await list.count(), 0)
        await page.waitForFunction(() => window.__visitor.menuDismissed)
        await page.locator('.site-select-menu[inert]').waitFor({ state: 'detached' })

        // Use a nonzero offset that keeps the scroll-aware navbar visible.
        await sort.evaluate(control => control.blur())
        await page.evaluate(() => scrollTo({ top: 38, behavior: 'instant' }))
        await page.waitForFunction(() => Math.abs(scrollY - 38) <= 1)
        if (!desktop) await page.getByRole('button', { name: 'Open menu' }).click()
        const homeEntry = await page.evaluate(() => history.state.key)
        await page.evaluate(() => {
            const scroll = window.scrollTo
            window.__visitor.restoreScrollSpy = () => { window.scrollTo = scroll }
            window.scrollTo = function (options) {
                if (options?.top === 0) window.__visitor.brandScrollBehavior = options.behavior
                return scroll.apply(this, arguments)
            }
        })
        await page.locator('.linen-brand').click()
        await page.waitForFunction(() => scrollY === 0 && !document.documentElement.hasAttribute('data-menu-scroll-lock'))
        assert.deepEqual(await page.evaluate(() => {
            window.__visitor.restoreScrollSpy()
            return [history.state.key, window.__visitor.brandScrollBehavior]
        }), [homeEntry, 'smooth'], 'The Home brand scrolls to the top without navigating')

        await page.evaluate(() => scrollTo({ top: 38, behavior: 'instant' }))
        await page.waitForFunction(() => Math.abs(scrollY - 38) <= 1)
        if (!desktop) await page.getByRole('button', { name: 'Open menu' }).click()
        const scroll = await page.evaluate(() => {
            const frozen = document.documentElement.hasAttribute('data-menu-scroll-lock')
            return frozen ? -parseFloat(document.body.style.top) : scrollY
        })
        assert.ok(scroll > 0)
        // A cold page must fade on arrival even if its module briefly shows a fallback.
        await page.route(/\/Apps-[^/]+\.js$/, async route => {
            await new Promise(done => setTimeout(done, 450))
            await route.fallback()
        })
        const appsPanel = page.locator('#nav-dropdown-apps')
        if (desktop) {
            await appsLink.hover()
            await page.waitForFunction(() => getComputedStyle(document.querySelector('#nav-dropdown-apps')).opacity === '1')
        }
        await appsLink.click()
        await page.waitForURL('**/apps')
        if (desktop) {
            const pendingNavigation = await appsPanel.evaluate(panel => [
                Boolean(document.querySelector('main .visitor-photo-catalog')), getComputedStyle(panel).visibility, panel.inert,
            ])
            assert.deepEqual(pendingNavigation, [true, 'visible', true], 'An open panel shields the old page while the cold destination loads')
        }
        await page.waitForFunction(() => window.__visitor.pageFades.length === 1)
        if (desktop) {
            const hiddenOnNavigation = await appsPanel.evaluate(panel => {
                const { opacity, visibility, transitionProperty } = getComputedStyle(panel)
                return [opacity, visibility, transitionProperty]
            })
            assert.deepEqual(hiddenOnNavigation, ['0', 'hidden', 'none'], 'The retiring navbar panel cannot show through the next page')
        }
        const enterFrames = await page.evaluate(() => window.__visitor.pageFades[0])
        assert.equal(enterFrames.loading, false, 'The fade runs on the page itself')
        assert.equal(enterFrames.duplicate, false, 'The new page has a single entrance fade')
        if (width < 500) {
            assert.equal(enterFrames.duration, 320)
            assert.equal(enterFrames.from, .92, 'The viewport overlay starts faded over the incoming page')
        } else {
            assert.ok(enterFrames.duration >= 370 && enterFrames.duration <= 400, 'A page fades in without a long wait')
            assert.equal(enterFrames.from, 0, 'Incoming text starts fully hidden while the route settles')
        }
        assert.equal(await page.locator('[data-route-card-morph]').count(), 0)
        await fade.waitFor({ state: 'detached' })
        // A synthetic horizontal wheel event stands in for residual trackpad
        // momentum after the browser has committed the history traversal.
        await page.evaluate(() => window.addEventListener('popstate', () => requestAnimationFrame(() => {
            window.dispatchEvent(new WheelEvent('wheel', { deltaX: -120, deltaY: 3 }))
        }), { once: true }))
        await page.goBack()
        await page.waitForFunction(() => window.__visitor.pageFades.length === 2)
        await page.waitForFunction(top => Math.abs(scrollY - top) <= 1, scroll)
        const returnFrames = await page.evaluate(() => window.__visitor.pageFades[1])
        assert.equal(returnFrames.motion, 'return')
        assert.equal(returnFrames.duration, enterFrames.duration)
        await fade.waitFor({ state: 'detached' })
        await page.goForward()
        await page.waitForFunction(() => window.__visitor.pageFades.length === 3)
        await fade.waitFor({ state: 'detached' })

        await page.emulateMedia({ reducedMotion: 'reduce' })
        if (!desktop) await page.getByRole('button', { name: 'Open menu' }).click()
        await page.goBack()
        if (!desktop) await page.getByRole('button', { name: 'Open menu' }).waitFor()
        await sort.waitFor()
        await sort.focus()
        await sort.press('ArrowDown')
        assert.equal(await list.evaluate(menu => getComputedStyle(menu).transitionProperty), 'none')
        assert.equal(await page.evaluate(() => window.__visitor.pageFades.length), 3)
        const result = { engine, width, check: 'page and dropdown fades, history scroll restoration and reduced motion', passed: true }
        outcomes.push(result); console.log(JSON.stringify(result))
    } finally { await context.close() }
}

async function albumLowerEdgeOpeningCase(width, partial = false) {
    const { context, page, cdp } = await openCase({ width })
    try {
        if (cdp) await cdp.send('Emulation.setCPUThrottlingRate', { rate: 1 })
        const card = page.locator('.catalog-section [data-route-card="album"]').first()
        const position = await card.evaluate(async (link, partial) => {
            const title = link.querySelector('h3')
            const paint = () => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))
            await document.fonts.ready
            link.scrollIntoView({ block: 'center', behavior: 'instant' })
            await paint()
            // Scroll-linked transforms can change the card position after the first update.
            for (let i = 0; i < 5; i++) {
                const rect = title.getBoundingClientRect()
                const offset = rect.bottom - innerHeight + (partial ? -rect.height / 2 : 22)
                if (Math.abs(offset) < 2) break
                scrollBy({ top: offset, behavior: 'instant' })
                await paint()
            }
            const tile = link.getBoundingClientRect()
            const rect = title.getBoundingClientRect()
            return { cardBottom: tile.bottom, titleTop: rect.top, titleBottom: rect.bottom, viewport: innerHeight,
                x: (tile.left + tile.right) / 2, y: (tile.top + Math.min(tile.bottom, innerHeight)) / 2 }
        }, partial)
        assert.ok(position.cardBottom > position.viewport && position.titleTop < position.viewport
            && (partial ? position.titleBottom > position.viewport : position.titleBottom <= position.viewport
                && position.titleBottom >= position.viewport - 65), `The title is ${partial ? 'partly visible' : 'visible'} at the viewport edge (${JSON.stringify(position)})`)
        await card.evaluate(link => {
            const title = link.querySelector('h3')
            const main = link.closest('main')
            const glyphTop = element => {
                const glyphs = document.createRange()
                glyphs.selectNodeContents(element)
                return glyphs.getBoundingClientRect().top
            }
            window.addEventListener('click', () => { window.__visitor.originalGlyphTop = glyphTop(title) }, { capture: true, once: true })
            window.__visitor.lowerEdgeTitle = []
            new MutationObserver(() => {
                const copy = document.querySelector('.route-card-title')
                if (!copy) return
                const style = getComputedStyle(copy)
                const mode = main.dataset.routePageMotion ?? 'prepare'
                window.__visitor.lowerEdgeTitle.push({ mode, top: glyphTop(copy), opacity: Number(style.opacity),
                    clip: style.clipPath, windowClip: getComputedStyle(copy.parentElement).clipPath,
                    moves: copy.getAnimations().some(animation => animation.effect.getKeyframes()[0].transform !== undefined) })
            }).observe(main, { attributes: true, attributeFilter: ['data-route-page-staged', 'data-route-page-motion'] })
        })
        if (width < 500 && engine !== 'firefox') await page.touchscreen.tap(position.x, position.y)
        else await page.mouse.click(position.x, position.y)
        await page.waitForFunction(() => window.__visitor.lowerEdgeTitle.some(state => state.mode === 'enter'))
        const { frames, original } = await page.evaluate(() => ({ frames: window.__visitor.lowerEdgeTitle, original: window.__visitor.originalGlyphTop }))
        const prepared = frames.find(frame => frame.mode === 'prepare')
        const moving = frames.find(frame => frame.mode === 'enter')
        assert.ok(prepared?.opacity === 1 && Math.abs(prepared.top - original) < 1, 'The title starts on the actual text at full opacity')
        assert.ok(moving.moves && frames.every(frame => frame.clip === 'none' && frame.windowClip === 'none'),
            'The moving title uses only the viewport crop')
        if (partial) {
            await page.locator('main[data-route-page-motion]').waitFor({ state: 'detached' })
            await page.goBack()
            await page.waitForFunction(() => window.__visitor.lowerEdgeTitle.some(state => state.mode === 'return'))
            const returning = await page.evaluate(() => window.__visitor.lowerEdgeTitle.find(state => state.mode === 'return'))
            assert.ok(returning.moves && returning.clip === 'none' && returning.windowClip === 'none',
                'The title moves back to the partially visible card with the same viewport crop')
            await page.locator('main[data-route-page-motion]').waitFor({ state: 'detached' })
        }
        const result = { engine, width, check: `a ${partial ? 'partially clipped' : 'visible'} album title moves at the lower viewport edge without a clipping flash`, passed: true }
        outcomes.push(result); console.log(JSON.stringify(result))
    } finally { await context.close() }
}

async function routeCardClipCase(width, timeline = false, sliver = false) {
    const { context, page, cdp } = await openCase({ width, titleSuffix: timeline ? ' · Canopy study' : ' · Evening light' })
    try {
        if (cdp) await cdp.send('Emulation.setCPUThrottlingRate', { rate: 1 })
        if (timeline) {
            if (width < 1080) await page.getByRole('button', { name: 'Open menu' }).click()
            await page.locator(width < 1080 ? '#site-menu' : '.linen-desktop-links').getByRole('link', { name: 'Stats', exact: true }).click()
            await page.waitForURL('**/stats')
            await page.locator('.photo-stats-timeline-scroll').waitFor()
            await page.locator('main[data-route-page-motion]').waitFor({ state: 'detached' })
        }
        await page.addStyleTag({ content: '[data-scroll-row], .photo-stats-timeline-scroll { scroll-snap-type: none !important }' })
        const cards = page.locator(timeline ? '[data-route-card="timeline"]' : '.catalog-section [data-route-card="album"]')
        const index = timeline ? await cards.evaluateAll((elements, sliver) => {
            const row = elements[0].closest('.photo-stats-timeline-scroll')
            const left = row.getBoundingClientRect().left
            return elements.findIndex(card => {
                const start = card.getBoundingClientRect().left - left + row.scrollLeft
                return sliver ? start > row.clientWidth && start + 10 < row.scrollWidth
                    : start >= 72 && start + 48 <= row.scrollWidth - row.clientWidth
            })
        }, sliver) : 0
        assert.ok(index >= 0, 'A card can be positioned partly outside the row')
        const card = cards.nth(index)
        const edge = await card.evaluate(async (element, sliver) => {
            const paint = () => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))
            const row = element.closest('[data-scroll-row], .photo-stats-timeline-scroll')
            element.scrollIntoView({ block: 'center', behavior: 'instant' })
            await paint()
            const rowRect = row.getBoundingClientRect()
            row.scrollLeft += element.getBoundingClientRect().left - (sliver ? rowRect.right - 10 : rowRect.left - 48)
            await paint()
            const bounds = element.getBoundingClientRect()
            const { left, right } = row.getBoundingClientRect()
            const x = sliver ? (bounds.left + right) / 2 : (left + bounds.right) / 2
            const y = bounds.top + bounds.height / 2
            return { clipped: sliver ? bounds.right - right : left - bounds.left, x, y, hit: element.contains(document.elementFromPoint(x, y)),
                left: Math.max(0, left), right: Math.min(innerWidth, right), gradient: getComputedStyle(row).maskImage }
        }, sliver)
        assert.ok(edge.clipped >= 40 && edge.hit, `The card is clickable and partly outside the row (${JSON.stringify(edge)})`)
        if (width < 500 && engine !== 'firefox') await page.touchscreen.tap(edge.x, edge.y)
        else await page.mouse.click(edge.x, edge.y)
        const title = page.locator('[data-route-card-morph] .route-card-title').first()
        if (!sliver) {
            const masking = await title.evaluate(element => ({
                clip: element.style.clipPath, gradient: getComputedStyle(element).maskImage,
                offset: parseFloat(element.style.maskPosition), width: parseFloat(element.style.maskSize),
                maskClip: getComputedStyle(element).maskClip, size: element.style.maskSize,
            }))
            assert.match(masking.clip, /^inset\(/, 'A partly visible card morphs its visible title crop')
            if (!timeline) {
                assert.equal(masking.gradient, edge.gradient, 'The title carries the same gradient as the carousel')
                assert.ok(masking.offset > 0 && masking.width >= width - 80, 'The gradient aligns with the carousel edge')
                assert.equal(masking.maskClip, 'no-clip', 'The gradient can paint beyond the title box')
                assert.match(masking.size, /calc\(100% \+ 0\.5em\)/, 'The gradient extends past the descenders')
            }
        }
        await page.waitForURL('**/album/**')
        const entering = page.locator('main[data-route-page-motion="enter"]')
        await entering.waitFor({ state: 'attached' })
        if (!sliver) await assertClippedTitlePace(title, false)
        await assertTitleWindow(title, false, edge.left)
        assert.equal(await page.locator('.route-card-outline').count(), 0, 'A clipped title travels without an outline')
        await entering.waitFor({ state: 'detached' })
        await page.goBack()
        const returning = page.locator('main[data-route-page-motion="return"]')
        await returning.waitFor({ state: 'attached' })
        if (timeline) {
            const landing = await page.locator('.route-card-title').last().evaluate(element => {
                const animations = element.getAnimations().map(animation => animation.effect.getKeyframes())
                const transform = animations.find(frames => frames[0].transform).at(-1).transform
                return { x: new DOMMatrix(transform).e, crop: getComputedStyle(element).clipPath,
                    landsOpaque: animations.some(frames => Number(frames[0].opacity) === 0 && Number(frames.at(-1).opacity) === 1) }
            })
            assert.equal(landing.crop, 'none', 'Only the timeline row crops the title on return')
            assert.ok(landing.landsOpaque, 'The title keeps its opacity as the card disappears behind the row edge')
            if (sliver) assert.ok(landing.x > edge.right - 18, `The title returns to the partly hidden card (${landing.x} vs ${edge.right})`)
        } else await assertClippedTitlePace(title, true)
        await assertTitleWindow(title, true, edge.left)
        assert.equal(await page.locator('.route-card-outline').count(), 0, 'A clipped title returns without an outline')
        const result = { engine, width, check: `${sliver ? 'nearly hidden' : 'partly visible'} ${timeline ? 'timeline' : 'carousel'} titles stay inside the row at the handoff`, passed: true }
        outcomes.push(result); console.log(JSON.stringify(result))
    } finally { await context.close() }
}

function parseInsets(clip) {
    const [top, right = top, bottom = top, left = right] = clip.slice(6, -1).split(/\s+/).map(part => Number.parseFloat(part))
    return { top, right, bottom, left }
}

async function assertTitleWindow(title, returning, left) {
    const [first, second] = await title.evaluate((element, returning) => {
        const animation = element.parentElement.getAnimations().find(entry => entry.effect.getKeyframes()[0].clipPath)
        const frames = animation?.effect.getKeyframes() ?? [{ clipPath: getComputedStyle(element.parentElement).clipPath },
            { clipPath: getComputedStyle(element.parentElement).clipPath }]
        return (returning ? frames.slice(-2) : frames.slice(0, 2)).map(frame => frame.clipPath)
    }, returning)
    assert.equal(first, second, 'The clipping window stays fixed by the row during the handoff')
    const insets = parseInsets(first)
    assert.ok(Math.abs(left - insets.left) < 1, 'Text is clipped to the row boundary')
    assert.deepEqual([insets.top, insets.bottom], [0, 0], 'A horizontal crop does not trim moving letterforms vertically')
}

async function assertClippedTitlePace(title, returning) {
    const motion = await title.evaluate(element => {
        const clip = element.getAnimations().find(animation => animation.effect.getKeyframes()[0].clipPath)
        return clip && { duration: clip.effect.getTiming().duration, crop: clip.effect.getKeyframes().map(frame => frame.clipPath) }
    })
    assert.ok(motion?.duration >= 350)
    assert.notEqual(motion.crop[0], motion.crop[1], 'The title crop changes continuously')
    const insets = motion.crop.map(parseInsets)
    assert.ok(insets.every(({ top, bottom }) => top < 0 && bottom < 0), 'The full glyphs have room on both ends of the morph')
    const { left, right } = insets[returning ? 0 : 1]
    assert.deepEqual([left, right], [0, 0], 'The album heading is uncropped horizontally')
}

async function routeCardEdgeOnlyCase(width, horizontal = false) {
    const { context, page, cdp } = await openCase({ width })
    try {
        if (cdp) await cdp.send('Emulation.setCPUThrottlingRate', { rate: 1 })
        const cards = page.locator('.catalog-section').first().locator('[data-route-card="album"]')
        const card = horizontal ? cards.last() : cards.first()
        if (horizontal) await page.addStyleTag({ content: '[data-scroll-row] { scroll-snap-type: none !important }' })
        const position = await card.evaluate(async (element, horizontal) => {
            const paint = () => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))
            const row = element.closest('[data-scroll-row]')
            const boundary = () => Math.min(innerWidth, row.getBoundingClientRect().right)
            if (horizontal) row.scrollIntoView({ block: 'center', behavior: 'instant' })
            else element.scrollIntoView({ block: 'center', behavior: 'instant' })
            await paint()
            if (horizontal) row.scrollLeft += element.getBoundingClientRect().left - boundary() + 56
            else scrollBy({ top: element.getBoundingClientRect().top - innerHeight + 72, behavior: 'instant' })
            await paint()
            const rect = element.getBoundingClientRect()
            const title = element.querySelector('h3').getBoundingClientRect()
            const visible = horizontal ? boundary() - rect.left : innerHeight - rect.top
            const y = rect.top + (horizontal ? rect.height / 3 : visible / 2)
            let x = rect.left + rect.width / 2
            if (horizontal) {
                x = rect.left + 6
                while (x < boundary() && !element.contains(document.elementFromPoint(x, y))) x += 3
            }
            return { x, y, hit: element.contains(document.elementFromPoint(x, y)),
                visible, titlePeeks: horizontal ? title.left < boundary() : title.top < innerHeight,
                fraction: visible / (horizontal ? rect.width : rect.height), scroll: scrollY, rowScroll: row.scrollLeft }
        }, horizontal)
        assert.ok(position.hit && position.visible > 12 && position.fraction < .25 && position.titlePeeks === horizontal,
            `The card exposes only a sliver (${JSON.stringify(position)})`)
        await page.evaluate(() => {
            const main = document.querySelector('main')
            window.__visitor.sliverFades = []
            new MutationObserver(() => {
                const mode = main.dataset.routePageMotion
                if (!mode) return
                const title = document.querySelector('.route-card-title')
                const motion = title?.getAnimations().find(animation => animation.effect.getKeyframes()[0].transform)
                const frames = motion?.effect.getKeyframes()
                const tucked = frames?.[mode === 'enter' ? 0 : frames.length - 1].transform
                const matrix = tucked && new DOMMatrix(tucked)
                window.__visitor.sliverFades.push({ mode, box: Boolean(document.querySelector('.route-card-outline')),
                    moving: Boolean(frames && frames[0].transform !== frames.at(-1).transform),
                    anchor: matrix && [matrix.e, matrix.f], duration: motion?.effect.getTiming().duration })
            }).observe(main, { attributes: true, attributeFilter: ['data-route-page-motion'] })
        })
        if (width < 500 && engine !== 'firefox') await page.touchscreen.tap(position.x, position.y)
        else await page.mouse.click(position.x, position.y)
        await page.waitForURL('**/album/**')
        await page.waitForFunction(() => window.__visitor.sliverFades.length === 1)
        await page.locator('main[data-route-page-motion="enter"]').waitFor({ state: 'detached' })
        await page.goBack()
        await page.waitForFunction(() => window.__visitor.sliverFades.length === 2)
        await page.locator('main[data-route-page-motion="return"]').waitFor({ state: 'detached' })
        const motions = await page.evaluate(() => window.__visitor.sliverFades)
        assert.deepEqual(motions.map(motion => motion.mode), ['enter', 'return'])
        for (const motion of motions) {
            assert.ok(!motion.box && motion.moving && motion.duration >= 350, `The heading travels without an outline (${JSON.stringify(motion)})`)
            const edge = horizontal ? position.x : position.y + position.visible / 2
            const offset = motion.anchor[horizontal ? 0 : 1] - edge
            assert.ok(horizontal ? Math.abs(offset) < 12 : offset >= 0 && offset < 24,
                `The heading travels ${horizontal ? 'from the carousel edge' : 'through the viewport edge'} (${offset}px away)`)
        }
        const final = await card.evaluate(element => [scrollY, element.closest('[data-scroll-row]').scrollLeft])
        assert.ok(Math.abs(final[0] - position.scroll) < 2 && Math.abs(final[1] - position.rowScroll) < 2, 'The gallery restores both scroll positions')
        const result = { engine, width, check: `${horizontal ? 'carousel' : 'viewport'} slivers move the heading from the visible edge without a box`, passed: true }
        outcomes.push(result); console.log(JSON.stringify(result))
    } finally { await context.close() }
}

async function floatingEdgeCase(width) {
    const { context, page, cdp } = await openCase({ width })
    let releaseAlbum
    try {
        if (cdp) await cdp.send('Emulation.setCPUThrottlingRate', { rate: 1 })
        const card = page.locator('.floating-lane-0 [data-route-card="floating"]').first()
        await card.locator('img.progressive-image-ready').waitFor({ state: 'attached' })
        const href = await card.getAttribute('href')
        const hold = new Promise(resolve => { releaseAlbum = resolve })
        await page.route(`**/public/albums/${href.split('/').at(-1)}`, async route => { await hold; await route.fallback() })
        await page.evaluate(async () => {
            await document.fonts.ready
            Object.defineProperty(document.fonts, 'status', { configurable: true, value: 'loading' })
        })
        const edge = await card.evaluate(element => {
            const lane = element.closest('.floating-lane')
            const track = element.closest('.floating-loop-track')
            const animation = track.getAnimations()[0]
            lane.scrollIntoView({ block: 'center', behavior: 'instant' })
            animation.pause()
            animation.currentTime = 0
            const left = Math.max(0, lane.getBoundingClientRect().left)
            const start = element.getBoundingClientRect()
            const strip = Math.round(start.width * .2)
            animation.currentTime = (start.right - left - strip) / (track.offsetWidth / 2) * animation.effect.getTiming().duration
            const bounds = element.getBoundingClientRect()
            const y = bounds.top + bounds.height / 3
            const x = (left + bounds.right) / 2
            return { x, y, left, fraction: (bounds.right - left) / bounds.width,
                hit: element.contains(document.elementFromPoint(x, y)) }
        })
        assert.ok(edge.hit && edge.fraction > .1 && edge.fraction < .25, 'A sliver of the auto-scrolling card is clickable')
        if (width < 500 && engine !== 'firefox') await page.touchscreen.tap(edge.x, edge.y)
        else await page.mouse.click(edge.x, edge.y)
        const morph = page.locator('[data-route-card-morph]')
        const floatingMedia = morph.locator('img, canvas, svg, video, .route-card-photo-strip, .route-card-outline')
        await morph.waitFor({ state: 'attached' })
        assert.equal(await floatingMedia.count(), 0, 'The original carousel takes its covers with it during a cold departure')
        await page.waitForFunction(() => document.querySelector('.route-card-preview')
            && document.querySelector('.route-card-title')?.getAnimations().some(animation =>
                animation.effect.getKeyframes()[0].transform))
        const previewTitle = await morph.locator('.route-card-title').first().evaluate(element => ({
            crop: getComputedStyle(element).clipPath, column: getComputedStyle(element.parentElement).clipPath,
        }))
        assert.equal(previewTitle.crop, 'none', 'The preview title travels without a second crop on the glyphs')
        assert.ok(Math.abs(parseInsets(previewTitle.column).left - edge.left) < 1, 'The title emerges from the carousel lane')
        await page.locator('.route-card-preview h1:not([data-route-title-landing])').waitFor()
        releaseAlbum()
        const entering = page.locator('main[data-route-page-motion="enter"]')
        await entering.waitFor({ state: 'attached' })
        const motion = await morph.evaluate(element => {
            const title = element.querySelector('.route-card-title')
            const travel = title?.getAnimations().find(animation => animation.effect.getKeyframes()[0].transform)
            const fade = document.querySelector('main').getAnimations()[0]
            return { travel: travel?.effect.getTiming().duration, revealDelay: fade.effect.getTiming().delay }
        })
        assert.deepEqual(motion, { travel: 175, revealDelay: 175 })
        assert.equal(await floatingMedia.count(), 0, 'Only the title lifts from the carousel edge')
        await page.evaluate(() => { delete document.fonts.status })
        await entering.waitFor({ state: 'detached' })
        await morph.waitFor({ state: 'detached' })
        await page.goBack()
        const returning = page.locator('main[data-route-page-motion="return"]')
        await returning.waitFor({ state: 'attached' })
        const heldTrack = page.locator('.floating-print-wall[data-route-card-hold] .floating-loop-track').first()
        assert.equal(await heldTrack.evaluate(track => getComputedStyle(track).animationPlayState), 'paused')
        assert.equal(await returning.evaluate(main => main.getAnimations()[0].effect.getTiming().duration), 400)
        assert.equal(await morph.locator('.route-card-title').count(), 2, 'The title returns to its position on the moving card')
        await assertTitleWindow(morph.locator('.route-card-title').first(), true, edge.left)
        await returning.waitFor({ state: 'detached' })
        await page.goForward()
        await morph.waitFor({ state: 'attached' })
        await entering.waitFor({ state: 'attached' })
        const forwardTravel = await morph.locator('.route-card-title').first().evaluate(title =>
            title.getAnimations().find(animation => 'transform' in animation.effect.getKeyframes()[0])?.effect.getTiming().duration)
        assert.equal(forwardTravel, 320, 'A quick Forward replay still moves the title')
        assert.equal(await floatingMedia.count(), 0, 'Forward leaves the cover with the carousel')
        await entering.waitFor({ state: 'detached' })
        const result = { engine, width, check: 'a clipped carousel cover leaves with the other cards, while the title moves on entry and Forward', passed: true }
        outcomes.push(result); console.log(JSON.stringify(result))
    } finally { releaseAlbum?.(); await context.close() }
}

try {
    const albumTitlesOnly = process.env.VISITOR_ALBUM_TITLES_ONLY === '1'
    const photoCardMotionOnly = process.env.VISITOR_PHOTO_CARD_MOTION_ONLY === '1'
    const widths = engine === 'firefox' || albumTitlesOnly || photoCardMotionOnly ? [1440] : [1440, 390]
    for (const width of widths) {
        if (photoCardMotionOnly) {
            await slowPhotoCardMotionCase(width, 'motion module')
            await slowPhotoCardMotionCase(width, 'photo')
            continue
        }
        if (albumTitlesOnly) {
            await wrappedAlbumTitleMotionCase(width)
            await slowAlbumTitleMotionCase(width, 'photo')
            await slowAlbumTitleMotionCase(width, 'video')
            await slowAlbumTitleMotionCase(width, 'photo', true)
            await albumLowerEdgeOpeningCase(width)
            await albumLowerEdgeOpeningCase(width, true)
            await routeCardClipCase(width)
            await routeCardClipCase(width, true)
            await routeCardClipCase(width, true, true)
            await routeCardEdgeOnlyCase(width)
            await routeCardEdgeOnlyCase(width, true)
            await floatingEdgeCase(width)
            continue
        }
        if (process.env.VISITOR_SHARE_HANDOFF_ONLY === '1') {
            await viewerCase(width, false, 'featured')
            continue
        }
        if (process.env.VISITOR_VIEWERS_ONLY === '1') {
            await photoDetailCase(width)
            await viewerCase(width)
            await viewerCase(width, true)
            await viewerCase(width, false, 'featured')
            continue
        }
        if (baselineRoot) for (const count of [85, 300]) for (const baseline of [true, false, false, true]) await performanceCase({ width, count, baseline })
        else await performanceCase({ width, count: 85 })
        if (process.env.VISITOR_COMPARE_ONLY === '1') continue
        if (baselineRoot) await stressCase(width, true)
        await stressCase(width)
        await pageFadeCase(width)
        if (width < 500) {
            await mobileAlbumHeaderCase()
            await mobileScrollAndAutoplayCase()
            await mobileMediaMotionCase()
        } else {
            await routeCardMotionCase(width)
            await wrappedAlbumTitleMotionCase(width)
            await slowAlbumTitleMotionCase(width, 'photo')
            await slowAlbumTitleMotionCase(width, 'video')
            await slowAlbumTitleMotionCase(width, 'photo', true)
            await albumLowerEdgeOpeningCase(width)
            await albumLowerEdgeOpeningCase(width, true)
            await routeCardClipCase(width)
            await routeCardClipCase(width, true)
            await routeCardClipCase(width, true, true)
            await routeCardEdgeOnlyCase(width)
            await routeCardEdgeOnlyCase(width, true)
            await floatingEdgeCase(width)
            await videoLightboxFrameCase(width)
            await routeSectionMotionCase(width)
            await routeTimelineLandingCase(width)
            await lightboxStabilityCase(width)
            await slowPhotoCardMotionCase(width, 'motion module')
            await slowPhotoCardMotionCase(width, 'photo')
        }
        await qrMotionCase(width)
        await exploreHandoffCase(width)
        await calendarYearCase(width)
        await photoDetailCase(width)
        await viewerCase(width)
        await viewerCase(width, true)
        await viewerCase(width, false, 'featured')
    }
} finally {
    await browser.close(); server.close()
    if (evidence) await writeFile(resolve(evidence, `${engine}-visitor-results.json`), JSON.stringify({
        scope: 'Local production builds, synthetic 85/300-album catalogs, generated raster WebP covers. CPU4 only on Chromium, DPR3 mobile. All API/media intercepted; no production writes. Lab results, not real-device or field percentiles.', outcomes,
    }, null, 2) + '\n')
}
console.log(`Passed ${outcomes.length} visitor browser checks (${engine}).`)
