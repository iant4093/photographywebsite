import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { MemoryRouter } from 'react-router'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const api = vi.hoisted(() => ({
  requestHeroUploadUrl: vi.fn(),
  uploadFileToS3: vi.fn(),
  completeHeroUpload: vi.fn(),
}))
const videoApi = vi.hoisted(() => ({
  requestVideoHeroUploadUrl: vi.fn(),
  completeVideoHeroUpload: vi.fn(),
}))
const auth = vi.hoisted(() => ({ getIdToken: vi.fn() }))
const publication = vi.hoisted(() => ({ waitForHeroPublication: vi.fn() }))

vi.mock('../context/auth', () => ({ useAuth: () => auth }))
vi.mock('../utils/api', () => api)
vi.mock('../utils/videoHeroApi', () => videoApi)
vi.mock('../utils/heroPublication', () => publication)
vi.mock('../hooks/usePublishedHero', () => ({ default: () => null }))

import ManageHero from './ManageHero'

const ETAG = '0123456789abcdef0123456789abcdef'

function heroFile(name = 'hero.jpg', type = 'image/jpeg') {
  return new File([new Uint8Array(2048)], name, { type })
}

function mounted() {
  return render(<MemoryRouter><ManageHero /></MemoryRouter>)
}

describe('admin hero cover upload', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    Object.defineProperties(URL, {
      createObjectURL: { configurable: true, value: vi.fn(() => 'blob:hero-preview') },
      revokeObjectURL: { configurable: true, value: vi.fn() },
    })
    auth.getIdToken.mockResolvedValue('admin-token')
    publication.waitForHeroPublication.mockImplementation(async (heroType) => ({
      version: ETAG,
      variants: { jpeg: [{ width: 1280, url: `https://media.example/site/hero/versions/${heroType}/${ETAG}/hero-1280.jpg` }] },
    }))
    api.requestHeroUploadUrl.mockResolvedValue({
      uploadUrl: 'https://upload.example',
      requiredHeaders: {
        'Content-Type': 'image/jpeg',
        'x-amz-tagging': 'visibility=pending',
      },
    })
    api.uploadFileToS3.mockResolvedValue(new Response('', { headers: { ETag: `"${ETAG}"` } }))
    api.completeHeroUpload.mockResolvedValue({ heroUrl: 'https://media.example/site/hero/home' })
    videoApi.requestVideoHeroUploadUrl.mockResolvedValue({
      uploadUrl: 'https://upload.example',
      requiredHeaders: {
        'Content-Type': 'image/jpeg',
        'x-amz-tagging': 'visibility=pending',
      },
    })
    videoApi.completeVideoHeroUpload.mockResolvedValue({ heroUrl: 'https://media.example/site/hero/video/home' })
  })

  it('uploads the exact original file and activates it without album or backup fields', async () => {
    const { container } = mounted()
    const file = heroFile()
    fireEvent.change(screen.getByLabelText('New hero image'), { target: { files: [file] } })
    expect(screen.getByText(/hero\.jpg · 0\.0 MB/)).toBeInTheDocument()

    const preview = screen.getByRole('img', { name: 'Selected hero cover preview' })
    Object.defineProperties(preview, {
      naturalWidth: { configurable: true, value: 2200 },
      naturalHeight: { configurable: true, value: 1400 },
    })
    fireEvent.load(preview)
    expect(screen.getByText(/2200 × 1400/)).toBeInTheDocument()
    expect(screen.getByText(/under the recommended 2560-pixel width/)).toBeInTheDocument()

    fireEvent.submit(container.querySelector('form'))
    expect(await screen.findByText('Photo Gallery cover is live.')).toBeInTheDocument()
    expect(publication.waitForHeroPublication).toHaveBeenCalledWith('photo', `"${ETAG}"`, expect.objectContaining({ signal: expect.any(AbortSignal) }))
    expect(screen.getByRole('img', { name: 'Current photography homepage hero cover' })).toHaveAttribute('src', expect.stringContaining(ETAG))
    expect(api.requestHeroUploadUrl).toHaveBeenCalledWith('admin-token', file, expect.objectContaining({ signal: expect.any(AbortSignal) }))
    expect(api.uploadFileToS3).toHaveBeenCalledWith(
      'https://upload.example',
      file,
      expect.objectContaining({ 'x-amz-tagging': 'visibility=pending' }),
      expect.objectContaining({ retries: 1, signal: expect.any(AbortSignal) }),
    )
    expect(api.completeHeroUpload).toHaveBeenCalledWith('admin-token', `"${ETAG}"`, expect.objectContaining({ signal: expect.any(AbortSignal) }))
    const authorizationBody = api.requestHeroUploadUrl.mock.calls[0]
    expect(JSON.stringify(authorizationBody)).not.toContain('album')
    expect(JSON.stringify(authorizationBody)).not.toContain('Google')
  })

  it('rejects unsupported and oversized files before requesting credentials', () => {
    mounted()
    const input = screen.getByLabelText('New hero image')
    fireEvent.change(input, { target: { files: [heroFile('hero.svg', 'image/svg+xml')] } })
    expect(screen.getByRole('alert')).toHaveTextContent('Choose a JPEG, PNG, WebP, or AVIF image.')

    const oversized = heroFile()
    Object.defineProperty(oversized, 'size', { configurable: true, value: (51 * 1024 * 1024) })
    fireEvent.change(input, { target: { files: [oversized] } })
    expect(screen.getByRole('alert')).toHaveTextContent('50 MB or smaller')
    expect(api.requestHeroUploadUrl).not.toHaveBeenCalled()
  })

  it('surfaces a missing S3 receipt and never activates an unverifiable upload', async () => {
    api.uploadFileToS3.mockResolvedValue(new Response(''))
    const { container } = mounted()
    fireEvent.change(screen.getByLabelText('New hero image'), { target: { files: [heroFile()] } })
    fireEvent.submit(container.querySelector('form'))
    expect(await screen.findByRole('alert')).toHaveTextContent('without a receipt')
    expect(api.completeHeroUpload).not.toHaveBeenCalled()
    await waitFor(() => expect(screen.getByRole('button', { name: 'Upload and Change Cover' })).toBeEnabled())
  })

  it('falls back to the bundled current cover when the managed object is absent', () => {
    mounted()
    const current = screen.getByRole('img', { name: 'Current photography homepage hero cover' })
    fireEvent.error(current)
    expect(screen.getByRole('img', { name: 'Current photography homepage hero cover' }))
      .toHaveAttribute('src', '/images/heroes/photo-1280.jpg')
  })

  it('switches to an isolated video-page hero and uploads within that tab', async () => {
    const { container } = mounted()
    fireEvent.click(screen.getByRole('tab', { name: 'Video Page' }))
    expect(screen.getByRole('tab', { name: 'Video Page' })).toHaveAttribute('aria-selected', 'true')
    expect(screen.getByText('Updating: Video Page')).toBeInTheDocument()
    const current = screen.getByRole('img', { name: 'Current video page hero cover' })
    expect(current).toHaveAttribute('src', expect.stringContaining('/site/hero/video/home'))

    const file = heroFile('video-hero.jpg')
    fireEvent.change(screen.getByLabelText('New hero image'), { target: { files: [file] } })
    fireEvent.submit(container.querySelector('form'))
    expect(await screen.findByText('Video Page cover is live.')).toBeInTheDocument()
    expect(publication.waitForHeroPublication).toHaveBeenCalledWith('video', `"${ETAG}"`, expect.objectContaining({ signal: expect.any(AbortSignal) }))
    expect(videoApi.requestVideoHeroUploadUrl).toHaveBeenCalledWith(
      'admin-token',
      file,
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    )
    expect(videoApi.completeVideoHeroUpload).toHaveBeenCalledWith(
      'admin-token',
      `"${ETAG}"`,
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    )
  })

  it('retains the selected preview and waits for publication before announcing success', async () => {
    let finish
    publication.waitForHeroPublication.mockReturnValue(new Promise((resolve) => { finish = resolve }))
    const { container } = mounted()
    fireEvent.change(screen.getByLabelText('New hero image'), { target: { files: [heroFile()] } })
    fireEvent.submit(container.querySelector('form'))
    expect(await screen.findByText(/Publishing your new cover/)).toBeInTheDocument()
    expect(screen.queryByText(/cover is live/)).not.toBeInTheDocument()
    expect(screen.getByRole('img', { name: 'Selected hero cover preview' })).toBeInTheDocument()
    expect(screen.getByRole('tab', { name: 'Video Page' })).toBeDisabled()
    finish({ variants: { jpeg: [{ width: 1280, url: 'https://media.example/published.jpg' }] } })
    expect(await screen.findByText('Photo Gallery cover is live.')).toBeInTheDocument()
  })

  it('surfaces a publication timeout without losing the selected file or claiming success', async () => {
    publication.waitForHeroPublication.mockRejectedValue(new Error('Publication has not been confirmed yet.'))
    const { container } = mounted()
    fireEvent.change(screen.getByLabelText('New hero image'), { target: { files: [heroFile()] } })
    fireEvent.submit(container.querySelector('form'))
    expect(await screen.findByRole('alert')).toHaveTextContent('Publication has not been confirmed yet.')
    expect(screen.queryByText(/cover is live/)).not.toBeInTheDocument()
    expect(screen.getByRole('img', { name: 'Selected hero cover preview' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Upload and Change Cover' })).toBeEnabled()
  })
})
