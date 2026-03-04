import { motion } from 'framer-motion'

export default function SkeletonGrid({ count = 6, type = 'photo' }) {
    // We create an array of length `count`
    const skeletons = Array.from({ length: count })

    return (
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-6 w-full">
            {skeletons.map((_, i) => (
                <div
                    key={i}
                    className={`w-full rounded-xl bg-charcoal/10 relative overflow-hidden flex items-center justify-center ${type === 'photo' ? 'aspect-[4/3]' : 'aspect-video'
                        }`}
                >
                    {/* Shimmer effect */}
                    <motion.div
                        className="absolute inset-0 -translate-x-full"
                        style={{
                            background: "linear-gradient(90deg, transparent 0%, rgba(255, 255, 255, 0.4) 50%, transparent 100%)"
                        }}
                        animate={{
                            translateX: ['-100%', '100%']
                        }}
                        transition={{
                            repeat: Infinity,
                            duration: 1.5,
                            ease: "easeInOut",
                        }}
                    />

                    {/* Optional inner icon placeholder for video */}
                    {type === 'video' && (
                        <div className="w-16 h-16 rounded-full bg-white/30 backdrop-blur-sm flex items-center justify-center text-white/50">
                            <svg className="w-8 h-8 ml-1" fill="currentColor" viewBox="0 0 24 24">
                                <path d="M8 5v14l11-7z" />
                            </svg>
                        </div>
                    )}
                </div>
            ))}
        </div>
    )
}
