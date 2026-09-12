import { useState } from 'react'

const ZOOM_SCALE = 2.5
const INITIAL_ZOOM = { zoomed: false, x: 50, y: 50 }

// The fitted frame owns the border and clipping; only its image is transformed.
export default function PhotoZoomFrame({ bounds, loaded = false, visible = true, outgoing = false, ...imageProps }) {
    const [naturalSize, setNaturalSize] = useState(null)
    const [zoom, setZoom] = useState(INITIAL_ZOOM)
    if (!visible && zoom.zoomed) setZoom(INITIAL_ZOOM)

    const width = Number(imageProps.width) || naturalSize?.width
    const height = Number(imageProps.height) || naturalSize?.height
    const fit = width > 0 && height > 0 && bounds.width > 0 && bounds.height > 0
        ? Math.min(1, bounds.width / width, bounds.height / height)
        : null
    const interactive = loaded && visible && !outgoing
    const Frame = outgoing ? 'div' : 'button'

    const toggleZoom = (event) => {
        event.stopPropagation()
        if (!interactive) return
        if (zoom.zoomed) {
            // Retain the origin on the return animation so the same detail
            // stays under the pointer in both directions.
            setZoom(current => ({ ...current, zoomed: false }))
            return
        }
        const rect = event.currentTarget.getBoundingClientRect()
        const pointerClick = event.detail > 0 && rect.width > 0 && rect.height > 0
        const percent = value => Math.max(0, Math.min(100, value))
        setZoom({
            zoomed: true,
            x: pointerClick ? percent((event.clientX - rect.left) / rect.width * 100) : 50,
            y: pointerClick ? percent((event.clientY - rect.top) / rect.height * 100) : 50,
        })
    }

    return (
        <Frame
            type={outgoing ? undefined : 'button'}
            className={`linen-lightbox-photo-frame ${loaded ? 'is-loaded' : ''} ${outgoing ? 'is-outgoing' : ''} ${visible ? '' : 'is-hidden'} ${zoom.zoomed ? 'is-zoomed' : ''}`}
            style={{ width: fit === null ? undefined : width * fit, height: fit === null ? undefined : height * fit }}
            disabled={outgoing ? undefined : !interactive}
            aria-hidden={outgoing || !visible || undefined}
            aria-label={outgoing ? undefined : zoom.zoomed ? 'Zoom out of photo' : 'Zoom in on photo'}
            aria-pressed={outgoing ? undefined : zoom.zoomed}
            data-camera-cursor={interactive ? zoom.zoomed ? 'zoom-out' : 'zoom-in' : 'native'}
            onClick={outgoing ? undefined : toggleZoom}
        >
            <img
                {...imageProps}
                // Request the full-resolution source when inspecting details,
                // rather than magnifying a responsive preview candidate.
                srcSet={zoom.zoomed ? undefined : imageProps.srcSet}
                draggable={false}
                onLoad={(event) => {
                    const image = event.currentTarget
                    if (!naturalSize && image.naturalWidth > 0 && image.naturalHeight > 0) {
                        setNaturalSize({ width: image.naturalWidth, height: image.naturalHeight })
                    }
                    imageProps.onLoad?.(event)
                }}
                style={{
                    ...imageProps.style,
                    transform: `scale(${zoom.zoomed ? ZOOM_SCALE : 1})`,
                    transformOrigin: `${zoom.x}% ${zoom.y}%`,
                }}
            />
        </Frame>
    )
}
