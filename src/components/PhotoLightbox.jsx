import AccessibleLightbox from './AccessibleLightbox'
import {
    mediaDisplayUrl,
    mediaId,
    mediaThumbnailUrl,
} from '../utils/mediaUrls'

function PhotoLightbox({
    images,
    index,
    ariaLabel,
    onClose,
    onNext,
    onPrevious,
    onDownload,
    onMediaError,
}) {
    const activeImage = images[index]
    if (!activeImage) return null

    const isLegacyOrDemo = typeof activeImage === 'string'
    const thumbUrl = mediaThumbnailUrl(activeImage)
    const activeRawUrl = mediaDisplayUrl(activeImage)

    return (
        <AccessibleLightbox
            ariaLabel={ariaLabel}
            onClose={onClose}
            onNext={images.length > 1 ? onNext : undefined}
            onPrevious={images.length > 1 ? onPrevious : undefined}
            className="fixed inset-0 z-[1000] bg-charcoal/95 backdrop-blur-md flex flex-col items-center justify-center p-4 md:p-12 mb-0 animate-fade-in"
        >
            <button
                type="button"
                onClick={onClose}
                className="linen-lightbox-close fixed z-[1001] w-12 h-12 text-white/80 hover:text-white transition-colors cursor-pointer flex items-center justify-center"
                style={{
                    top: 'max(1rem, calc(env(safe-area-inset-top) + 0.5rem))',
                    right: 'max(1rem, calc(env(safe-area-inset-right) + 0.5rem))',
                }}
                aria-label="Close photo viewer"
                title="Close Photo Viewer"
                data-lightbox-initial-focus
            >
                <svg className="w-8 h-8" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
                </svg>
            </button>

            {images.length > 1 && (
                <>
                    <button
                        type="button"
                        onClick={(event) => { event.stopPropagation(); onPrevious() }}
                        className="absolute left-4 md:left-8 top-1/2 -translate-y-1/2 w-12 h-12 rounded-full bg-white/10 hover:bg-white/25 backdrop-blur-sm text-white flex items-center justify-center transition-all cursor-pointer z-10"
                        aria-label="Previous photo"
                    >
                        <svg className="w-6 h-6" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 19l-7-7 7-7" />
                        </svg>
                    </button>

                    <button
                        type="button"
                        onClick={(event) => { event.stopPropagation(); onNext() }}
                        className="absolute right-4 md:right-8 top-1/2 -translate-y-1/2 w-12 h-12 rounded-full bg-white/10 hover:bg-white/25 backdrop-blur-sm text-white flex items-center justify-center transition-all cursor-pointer z-10"
                        aria-label="Next photo"
                    >
                        <svg className="w-6 h-6" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5l7 7-7 7" />
                        </svg>
                    </button>
                </>
            )}

            <div
                className="flex-1 w-full min-h-0 flex flex-col items-center justify-center relative z-0"
                onClick={(event) => event.stopPropagation()}
            >
                <div className="flex-1 min-h-0 flex items-center justify-center w-full relative">
                    <img
                        key={`high-${mediaId(activeImage) || index}`}
                        src={activeRawUrl}
                        alt="Full size preview"
                        onError={onMediaError}
                        width={activeImage.width}
                        height={activeImage.height}
                        decoding="async"
                        className="linen-lightbox-photo max-w-full max-h-full object-contain relative z-20 animate-fade-in"
                    />
                    <img
                        src={thumbUrl}
                        alt=""
                        className="absolute inset-0 w-full h-full object-contain blur-sm scale-95 opacity-50 z-10 pointer-events-none"
                    />
                </div>

                {!isLegacyOrDemo && activeImage.exif && (
                    <div className="shrink-0 mt-4 text-center animate-fade-in max-w-2xl px-4">
                        {activeImage.exif.model && (
                            <p className="text-white font-medium text-sm md:text-base drop-shadow-md">
                                {activeImage.exif.model}
                            </p>
                        )}
                        {activeImage.exif.lens && (
                            <p className="text-white/80 text-xs md:text-sm drop-shadow-md mb-1">
                                {activeImage.exif.lens}
                            </p>
                        )}
                        <div className="flex items-center justify-center gap-4 text-white/70 text-xs md:text-sm font-light tracking-wide italic mt-2">
                            {activeImage.exif.focalLength && <span>{activeImage.exif.focalLength}</span>}
                            {activeImage.exif.focalRatio && <span>{activeImage.exif.focalRatio}</span>}
                            {activeImage.exif.shutterSpeed && <span>{activeImage.exif.shutterSpeed}</span>}
                            {activeImage.exif.iso && <span>{activeImage.exif.iso}</span>}
                        </div>
                    </div>
                )}
            </div>

            <div className="shrink-0 mt-6 flex flex-col items-center gap-2 z-10" onClick={(event) => event.stopPropagation()}>
                {onDownload && (
                    <button
                        type="button"
                        onClick={(event) => onDownload(event, activeImage, index)}
                        className="text-white/60 hover:text-white transition-colors p-4 rounded-full cursor-pointer hover:bg-white/10 active:scale-95 touch-manipulation"
                        title="Download Photo"
                        aria-label="Download photo"
                    >
                        <svg className="w-7 h-7" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-4l-4 4m0 0l-4-4m4 4V4" />
                        </svg>
                    </button>
                )}
                <span className="text-white/70 text-sm font-medium drop-shadow-md">
                    {index + 1} / {images.length}
                </span>
            </div>
        </AccessibleLightbox>
    )
}

export default PhotoLightbox
