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
    const activeImages = sections.find(section => section.images.some(image => mediaId(image) === selectedId))?.images || EMPTY_IMAGES
    const index = activeImages.findIndex(image => mediaId(image) === selectedId)
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
