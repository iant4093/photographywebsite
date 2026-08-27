export async function registerPwa(serviceWorker = navigator.serviceWorker) {
    if (!serviceWorker?.register) return null
    const release = document.documentElement.dataset.releaseSha || 'stable'
    const registration = await serviceWorker.register(`/service-worker.js?v=${encodeURIComponent(release)}`, {
        scope: '/',
        updateViaCache: 'none',
    })

    const checkForUpdate = () => registration.update().catch(() => {})
    checkForUpdate()
    window.addEventListener('focus', checkForUpdate)
    document.addEventListener('visibilitychange', () => {
        if (document.visibilityState === 'visible') checkForUpdate()
    })
    return registration
}
