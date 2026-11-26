import { useLayoutEffect, useRef } from 'react'
import { useFrame } from '@react-three/fiber'
import * as THREE from 'three'
import { FullScreenQuad } from 'three/addons/postprocessing/Pass.js'

const fragmentShader = `
    uniform sampler2D departure;
    uniform sampler2D destination;
    uniform vec2 focus;
    uniform float aspect;
    uniform float amount;
    uniform float destinationBend;
    uniform float reveal;
    varying vec2 vUv;

    vec2 bend(vec2 uv, float pull) {
        vec2 offset = uv - focus;
        float radius = length(offset * vec2(aspect, 1.0));
        // The edges travel farther than the centre, bowing straight lines as
        // the photograph expands. At zero pull the mapping is exactly 1:1.
        float edge = radius / (0.30 + radius);
        return focus + offset / (1.0 + pull * (0.22 + 2.5 * edge * edge));
    }

    void main() {
        vec2 outgoing = bend(vUv, amount * (1.0 + 1.2 * reveal));
        vec3 colour = texture2D(departure, outgoing).rgb;
        if (reveal > 0.0) {
            float radius = length((vUv - focus) * vec2(aspect, 1.0));
            float edge = radius / (0.40 + radius);
            float blend = smoothstep(0.30 * edge, 0.70 + 0.30 * edge, reveal);
            vec2 incoming = bend(vUv, destinationBend * (1.0 - reveal));
            colour = mix(colour, texture2D(destination, incoming).rgb, blend);
        }
        gl_FragColor = vec4(colour, 1.0);
    }
`

function frameTexture(gl, frame) {
    const { width, height } = gl.domElement
    if (!frame || frame.image.width !== width || frame.image.height !== height) {
        frame?.dispose()
        frame = new THREE.FramebufferTexture(width, height)
        frame.magFilter = frame.minFilter = THREE.LinearFilter
    }
    return frame
}

function createMorphQuad() {
    const material = new THREE.ShaderMaterial({
        uniforms: {
            departure: { value: null }, destination: { value: null },
            focus: { value: new THREE.Vector2(0.5, 0.5) }, aspect: { value: 1 },
            amount: { value: 0 }, destinationBend: { value: 1 }, reveal: { value: 0 },
        },
        vertexShader: 'varying vec2 vUv; void main(){ vUv = uv; gl_Position = vec4(position.xy, 0.0, 1.0); }',
        fragmentShader, depthTest: false, depthWrite: false, toneMapped: false,
    })
    return new FullScreenQuad(material)
}

export default function MuseumMorphPass({ phase, destinationBend, motion, reducedMotion }) {
    const pass = useRef(null)
    useLayoutEffect(() => () => {
        const quad = pass.current
        if (!quad) return
        const { material } = quad
        material.uniforms.departure.value?.dispose()
        material.uniforms.destination.value?.dispose()
        material.dispose()
        quad.dispose()
        pass.current = null
    }, [])

    // Warm the morph during the first normal gallery draw, behind the entry
    // screen. The first E press can then reuse the shader and capture buffers.
    useFrame(({ gl }) => {
        if (pass.current || reducedMotion) return
        const quad = createMorphQuad()
        pass.current = quad
        const { departure, destination } = quad.material.uniforms
        departure.value = frameTexture(gl)
        destination.value = frameTexture(gl)
        const scissor = gl.getScissor(new THREE.Vector4())
        const scissorTest = gl.getScissorTest()
        try {
            gl.setScissorTest(true)
            gl.setScissor(0, 0, 1, 1)
            quad.render(gl)
        } finally {
            gl.setScissor(scissor)
            gl.setScissorTest(scissorTest)
        }
    })

    // Only take over the renderer during the morph. Keep its shader and two
    // frame textures available for the return trip, at the current canvas size.
    return phase ? <MorphFrame pass={pass} phase={phase} destinationBend={destinationBend} motion={motion} /> : null
}

function MorphFrame({ pass, phase, destinationBend, motion }) {
    const hasDeparture = useRef(false)
    useFrame(({ gl, scene, camera }) => {
        gl.render(scene, camera)
        const quad = pass.current ??= createMorphQuad()
        const u = quad.material.uniforms
        const frame = phase === 'jump' ? u.departure : u.destination
        frame.value = frameTexture(gl, frame.value)
        gl.copyFramebufferToTexture(frame.value)
        // Reduced motion can be toggled while crossing.
        if (phase === 'jump') hasDeparture.current = true
        if (!hasDeparture.current) return
        u.amount.value = motion.current.amount
        u.destinationBend.value = destinationBend
        u.reveal.value = phase === 'jump' ? 0 : motion.current.reveal
        u.focus.value.copy(motion.current.focus)
        u.aspect.value = camera.aspect
        quad.render(gl)
    }, 1)
    return null
}
