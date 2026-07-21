import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

import {
    PREVIEW_HTTP_CLASSES,
    PREVIEW_OBJECT_FAILURE_CATEGORIES,
    atPreviewStage,
    classifyPreviewObjectFailure,
    previewStageFailure,
    safePreviewFailureTelemetry,
} from './telemetry.mjs'

test('object write failure classification is allowlisted and coarse', () => {
    const cases = [
        [{ name: 'AccessDenied', $metadata: { httpStatusCode: 403 } }, 'put_access_denied', '4xx'],
        [{ name: 'InvalidRequest', $metadata: { httpStatusCode: 400 } }, 'put_invalid_request', '4xx'],
        [{ name: 'SlowDown', $metadata: { httpStatusCode: 503 } }, 'put_throttled', '5xx'],
        [{ name: 'ServiceFailure', $metadata: { httpStatusCode: 503 } }, 'put_service_failure', '5xx'],
        [{ name: 'TimeoutError' }, 'put_transport_failure', 'none'],
        [{ Code: 'Forbidden', $metadata: { httpStatusCode: 403 } }, 'put_access_denied', '4xx'],
        [{ code: 'ThrottlingException', $metadata: { httpStatusCode: 429 } }, 'put_throttled', '4xx'],
        [{ $metadata: { httpStatusCode: 404 } }, 'put_invalid_request', '4xx'],
        [{ $metadata: { httpStatusCode: 99 } }, 'put_unclassified', 'none'],
        [{ $metadata: { httpStatusCode: 600 } }, 'put_unclassified', 'none'],
        [{}, 'put_unclassified', 'none'],
        [{ name: 'SecretClientFilename', message: 'albums/private/client.jpg' }, 'put_unclassified', 'none'],
    ]
    for (const [error, failureCategory, httpClass] of cases) {
        const classified = classifyPreviewObjectFailure(error, 'put')
        assert.deepEqual(classified, { failureCategory, httpClass })
        assert.equal(PREVIEW_OBJECT_FAILURE_CATEGORIES.includes(classified.failureCategory), true)
        assert.equal(PREVIEW_HTTP_CLASSES.includes(classified.httpClass), true)
        assert.equal(JSON.stringify(classified).includes('client'), false)
    }
})

test('validation failures expose only the validation category and status class', () => {
    assert.deepEqual(classifyPreviewObjectFailure({
        name: 'NoSuchKey',
        message: 'albums/private/client.jpg',
        $metadata: { httpStatusCode: 404 },
    }, 'validate'), {
        failureCategory: 'object_validation_failed',
        httpClass: '4xx',
    })
})

test('safe stage errors retain approved nested diagnostics', async () => {
    const original = previewStageFailure('preview_object_write_failed', {
        failureCategory: 'put_access_denied',
        httpClass: '4xx',
    })
    await assert.rejects(
        atPreviewStage('unexpected_failure', async () => { throw original }),
        (error) => error === original,
    )
    assert.deepEqual(safePreviewFailureTelemetry(original), {
        reasonCode: 'preview_object_write_failed',
        failureCategory: 'put_access_denied',
        httpClass: '4xx',
    })
})

test('successful stage operations return their value', async () => {
    assert.equal(await atPreviewStage('source_read_failed', async () => 'ok'), 'ok')
})

test('stage construction rejects unapproved diagnostic values', () => {
    const error = previewStageFailure('private/client-name', {
        failureCategory: 'private-client-name',
        httpClass: '404-private-client-name',
    })
    assert.deepEqual(safePreviewFailureTelemetry(error), {
        reasonCode: 'unexpected_failure',
        failureCategory: 'none',
        httpClass: 'none',
    })
})

test('untrusted diagnostics collapse to fixed safe fallbacks', async () => {
    const secret = new Error('albums/private/client-name.jpg')
    secret.reasonCode = 'client-name'
    secret.failureCategory = 'another-client-name'
    secret.httpClass = '403 for albums/private/client-name.jpg'
    await assert.rejects(
        atPreviewStage('source_read_failed', async () => { throw secret }),
        (error) => {
            assert.equal(error.message, 'Preview processing stage failed')
            assert.equal(error.cause, undefined)
            assert.deepEqual(safePreviewFailureTelemetry(error), {
                reasonCode: 'source_read_failed',
                failureCategory: 'none',
                httpClass: 'none',
            })
            return true
        },
    )
    assert.deepEqual(safePreviewFailureTelemetry(secret), {
        reasonCode: 'unexpected_failure',
        failureCategory: 'none',
        httpClass: 'none',
    })
})

test('worker requests explicit bucket-matching encryption and logs no request identifier on failure', () => {
    const workerSource = readFileSync(new URL('./index.mjs', import.meta.url), 'utf8')
    assert.match(workerSource, /ServerSideEncryption: 'AES256'/)
    const ensureObject = workerSource.match(
        /async function ensurePreviewObject[\s\S]*?(?=\nasync function setVisibilityTag)/,
    )?.[0]
    assert.ok(ensureObject)
    assert.match(ensureObject, /IfNoneMatch: '\*'/)
    assert.doesNotMatch(ensureObject, /HeadObjectCommand/)
    const failureLog = workerSource.match(/console\.error\(JSON\.stringify\(\{(?<body>[\s\S]*?)\}\)\)/)?.groups?.body
    assert.ok(failureLog)
    assert.doesNotMatch(failureLog, /requestId|message|stack|key/i)
})
