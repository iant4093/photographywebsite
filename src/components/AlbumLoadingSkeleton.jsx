import SkeletonGrid from './SkeletonGrid'

export default function AlbumLoadingSkeleton({ standalone = false }) {
    const placeholder = <div role="status" aria-label="Loading album">
        <span className="sr-only">Loading album</span>
        <div aria-hidden="true">
            <div className="mb-12 flex flex-col md:flex-row md:items-end justify-between gap-6 pb-6 border-b border-warm-gray/10">
                <div className="w-full max-w-2xl space-y-4">
                    <div className="h-12 w-3/4 rounded bg-charcoal/10" />
                    <div className="h-6 w-2/3 rounded bg-charcoal/10" />
                    <div className="h-4 w-32 rounded bg-charcoal/10" />
                    <div className="h-24 w-2/3 rounded bg-charcoal/10" />
                </div>
                <div className="flex flex-col gap-3 shrink-0 md:w-48">
                    {[0, 1, 2].map(index => <div key={index} className="h-12 rounded bg-charcoal/10" />)}
                </div>
            </div>
            <SkeletonGrid />
        </div>
    </div>
    if (!standalone) return placeholder
    return <div data-route-loading="" aria-busy="true" className="linen-gallery-page min-h-screen pb-16 pt-[88px] md:pt-[104px]">
        <div className="max-w-7xl mx-auto px-6 pt-8 md:pt-12">
            <div aria-hidden="true" className="h-5 w-32 mb-8 rounded bg-charcoal/10" />
            {placeholder}
        </div>
    </div>
}
