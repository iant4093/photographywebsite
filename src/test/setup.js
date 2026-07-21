import '@testing-library/jest-dom/vitest'
import { afterEach, vi } from 'vitest'
import { cleanup } from '@testing-library/react'

// Node can expose experimental storage globals that override JSDOM and do not
// implement the Web Storage contract. Install deterministic browser-compatible
// storage so tests remain independent of runner flags.
function createWebStorage() {
  const storage = {}
  Object.defineProperties(storage, {
    length: {
      configurable: true,
      get: () => Object.keys(storage).length,
    },
    key: {
      configurable: true,
      value: (index) => Object.keys(storage)[index] ?? null,
    },
    getItem: {
      configurable: true,
      value: (key) => Object.prototype.hasOwnProperty.call(storage, String(key))
        ? storage[String(key)]
        : null,
    },
    setItem: {
      configurable: true,
      value: (key, value) => Object.defineProperty(storage, String(key), {
        configurable: true,
        enumerable: true,
        writable: true,
        value: String(value),
      }),
    },
    removeItem: {
      configurable: true,
      value: (key) => delete storage[String(key)],
    },
    clear: {
      configurable: true,
      value: () => Object.keys(storage).forEach((key) => delete storage[key]),
    },
  })
  return storage
}

for (const name of ['localStorage', 'sessionStorage']) {
  const storage = createWebStorage()
  Object.defineProperty(window, name, { configurable: true, value: storage })
  if (globalThis !== window) {
    Object.defineProperty(globalThis, name, { configurable: true, value: storage })
  }
}

class ObserverStub {
  observe() {}
  unobserve() {}
  disconnect() {}
}

globalThis.IntersectionObserver ??= ObserverStub
globalThis.ResizeObserver ??= ObserverStub
globalThis.matchMedia ??= vi.fn().mockImplementation((query) => ({
  matches: false,
  media: query,
  onchange: null,
  addEventListener: vi.fn(),
  removeEventListener: vi.fn(),
  addListener: vi.fn(),
  removeListener: vi.fn(),
  dispatchEvent: vi.fn(),
}))

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
})
