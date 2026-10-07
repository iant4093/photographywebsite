// Shared by the immediate explorer dialog and the complete viewer so the
// photograph keeps the same available space through a cold-code handoff.
export default function PhotoLightboxNavigation({ image, navigable, onNext, onPrevious, disabled = false }) {
    const exif = image && typeof image !== 'string' ? image.exif : null
    if (!navigable && !exif) return null
    return <nav className={`linen-lightbox-nav ${navigable ? 'has-navigation' : ''}`} aria-label="Photo navigation">
        {navigable && <button type="button" onClick={event => { event.stopPropagation(); onPrevious?.() }} disabled={disabled}
            className="linen-lightbox-previous absolute left-4 md:left-8 top-1/2 -translate-y-1/2 w-12 h-12 rounded-full bg-white/10 hover:bg-white/25 backdrop-blur-sm text-white flex items-center justify-center transition-all cursor-pointer z-10"
            aria-label="Previous photo" data-camera-cursor="previous">
            <svg className="w-6 h-6" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 19l-7-7 7-7" /></svg>
        </button>}
        {exif && <div className="linen-lightbox-metadata shrink-0 mt-4 text-center animate-fade-in max-w-2xl px-4">
            {exif.model && <p title={exif.model} className="text-white font-medium text-sm md:text-base drop-shadow-md">{exif.model}</p>}
            {exif.lens && <p title={exif.lens} className="text-white/80 text-xs md:text-sm drop-shadow-md mb-1">{exif.lens}</p>}
            <div className="flex items-center justify-center gap-4 text-white/70 text-xs md:text-sm font-light tracking-wide italic mt-2">
                {exif.focalLength && <span>{exif.focalLength}</span>}
                {exif.focalRatio && <span>{exif.focalRatio}</span>}
                {exif.shutterSpeed && <span>{exif.shutterSpeed}</span>}
                {exif.iso && <span>{exif.iso}</span>}
            </div>
        </div>}
        {navigable && <button type="button" onClick={event => { event.stopPropagation(); onNext?.() }} disabled={disabled}
            className="linen-lightbox-next absolute right-4 md:right-8 top-1/2 -translate-y-1/2 w-12 h-12 rounded-full bg-white/10 hover:bg-white/25 backdrop-blur-sm text-white flex items-center justify-center transition-all cursor-pointer z-10"
            aria-label="Next photo" data-camera-cursor="next">
            <svg className="w-6 h-6" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5l7 7-7 7" /></svg>
        </button>}
    </nav>
}
