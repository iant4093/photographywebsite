import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { MemoryRouter, Route, Routes } from 'react-router'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const auth = vi.hoisted(() => ({ getIdToken: vi.fn() }))
const api = vi.hoisted(() => ({ fetchSiteHealth: vi.fn(), fetchAuditLog: vi.fn() }))
vi.mock('../context/auth', () => ({ useAuth: () => auth }))
vi.mock('../utils/api', () => api)

import AuditLog from './AuditLog'
import SiteHealth from './SiteHealth'

const HEALTH = {
  generatedAt: '2026-08-27T12:00:00Z', overall: 'healthy',
  summary: { checksPassing: 3, checksTotal: 3, activeAlarms: 0, unknownAlarms: 0, monitoredAlarms: 17 },
  checks: [{ id: 'website', label: 'Public website', status: 'healthy', detail: 'HTTP 200', latencyMs: 42 }],
  alarms: [{ name: 'API Server Error', description: 'Website API failures', state: 'OK', updatedAt: '2026-08-27T11:00:00Z' }],
}
const AUDIT = {
  windowDays: 7, limited: false,
  summary: { returned: 2, outcomes: { success: 1, denied: 1, failure: 0 }, actors: {}, resources: {}, bytesScanned: 1024 },
  events: [
    { timestamp: '2026-08-27T12:00:00Z', event_name: 'album.create', action: 'album.create.execute', outcome: 'success', actor_type: 'admin', resource_type: 'album', reason_code: 'album_created' },
    { timestamp: '2026-08-27T11:00:00Z', event_name: 'auth.login', action: 'auth.login.attempt', outcome: 'denied', actor_type: 'anonymous', resource_type: 'authentication', reason_code: 'invalid_credentials' },
  ],
}

describe('admin observability modules', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    auth.getIdToken.mockResolvedValue('admin-token')
    api.fetchSiteHealth.mockResolvedValue(HEALTH)
    api.fetchAuditLog.mockResolvedValue(AUDIT)
  })

  it('renders live health checks and website-only alarms and refreshes', async () => {
    render(<MemoryRouter><SiteHealth /></MemoryRouter>)
    expect(await screen.findByRole('heading', { name: 'Site Health' })).toBeInTheDocument()
    expect(screen.getByText('All systems operational')).toBeInTheDocument()
    expect(screen.getByText('Public website')).toBeInTheDocument()
    expect(screen.getByText('API Server Error')).toBeInTheDocument()
    expect(screen.getByText('42 ms')).toBeInTheDocument()
    expect(screen.getByRole('link', { name: /Back to Dashboard/ })).toHaveAttribute('href', '/admin')
    fireEvent.click(screen.getByRole('button', { name: 'Refresh' }))
    await waitFor(() => expect(api.fetchSiteHealth).toHaveBeenCalledTimes(2))
  })

  it('recovers when the initial site-health request fails', async () => {
    api.fetchSiteHealth
      .mockRejectedValueOnce(new Error('Health service unavailable'))
      .mockResolvedValueOnce({
        generatedAt: 'not-a-date',
        overall: 'incident',
        summary: {},
        checks: [{ id: 'api', label: 'Public API', status: 'incident', detail: 'HTTP 503', latencyMs: null }],
        alarms: [],
      })

    render(<MemoryRouter><SiteHealth /></MemoryRouter>)
    expect(await screen.findByRole('alert')).toHaveTextContent('Health service unavailable')
    fireEvent.click(screen.getByRole('button', { name: 'Try again' }))
    expect(await screen.findByText('Attention required')).toBeInTheDocument()
    expect(screen.getByText(/Checked Unknown/)).toBeInTheDocument()
    expect(screen.getByText('No operational alarms were returned.')).toBeInTheDocument()
  })

  it('filters searchable privacy-safe audit events and changes range', async () => {
    render(<MemoryRouter><AuditLog /></MemoryRouter>)
    expect(await screen.findByRole('heading', { name: 'Audit Log' })).toBeInTheDocument()
    expect(screen.getByText('Album Create')).toBeInTheDocument()
    expect(screen.getByText('Auth Login')).toBeInTheDocument()
    fireEvent.change(screen.getByLabelText('Outcome'), { target: { value: 'denied' } })
    expect(screen.queryByText('Album Create')).toBeNull()
    expect(screen.getByText('Auth Login')).toBeInTheDocument()
    fireEvent.change(screen.getByLabelText('Search'), { target: { value: 'album' } })
    expect(screen.getByText('No events match these filters.')).toBeInTheDocument()
    fireEvent.change(screen.getByLabelText('Time range'), { target: { value: '30' } })
    await waitFor(() => expect(api.fetchAuditLog).toHaveBeenLastCalledWith('admin-token', 30, { signal: expect.any(AbortSignal) }))
  })

  it('recovers from an audit query failure and supports resource filtering', async () => {
    api.fetchAuditLog
      .mockRejectedValueOnce(new Error('Audit query unavailable'))
      .mockResolvedValueOnce({
        windowDays: 7,
        limited: true,
        summary: {},
        events: [{ timestamp: 'not-a-date', event_name: '', action: '', outcome: 'failure', actor_type: '', resource_type: 'provider', reason_code: '' }],
      })

    render(<MemoryRouter><AuditLog /></MemoryRouter>)
    expect(await screen.findByRole('alert')).toHaveTextContent('Audit query unavailable')
    fireEvent.click(screen.getByRole('button', { name: 'Try again' }))
    expect(await screen.findByText(/Showing the newest 200 events/)).toBeInTheDocument()
    expect(screen.getAllByText('Unknown')).toHaveLength(4)
    fireEvent.change(screen.getByLabelText('Resource'), { target: { value: 'provider' } })
    expect(screen.getByLabelText('Resource')).toHaveValue('provider')
    fireEvent.change(screen.getByLabelText('Resource'), { target: { value: 'all' } })
    fireEvent.click(screen.getByRole('button', { name: 'Refresh' }))
    await waitFor(() => expect(api.fetchAuditLog).toHaveBeenCalledTimes(3))
  })

  it('keeps dashboard return intent in router state', async () => {
    render(
      <MemoryRouter initialEntries={['/admin/site-health']}>
        <Routes>
          <Route path="/admin/site-health" element={<SiteHealth />} />
          <Route path="/admin" element={<div>Dashboard destination</div>} />
        </Routes>
      </MemoryRouter>,
    )
    fireEvent.click(await screen.findByRole('link', { name: /Back to Dashboard/ }))
    expect(screen.getByText('Dashboard destination')).toBeInTheDocument()
  })
})
