import { describe, expect, it, vi } from 'vitest'
import { canPrintProtectedPhoto, pictoremOrderUrl, pictoremProtectedOrderUrl } from './printOrders'

vi.mock('./mediaUrls', () => ({ cdnDomain: 'media.test' }))

const downloadUrl = 'https://media.test/albums/album/original/Cape%20Horn%20%26%20River.JPG'

describe('Pictorem print link', () => {
    it('passes the full edited image address with the public PRO ID', () => {
        const url = new URL(pictoremOrderUrl({ downloadUrl, before: { url: 'https://media.test/before.jpg' } }))
        expect(url.origin + url.pathname).toBe('https://www.pictorem.com/order.html')
        expect(url.searchParams.get('apiid')).toBe('HQ1RAJ10HOD')
        expect(url.searchParams.get('import')).toBe(downloadUrl)
    })

    it('uses the signed edited source returned by the server for protected galleries', () => {
        const source = 'https://bucket.s3.us-west-2.amazonaws.com/albums/demo/original/one.jpg?X-Amz-Expires=300&X-Amz-Signature=example'
        expect(canPrintProtectedPhoto({ freshDownloadRequired: true, url: downloadUrl })).toBe(true)
        expect(canPrintProtectedPhoto({ freshDownloadRequired: true, url: downloadUrl.replace('.JPG', '.webp') })).toBe(false)
        expect(new URL(pictoremProtectedOrderUrl(source)).searchParams.get('import')).toBe(source)
        expect(pictoremProtectedOrderUrl(downloadUrl)).toBe('')
    })

    it.each([
        null,
        { url: downloadUrl },
        { downloadUrl, freshDownloadRequired: true },
        { downloadUrl: downloadUrl + '?Signature=private' },
        { downloadUrl: downloadUrl + '#private' },
        { downloadUrl: downloadUrl.replace('https:', 'http:') },
        { downloadUrl: downloadUrl.replace('media.test', 'another.test') },
        { downloadUrl: downloadUrl.replace('media.test', 'user:pass@media.test') },
        { downloadUrl: downloadUrl.replace('/albums/', '/public-previews/') },
        { downloadUrl: downloadUrl.replace('.JPG', '.webp') },
        { downloadUrl: 'not a URL' },
    ])('omits the link when the photo has no eligible public asset (%j)', photo => {
        expect(pictoremOrderUrl(photo)).toBe('')
    })
})
