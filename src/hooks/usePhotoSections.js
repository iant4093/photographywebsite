import { useCallback, useMemo, useState } from 'react'
import { mediaId } from '../utils/mediaUrls'

const EMPTY_IMAGES = []

// Track the open photo by identity so refreshing signed URLs or changing the
// manifest cannot silently move the viewer to a different photo.
export default function usePhotoSections(images, enabled = true) {
    const [selectedId, setSelectedId] = useState(null)
    const sections = useMemo(() => {
        const featured = enabled ? images.filter(image => image.isFavorite === true) : []
        if (!featured.length) return [{ key: 'all', title: '', images }]
        return [
            { key: 'featured', title: 'Featured photos', images: featured },
            { key: 'all', title: 'All photos', images: images.filter(image => image.isFavorite !== true) },
        ]
    }, [images, enabled])
    const positions = useMemo(() => {
        const lookup = new Map()
        for (const section of sections) {
            section.images.forEach((image, index) => {
                const id = mediaId(image)
                // Keep the first occurrence, matching the former list search.
                if (!lookup.has(id)) lookup.set(id, { images: section.images, index })
            })
        }
        return lookup
    }, [sections])
    const selected = positions.get(selectedId)
    const activeImages = selected?.images || EMPTY_IMAGES
    const index = selected?.index ?? -1
    const lightboxIndex = index < 0 ? null : index
    const openPhoto = useCallback(image => setSelectedId(mediaId(image)), [])
    const resetLightbox = useCallback(() => setSelectedId(null), [])
    const goNext = useCallback(() => {
        if (activeImages.length) setSelectedId(mediaId(activeImages[(index + 1) % activeImages.length]))
    }, [activeImages, index])
    const goPrev = useCallback(() => {
        if (activeImages.length) setSelectedId(mediaId(activeImages[(index - 1 + activeImages.length) % activeImages.length]))
    }, [activeImages, index])
    return { sections, activeImages, lightboxIndex, openPhoto, resetLightbox, goNext, goPrev }
}
