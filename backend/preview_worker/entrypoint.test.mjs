import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { dirname } from 'node:path'
import test from 'node:test'
import { withWorkerBudget, hasWorkerTime, runWorkerJob } from './runtime-budget.mjs'
import { ObsoletePreviewJob } from './contract.mjs'
import { fileURLToPath } from 'node:url'


test('the packaged worker entrypoint initializes with its runtime dependencies', () => {
    const childEnv = { ...process.env, AWS_REGION: 'us-west-2' }
    delete childEnv.NODE_V8_COVERAGE
    const result = spawnSync(
        process.execPath,
        ['--input-type=module', '--eval', "await import('./index.mjs')"],
        {
            cwd: dirname(fileURLToPath(import.meta.url)),
            encoding: 'utf8',
            env: childEnv,
            timeout: 10_000,
        },
    )
    assert.equal(result.status, 0, result.stderr)
})

// Exercise the actual batch handler with pure processing substitutes; no AWS
// calls or image decoding are needed to prove message isolation.
test('a malformed queue body retries only that record and does not block valid jobs', async () => {
    const { readFileSync } = await import('node:fs')
    const vm = await import('node:vm')
    const source = readFileSync(new URL('./index.mjs', import.meta.url), 'utf8')
    const handlerSource = source.slice(source.indexOf('function eventJobs(event)')).replace('export async function handler', 'async function handler')
    const completed = []
    const context = vm.createContext({
        console: { log() {}, error() {} },
        processJob: async job => { completed.push(job.id); return { status: 'completed' } },
        processHeroJob: async job => { completed.push(job.id); return { status: 'completed' } },
        safePreviewFailureTelemetry: () => ({}),
        withWorkerBudget, hasWorkerTime, runWorkerJob, ObsoletePreviewJob,
    })
    vm.runInContext(handlerSource, context)
    const result = await context.handler({ Records: [
        { messageId: 'bad', body: '{' },
        { messageId: 'good', body: JSON.stringify({ id: 'photo' }) },
        { messageId: 'hero', body: JSON.stringify({ kind: 'hero', id: 'cover' }) },
    ] })
    assert.deepEqual(completed, ['photo', 'cover'])
    assert.deepEqual(JSON.parse(JSON.stringify(result)), { batchItemFailures: [{ itemIdentifier: 'bad' }] })
})

test('obsolete records are acknowledged, provider failures retry, and low remaining time defers work', async () => {
    const { readFileSync } = await import('node:fs')
    const vm = await import('node:vm')
    const source = readFileSync(new URL('./index.mjs', import.meta.url), 'utf8')
    const handlerSource = source.slice(source.indexOf('function eventJobs(event)')).replace('export async function handler', 'async function handler')
    const attempted = []
    const context = vm.createContext({
        console: { log() {}, error() {} }, withWorkerBudget, hasWorkerTime, runWorkerJob, ObsoletePreviewJob,
        processJob: async job => { attempted.push(job.id); if (job.id === 'gone') throw new ObsoletePreviewJob(); throw new Error('provider unavailable') },
        processHeroJob: async () => ({ status: 'completed' }), safePreviewFailureTelemetry: () => ({}),
    })
    vm.runInContext(handlerSource, context)
    const Records = ['gone', 'retry'].map(id => ({ messageId: id, body: JSON.stringify({ id }) }))
    const result = await context.handler({ Records })
    assert.deepEqual(JSON.parse(JSON.stringify(result)), { batchItemFailures: [{ itemIdentifier: 'retry' }] })
    assert.deepEqual(attempted, ['gone', 'retry'])
    attempted.length = 0
    const deferred = await context.handler({ Records }, { get_remaining_time_in_millis: () => 5000 })
    assert.deepEqual(attempted, [])
    assert.deepEqual(JSON.parse(JSON.stringify(deferred)), { batchItemFailures: Records.map(record => ({ itemIdentifier: record.messageId })) })
    assert.deepEqual(JSON.parse(JSON.stringify(await context.handler({ id: 'gone' }))), { status: 'obsolete' })
})

test('bounded clients forward a shared deadline and reject work after it expires', async () => {
    const { boundedClient, checkWorkerTime, workerClientConfig } = await import('./runtime-budget.mjs')
    assert.equal(workerClientConfig.maxAttempts, 2)
    assert.equal(workerClientConfig.requestHandler.throwOnRequestTimeout, true)
    let calls = 0
    const client = boundedClient({ send: async (_command, options) => { calls++; return { signal: options.abortSignal } } })
    await withWorkerBudget({ get_remaining_time_in_millis: () => 3010 }, async () => {
        const result = await client.send({})
        assert.ok(result.signal instanceof AbortSignal)
        await new Promise(resolve => setTimeout(resolve, 20))
        assert.equal(result.signal.aborted, true)
        assert.throws(checkWorkerTime, /deadline/)
        await assert.rejects(client.send({}), /deadline/)
    })
    assert.equal(calls, 1)
    assert.equal(hasWorkerTime(), true)
})

test('a noncooperative transform returns at the job deadline', async () => {
    await withWorkerBudget({ get_remaining_time_in_millis: () => 3010 }, async () => {
        await assert.rejects(runWorkerJob(() => new Promise(() => {})), /deadline/)
    })
})

test('publication holds an owner-specific lease beyond the actual Lambda deadline', async () => {
    const { withMediaLease } = await import('./media-lease.mjs')
    const writes = []
    const client = { send: async command => { writes.push(command.input) } }
    await withWorkerBudget({ getRemainingTimeInMillis: () => 120000 }, async () => {
        await withMediaLease(client, 'albums', 'album', async () => {
            assert.equal(writes.length, 1)
            const until = writes[0].ExpressionAttributeValues[':until']
            assert.ok(until >= Math.floor(Date.now() / 1000) + 179)
            assert.match(writes[0].ConditionExpression, /attribute_exists\(albumId\)/)
            assert.match(writes[0].ConditionExpression, /mediaLeaseUntil < :now/)
        })
    })
    assert.equal(writes.length, 2)
    assert.equal(writes[0].ExpressionAttributeValues[':owner'], writes[1].ExpressionAttributeValues[':owner'])
})

test('a busy publication never starts work and failed work releases only its own lease', async () => {
    const { withMediaLease } = await import('./media-lease.mjs')
    let ran = false
    await assert.rejects(withMediaLease({ send: async () => { throw new Error('busy') } }, 'albums', 'album', async () => { ran = true }), /busy/)
    assert.equal(ran, false)
    let calls = 0
    await assert.rejects(withMediaLease({ send: async () => { calls++; if (calls === 2) throw new Error('release unavailable') } }, 'albums', 'album', async () => { throw new Error('operation failed') }), /operation failed/)
    assert.equal(calls, 2)
})
