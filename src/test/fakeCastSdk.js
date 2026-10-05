import { vi } from 'vitest'

/** A stand-in for the Cast sender framework with one TV in range. */
export function fakeCastSdk({ state = 'NOT_CONNECTED', device = 'Living Room TV' } = {}) {
    const listeners = new Map()
    const session = {
        loadMedia: vi.fn(() => Promise.resolve()),
        getCastDevice: () => ({ friendlyName: device }),
    }
    const context = {
        state,
        setOptions: vi.fn(),
        getCastState: () => context.state,
        getCurrentSession: () => (context.state === 'CONNECTED' ? session : null),
        addEventListener: vi.fn((type, listener) => listeners.set(type, listener)),
        removeEventListener: vi.fn((type) => listeners.delete(type)),
        requestSession: vi.fn(() => Promise.reject(new Error('cancel'))),
        endCurrentSession: vi.fn(),
        emit(next) {
            context.state = next
            listeners.get('caststatechanged')?.({ castState: next })
        },
    }
    class MediaInfo { constructor(contentId, contentType) { Object.assign(this, { contentId, contentType }) } }
    class PhotoMediaMetadata {}
    class LoadRequest { constructor(media) { this.media = media } }
    const win = {
        cast: {
            framework: {
                CastContext: { getInstance: () => context },
                CastState: { NO_DEVICES_AVAILABLE: 'NO_DEVICES_AVAILABLE', NOT_CONNECTED: 'NOT_CONNECTED', CONNECTING: 'CONNECTING', CONNECTED: 'CONNECTED' },
                CastContextEventType: { CAST_STATE_CHANGED: 'caststatechanged', SESSION_STATE_CHANGED: 'sessionstatechanged' },
            },
        },
        chrome: {
            cast: {
                AutoJoinPolicy: { ORIGIN_SCOPED: 'origin_scoped' },
                media: { DEFAULT_MEDIA_RECEIVER_APP_ID: 'CC1AD845', MediaInfo, PhotoMediaMetadata, LoadRequest },
            },
        },
    }
    return { win, context, session, listeners }
}
