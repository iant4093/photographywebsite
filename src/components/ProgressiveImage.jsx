import { useState, useEffect } from 'react'
import { Blurhash } from 'react-blurhash'

export default function ProgressiveImage({
    src,
    blurhash,
    alt,
    className = ""
}) {
    const [isLoaded, setIsLoaded] = useState(false)

    useEffect(() => {
        if (!src) return

        // Reset state when src changes
        setIsLoaded(false)

        const img = new Image()
        img.onload = () => setIsLoaded(true)
        img.src = src

        return () => {
            img.onload = null
        }
    }, [src])

    return (
        <div className={`relative overflow-hidden ${className}`}>
            {/* Blurhash Placeholder */}
            {blurhash && (
                <div
                    className={`absolute inset-0 transition-opacity duration-700 ease-in-out z-10 
                    ${isLoaded ? 'opacity-0' : 'opacity-100'}`}
                >
                    <Blurhash
                        hash={blurhash}
                        width="100%"
                        height="100%"
                        resolutionX={32}
                        resolutionY={32}
                        punch={1}
                    />
                </div>
            )}

            {/* Actual Image */}
            <img
                src={src}
                alt={alt}
                className={`absolute inset-0 w-full h-full object-cover transition-all duration-700 ease-in-out z-0
                    ${isLoaded ? 'opacity-100 scale-100' : 'opacity-0 scale-105'}`}
            />
        </div>
    )
}
