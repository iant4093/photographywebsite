import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { MemoryRouter, Route, Routes } from 'react-router'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const api = vi.hoisted(() => ({
  createUser: vi.fn(), sendContactMessage: vi.fn(), listUsers: vi.fn(),
  deleteUser: vi.fn(), editUser: vi.fn(),
}))
const auth = vi.hoisted(() => ({
  getIdToken: vi.fn(), login: vi.fn(), completeNewPassword: vi.fn(), completeMfa: vi.fn(),
  user: null, isAdmin: false,
}))
const turnstileReset = vi.hoisted(() => vi.fn())

vi.mock('../utils/api', () => api)
vi.mock('../context/auth', () => ({ useAuth: () => auth }))
vi.mock('@marsidev/react-turnstile', async () => {
  const React = await import('react')
  return {
    Turnstile: ({ onSuccess, onExpire, onError, ref }) => {
      React.useEffect(() => {
        if (ref) ref.current = { reset: turnstileReset }
      }, [ref])
      return <div>
        <button type="button" onClick={() => onSuccess?.('turnstile-token')}>Solve challenge</button>
        <button type="button" onClick={() => onExpire?.()}>Expire challenge</button>
        <button type="button" onClick={() => onError?.()}>Fail challenge</button>
      </div>
    },
  }
})
vi.mock('framer-motion', () => ({ motion: { div: ({ children, ...props }) => {
  const { variants: _variants, initial: _initial, animate: _animate, exit: _exit, ...domProps } = props
  return <div {...domProps}>{children}</div>
} } }))

import AddUser from './AddUser'
import Contact from './Contact'
import DeleteUser from './DeleteUser'
import EditUser from './EditUser'
import Login from './Login'

function routed(ui, path = '/') {
  return render(<MemoryRouter initialEntries={[path]}>{ui}</MemoryRouter>)
}

function loginRouted() {
  return render(
    <MemoryRouter initialEntries={['/login']}>
      <Routes>
        <Route path="/login" element={<Login />} />
        <Route path="/admin" element={<div>Admin destination</div>} />
        <Route path="/dashboard" element={<div>User destination</div>} />
      </Routes>
    </MemoryRouter>,
  )
}

function submitForm() {
  fireEvent.submit(document.querySelector('form'))
}

describe('AddUser', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    auth.getIdToken.mockResolvedValue('token')
    api.createUser.mockResolvedValue({})
  })

  it('creates an invitation and clears the address', async () => {
    routed(<AddUser />)
    expect(screen.getByRole('link', { name: /Back to Manage Users/ })).toHaveAttribute('href', '/admin/users')
    fireEvent.change(screen.getByLabelText('Email *'), { target: { value: 'viewer@example.com' } })
    submitForm()
    expect(await screen.findByText(/Invitation sent to viewer@example.com/)).toBeInTheDocument()
    expect(api.createUser).toHaveBeenCalledWith('token', 'viewer@example.com')
    expect(screen.getByLabelText('Email *')).toHaveValue('')
  })

  it('shows backend and fallback errors while preserving the address', async () => {
    api.createUser.mockRejectedValueOnce(new Error('Already exists')).mockRejectedValueOnce({})
    routed(<AddUser />)
    const input = screen.getByLabelText('Email *')
    fireEvent.change(input, { target: { value: 'same@example.com' } })
    submitForm()
    expect(await screen.findByText('Already exists')).toBeInTheDocument()
    submitForm()
    expect(await screen.findByText('Failed to create user.')).toBeInTheDocument()
  })
})

describe('Contact', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    api.sendContactMessage.mockResolvedValue({})
  })

  const fill = () => {
    fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'Ian' } })
    fireEvent.change(screen.getByLabelText('Email'), { target: { value: 'ian@example.com' } })
    fireEvent.change(screen.getByLabelText('Message'), { target: { value: 'Hello' } })
  }

  it('requires Turnstile, handles widget failures, sends, clears, and resets', async () => {
    routed(<Contact />)
    expect(screen.getByRole('link', { name: 'privacy notice' })).toHaveAttribute('href', '/privacy')
    expect(screen.getByLabelText('Name')).not.toHaveAttribute('placeholder')
    expect(screen.getByLabelText('Email')).not.toHaveAttribute('placeholder')
    expect(screen.getByLabelText('Message')).not.toHaveAttribute('placeholder')
    expect(screen.getByRole('button', { name: 'Send Message' })).toHaveClass('contact-submit')
    fill()
    submitForm()
    expect(screen.getByText('Please complete the security check.')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Expire challenge' }))
    expect(screen.getByText(/security check expired/)).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Fail challenge' }))
    expect(screen.getByText(/could not be loaded/)).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Solve challenge' }))
    submitForm()
    expect(await screen.findByText(/message was sent/)).toBeInTheDocument()
    expect(api.sendContactMessage).toHaveBeenCalledWith({ name: 'Ian', email: 'ian@example.com', message: 'Hello', turnstileToken: 'turnstile-token' })
    expect(turnstileReset).toHaveBeenCalled()
    expect(screen.getByLabelText('Name')).toHaveValue('')
  })

  it('shows explicit and fallback API errors', async () => {
    api.sendContactMessage.mockRejectedValueOnce(new Error('Mail unavailable')).mockRejectedValueOnce({})
    routed(<Contact />)
    fill()
    fireEvent.click(screen.getByRole('button', { name: 'Solve challenge' }))
    submitForm()
    expect(await screen.findByText('Mail unavailable')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Solve challenge' }))
    submitForm()
    expect(await screen.findByText(/could not be sent/)).toBeInTheDocument()
  })
})

