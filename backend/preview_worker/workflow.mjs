import { PREVIEW_VERSION, PREVIEW_WIDTHS } from './contract.mjs'

export function readyPreviewDescriptor(metadata, expectedKeys) {
    if (!metadata || metadata.status !== 'ready' || Number(metadata.previewVersion) !== PREVIEW_VERSION) {
        return null
    }
    if (!metadata.previewKeys || PREVIEW_WIDTHS.some((width) => (
        metadata.previewKeys[String(width)] !== expectedKeys[String(width)]
    ))) return null
    if (typeof metadata.sourceSha256 !== 'string' || !/^[0-9a-f]{64}$/.test(metadata.sourceSha256)) {
        return null
    }
    if (!metadata.dimensions || typeof metadata.dimensions !== 'object') return null
    const outputs = {}
    for (const width of PREVIEW_WIDTHS) {
        const value = metadata.dimensions[String(width)]
        if (!value || Number(value.width) !== width || !Number.isSafeInteger(Number(value.height)) || Number(value.height) < 1) {
            return null
        }
        outputs[String(width)] = { width, height: Number(value.height) }
    }
    return { sourceDigest: metadata.sourceSha256, outputs }
}

export async function validateReadyOrMarkPending({
    metadata,
    expectedKeys,
    validateObject,
    tagObject,
    visibility,
    markPending,
}) {
    if (metadata?.status !== 'ready') return false
    try {
        const descriptor = readyPreviewDescriptor(metadata, expectedKeys)
        if (!descriptor) throw new Error('Ready preview metadata is invalid')
        for (const width of PREVIEW_WIDTHS) {
            const key = expectedKeys[String(width)]
            await validateObject(key, descriptor.outputs[String(width)], descriptor.sourceDigest)
            await tagObject(key, visibility)
        }
        return true
    } catch (error) {
        await markPending()
        return false
    }
}
