import { useEffect, useMemo } from 'react'
import { museumRoomSkylights } from '../../utils/museumSkylights'
import { createMuseumSkylightGeometry } from '../../utils/museumSkylightGeometry'

export default function MuseumSkylights({ room }) {
    const geometry = useMemo(() => createMuseumSkylightGeometry(museumRoomSkylights(room)), [room])
    useEffect(() => () => {
        geometry.frames?.dispose()
        geometry.panes?.dispose()
    }, [geometry])
    if (!geometry.frames) return null
    return (
        <group>
            {/* Two opaque batches per selected room, no textures, dynamic
                lights, offscreen glass/refraction, or animation callbacks. */}
            <mesh geometry={geometry.frames}>
                <meshStandardMaterial vertexColors color="#ffffff" roughness={0.82} />
            </mesh>
            <mesh geometry={geometry.panes}>
                <meshStandardMaterial
                    vertexColors color="#ffffff" roughness={0.92}
                    emissive="#a3c2d5" emissiveIntensity={0.7}
                />
            </mesh>
        </group>
    )
}
