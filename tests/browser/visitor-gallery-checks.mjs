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
        }
    })
    const photos = Array.from({ length: 6 }, (_, index) => ({
        id: createHash('sha256').update(`photo-${index}`).digest('hex').slice(0, 24),
        albumId: items[0].albumId, albumTitle: 'Fixture photographs', altText: `Fixture photograph ${index + 1}`,
        url: `https://${mediaDomain}/photos/photo-${index}-w1920.webp`,
        thumbnailUrl: `https://${mediaDomain}/photos/photo-${index}-w640.webp`,
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

async function openCase({ width, count = 85, baseline = false, moduleDelay = 0, failModule = false, imageDelay = 0 }) {
    const context = await browser.newContext({ viewport: { width, height: 900 }, deviceScaleFactor: width < 500 ? 3 : 1,
        ...(engine !== 'firefox' ? { isMobile: width < 500, hasTouch: width < 500 } : {}), serviceWorkers: 'block' })
    const data = fixture(count), traffic = [], errors = []
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
            if (!['GET', 'HEAD', 'POST'].includes(request.method()) || (request.method() === 'POST' && !/\/(download-url|print|original-comparison)$/.test(url.pathname))) {
                errors.push(`Blocked unexpected API action: ${request.method()} ${url.pathname}`)
                return route.abort()
            }
            let body = { items: [], images: [], nextCursor: null }
            if (url.pathname.endsWith('/download-url')) body = { downloadUrl: origin + '/fixture-download.webp' }
            else if (url.pathname.endsWith('/print')) body = { sessionToken: 'fixture-'.repeat(16) }
            else if (url.pathname.includes('/random-photos') || url.pathname.includes('/featured-photos')) body = { images: data.photos, totalPhotos: 6 }
            else if (/\/public\/albums\/[^/]+$/.test(url.pathname)) {
                const album = data.items.find(item => item.albumId === url.pathname.split('/').pop()) || data.items[0]
                body = { album: { ...album, images: data.photos }, images: data.photos }
            } else if (url.pathname.endsWith('/public/albums')) body = { items: data.items, nextCursor: null }
            return route.fulfill({ contentType: 'application/json', headers, body: JSON.stringify(body) })
        }
        if (url.origin === origin && url.pathname === '/fixture-download.webp') return route.continue()
        if (request.resourceType() === 'document' && url.origin !== origin && url.pathname === '/print.html') return route.fulfill({ contentType: 'text/html', body: '<!doctype html><title>Fixture checkout</title><h1>Fixture print options</h1>' })
        if (request.resourceType() === 'image') {
            if (imageDelay) await new Promise(done => setTimeout(done, imageDelay))
            const width = Number(url.pathname.match(/-w(\d+)/)?.[1] || url.pathname.match(/hero-(\d+)/)?.[1] || 640)
            return route.fulfill({ contentType: 'image/webp', headers: { 'access-control-allow-origin': '*' }, body: images[width] || images[1920] }).catch(() => {})
        }
        if (url.hostname === mediaDomain && url.pathname.endsWith('.json')) {
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
        const pendingBounds = await page.getByRole('img', { name: 'Fixture photograph 1', exact: true }).boundingBox()
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
            await page.getByRole('button', { name: 'Order a print of this photo', exact: true }).click()
            await page.getByRole('dialog', { name: 'Print options', exact: true }).waitFor()
            await page.waitForTimeout(3250)
            assert.equal(await page.getByRole('dialog', { name: 'Print options', exact: true }).isVisible(), true)
            await page.getByRole('button', { name: 'Close print options', exact: true }).click()
            // The host closes through a separate React root. Check the
            // completed close and its focus restoration, rather than racing
            // that root's effect cleanup immediately after the click.
            await page.getByRole('dialog', { name: 'Print options', exact: true }).waitFor({ state: 'hidden' })
            await page.waitForFunction(() => document.querySelector('.linen-lightbox-print') === document.activeElement, null, { timeout: 2000 })
            assert.equal(traffic.filter(request => request.path.endsWith('/print')).length, 1)
        }
        if (failModule) {
            await page.getByRole('alert').filter({ hasText: 'Photo controls could not be loaded' }).waitFor()
            await page.getByRole('button', { name: 'Try again', exact: true }).click()
        }
        await page.locator('.explorer-viewer-pending').waitFor({ state: 'hidden' })
        await page.getByRole('button', { name: 'Download photo', exact: true }).waitFor()
        const readyBounds = await page.locator('.linen-lightbox-edited').boundingBox()
        for (const dimension of ['x', 'y', 'width', 'height']) assert.ok(Math.abs(pendingBounds[dimension] - readyBounds[dimension]) <= 2, `Photo ${dimension} shifted on viewer handoff`)
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

try {
    const widths = engine === 'firefox' ? [1440] : [1440, 390]
    for (const width of widths) {
        if (process.env.VISITOR_SHARE_HANDOFF_ONLY === '1') {
            await viewerCase(width, false, 'featured')
            continue
        }
        if (process.env.VISITOR_VIEWERS_ONLY === '1') {
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