describe('DeleteUser and EditUser', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.useFakeTimers({ shouldAdvanceTime: true })
    auth.getIdToken.mockResolvedValue('token')
    api.listUsers.mockResolvedValue([
      { email: 'iant4093@gmail.com' },
      { email: 'viewer@example.com', status: '', createdAt: null },
      { email: 'other@example.com', status: 'CONFIRMED', createdAt: '2026-01-01' },
    ])
    api.deleteUser.mockResolvedValue({ albumsDeleted: 2 })
    api.editUser.mockResolvedValue({})
  })

  it('filters users, cancels, confirms deletion, reloads, and reports deletion errors', async () => {
    routed(<DeleteUser />)
    await act(async () => vi.runOnlyPendingTimersAsync())
    expect(await screen.findByText('viewer@example.com')).toBeInTheDocument()
    expect(screen.queryByText('iant4093@gmail.com')).toBeNull()
    fireEvent.change(screen.getByPlaceholderText('Search users by email…'), { target: { value: 'none' } })
    expect(screen.getByText('No users found.')).toBeInTheDocument()
    fireEvent.change(screen.getByPlaceholderText('Search users by email…'), { target: { value: '' } })
    fireEvent.click(screen.getAllByRole('button', { name: 'Delete' })[0])
    expect(screen.getByRole('button', { name: 'Delete Permanently' })).toBeDisabled()
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }))
    expect(screen.queryByText(/Delete viewer/)).toBeNull()
    fireEvent.click(screen.getAllByRole('button', { name: 'Delete' })[0])
    fireEvent.change(screen.getByPlaceholderText('Type confirm...'), { target: { value: 'confirm' } })
    fireEvent.click(screen.getByRole('button', { name: 'Delete Permanently' }))
    expect(await screen.findByText(/deleted along with 2 album/)).toBeInTheDocument()
    expect(api.deleteUser).toHaveBeenCalledWith('token', 'viewer@example.com')

    api.deleteUser.mockRejectedValueOnce({})
    fireEvent.click(screen.getAllByRole('button', { name: 'Delete' })[0])
    fireEvent.change(screen.getByPlaceholderText('Type confirm...'), { target: { value: 'confirm' } })
    fireEvent.click(screen.getByRole('button', { name: 'Delete Permanently' }))
    expect(await screen.findByText('Failed to delete user.')).toBeInTheDocument()
    vi.useRealTimers()
  })

  it('edits/migrates users, cancels, filters, clears success, and reports errors', async () => {
    routed(<EditUser />)
    await act(async () => vi.runOnlyPendingTimersAsync())
    expect(await screen.findByText('viewer@example.com')).toBeInTheDocument()
    fireEvent.change(screen.getByPlaceholderText('Search users by email…'), { target: { value: 'none' } })
    expect(screen.getByText('No users found.')).toBeInTheDocument()
    fireEvent.change(screen.getByPlaceholderText('Search users by email…'), { target: { value: '' } })
    fireEvent.click(screen.getAllByRole('button', { name: 'Edit' })[0])
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }))
    fireEvent.click(screen.getAllByRole('button', { name: 'Edit' })[0])
    const email = screen.getByDisplayValue('viewer@example.com')
    fireEvent.change(email, { target: { value: 'new@example.com' } })
    expect(screen.getByText(/migrate all albums/)).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Save Changes' }))
    expect(await screen.findByText(/Albums have been migrated/)).toBeInTheDocument()
    expect(api.editUser).toHaveBeenCalledWith('token', 'viewer@example.com', { email: 'new@example.com' })
    await act(async () => vi.advanceTimersByTimeAsync(5_000))

    api.editUser.mockRejectedValueOnce(new Error('Edit failed'))
    fireEvent.click(screen.getAllByRole('button', { name: 'Edit' })[0])
    fireEvent.click(screen.getByRole('button', { name: 'Save Changes' }))
    expect(await screen.findByText('Edit failed')).toBeInTheDocument()
    vi.useRealTimers()
  })

  it('survives a user-list failure and clears loading', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    api.listUsers.mockRejectedValue(new Error('list failed'))
    const first = routed(<DeleteUser />)
    await act(async () => vi.runOnlyPendingTimersAsync())
    expect(await screen.findByText('No users found.')).toBeInTheDocument()
    first.unmount()
    routed(<EditUser />)
    await act(async () => vi.runOnlyPendingTimersAsync())
    expect(await screen.findByText('No users found.')).toBeInTheDocument()
    vi.useRealTimers()
  })
})

