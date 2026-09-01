import { createHash } from 'node:crypto'


export const EXPLORE_INDEX_VERSION = 1
export const EXPLORE_INDEX_PREFIX = '__EXPLORE_V1__'
export const EXPLORE_INDEX_RECORD_TYPE = 'explore-index-v1'
export const EXPLORE_FACET_RECORD_TYPE = 'explore-facet-v1'
export const EXPLORE_FACETS_PARTITION = `${EXPLORE_INDEX_PREFIX}#FACETS`

const COLORS = new Set(['red', 'orange', 'yellow', 'green', 'cyan', 'blue', 'purple', 'pink', 'monochrome'])
const EXPOSURES = new Set([
    'aperture:wide', 'aperture:middle', 'aperture:deep',
    'shutter:motion', 'shutter:handheld', 'shutter:frozen',
    'iso:clean', 'iso:available', 'iso:low',
    'focal:wide', 'focal:normal', 'focal:telephoto',
])
const TIMES = new Set(['dawn', 'morning', 'afternoon', 'evening', 'night'])
const SEASONS = new Set(['winter', 'spring', 'summer', 'autumn'])
const TEMPORAL_VERSION = 1
const ALBUM_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/
const MEDIA_ID_PATTERN = /^[a-f0-9]{24}$/

export function facetPartition(mode, value) {
    if (mode === 'color') {
        const normalized = typeof value === 'string' ? value.trim().toLowerCase() : ''
        if (!COLORS.has(normalized)) throw new Error('Unsupported color facet')
        return `${EXPLORE_INDEX_PREFIX}#COLOR#${normalized}`
    }
    if (mode === 'lens') {
        const normalized = typeof value === 'string' ? value.trim().replace(/\s+/g, ' ').toLowerCase() : ''
        if (!normalized || normalized.length > 160) throw new Error('Invalid lens facet')
        return `${EXPLORE_INDEX_PREFIX}#LENS#${normalized}`
    }
    if (mode === 'exposure') {
        const normalized = typeof value === 'string' ? value.trim().toLowerCase() : ''
        if (!EXPOSURES.has(normalized)) throw new Error('Unsupported exposure facet')
        return `${EXPLORE_INDEX_PREFIX}#EXPOSURE#${normalized}`
    }
    if (mode === 'time') {
        const normalized = typeof value === 'string' ? value.trim().toLowerCase() : ''
        if (!TIMES.has(normalized)) throw new Error('Unsupported time facet')
        return `${EXPLORE_INDEX_PREFIX}#TIME#${normalized}`
    }
    if (mode === 'season') {
        const normalized = typeof value === 'string' ? value.trim().toLowerCase() : ''
        if (!SEASONS.has(normalized)) throw new Error('Unsupported season facet')
        return `${EXPLORE_INDEX_PREFIX}#SEASON#${normalized}`
    }
    throw new Error('Unsupported Explore facet mode')
}

export function indexSortKey(albumId, mediaId) {
    if (!ALBUM_ID_PATTERN.test(albumId || '')) throw new Error('Invalid album reference')
    if (!MEDIA_ID_PATTERN.test(mediaId || '')) throw new Error('Invalid media reference')
    const randomKey = createHash('sha256').update(`${albumId}\0${mediaId}`, 'utf8').digest('hex').slice(0, 16)
    return `${randomKey}#${albumId}#${mediaId}`
}

export function metadataFacets(metadata) {
    if (!metadata || metadata.status !== 'ready' || Number(metadata.exploreVersion) !== 2) return new Map()
    const facets = new Map()
    if (Array.isArray(metadata.colorFamilies)) {
        for (const family of new Set(metadata.colorFamilies)) {
            if (COLORS.has(family)) facets.set(facetPartition('color', family), family)
        }
    }
    const lens = typeof metadata.lens === 'string' ? metadata.lens.trim().replace(/\s+/g, ' ') : ''
    const lensKey = typeof metadata.lensKey === 'string' ? metadata.lensKey : ''
    if (lens && lens.length <= 160 && lensKey === lens.toLowerCase()) {
        facets.set(facetPartition('lens', lensKey), lens)
    }
    if (Array.isArray(metadata.exposureBuckets)) {
        for (const bucket of new Set(metadata.exposureBuckets)) {
            if (EXPOSURES.has(bucket)) facets.set(facetPartition('exposure', bucket), bucket)
        }
    }
    if (
        Number(metadata.temporalVersion) === TEMPORAL_VERSION
        && TIMES.has(metadata.timeOfDayBucket)
        && SEASONS.has(metadata.seasonBucket)
    ) {
        facets.set(facetPartition('time', metadata.timeOfDayBucket), metadata.timeOfDayBucket)
        facets.set(facetPartition('season', metadata.seasonBucket), metadata.seasonBucket)
    }
    return facets
}

