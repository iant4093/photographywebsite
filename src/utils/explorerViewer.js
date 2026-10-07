let pendingViewer = null
let loadedViewer = null

export function readExplorerViewer() {
    return loadedViewer
}

export function loadExplorerViewer({ retry = false } = {}) {
    if (loadedViewer) return Promise.resolve(loadedViewer)
    if (!pendingViewer) {
        // Browsers cache a failed module URL. A separately bundled retry entry
        // lets a transient download failure recover without reloading the page
        // or discarding the visitor's selected photograph.
        const load = retry
            ? import('../components/PhotoLightbox.jsx?explorer-retry')
            : import('../components/PhotoLightbox')
        pendingViewer = load.then(module => {
            loadedViewer = module.default
            return loadedViewer
        }).catch(error => {
            pendingViewer = null
            throw error
        })
    }
    return pendingViewer
}

export function warmExplorerViewer() {
    void loadExplorerViewer().catch(() => {})
    void import('./printOrders').catch(() => {})
}