describe('Login challenge workflow', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    auth.user = null
    auth.isAdmin = false
    auth.login.mockResolvedValue({})
    auth.completeNewPassword.mockResolvedValue({})
    auth.completeMfa.mockResolvedValue({})
  })

  const credentials = () => {
    fireEvent.change(screen.getByLabelText('Email'), { target: { value: 'viewer@example.com' } })
    fireEvent.change(screen.getByLabelText('Password'), { target: { value: 'OldPassword1!' } })
  }

  it('redirects existing users according to role', async () => {
    auth.user = { id: 'u' }
    auth.isAdmin = true
    const first = loginRouted()
    expect(await screen.findByText('Admin destination')).toBeInTheDocument()
    first.unmount()
    auth.isAdmin = false
    loginRouted()
    expect(await screen.findByText('User destination')).toBeInTheDocument()
  })

  it('requires human verification and maps authorization/fallback failures', async () => {
    loginRouted()
    credentials()
    submitForm()
    expect(screen.getByText(/verify you are human/)).toBeInTheDocument()
    auth.login.mockRejectedValueOnce(Object.assign(new Error('raw'), { code: 'NotAuthorizedException' }))
    fireEvent.click(screen.getByRole('button', { name: 'Solve challenge' }))
    submitForm()
    expect(await screen.findByText('Incorrect email or password.')).toBeInTheDocument()
    expect(turnstileReset).toHaveBeenCalled()
    auth.login.mockRejectedValueOnce({})
    fireEvent.click(screen.getByRole('button', { name: 'Solve challenge' }))
    submitForm()
    expect(await screen.findByText(/Sign in could not be completed/)).toBeInTheDocument()
  })

  it('completes the new-password flow and transitions into MFA', async () => {
    auth.login.mockResolvedValueOnce({ challengeName: 'NEW_PASSWORD_REQUIRED', challengeSession: 's1' })
    auth.completeNewPassword.mockResolvedValueOnce({ challengeName: 'SOFTWARE_TOKEN_MFA', challengeSession: 's2' })
    loginRouted()
    credentials()
    fireEvent.click(screen.getByRole('button', { name: 'Solve challenge' }))
    submitForm()
    expect(await screen.findByRole('heading', { name: 'Choose a New Password' })).toBeInTheDocument()
    fireEvent.change(screen.getByLabelText('New password'), { target: { value: 'StrongPassword1!' } })
    fireEvent.change(screen.getByLabelText('Confirm new password'), { target: { value: 'MismatchPassword1!' } })
    fireEvent.click(screen.getByRole('button', { name: 'Solve challenge' }))
    submitForm()
    expect(screen.getByText(/do not match/)).toBeInTheDocument()
    fireEvent.change(screen.getByLabelText('New password'), { target: { value: 'weak password' } })
    fireEvent.change(screen.getByLabelText('Confirm new password'), { target: { value: 'weak password' } })
    submitForm()
    expect(screen.getAllByText(/12–128 characters/)).toHaveLength(2)
    fireEvent.change(screen.getByLabelText('New password'), { target: { value: 'StrongPassword1!' } })
    fireEvent.change(screen.getByLabelText('Confirm new password'), { target: { value: 'StrongPassword1!' } })
    submitForm()
    expect(await screen.findByRole('heading', { name: 'Verify Your Sign-In' })).toBeInTheDocument()
    expect(auth.completeNewPassword).toHaveBeenCalledWith(expect.objectContaining({ email: 'viewer@example.com', challengeSession: 's1' }))
    fireEvent.change(screen.getByLabelText('Authenticator code'), { target: { value: '12ab' } })
    fireEvent.click(screen.getByRole('button', { name: 'Solve challenge' }))
    submitForm()
    expect(screen.getByText(/6-digit code/)).toBeInTheDocument()
    fireEvent.change(screen.getByLabelText('Authenticator code'), { target: { value: '1234567' } })
    submitForm()
    await waitFor(() => expect(auth.completeMfa).toHaveBeenCalledWith(expect.objectContaining({ code: '123456', challengeSession: 's2' })))
  })

  it('handles direct MFA and ordinary successful login', async () => {
    auth.login.mockResolvedValueOnce({ challengeName: 'SOFTWARE_TOKEN_MFA', challengeSession: 'mfa' }).mockResolvedValueOnce({})
    const first = loginRouted()
    credentials()
    fireEvent.click(screen.getByRole('button', { name: 'Solve challenge' }))
    submitForm()
    await screen.findByRole('heading', { name: 'Verify Your Sign-In' })
    fireEvent.change(screen.getByLabelText('Authenticator code'), { target: { value: '123456' } })
    fireEvent.click(screen.getByRole('button', { name: 'Solve challenge' }))
    submitForm()
    await waitFor(() => expect(auth.completeMfa).toHaveBeenCalled())
    first.unmount()

    loginRouted()
    credentials()
    fireEvent.click(screen.getByRole('button', { name: 'Solve challenge' }))
    submitForm()
    await waitFor(() => expect(auth.login).toHaveBeenCalledTimes(2))
  })
})
