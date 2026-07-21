import { describe, expect, it, vi } from 'vitest'

const render = vi.hoisted(() => vi.fn())
const createRoot = vi.hoisted(() => vi.fn(() => ({ render })))

vi.mock('react-dom/client', () => ({ createRoot }))
vi.mock('./App', () => ({ default: () => <div>app</div> }))
vi.mock('./context/authContext', () => ({ AuthProvider: ({ children }) => children }))

describe('application entry point', () => {
  it('mounts the router and auth-wrapped app into #root', async () => {
    document.body.innerHTML = '<div id="root"></div>'
    await import('./main')
    expect(createRoot).toHaveBeenCalledWith(document.getElementById('root'))
    expect(render).toHaveBeenCalledOnce()
  })
})
