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
