import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
    LOCAL_SAMPLE_RATE,
    hasPrivacyOptOut,
    initializeRum,
    isSensitiveRumPath,
    readRumConfiguration,
    resetRumForTests,
    shouldInitializeRum,
} from './rum'

const ENV = {
    VITE_RELEASE_SHA: 'a'.repeat(40),
    VITE_RUM_APPLICATION_ID: '11111111-1111-4111-8111-111111111111',
    VITE_RUM_GUEST_ROLE_ARN: 'arn:aws:iam::123456789012:role/rum-public',
    VITE_RUM_IDENTITY_POOL_ID: 'us-west-2:22222222-2222-4222-8222-222222222222',
    VITE_RUM_REGION: 'us-west-2',
}

function browser(overrides = {}) {
    return {
        env: ENV,
        locationObject: { pathname: '/' },
        navigatorObject: { doNotTrack: '0', globalPrivacyControl: false },
        random: () => 0.01,
        windowObject: {},
        ...overrides,
    }
}

beforeEach(() => resetRumForTests())

describe('RUM privacy gate', () => {
    it('requires every valid public configuration value', () => {
        expect(readRumConfiguration(ENV)).toEqual({
            applicationId: ENV.VITE_RUM_APPLICATION_ID,
            guestRoleArn: ENV.VITE_RUM_GUEST_ROLE_ARN,
            identityPoolId: ENV.VITE_RUM_IDENTITY_POOL_ID,
            region: ENV.VITE_RUM_REGION,
            releaseSha: ENV.VITE_RELEASE_SHA,
        })
        for (const key of Object.keys(ENV)) {
            expect(readRumConfiguration({ ...ENV, [key]: '' })).toBeNull()
        }
        expect(readRumConfiguration({ ...ENV, VITE_RUM_APPLICATION_ID: 'bad' })).toBeNull()
        expect(readRumConfiguration({ ...ENV, VITE_RUM_REGION: 'bad' })).toBeNull()
        expect(readRumConfiguration({ ...ENV, VITE_RUM_IDENTITY_POOL_ID: `us-east-1:${ENV.VITE_RUM_APPLICATION_ID}` })).toBeNull()
        expect(readRumConfiguration({ ...ENV, VITE_RUM_GUEST_ROLE_ARN: 'arn:aws:iam::wrong' })).toBeNull()
        expect(readRumConfiguration({ ...ENV, VITE_RELEASE_SHA: 'unknown' })).toBeNull()
    })

    it('excludes every sensitive route without overmatching public names', () => {
        for (const pathname of (
            ['/admin', '/admin/users', '/LOGIN', '/dashboard', '/sharedalbum', '/sharedalbum/public-code']
        )) {
            expect(isSensitiveRumPath(pathname)).toBe(true)
        }
        expect(isSensitiveRumPath('/administrator')).toBe(false)
        expect(isSensitiveRumPath('/albums')).toBe(false)
        expect(isSensitiveRumPath(null)).toBe(true)
    })

    it('honors GPC and every browser DNT representation', () => {
        expect(hasPrivacyOptOut({ globalPrivacyControl: true }, {})).toBe(true)
        expect(hasPrivacyOptOut({ doNotTrack: '1' }, {})).toBe(true)
        expect(hasPrivacyOptOut({ msDoNotTrack: '1' }, {})).toBe(true)
        expect(hasPrivacyOptOut({ doNotTrack: '0' }, { doNotTrack: '1' })).toBe(true)
        expect(hasPrivacyOptOut({ doNotTrack: '0' }, {})).toBe(false)
        expect(hasPrivacyOptOut(null, {})).toBe(true)
    })

    it('samples locally at exactly ten percent before SDK loading', () => {
        expect(LOCAL_SAMPLE_RATE).toBe(0.1)
        expect(shouldInitializeRum(browser({ random: () => 0.099999 }))).toBe(true)
        expect(shouldInitializeRum(browser({ random: () => 0.1 }))).toBe(false)
        expect(shouldInitializeRum(browser({ locationObject: { pathname: '/login' } }))).toBe(false)
        expect(shouldInitializeRum(browser({ navigatorObject: { globalPrivacyControl: true } }))).toBe(false)
        expect(shouldInitializeRum(browser({ env: {} }))).toBe(false)
        expect(shouldInitializeRum(browser({ windowObject: null }))).toBe(false)
    })
})

describe('RUM lazy initialization', () => {
    it('does not download the SDK for missing config, opt-out, sensitive routes, or unsampled sessions', async () => {
        for (const options of (
            [
                browser({ env: {} }),
                browser({ navigatorObject: { globalPrivacyControl: true } }),
                browser({ locationObject: { pathname: '/dashboard' } }),
                browser({ random: () => 0.9 }),
            ]
        )) {
            resetRumForTests()
            const sdkLoader = vi.fn()
            await expect(initializeRum({ ...options, sdkLoader })).resolves.toBeNull()
            expect(sdkLoader).not.toHaveBeenCalled()
        }
    })

    it('loads once and constructs a cookie-free, replay-free, trace-free client', async () => {
        const instance = { active: true }
        const AwsRum = vi.fn(function createRum() { return instance })
        const sdkLoader = vi.fn().mockResolvedValue({ AwsRum })
        const options = browser({ sdkLoader })

        await expect(initializeRum(options)).resolves.toBe(instance)
        await expect(initializeRum(options)).resolves.toBe(instance)
        expect(sdkLoader).toHaveBeenCalledOnce()
        expect(AwsRum).toHaveBeenCalledOnce()
        const [applicationId, version, region, config] = AwsRum.mock.calls[0]
        expect([applicationId, version, region]).toEqual([
            ENV.VITE_RUM_APPLICATION_ID,
            ENV.VITE_RELEASE_SHA,
            ENV.VITE_RUM_REGION,
        ])
        expect(config).toMatchObject({
            allowCookies: false,
            enableW3CTraceId: false,
            enableXRay: false,
            guestRoleArn: ENV.VITE_RUM_GUEST_ROLE_ARN,
            identityPoolId: ENV.VITE_RUM_IDENTITY_POOL_ID,
            releaseId: ENV.VITE_RELEASE_SHA,
            sessionSampleRate: 1,
            signing: true,
            telemetries: ['errors', 'performance', 'http'],
        })
        expect(config.telemetries).not.toContain('replay')
        for (const route of ('admin login dashboard sharedalbum'.split(' '))) {
            expect(config.pagesToExclude.some((pattern) => (
                pattern.test(`https://iantruongphotography.com/${route}/example`)
            ))).toBe(true)
        }
    })

    it('rechecks privacy and route state after the lazy chunk resolves', async () => {
        let resolveSdk
        const AwsRum = vi.fn()
        const locationObject = { pathname: '/' }
        const promise = initializeRum(browser({
            locationObject,
            sdkLoader: () => new Promise((resolve) => { resolveSdk = resolve }),
        }))
        locationObject.pathname = '/sharedalbum/private-code'
        resolveSdk({ AwsRum })
        await expect(promise).resolves.toBeNull()
        expect(AwsRum).not.toHaveBeenCalled()
    })

    it('fails closed without logging or breaking the application', async () => {
        const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {})
        await expect(initializeRum(browser({
            sdkLoader: vi.fn().mockRejectedValue(new Error('network failure')),
        }))).resolves.toBeNull()
        expect(consoleError).not.toHaveBeenCalled()
    })
})
