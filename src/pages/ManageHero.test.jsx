import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { MemoryRouter } from 'react-router'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const api = vi.hoisted(() => ({
  requestHeroUploadUrl: vi.fn(),
  uploadFileToS3: vi.fn(),
  completeHeroUpload: vi.fn(),
}))
const auth = vi.hoisted(() => ({ getIdToken: vi.fn() }))

vi.mock('../context/auth', () => ({ useAuth: () => auth }))
vi.mock('../utils/api', () => api)

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
    api.requestHeroUploadUrl.mockResolvedValue({
      uploadUrl: 'https://upload.example',
      requiredHeaders: {
        'Content-Type': 'image/jpeg',
        'x-amz-tagging': 'visibility=pending',
      },
    })
    api.uploadFileToS3.mockResolvedValue(new Response('', { headers: { ETag: `"${ETAG}"` } }))
    api.completeHeroUpload.mockResolvedValue({ heroUrl: 'https://media.example/site/hero/home' })
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
    expect(await screen.findByText('Hero cover updated successfully.')).toBeInTheDocument()
    expect(api.requestHeroUploadUrl).toHaveBeenCalledWith('admin-token', file, expect.objectContaining({ signal: expect.any(AbortSignal) }))
    expect(api.uploadFileToS3).toHaveBeenCalledWith(
      'https://upload.example',
      file,
      expect.objectContaining({ 'x-amz-tagging': 'visibility=pending' }),
      expect.objectContaining({ retries: 1, signal: expect.any(AbortSignal) }),
    )
    expect(api.completeHeroUpload).toHaveBeenCalledWith('admin-token', `"${ETAG}"`, expect.anything())
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
    const current = screen.getByRole('img', { name: 'Current homepage hero cover' })
    fireEvent.error(current)
    expect(screen.getByRole('img', { name: 'Current homepage hero cover' }))
      .toHaveAttribute('src', '/images/heroes/photo-1280.jpg')
  })
})
