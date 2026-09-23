import { lazy } from 'react'

// Retry only a failed module fetch, once. Never reload a working editor or upload.
export default function lazyRetry(load) {
    return lazy(async () => {
        try { return await load() } catch (error) {
            if (!/Failed to fetch dynamically imported module|Importing a module script failed|error loading dynamically imported module|Loading chunk .* failed/i.test(error?.message || '')) throw error
            await new Promise(resolve => setTimeout(resolve, 250))
            return load()
        }
    })
}
