import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { MemoryRouter, Route, Routes, useLocation } from 'react-router'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const auth = vi.hoisted(() => ({
  adminMfaStatus: 'required',
  userEmail: 'admin@example.com',
  refreshAdminMfaStatus: vi.fn(),
  beginAdminMfaSetup: vi.fn(),
  completeAdminMfaSetup: vi.fn(),
  logout: vi.fn(),
}))
const qr = vi.hoisted(() => ({ toDataURL: vi.fn() }))

vi.mock('../context/auth', () => ({ useAuth: () => auth }))
vi.mock('qrcode', () => ({ default: qr }))

import AdminSecurity from './AdminSecurity'

function LoginDestination() {
  const location = useLocation()
  return <div>{location.state?.mfaEnabled ? 'MFA enabled destination' : 'Login destination'}</div>
}

function mounted() {
  return render(
    <MemoryRouter initialEntries={['/admin/security']}>
      <Routes>
        <Route path="/admin/security" element={<AdminSecurity />} />
        <Route path="/admin" element={<div>Admin destination</div>} />
        <Route path="/login" element={<LoginDestination />} />
      </Routes>
    </MemoryRouter>,
  )
}

describe('AdminSecurity', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    auth.adminMfaStatus = 'required'
    auth.beginAdminMfaSetup.mockResolvedValue('ABCDEF234567')
    auth.completeAdminMfaSetup.mockResolvedValue({ globallySignedOut: true })
    auth.refreshAdminMfaStatus.mockResolvedValue('required')
    qr.toDataURL.mockResolvedValue('data:image/png;base64,qr')
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: { writeText: vi.fn().mockResolvedValue(undefined) },
    })
  })

  it('enrolls an authenticator and sends the admin through a fresh sign-in', async () => {
    mounted()
    expect(screen.getByRole('heading', { name: 'Set up two-factor authentication' })).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Set Up Authenticator' }))

    const image = await screen.findByRole('img', { name: 'Authenticator setup QR code' })
    expect(image).toHaveAttribute('src', 'data:image/png;base64,qr')
    expect(qr.toDataURL).toHaveBeenCalledWith(
      expect.stringContaining('otpauth://totp/'),
      expect.objectContaining({ errorCorrectionLevel: 'M' }),
    )
    expect(qr.toDataURL.mock.calls[0][0]).toContain('secret=ABCDEF234567')
    expect(screen.getByText('ABCD EF23 4567')).toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: 'Copy Key' }))
    await waitFor(() => expect(navigator.clipboard.writeText).toHaveBeenCalledWith('ABCDEF234567'))

    fireEvent.change(screen.getByLabelText('Authenticator code'), { target: { value: '123456' } })
    fireEvent.click(screen.getByRole('button', { name: 'Enable Two-Factor Authentication' }))
    expect(await screen.findByText('MFA enabled destination')).toBeInTheDocument()
    expect(auth.completeAdminMfaSetup).toHaveBeenCalledWith('123456')
  })

  it('validates codes and surfaces setup and verification failures safely', async () => {
    auth.beginAdminMfaSetup.mockRejectedValueOnce(new Error('Setup unavailable'))
    mounted()
    fireEvent.click(screen.getByRole('button', { name: 'Set Up Authenticator' }))
    expect(await screen.findByRole('alert')).toHaveTextContent('Setup unavailable')

    fireEvent.click(screen.getByRole('button', { name: 'Set Up Authenticator' }))
    await screen.findByRole('img', { name: 'Authenticator setup QR code' })
    fireEvent.change(screen.getByLabelText('Authenticator code'), { target: { value: '123' } })
    fireEvent.submit(screen.getByLabelText('Authenticator code').closest('form'))
    expect(screen.getByRole('alert')).toHaveTextContent('Enter the 6-digit code')

    auth.completeAdminMfaSetup.mockRejectedValueOnce(new Error('Fresh code required'))
    fireEvent.change(screen.getByLabelText('Authenticator code'), { target: { value: '654321' } })
    fireEvent.click(screen.getByRole('button', { name: 'Enable Two-Factor Authentication' }))
    expect(await screen.findByRole('alert')).toHaveTextContent('Fresh code required')
    expect(screen.getByLabelText('Authenticator code')).toHaveValue('')
  })

  it('renders enabled, checking, and fail-closed status views', () => {
    auth.adminMfaStatus = 'enabled'
    const enabled = mounted()
    expect(screen.getByRole('heading', { name: 'Two-factor authentication is enabled' })).toBeInTheDocument()
    expect(screen.getByRole('link', { name: /Back to Admin Dashboard/ })).toHaveAttribute('href', '/admin')
    enabled.unmount()

    auth.adminMfaStatus = 'checking'
    const checking = mounted()
    expect(screen.getByRole('status')).toHaveTextContent('Checking two-factor authentication')
    checking.unmount()

    auth.adminMfaStatus = 'error'
    mounted()
    expect(screen.getByRole('heading', { name: 'Security Check Unavailable' })).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Try Again' }))
    expect(auth.refreshAdminMfaStatus).toHaveBeenCalled()
    fireEvent.click(screen.getByRole('button', { name: 'Sign Out' }))
    expect(auth.logout).toHaveBeenCalled()
  })
})
