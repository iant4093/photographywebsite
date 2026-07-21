import { safePreviewFailureReason } from './contract.mjs'

export const PREVIEW_OBJECT_FAILURE_CATEGORIES = Object.freeze([
    'none',
    'object_validation_failed',
    'put_access_denied',
    'put_invalid_request',
    'put_service_failure',
    'put_throttled',
    'put_transport_failure',
    'put_unclassified',
])

export const PREVIEW_HTTP_CLASSES = Object.freeze(['none', '4xx', '5xx'])

const ACCESS_DENIED_CODES = new Set(['AccessDenied', 'Forbidden'])
const INVALID_REQUEST_CODES = new Set([
    'BadRequest',
    'InvalidArgument',
    'InvalidRequest',
    'InvalidTag',
    'MalformedXML',
])
const THROTTLE_CODES = new Set([
    'RequestLimitExceeded',
    'SlowDown',
    'Throttling',
    'ThrottlingException',
    'TooManyRequestsException',
])
const TRANSPORT_CODES = new Set([
    'AbortError',
    'NetworkingError',
    'RequestTimeout',
    'RequestTimeoutException',
    'TimeoutError',
])

function statusCode(error) {
    const value = Number(error?.$metadata?.httpStatusCode)
    return Number.isSafeInteger(value) && value >= 100 && value <= 599 ? value : null
}

function httpClassFor(error) {
    const value = statusCode(error)
    if (value !== null && value >= 400 && value <= 499) return '4xx'
    if (value !== null && value >= 500) return '5xx'
    return 'none'
}

function errorCode(error) {
    for (const value of [error?.name, error?.Code, error?.code]) {
        if (typeof value === 'string' && value) return value
    }
    return ''
}

function safeCategory(value) {
    return PREVIEW_OBJECT_FAILURE_CATEGORIES.includes(value) ? value : 'none'
}

function safeHttpClass(value) {
    return PREVIEW_HTTP_CLASSES.includes(value) ? value : 'none'
}

export function classifyPreviewObjectFailure(error, boundary) {
    const httpClass = httpClassFor(error)
    if (boundary === 'validate') {
        return { failureCategory: 'object_validation_failed', httpClass }
    }

    const code = errorCode(error)
    if (ACCESS_DENIED_CODES.has(code) || statusCode(error) === 403) {
        return { failureCategory: 'put_access_denied', httpClass }
    }
    if (THROTTLE_CODES.has(code) || statusCode(error) === 429) {
        return { failureCategory: 'put_throttled', httpClass }
    }
    if (INVALID_REQUEST_CODES.has(code) || httpClass === '4xx') {
        return { failureCategory: 'put_invalid_request', httpClass }
    }
    if (httpClass === '5xx') {
        return { failureCategory: 'put_service_failure', httpClass }
    }
    if (TRANSPORT_CODES.has(code)) {
        return { failureCategory: 'put_transport_failure', httpClass }
    }
    return { failureCategory: 'put_unclassified', httpClass }
}

export class PreviewStageError extends Error {
    constructor(reasonCode, details = {}) {
        super('Preview processing stage failed')
        this.name = 'PreviewStageError'
        this.reasonCode = safePreviewFailureReason({ reasonCode })
        this.failureCategory = safeCategory(details.failureCategory)
        this.httpClass = safeHttpClass(details.httpClass)
    }
}

export function previewStageFailure(reasonCode, details) {
    return new PreviewStageError(reasonCode, details)
}

export async function atPreviewStage(reasonCode, operation) {
    try {
        return await operation()
    } catch (error) {
        if (error instanceof PreviewStageError) throw error
        throw previewStageFailure(reasonCode)
    }
}

export function safePreviewFailureTelemetry(error) {
    if (!(error instanceof PreviewStageError)) {
        return {
            reasonCode: 'unexpected_failure',
            failureCategory: 'none',
            httpClass: 'none',
        }
    }
    return {
        reasonCode: safePreviewFailureReason(error),
        failureCategory: safeCategory(error.failureCategory),
        httpClass: safeHttpClass(error.httpClass),
    }
}
