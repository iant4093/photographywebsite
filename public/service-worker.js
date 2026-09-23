const release = new URL(self.location.href).searchParams.get('v') || 'stable'
const SHELL_CACHE = `ian-photography-shell-${release}`
const ASSET_CACHE = `ian-photography-assets-${release}`
const APP_SHELL = ['/', '/index.html', '/manifest.webmanifest', '/favicon.svg', '/theme-init.js']
const SHELL_LIMIT = 40
const ASSET_LIMIT = 160

async function openCache(name) {
  try { return await caches.open(name) } catch { return null }
}

async function matchCache(cache, request) {
  try { return await cache?.match(request) } catch { return undefined }
}

async function remember(cache, request, response, limit) {
  if (!cache || /(?:no-store|private)/i.test(response.headers.get('cache-control') || '')) return
  try {
    await cache.put(request, response.clone())
    const keys = await cache.keys()
    const removable = keys.filter(key => {
      const url = new URL(key.url)
      return !APP_SHELL.includes(url.pathname + url.search)
    })
    for (const key of removable.slice(0, Math.max(0, keys.length - limit))) await cache.delete(key)
  } catch { /* Storage is optional; a healthy network response must still work. */ }
}

self.addEventListener('install', event => {
  event.waitUntil((async () => {
    const cache = await openCache(SHELL_CACHE)
    if (cache) await Promise.allSettled(APP_SHELL.map(path => cache.add(new Request(path, { cache: 'reload' }))))
    await self.skipWaiting()
  })())
})

self.addEventListener('activate', event => {
  event.waitUntil((async () => {
    const keep = new Set([SHELL_CACHE, ASSET_CACHE])
    try {
      const names = await caches.keys()
      await Promise.all(names.filter(name => name.startsWith('ian-photography-') && !keep.has(name)).map(name => caches.delete(name)))
    } catch { /* Browsing works without persistent caches. */ }
    await self.clients.claim()
  })())
})

async function networkFirst(request) {
  const cache = await openCache(SHELL_CACHE)
  try {
    const response = await fetch(request)
    if (response.ok && (response.headers.get('content-type') || '').includes('text/html')) {
      await remember(cache, request, response, SHELL_LIMIT)
    }
    return response
  } catch (error) {
    return (await matchCache(cache, request)) || (await matchCache(cache, '/index.html')) || Promise.reject(error)
  }
}

async function cacheFirstAsset(request) {
  const cache = await openCache(ASSET_CACHE)
  const cached = await matchCache(cache, request)
  if (cached) return cached
  const response = await fetch(request)
  if (response.ok && response.type === 'basic') await remember(cache, request, response, ASSET_LIMIT)
  return response
}

self.addEventListener('fetch', event => {
  const { request } = event
  if (request.method !== 'GET') return
  const url = new URL(request.url)
  if (url.origin !== self.location.origin) return
  if (url.pathname === '/api' || url.pathname.startsWith('/api/') || request.headers.has('authorization')) return

  if (request.mode === 'navigate') {
    event.respondWith(networkFirst(request))
    return
  }

  if (url.pathname.startsWith('/assets/') || ['/favicon.svg', '/theme-init.js', '/manifest.webmanifest'].includes(url.pathname)) {
    event.respondWith(cacheFirstAsset(request))
  }
})
