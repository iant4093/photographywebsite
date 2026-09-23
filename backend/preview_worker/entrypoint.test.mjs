import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { dirname } from 'node:path'
import test from 'node:test'
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
