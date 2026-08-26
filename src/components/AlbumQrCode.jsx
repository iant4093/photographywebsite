import { useCallback, useState } from 'react'
import AccessibleLightbox from './AccessibleLightbox'

export default function AlbumQrCode({ albumTitle, qrCodeUrl, onLoadError }) {
    const [open, setOpen] = useState(false)
    const [imageError, setImageError] = useState(false)
    const close = useCallback(() => setOpen(false), [])

    if (!qrCodeUrl) return null

    const show = () => {
        setImageError(false)
        setOpen(true)
    }

    const handleImageError = () => {
        setImageError(true)
        if (onLoadError) {
            setOpen(false)
            onLoadError()
        }
    }

    return (
        <>
            <button
                type="button"
                onClick={show}
                className="inline-flex items-center justify-center gap-2 px-6 py-3 rounded-xl font-medium transition-all duration-300 shadow-warm-sm border border-charcoal/30 bg-white/70 text-charcoal hover:border-amber hover:text-amber hover:scale-105 active:scale-95 shrink-0 cursor-pointer"
                aria-label={`Show QR code for ${albumTitle}`}
            >
                <svg className="w-5 h-5" viewBox="0 0 24 24" fill="none" stroke="currentColor" aria-hidden="true">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="1.75" d="M4 4h6v6H4V4Zm10 0h6v6h-6V4ZM4 14h6v6H4v-6Zm11 0h2v2h-2v-2Zm3 0h2v5h-2v-5Zm-3 5h2v1h-2v-1Zm-2-2h2v3h-2v-3Z" />
                </svg>
                Show QR Code
            </button>

            {open && (
                <AccessibleLightbox
                    ariaLabel={`QR code for ${albumTitle}`}
                    onClose={close}
                    className="linen-responsive-lightbox linen-qr-lightbox fixed inset-0 z-[1000] bg-charcoal/75 flex flex-col items-center justify-center p-6"
                >
                    <button
                        type="button"
                        onClick={close}
                        className="linen-lightbox-close fixed z-[1001] w-12 h-12 text-white/80 hover:text-white transition-colors cursor-pointer flex items-center justify-center"
                        style={{
                            top: 'max(1rem, calc(env(safe-area-inset-top) + 0.5rem))',
                            right: 'max(1rem, calc(env(safe-area-inset-right) + 0.5rem))',
                        }}
                        aria-label="Close QR code"
                        data-lightbox-initial-focus
                    >
                        <svg className="w-8 h-8" fill="none" stroke="currentColor" viewBox="0 0 24 24" aria-hidden="true">
                            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
                        </svg>
                    </button>

                    <section className="linen-lightbox-content linen-qr-card max-w-[min(88vw,32rem)] bg-cream p-5 md:p-8 text-center border border-charcoal shadow-2xl">
                        {!imageError && (
                            <img
                                src={qrCodeUrl}
                                alt={`QR code linking to ${albumTitle}`}
                                className="block w-full h-auto bg-white border border-charcoal/40 p-3"
                                onError={handleImageError}
                            />
                        )}
                        {imageError && !onLoadError && (
                            <p role="alert" className="text-red-700">This QR code could not be loaded. Please try again.</p>
                        )}
                        <h2 className="font-serif text-2xl md:text-3xl text-charcoal mt-6">{albumTitle}</h2>
                        <p className="text-sm text-warm-gray mt-2">Scan to open this album</p>
                    </section>
                </AccessibleLightbox>
            )}
        </>
    )
}
