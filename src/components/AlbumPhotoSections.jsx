import { useId } from 'react'
import ProgressiveImage from './ProgressiveImage'
import { mediaId, mediaPreviewSrcSet, mediaThumbnailUrl } from '../utils/mediaUrls'

export default function AlbumPhotoSections({ sections, albumTitle, onOpen, onMediaError, eagerImageCount = 0, itemLabel = 'Item' }) {
    const id = useId()
    return <div className="space-y-12">
        {sections.map((section, sectionIndex) => <section key={section.key} aria-labelledby={section.title ? `${id}-${section.key}` : undefined}>
            {section.title && <div className="mb-6 flex items-center gap-4 border-b border-warm-border pb-4">
                <h2 id={`${id}-${section.key}`} className="font-serif text-2xl text-charcoal">{section.title}</h2>
                <span className="text-sm text-warm-gray">{section.images.length} photos</span>
            </div>}
            <div className="linen-media-grid grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
                {section.images.map((img, index) => <button
                    data-camera-cursor="photo"
                    data-page-scroll-media
                    type="button"
                    key={mediaId(img) || index}
                    className="linen-media-frame linen-photo-frame group cursor-pointer rounded-xl overflow-hidden transition-shadow duration-500 aspect-[4/3] relative text-left focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-amber"
                    onClick={() => onOpen(img)}
                    aria-label={`Open item ${index + 1} from ${albumTitle}${section.title ? ` — ${section.title}` : ''}${img.altText ? ` — ${img.altText}` : ''}`}
                >
                    <div className="linen-photo-viewport">
                        <ProgressiveImage
                            src={mediaThumbnailUrl(img)}
                            eager={sectionIndex === 0 && index < eagerImageCount}
                            srcSet={mediaPreviewSrcSet(img) || undefined}
                            blurhash={img.blurhash}
                            width={img.width}
                            height={img.height}
                            sizes="(min-width: 1024px) 33vw, (min-width: 640px) 50vw, 100vw"
                            alt={img.altText || `${itemLabel} ${index + 1} from ${albumTitle}`}
                            onError={onMediaError}
                            className="w-full h-full"
                        />
                        <div className="absolute inset-0 bg-gradient-to-t from-charcoal/20 to-transparent opacity-0 group-hover:opacity-100 transition-opacity duration-500 pointer-events-none" />
                    </div>
                </button>)}
            </div>
            {section.title && section.images.length === 0 && <p className="py-8 text-warm-gray">All photos in this album are featured.</p>}
        </section>)}
    </div>
}
