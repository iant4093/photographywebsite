import AccessibleLightbox from './AccessibleLightbox'
import LightboxShareButton from './LightboxShareButton'
import VideoPlayer from './VideoPlayer'
import { settleLightboxEntrance } from '../utils/lightboxMotionControl'
import { mediaId } from '../utils/mediaUrls'

export default function VideoLightbox({ images, index, title, motionOrigin, onClose, onNext, onPrevious, onDownload, onMediaError,
    shareUrl, showSingleCount = false }) {
    const video = images[index]
    if (!video) return null
    const hasNavigation = images.length > 1
    return (
        <AccessibleLightbox
            motion={{ kind: 'video', key: mediaId(video), origin: motionOrigin }}
            ariaLabel={`Video player for ${title}`}
            onClose={onClose}
            onNext={hasNavigation ? onNext : undefined}
            onPrevious={hasNavigation ? onPrevious : undefined}
            className="linen-responsive-lightbox linen-video-lightbox fixed inset-0 z-[1000] bg-charcoal/90 flex flex-col items-center justify-center p-4 md:p-12"
        >
            <button type="button" onClick={onClose} title="Close Player" aria-label="Close video player"
                className="linen-lightbox-close fixed z-[1001] w-12 h-12 text-white/80 hover:text-white transition-colors cursor-pointer flex items-center justify-center"
                style={{ top: 'max(1rem, calc(env(safe-area-inset-top) + 0.5rem))', right: 'max(1rem, calc(env(safe-area-inset-right) + 0.5rem))' }}
                data-camera-cursor="close" data-lightbox-initial-focus>
                <svg className="w-8 h-8" fill="none" stroke="currentColor" viewBox="0 0 24 24" aria-hidden="true">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
                </svg>
            </button>

            <div className="linen-lightbox-content flex-1 w-full max-w-6xl min-h-0 flex items-center justify-center relative shadow-2xl bg-black rounded-none md:rounded-xl overflow-hidden">
                <VideoPlayer videoInfo={video} onMediaError={onMediaError} />
            </div>

            <div className="linen-lightbox-footer">
                {hasNavigation && (
                    <nav className="linen-lightbox-nav" aria-label="Video navigation"
                        onClickCapture={event => settleLightboxEntrance(event.currentTarget.closest('.linen-lightbox'))}>
                        <button type="button" onClick={onPrevious} aria-label="Previous video" data-camera-cursor="previous"
                            className="linen-lightbox-previous absolute left-4 md:left-8 top-1/2 -translate-y-1/2 w-12 h-12 rounded-full bg-white/10 hover:bg-white/25 backdrop-blur-sm text-white flex items-center justify-center transition-colors cursor-pointer z-10">
                            <svg className="w-6 h-6" fill="none" stroke="currentColor" viewBox="0 0 24 24" aria-hidden="true">
                                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 19l-7-7 7-7" />
                            </svg>
                        </button>
                        <button type="button" onClick={onNext} aria-label="Next video" data-camera-cursor="next"
                            className="linen-lightbox-next absolute right-4 md:right-8 top-1/2 -translate-y-1/2 w-12 h-12 rounded-full bg-white/10 hover:bg-white/25 backdrop-blur-sm text-white flex items-center justify-center transition-colors cursor-pointer z-10">
                            <svg className="w-6 h-6" fill="none" stroke="currentColor" viewBox="0 0 24 24" aria-hidden="true">
                                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5l7 7-7 7" />
                            </svg>
                        </button>
                    </nav>
                )}
                <div className="linen-lightbox-actions shrink-0 mt-6 flex flex-col items-center gap-2 z-10">
                    <div className="linen-lightbox-action-buttons flex items-center justify-center gap-2">
                        {shareUrl && <LightboxShareButton media={video} index={index} mediaType="video"
                            shareTitle={`${title} — Ian Truong Photography`} shareUrl={shareUrl} />}
                        <button type="button" onClick={onDownload} title="Download Video" aria-label="Download video"
                            className="linen-lightbox-download inline-flex items-center gap-2 rounded-full border border-white/30 px-4 py-2.5 text-sm text-white/80 transition-colors hover:border-white/60 hover:bg-white/10 hover:text-white active:scale-[0.98] cursor-pointer touch-manipulation">
                            <svg className="h-5 w-5" fill="none" stroke="currentColor" viewBox="0 0 24 24" aria-hidden="true">
                                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1M8 12l4 4m0 0l4-4m-4 4V4" />
                            </svg>
                            <span>Download</span>
                        </button>
                    </div>
                    {(hasNavigation || showSingleCount) && <span className="linen-lightbox-counter text-white/70 text-sm font-medium drop-shadow-md">
                        {index + 1} / {images.length}
                    </span>}
                </div>
            </div>
        </AccessibleLightbox>
    )
}
