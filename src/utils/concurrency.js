export async function mapWithConcurrency(items, requestedLimit, mapper) {
    const values = Array.from(items)
    if (values.length === 0) return []

    const limit = Math.max(1, Math.min(Math.floor(requestedLimit) || 1, values.length))
    const results = new Array(values.length)
    let nextIndex = 0

    async function worker() {
        while (nextIndex < values.length) {
            const index = nextIndex
            nextIndex += 1
            results[index] = await mapper(values[index], index)
        }
    }

    await Promise.all(Array.from({ length: limit }, () => worker()))
    return results
}
