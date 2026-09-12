import { useMemo } from 'react'
import { photoEquipment } from '../utils/photoStats'

export default function AlbumStats({ images = [] }) {
    // Derive equipment from the current photos so removed lenses never leave
    // behind a stored count, and newly uploaded equipment appears automatically.
    const { cameras, lenses } = useMemo(() => photoEquipment(images), [images])

    return (
        <dl aria-label="Album statistics" className="mt-5 grid grid-cols-[max-content_minmax(0,1fr)] gap-x-4 gap-y-1 text-xs leading-relaxed text-warm-gray">
            <dt className="font-medium">Total photos</dt>
            <dd>{images.length}</dd>
            <dt className="font-medium">{cameras.length > 1 ? 'Cameras used' : 'Camera used'}</dt>
            <dd className="[overflow-wrap:anywhere]">{cameras.join(' · ') || 'Not recorded'}</dd>
            <dt className="font-medium">Lenses used</dt>
            <dd className="min-w-0 [overflow-wrap:anywhere]">
                {lenses.length > 0 ? (
                    <ul className="flex flex-wrap gap-x-4 gap-y-1">
                        {lenses.map(([name, count]) => <li key={name}>{name} ({count})</li>)}
                    </ul>
                ) : 'Not recorded'}
            </dd>
        </dl>
    )
}
