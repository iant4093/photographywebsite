import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { MemoryRouter } from 'react-router'
import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('./components/Navbar', async () => {
  const { Link } = await import('react-router')
  return { default: () => <nav><Link to="/videos">Videos nav</Link></nav> }
})
vi.mock('./components/Footer', () => ({ default: () => <footer>Footer</footer> }))
vi.mock('./components/BackToTop', () => ({ default: () => <button>Top</button> }))
vi.mock('./components/DocumentMetadata', () => ({ default: () => null }))
vi.mock('./components/ProtectedRoute', () => ({ default: ({ children }) => <>{children}</> }))
vi.mock('./pages/Home', () => ({ default: () => <h1>Home route</h1> }))

vi.mock('./pages/AlbumGallery', () => ({ default: () => <h1>Album route</h1> }))
vi.mock('./pages/Search', () => ({ default: () => <h1>Search route</h1> }))
vi.mock('./pages/SharedAlbum', () => ({ default: () => <h1>Shared route</h1> }))
vi.mock('./pages/Contact', () => ({ default: () => <h1>Contact route</h1> }))
vi.mock('./pages/Privacy', () => ({ default: () => <h1>Privacy route</h1> }))
vi.mock('./pages/Login', () => ({ default: () => <h1>Login route</h1> }))
vi.mock('./pages/AdminDashboard', () => ({ default: () => <h1>Admin route</h1> }))
vi.mock('./pages/AwsCosts', () => ({ default: () => <h1>AWS costs route</h1> }))
vi.mock('./pages/GoogleDriveUsage', () => ({ default: () => <h1>Google Drive usage route</h1> }))
vi.mock('./pages/Admin', () => ({ default: () => <h1>Upload route</h1> }))
vi.mock('./pages/UploadVideo', () => ({ default: () => <h1>Upload video route</h1> }))
vi.mock('./pages/ManageHero', () => ({ default: () => <h1>Hero route</h1> }))
vi.mock('./pages/ManageAlbums', () => ({ default: () => <h1>Manage route</h1> }))
vi.mock('./pages/ManageUsers', () => ({ default: () => <h1>Users route</h1> }))
vi.mock('./pages/AddUser', () => ({ default: () => <h1>Add user route</h1> }))
vi.mock('./pages/DeleteUser', () => ({ default: () => <h1>Delete user route</h1> }))
vi.mock('./pages/EditUser', () => ({ default: () => <h1>Edit user route</h1> }))
vi.mock('./pages/UserDashboard', () => ({ default: () => <h1>Dashboard route</h1> }))
vi.mock('./pages/NotFound', () => ({ default: () => <h1>Not found route</h1> }))
vi.mock('./pages/VideoGallery', () => ({ default: () => <h1>Video route</h1> }))
vi.mock('./pages/Videos', () => ({ default: () => <h1>Videos route</h1> }))

import App from './App'

describe('App routing shell', () => {
  beforeEach(() => vi.spyOn(window, 'scrollTo').mockImplementation(() => {}))

  it('renders the eager home route and persistent shell', () => {
    render(<MemoryRouter><App /></MemoryRouter>)
    expect(screen.getByRole('heading', { name: 'Home route' })).toBeInTheDocument()
    expect(screen.getByText('Footer')).toBeInTheDocument()
    expect(window.history.scrollRestoration).toBe('manual')
  })

  it('can be evaluated safely during server-side tooling without window', async () => {
    vi.stubGlobal('window', undefined)
    vi.resetModules()
    await expect(import('./App')).resolves.toHaveProperty('default')
    vi.unstubAllGlobals()
  })

  it('loads a lazy route and scrolls to top after PUSH navigation', async () => {
    render(<MemoryRouter><App /></MemoryRouter>)
    fireEvent.click(screen.getByRole('link', { name: 'Videos nav' }))
    expect(await screen.findByRole('heading', { name: 'Videos route' })).toBeInTheDocument()
    await waitFor(() => {
      expect(window.scrollTo).toHaveBeenCalledWith({ top: 0, left: 0, behavior: 'instant' })
    })
  })

  it('uses the editorial admin shell on protected admin routes', async () => {
    const { container } = render(<MemoryRouter initialEntries={['/admin']}><App /></MemoryRouter>)
    await waitFor(() => expect(screen.getByRole('heading', { name: 'Admin route' })).toBeInTheDocument())
    expect(container.firstElementChild).toHaveClass('linen-site', 'linen-admin')
  })

  it.each([
    ['/album/id', 'Album route'], ['/video/id', 'Video route'], ['/sharedalbum/code', 'Shared route'],
    ['/contact', 'Contact route'], ['/privacy', 'Privacy route'], ['/login', 'Login route'],
    ['/search', 'Search route'],
    ['/admin', 'Admin route'], ['/admin/costs', 'AWS costs route'], ['/admin/drive-usage', 'Google Drive usage route'],
    ['/admin/upload', 'Upload route'], ['/admin/upload-video', 'Upload video route'],
    ['/admin/hero', 'Hero route'],
    ['/admin/manage', 'Manage route'], ['/admin/users', 'Users route'], ['/admin/users/add', 'Add user route'],
    ['/admin/users/delete', 'Delete user route'], ['/admin/users/edit', 'Edit user route'],
    ['/dashboard', 'Dashboard route'], ['/missing', 'Not found route'],
  ])('routes %s to its page', async (path, label) => {
    render(<MemoryRouter initialEntries={[path]}><App /></MemoryRouter>)
    await waitFor(() => expect(screen.getByRole('heading', { name: label })).toBeInTheDocument())
  })
})
