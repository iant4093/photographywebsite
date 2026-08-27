const release = new URL(self.location.href).searchParams.get('v') || 'stable'
const SHELL_CACHE = `ian-photography-shell-${release}`
const ASSET_CACHE = `ian-photography-assets-${release}`
const APP_SHELL = ['/', '/index.html', '/manifest.webmanifest', '/favicon.svg', '/theme-init.js']

self.addEventListener('install', event => {
  event.waitUntil((async () => {
    const cache = await caches.open(SHELL_CACHE)
    await Promise.allSettled(APP_SHELL.map(path => cache.add(new Request(path, { cache: 'reload' }))))
    await self.skipWaiting()
  })())
})

self.addEventListener('activate', event => {
  event.waitUntil((async () => {
    const keep = new Set([SHELL_CACHE, ASSET_CACHE])
    const names = await caches.keys()
    await Promise.all(names.filter(name => name.startsWith('ian-photography-') && !keep.has(name)).map(name => caches.delete(name)))
    await self.clients.claim()
  })())
})

async function networkFirst(request) {
  const cache = await caches.open(SHELL_CACHE)
  try {
    const response = await fetch(request)
    if (response.ok) await cache.put(request, response.clone())
    return response
  } catch (error) {
    return (await cache.match(request)) || (await cache.match('/index.html')) || Promise.reject(error)
  }
}

async function cacheFirstAsset(request) {
  const cache = await caches.open(ASSET_CACHE)
  const cached = await cache.match(request)
  if (cached) return cached
  const response = await fetch(request)
  if (response.ok && response.type === 'basic') await cache.put(request, response.clone())
  return response
}

self.addEventListener('fetch', event => {
  const { request } = event
  if (request.method !== 'GET') return
  const url = new URL(request.url)
  if (url.origin !== self.location.origin) return

  if (request.mode === 'navigate') {
    event.respondWith(networkFirst(request))
    return
  }

  if (url.pathname.startsWith('/assets/') || ['/favicon.svg', '/theme-init.js', '/manifest.webmanifest'].includes(url.pathname)) {
    event.respondWith(cacheFirstAsset(request))
  }
})
