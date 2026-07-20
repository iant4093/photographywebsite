const catalogSnapshots = new Map()
const MAX_SNAPSHOT_AGE_MS = 5 * 60_000

export function getCatalogSnapshot(key) {
    const snapshot = catalogSnapshots.get(key)
    if (!snapshot || Date.now() - snapshot.savedAt > MAX_SNAPSHOT_AGE_MS) return null
    return snapshot
}

export function setCatalogSnapshot(key, value) {
    catalogSnapshots.set(key, { ...value, savedAt: Date.now() })
}

export function clearCatalogSnapshots() {
    catalogSnapshots.clear()
}
