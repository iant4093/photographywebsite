// Exercise the shipped native binary with an original, synthetic linear DNG.
// No downloaded or customer photographs are needed for this regression test.
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createRequire } from 'node:module'

function syntheticDng() {
    const width = 128, height = 96
    const entries = []
    const field = (tag, type, values) => {
        const sizes = { 1: 1, 2: 1, 3: 2, 4: 4, 5: 8, 10: 8 }
        const data = Buffer.alloc(values.length * sizes[type])
        values.forEach((value, index) => {
            const offset = index * sizes[type]
            if (type <= 2) data.writeUInt8(value, offset)
            else if (type === 3) data.writeUInt16LE(value, offset)
            else if (type === 4) data.writeUInt32LE(value, offset)
            else {
                data.writeInt32LE(value, offset)
                data.writeInt32LE(1, offset + 4)
            }
        })
        entries.push({ tag, type, count: values.length, data })
    }
    field(254, 4, [0])
    field(256, 4, [width]); field(257, 4, [height])
    field(258, 3, [16, 16, 16]); field(259, 3, [1]); field(262, 3, [34892])
    field(271, 2, [...Buffer.from('Synthetic\0')]); field(272, 2, [...Buffer.from('License smoke fixture\0')])
    field(273, 4, [0]); field(277, 3, [3]); field(278, 4, [height])
    field(279, 4, [width * height * 6]); field(284, 3, [1])
    field(50706, 1, [1, 4, 0, 0]); field(50707, 1, [1, 1, 0, 0])
    field(50708, 2, [...Buffer.from('Synthetic RGB DNG\0')])
    field(50717, 4, [65535, 65535, 65535])
    field(50718, 5, [1, 1]); field(50719, 4, [0, 0]); field(50720, 4, [width, height])
    field(50721, 10, [1, 0, 0, 0, 1, 0, 0, 0, 1])
    field(50728, 5, [1, 1, 1]); field(50778, 3, [21])
    entries.sort((a, b) => a.tag - b.tag)
    let offset = 8 + 2 + entries.length * 12 + 4
    for (const entry of entries) if (entry.data.length > 4) { entry.offset = offset; offset += entry.data.length + entry.data.length % 2 }
    entries.find(entry => entry.tag === 273).data.writeUInt32LE(offset)
    const bytes = Buffer.alloc(offset + width * height * 6)
    bytes.write('II'); bytes.writeUInt16LE(42, 2); bytes.writeUInt32LE(8, 4)
    bytes.writeUInt16LE(entries.length, 8)
    entries.forEach((entry, index) => {
        const at = 10 + index * 12
        bytes.writeUInt16LE(entry.tag, at); bytes.writeUInt16LE(entry.type, at + 2); bytes.writeUInt32LE(entry.count, at + 4)
        if (entry.offset) { bytes.writeUInt32LE(entry.offset, at + 8); entry.data.copy(bytes, entry.offset) }
        else entry.data.copy(bytes, at + 8)
    })
    for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
        const at = offset + (y * width + x) * 6
        bytes.writeUInt16LE(2000 + x * 350, at)
        bytes.writeUInt16LE(2000 + y * 400, at + 2)
        bytes.writeUInt16LE(16000, at + 4)
    }
    return { bytes, width, height }
}

const temporary = mkdtempSync(join(tmpdir(), 'photography-raw-smoke-'))
try {
    const core = new URL('../src/editor/vendor/rawconvert-core.js', import.meta.url)
    const source = readFileSync(core, 'utf8')
    assert.doesNotMatch(source, /new Function\s*\(|\beval\s*\(/, 'RAW core must work without unsafe-eval')
    const modulePath = join(temporary, 'core.cjs')
    writeFileSync(modulePath, source)
    const createCore = createRequire(import.meta.url)(modulePath)
    const runtime = await createCore({ wasmBinary: readFileSync(new URL('../src/editor/vendor/rawconvert-core.wasm', import.meta.url)) })
    const processor = new runtime.RawProcessor()
    const { bytes, width, height } = syntheticDng()
    if (process.argv[2]) writeFileSync(process.argv[2], bytes)
    runtime.FS.writeFile('/tmp/input.dng', bytes)
    assert.equal(processor.loadFromFile('/tmp/input.dng'), true, processor.getLastError())
    assert.equal(processor.getMetadata().librawVersion, '0.22.2-Release')
    // The worker unlinks its temporary input immediately after loading it.
    runtime.FS.unlink('/tmp/input.dng')
    const options = { colorSpace: 1, interpolation: 3, outputBps: 8, halfSize: false, autoWhiteBalance: false, cameraWhiteBalance: true, brightness: 1, highlightMode: 2, noiseReduction: 0, medianPasses: 0 }
    assert.equal(processor.process(options), true, processor.getLastError())
    assert.equal(processor.exportRawPixels('/tmp/pixels.bin'), true, processor.getLastError())
    const result = Buffer.from(runtime.FS.readFile('/tmp/pixels.bin'))
    assert.equal(result.readUInt32LE(0), width)
    assert.equal(result.readUInt32LE(4), height)
    assert.equal(result.readUInt16LE(8), 8)
    assert.equal(result[10], 3)
    assert.equal(result.length, 11 + width * height * 3)
    assert.ok(new Set(result.subarray(11)).size > 100, 'Decoder should preserve the color gradient')
    processor.reset()
    assert.equal(processor.isLoaded(), false)
    runtime.FS.writeFile('/tmp/invalid.dng', new Uint8Array([1, 2, 3]))
    assert.equal(processor.loadFromFile('/tmp/invalid.dng'), false)
    assert.ok(processor.getLastError())
    processor.delete()
    console.log(`RAW native smoke passed: ${width}×${height} RGB DNG, pixel output, invalid input, reset, and CSP.`)
} finally {
    rmSync(temporary, { recursive: true, force: true })
}