export function desiredIndexRecords(metadata, isPublic) {
    if (!isPublic) return []
    const facets = metadataFacets(metadata)
    const sortKey = indexSortKey(metadata.albumId, metadata.mediaId)
    const records = [...facets.keys()].sort().map(albumId => ({
        albumId,
        mediaId: sortKey,
        recordType: EXPLORE_INDEX_RECORD_TYPE,
        indexVersion: EXPLORE_INDEX_VERSION,
        sourceAlbumId: metadata.albumId,
        sourceMediaId: metadata.mediaId,
    }))
    for (const [partition, label] of [...facets.entries()].sort()) {
        if (!partition.startsWith(`${EXPLORE_INDEX_PREFIX}#LENS#`)) continue
        records.push({
            albumId: EXPLORE_FACETS_PARTITION,
            mediaId: partition.slice(`${EXPLORE_INDEX_PREFIX}#`.length),
            recordType: EXPLORE_FACET_RECORD_TYPE,
            indexVersion: EXPLORE_INDEX_VERSION,
            facetPartition: partition,
            name: label,
        })
    }
    return records
}

function entryKeys(metadata) {
    if (!metadata || !ALBUM_ID_PATTERN.test(metadata.albumId || '') || !MEDIA_ID_PATTERN.test(metadata.mediaId || '')) {
        return []
    }
    const sortKey = indexSortKey(metadata.albumId, metadata.mediaId)
    const partitions = new Set(metadataFacets(metadata).keys())
    if (!Array.isArray(metadata.exposureBuckets)) {
        for (const bucket of EXPOSURES) partitions.add(facetPartition('exposure', bucket))
    }
    // Temporal partitions are fixed and small. Always probe all of them so a
    // pending repair, malformed legacy row, or bucket change cannot strand a
    // stale public reference.
    for (const bucket of TIMES) partitions.add(facetPartition('time', bucket))
    for (const bucket of SEASONS) partitions.add(facetPartition('season', bucket))
    return [...partitions].sort().map(albumId => ({ albumId, mediaId: sortKey }))
}

export async function syncExploreIndex(
    documentClient,
    tableName,
    previous,
    current,
    visibility,
    batchWriteCommand,
) {
    if (!tableName) throw new Error('PREVIEW_METADATA_TABLE is not configured')
    if (typeof batchWriteCommand !== 'function') throw new Error('Batch write command factory is required')
    const desired = desiredIndexRecords(current, visibility === 'public')
    const desiredEntries = new Set(
        desired
            .filter(item => item.recordType === EXPLORE_INDEX_RECORD_TYPE)
            .map(item => `${item.albumId}\0${item.mediaId}`),
    )
    const requests = entryKeys(previous)
        .filter(key => !desiredEntries.has(`${key.albumId}\0${key.mediaId}`))
        .map(Key => ({ DeleteRequest: { Key } }))
    requests.push(...desired.map(Item => ({ PutRequest: { Item } })))
    for (let offset = 0; offset < requests.length; offset += 25) {
        let pending = requests.slice(offset, offset + 25)
        for (let attempt = 0; attempt < 5 && pending.length; attempt += 1) {
            const response = await documentClient.send(batchWriteCommand({
                RequestItems: { [tableName]: pending },
            }))
            pending = response.UnprocessedItems?.[tableName] || []
        }
        if (pending.length) throw new Error('Explore index write remained unprocessed')
    }
}
