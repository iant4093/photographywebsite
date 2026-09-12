export const MANUAL_LENS_FALLBACK = 'Sirui Nightwalker 75mm T1.2'

function equipmentName(value) {
    return typeof value === 'string' ? value.replace(/\s+/g, ' ').trim() : ''
}

export function photoEquipment(images = []) {
    const cameras = new Set()
    const lenses = new Map()
    for (const image of images) {
        const camera = equipmentName(image?.exif?.model)
        const lens = equipmentName(image?.exif?.lens) || MANUAL_LENS_FALLBACK
        if (camera) cameras.add(camera)
        lenses.set(lens, (lenses.get(lens) || 0) + 1)
    }
    return {
        cameras: [...cameras].sort((a, b) => a.localeCompare(b)),
        lenses: [...lenses].sort(([a, countA], [b, countB]) => countB - countA || a.localeCompare(b)),
    }
}

export function sectionStats(albums) {
    const images = albums.flatMap(album => album.images || [])
    const dates = albums.map(album => typeof album.createdAt === 'string' ? album.createdAt.slice(0, 10) : '')
        .filter(date => /^\d{4}-\d{2}-\d{2}$/.test(date) && Number.isFinite(Date.parse(date)))
        .sort()
    return {
        albumCount: albums.length,
        photoCount: images.length,
        firstDate: dates[0],
        lastDate: dates.at(-1),
        ...photoEquipment(images),
    }
}
