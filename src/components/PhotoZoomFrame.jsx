import { useState } from 'react'

const ZOOM_SCALE = 2.5
const INITIAL_ZOOM = { zoomed: false, x: 50, y: 50 }

function freshDetail(src) {
    return { src, requested: false, ready: false }
}

// The fitted frame owns the border and clipping; only its image is transformed.
export default function PhotoZoomFrame({ bounds, loaded = false, visible = true, outgoing = false, ...imageProps }) {
    const [naturalSize, setNaturalSize] = useState(null)
    const [zoom, setZoom] = useState(INITIAL_ZOOM)
    const [detail, setDetail] = useState(() => freshDetail(imageProps.src))
    if (detail.src !== imageProps.src) setDetail(freshDetail(imageProps.src))
    if (!visible && zoom.zoomed) setZoom(INITIAL_ZOOM)

    const width = Number(imageProps.width) || naturalSize?.width
    const height = Number(imageProps.height) || naturalSize?.height
    const fit = width > 0 && height > 0 && bounds.width > 0 && bounds.height > 0
        ? Math.min(1, bounds.width / width, bounds.height / height)
        : null
    const interactive = loaded && visible && !outgoing
    const Frame = outgoing ? 'div' : 'button'
    const scale = zoom.zoomed ? ZOOM_SCALE : 1

    const toggleZoom = (event) => {
        event.stopPropagation()
        if (!interactive) return
        if (zoom.zoomed) {
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
        if (imageProps.srcSet) setDetail(current => ({ ...current, requested: true }))
    }

    const detailFailed = (image) => {
        if (!image.isConnected) return
        // A detail upgrade is optional. Keep the decoded preview available
        // and allow a fresh attempt on the next zoom.
        setDetail(current => current.src === imageProps.src ? freshDetail(current.src) : current)
    }
    const detailLoaded = (event) => {
        const image = event.currentTarget
        const ready = () => {
            if (!image.isConnected || image.getAttribute('src') !== imageProps.src) return
            setDetail(current => current.src === imageProps.src ? { ...current, ready: true } : current)
        }
        if (typeof image.decode !== 'function') ready()
        else {
            try { image.decode().then(ready, () => detailFailed(image)) } catch { detailFailed(image) }
        }
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
            <div
                className="linen-lightbox-photo-surface"
                // Translate and scale together around a constant origin. A
                // quick reversal can then interpolate from its current matrix
                // without jumping when the next click targets another spot.
                style={{
                    transform: `translate(${zoom.x * (1 - scale)}%, ${zoom.y * (1 - scale)}%) scale(${scale})`,
                }}
            >
                <img
                    {...imageProps}
                    draggable={false}
                    onLoad={(event) => {
                        const image = event.currentTarget
                        if (!naturalSize && image.naturalWidth > 0 && image.naturalHeight > 0) {
                            setNaturalSize({ width: image.naturalWidth, height: image.naturalHeight })
                        }
                        imageProps.onLoad?.(event)
                    }}
                />
                {detail.requested && (
                    <img
                        key={detail.src}
                        src={detail.src}
                        alt=""
                        aria-hidden="true"
                        decoding="async"
                        draggable={false}
                        className={`linen-lightbox-photo-detail ${detail.ready ? 'is-ready' : ''}`}
                        onLoad={detailLoaded}
                        onError={event => detailFailed(event.currentTarget)}
                    />
                )}
            </div>
        </Frame>
    )
}
