import { describe, expect, it } from 'vitest'

import { parseHlsVariants, qualityLabel, qualityOptions } from './hlsSource'

describe('stream quality helpers', () => {
    it('names qualities by the short side, whichever way the video is turned', () => {
        expect(qualityLabel(3840, 2160)).toBe('4K')
        expect(qualityLabel(2160, 3840)).toBe('4K')
        expect(qualityLabel(1920, 1080)).toBe('1080p')
        expect(qualityLabel(1080, 1920)).toBe('1080p')
        expect(qualityLabel(1920, 1072)).toBe('1080p')
        expect(qualityLabel(2560, 1440)).toBe('1440p')
        expect(qualityLabel(3000, 1688)).toBe('1688p')
        expect(qualityLabel(0, 1080)).toBe('')
        expect(qualityLabel()).toBe('')
    })

    it('keeps one option per label, the best bitrate, highest quality first', () => {
        expect(qualityOptions([
            { width: 640, height: 360, bitrate: 1, value: 5 },
            { width: 1920, height: 1080, bitrate: 2, value: 1 },
            { width: 1920, height: 1080, bitrate: 9, value: 2 },
            { width: 3840, height: 2160, value: 0 },
            { width: 0, height: 0, value: 9 },
        ])).toEqual([
            { value: '0', label: '4K' },
            { value: '2', label: '1080p' },
            { value: '5', label: '360p' },
        ])
        expect(qualityOptions(undefined)).toEqual([])
    })

    it('reads variant streams from a multivariant playlist', () => {
        const text = [
            '#EXTM3U',
            '#EXT-X-VERSION:3',
            '#EXT-X-STREAM-INF:AVERAGE-BANDWIDTH=4000000,BANDWIDTH=6500000,RESOLUTION=1920x1080,CODECS="avc1.640028,mp4a.40.2"',
            'movie_1080p.m3u8',
            '#EXT-X-STREAM-INF:BANDWIDTH=800000,RESOLUTION=640x360',
            'https://cdn.test/elsewhere/movie_360p.m3u8',
            '#EXT-X-STREAM-INF:BANDWIDTH=1',
            'no-resolution.m3u8',
            '#EXT-X-STREAM-INF:BANDWIDTH=2,RESOLUTION=1x1',
            '#EXT-X-ENDLIST',
            '#EXT-X-STREAM-INF:RESOLUTION=2x2',
            'http://[bad',
        ].join('\r\n')
        expect(parseHlsVariants(text, 'https://cdn.test/a/b/movie.m3u8')).toEqual([
            { url: 'https://cdn.test/a/b/movie_1080p.m3u8', width: 1920, height: 1080, bitrate: 6500000 },
            { url: 'https://cdn.test/elsewhere/movie_360p.m3u8', width: 640, height: 360, bitrate: 800000 },
        ])
        expect(parseHlsVariants('not a playlist', 'https://cdn.test/x.m3u8')).toEqual([])
        expect(parseHlsVariants(null, 'https://cdn.test/x.m3u8')).toEqual([])
    })
})
