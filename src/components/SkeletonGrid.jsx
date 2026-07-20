export default function SkeletonGrid({ count = 6, type = 'photo' }) {
    return (
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-6 w-full" role="status" aria-label="Loading gallery">
            {Array.from({ length: count }, (_, index) => (
                <div key={index} className={`w-full rounded-xl bg-charcoal/10 relative overflow-hidden flex items-center justify-center ${type === 'photo' ? 'aspect-[4/3]' : 'aspect-video'}`}>
                    <div className="absolute inset-0 skeleton-shimmer" />
                    {type === 'video' && (
                        <div className="w-16 h-16 rounded-full bg-white/30 backdrop-blur-sm flex items-center justify-center text-white/50">
                            <svg className="w-8 h-8 ml-1" fill="currentColor" viewBox="0 0 24 24" aria-hidden="true">
                                <path d="M8 5v14l11-7z" />
                            </svg>
                        </div>
                    )}
                </div>
            ))}
            <span className="sr-only">Loading albums</span>
        </div>
    )
}
