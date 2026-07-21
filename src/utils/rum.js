const LOCAL_SAMPLE_RATE = 0.1

const SENSITIVE_ROUTE_PATTERNS = [
    /^\/admin(?:\/|$)/i,
    /^\/login(?:\/|$)/i,
    /^\/dashboard(?:\/|$)/i,
    /^\/sharedalbum(?:\/|$)/i,
]

const SDK_EXCLUDED_PAGE_PATTERNS = [
    /^https?:\/\/[^/]+\/admin(?:\/|$|[?#])/i,
    /^https?:\/\/[^/]+\/login(?:\/|$|[?#])/i,
    /^https?:\/\/[^/]+\/dashboard(?:\/|$|[?#])/i,
    /^https?:\/\/[^/]+\/sharedalbum(?:\/|$|[?#])/i,
]

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
const REGION_PATTERN = /^[a-z]{2}(?:-gov)?-[a-z]+-[0-9]$/
const RELEASE_PATTERN = /^[0-9a-f]{40}$/
const ROLE_PATTERN = /^arn:(?:aws|aws-us-gov):iam::[0-9]{12}:role\/[A-Za-z0-9+=,.@_/-]+$/

let initializationAttempted = false
let initializationPromise = null

export function isSensitiveRumPath(pathname) {
    if (typeof pathname !== 'string') return true
    return SENSITIVE_ROUTE_PATTERNS.some((pattern) => pattern.test(pathname))
}

export function hasPrivacyOptOut(navigatorObject, windowObject) {
    if (!navigatorObject) return true
    return navigatorObject.globalPrivacyControl === true
        || navigatorObject.doNotTrack === '1'
        || navigatorObject.msDoNotTrack === '1'
        || windowObject?.doNotTrack === '1'
}

export function readRumConfiguration(env) {
    const config = {
        applicationId: env?.VITE_RUM_APPLICATION_ID?.trim(),
        guestRoleArn: env?.VITE_RUM_GUEST_ROLE_ARN?.trim(),
        identityPoolId: env?.VITE_RUM_IDENTITY_POOL_ID?.trim(),
        region: env?.VITE_RUM_REGION?.trim(),
        releaseSha: env?.VITE_RELEASE_SHA?.trim(),
    }
    if (Object.values(config).some((value) => !value)) return null
    if (!UUID_PATTERN.test(config.applicationId)) return null
    if (!REGION_PATTERN.test(config.region)) return null
    if (!config.identityPoolId.startsWith(`${config.region}:`)) return null
    if (!UUID_PATTERN.test(config.identityPoolId.slice(config.region.length + 1))) return null
    if (!ROLE_PATTERN.test(config.guestRoleArn)) return null
    if (!RELEASE_PATTERN.test(config.releaseSha)) return null
    return config
}

export function shouldInitializeRum({
    env,
    navigatorObject,
    windowObject,
    locationObject,
    random = Math.random,
}) {
    const config = readRumConfiguration(env)
    if (!config || !windowObject || !locationObject) return false
    if (hasPrivacyOptOut(navigatorObject, windowObject)) return false
    if (isSensitiveRumPath(locationObject.pathname)) return false
    return random() < LOCAL_SAMPLE_RATE
}

export async function initializeRum({
    env = import.meta.env,
    navigatorObject = globalThis.navigator,
    windowObject = globalThis.window,
    locationObject = globalThis.location,
    random = Math.random,
    sdkLoader = () => import('aws-rum-web'),
} = {}) {
    if (initializationAttempted) return initializationPromise
    initializationAttempted = true

    if (!shouldInitializeRum({
        env,
        navigatorObject,
        windowObject,
        locationObject,
        random,
    })) return null

    const config = readRumConfiguration(env)
    initializationPromise = (async () => {
        const { AwsRum } = await sdkLoader()
        // Recheck after the network import in case an SPA navigation occurred.
        if (
            hasPrivacyOptOut(navigatorObject, windowObject)
            || isSensitiveRumPath(locationObject.pathname)
        ) return null

        return new AwsRum(
            config.applicationId,
            config.releaseSha,
            config.region,
            {
                allowCookies: false,
                cookieAttributes: { unique: true },
                debug: false,
                enableW3CTraceId: false,
                enableXRay: false,
                guestRoleArn: config.guestRoleArn,
                identityPoolId: config.identityPoolId,
                pagesToExclude: SDK_EXCLUDED_PAGE_PATTERNS,
                releaseId: config.releaseSha,
                // Sampling already happened before this chunk was downloaded.
                // A second SDK sample would turn the approved 10% into 1%.
                sessionSampleRate: 1,
                signing: true,
                telemetries: ['errors', 'performance', 'http'],
            },
        )
    })().catch(() => null)
    return initializationPromise
}

export function resetRumForTests() {
    initializationAttempted = false
    initializationPromise = null
}

export { LOCAL_SAMPLE_RATE }
