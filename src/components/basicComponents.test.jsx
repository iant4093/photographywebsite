import { fireEvent, render, screen } from '@testing-library/react'
import { MemoryRouter, Route, Routes } from 'react-router'
import { describe, expect, it, vi } from 'vitest'

import { AuthContext, useAuth } from '../context/auth'
import AdminDashboard from '../pages/AdminDashboard'
import ManageUsers from '../pages/ManageUsers'
import NotFound from '../pages/NotFound'
import Privacy from '../pages/Privacy'
import Footer from './Footer'
import ProtectedRoute from './ProtectedRoute'
import SkeletonGrid from './SkeletonGrid'


function routed(ui, initialPath = '/') {
  return render(<MemoryRouter initialEntries={[initialPath]}>{ui}</MemoryRouter>)
}

function Location() {
  return <div>destination</div>
}

function AuthConsumer() {
  const { user } = useAuth()
  return <div>{user.name}</div>
}

describe('small presentational and routing components', () => {
  it('renders the skeleton count and video affordance', () => {
    const { container } = render(<SkeletonGrid count={3} type="video" />)
    expect(screen.getByRole('status', { name: 'Loading gallery' })).toBeInTheDocument()
    expect(screen.getByText('Loading albums')).toBeInTheDocument()
    expect(container.querySelectorAll('.aspect-video')).toHaveLength(3)
    expect(container.querySelectorAll('svg')).toHaveLength(3)
  })

  it('renders footer links with safe external-link attributes', () => {
    const { container } = routed(<Footer />)
    expect(container.querySelector('.linen-footer-identity')).toBeInTheDocument()
    expect(container.querySelector('.linen-footer-links')).toBeInTheDocument()
    expect(screen.queryByRole('link', { name: 'Stats' })).not.toBeInTheDocument()
    expect(screen.getByRole('link', { name: 'Privacy' })).toHaveAttribute('href', '/privacy')
    for (const name of ['Instagram', 'Source Code']) {
      const link = screen.getByRole('link', { name })
      expect(link).toHaveAttribute('target', '_blank')
      expect(link).toHaveAttribute('rel', 'noopener noreferrer')
    }
    expect(screen.getByText(new RegExp(String(new Date().getFullYear())))).toBeInTheDocument()
  })

  it('keeps the non-editorial footer content compact for admin routes', () => {
    const { container } = routed(<Footer editorial={false} />)
    expect(screen.getByText(`© ${new Date().getFullYear()} Ian Truong`)).toBeInTheDocument()
    expect(container.querySelector('.linen-footer-identity')).not.toBeInTheDocument()
    expect(container.querySelector('.linen-footer-mark')).not.toBeInTheDocument()
  })

  it('renders static navigation pages and all admin destinations', () => {
    const { unmount } = routed(<NotFound />)
    expect(screen.getByRole('heading', { name: '404' })).toBeInTheDocument()
    expect(screen.getByRole('link', { name: 'Return Home' })).toHaveAttribute('href', '/')
    unmount()

    const privacy = routed(<Privacy />)
    expect(screen.getByRole('heading', { name: 'Privacy Notice' })).toBeInTheDocument()
    expect(screen.getByRole('heading', { name: 'Retention and sharing' })).toBeInTheDocument()
    privacy.unmount()

    const users = routed(<ManageUsers />)
    expect(screen.getByRole('link', { name: /Add User/ })).toHaveAttribute('href', '/admin/users/add')
    expect(screen.getByRole('link', { name: /Edit User/ })).toHaveAttribute('href', '/admin/users/edit')
    expect(screen.getByRole('link', { name: /Delete User/ })).toHaveAttribute('href', '/admin/users/delete')
    users.unmount()

    const admin = routed(<AdminDashboard />)
    expect(screen.getByText('Studio controls')).toBeInTheDocument()
    expect(admin.container.querySelectorAll('.linen-admin-card')).toHaveLength(12)
    expect(Array.from(
      admin.container.querySelectorAll('.linen-admin-card-index'),
      (index) => index.textContent,
    )).toEqual(['01', '02', '03', '04', '05', '06', '07', '08', '09', '10', '11', '12'])
    expect(screen.getByRole('link', { name: /Upload Photos/ })).toHaveAttribute('href', '/admin/upload')
    expect(screen.getByRole('link', { name: /Upload Videos/ })).toHaveAttribute('href', '/admin/upload-video')
    expect(screen.getByRole('link', { name: /Change Hero Cover/ })).toHaveAttribute('href', '/admin/hero')
    expect(screen.getByRole('link', { name: /Manage Photo Albums/ })).toHaveAttribute('href', '/admin/manage?type=photo')
    expect(screen.getByRole('link', { name: /Manage Video Albums/ })).toHaveAttribute('href', '/admin/manage?type=video')
    expect(screen.getByRole('link', { name: /Manage Users/ })).toHaveAttribute('href', '/admin/users')
    expect(screen.getByRole('link', { name: /Site Health/ })).toHaveAttribute('href', '/admin/site-health')
    expect(screen.getByRole('link', { name: /Audit Log/ })).toHaveAttribute('href', '/admin/audit-log')
    expect(screen.getByRole('link', { name: /Website Analytics/ })).toHaveAttribute('href', '/admin/analytics')
    expect(screen.getByRole('link', { name: /AWS Costs/ })).toHaveAttribute('href', '/admin/costs')
    expect(screen.getByRole('link', { name: /Google Drive Usage/ })).toHaveAttribute('href', '/admin/drive-usage')
    expect(screen.getByRole('link', { name: /GitHub Analytics/ })).toHaveAttribute('href', '/admin/github-analytics')
    expect(Array.from(admin.container.querySelectorAll('.linen-admin-card h2'), (heading) => heading.textContent).slice(-6)).toEqual([
      'Site Health', 'Audit Log', 'Website Analytics', 'AWS Costs', 'Google Drive Usage', 'GitHub Analytics',
    ])
    expect(screen.queryByRole('link', { name: /Admin Security/ })).toBeNull()
  })

  it('restores the saved dashboard position when returning from a module', () => {
    window.sessionStorage.clear()
    Object.defineProperty(window, 'scrollY', { configurable: true, value: 640 })
    const first = routed(<AdminDashboard />)
    fireEvent.click(screen.getByRole('link', { name: /Site Health/ }))
    expect(window.sessionStorage.getItem('ian-photography-admin-dashboard-scroll')).toBe('640')
    first.unmount()

    window.scrollTo.mockClear()
    vi.spyOn(window, 'requestAnimationFrame').mockImplementation((callback) => {
      callback()
      return 1
    })
    render(
      <MemoryRouter initialEntries={[{ pathname: '/admin', state: { restoreDashboardScroll: true } }]}>
        <AdminDashboard />
      </MemoryRouter>,
    )
    expect(window.scrollTo).toHaveBeenCalledWith({ top: 640, left: 0, behavior: 'instant' })
  })

  it('requires an auth provider and exposes the provided value', () => {
    expect(() => render(<AuthConsumer />)).toThrow(/within an AuthProvider/)
    render(
      <AuthContext.Provider value={{ user: { name: 'Synthetic User' } }}>
        <AuthConsumer />
      </AuthContext.Provider>,
    )
    expect(screen.getByText('Synthetic User')).toBeInTheDocument()
  })

  it.each([
    [{ user: null, loading: true, isAdmin: false }, 'loading'],
    [{ user: null, loading: false, isAdmin: false }, 'login'],
    [{ user: { name: 'Viewer' }, loading: false, isAdmin: false }, 'dashboard'],
    [{ user: { name: 'Admin' }, loading: false, isAdmin: true, adminMfaStatus: 'required' }, 'security'],
    [{ user: { name: 'Admin' }, loading: false, isAdmin: true, adminMfaStatus: 'enabled' }, 'content'],
  ])('enforces the protected-route state %#', (auth, expected) => {
    const adminOnly = ['dashboard', 'security', 'content'].includes(expected)
    const { container } = routed(
      <AuthContext.Provider value={auth}>
        <Routes>
          <Route path="/login" element={<Location />} />
          <Route path="/dashboard" element={<Location />} />
          <Route path="/admin/security" element={<Location />} />
          <Route
            path="/private"
            element={<ProtectedRoute adminOnly={adminOnly}><div>protected content</div></ProtectedRoute>}
          />
        </Routes>
      </AuthContext.Provider>,
      '/private',
    )
    if (expected === 'loading') {
      expect(container.querySelector('.animate-spin')).toBeInTheDocument()
    } else if (expected === 'content') {
      expect(screen.getByText('protected content')).toBeInTheDocument()
    } else {
      expect(screen.getByText('destination')).toBeInTheDocument()
    }
  })
})
