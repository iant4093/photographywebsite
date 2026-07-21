import { render, screen } from '@testing-library/react'
import { MemoryRouter, Route, Routes } from 'react-router-dom'
import { describe, expect, it } from 'vitest'

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
    routed(<Footer />)
    expect(screen.getByRole('link', { name: 'Privacy' })).toHaveAttribute('href', '/privacy')
    for (const name of ['Instagram', 'Source Code']) {
      const link = screen.getByRole('link', { name })
      expect(link).toHaveAttribute('target', '_blank')
      expect(link).toHaveAttribute('rel', 'noopener noreferrer')
    }
    expect(screen.getByText(new RegExp(String(new Date().getFullYear())))).toBeInTheDocument()
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

    routed(<AdminDashboard />)
    expect(screen.getByRole('link', { name: /Upload Photos/ })).toHaveAttribute('href', '/admin/upload')
    expect(screen.getByRole('link', { name: /Upload Videos/ })).toHaveAttribute('href', '/admin/upload-video')
    expect(screen.getByRole('link', { name: /Manage Photo Albums/ })).toHaveAttribute('href', '/admin/manage?type=photo')
    expect(screen.getByRole('link', { name: /Manage Video Albums/ })).toHaveAttribute('href', '/admin/manage?type=video')
    expect(screen.getByRole('link', { name: /Manage Users/ })).toHaveAttribute('href', '/admin/users')
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
    [{ user: { name: 'Admin' }, loading: false, isAdmin: true }, 'content'],
  ])('enforces the protected-route state %#', (auth, expected) => {
    const adminOnly = expected === 'dashboard' || expected === 'content'
    const { container } = routed(
      <AuthContext.Provider value={auth}>
        <Routes>
          <Route path="/login" element={<Location />} />
          <Route path="/dashboard" element={<Location />} />
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
