import assert from 'node:assert/strict'
import crypto from 'node:crypto'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import vm from 'node:vm'

const source = readFileSync(new URL('../photo_api_selector.js', import.meta.url), 'utf8')
const signingKey = 'test-key'
const albums = { cliffs: ['cliffs-version', 2, 1], dunes: ['dunes-version', 1, 0] }

function select(uri, querystring = {}, { random = 0, expires = 2000, method = 'GET' } = {}) {
    const context = {
        require: () => crypto,
        Buffer,
        Date: { now: () => 1000 },
        Math: { random: () => random, floor: Math.floor },
    }
    const code = source.replace('const snapshot = null;', `const snapshot = ${JSON.stringify({ albums, signingKey, expires })};`)
    vm.runInNewContext(code, context)
    return context.handler({
        request: { uri, querystring, method, headers: { range: { value: 'bytes=1-2' } } },
    })
}

const route = '/v1/photos/random'
const featured = { value: 'true' }

test('picks by photo count, resolves featured pools and keeps the album fallback local', () => {
    assert.equal(select(route, {}, { random: 0.6 }).uri, '/catalog/cliffs-version/all/1.json')
    assert.equal(select(route, {}, { random: 0.8 }).uri, '/catalog/dunes-version/all/0.json')
    assert.equal(select(route, { featured }).uri, '/catalog/cliffs-version/featured/0.json')
    assert.equal(select(route, { album: { value: 'dunes' } }).uri, '/catalog/dunes-version/all/0.json')
    assert.equal(select(route, { album: { value: 'dunes' }, featured }).uri, '/catalog/dunes-version/fallback/0.json')
})

test('rejects unknown or duplicate parameters, unknown albums and direct origin paths', () => {
    assert.equal(select(route, { featured: { value: '1' } }).statusCode, 400)
    assert.equal(select(route, { limit: { value: '10' } }).statusCode, 400)
    assert.equal(select(route, { album: { value: 'dunes', multiValue: [{ value: 'dunes' }, { value: 'cliffs' }] } }).statusCode, 400)
    assert.equal(select(route, { album: { value: 'constructor' } }).statusCode, 404)
    assert.equal(select('/catalog/cliffs-version/all/0.json').statusCode, 404)
    assert.equal(select(route, {}, { method: 'POST' }).statusCode, 405)
    assert.equal(select(route, {}, { expires: 1000 }).statusCode, 503)
})

function imageRoute(key) {
    const token = Buffer.from(key).toString('base64url')
    const signature = crypto.createHmac('sha256', signingKey).update(token).digest('hex')
    return `/v1/images/${signature}/${token}`
}

test('verifies the signed image path before rewriting it to a canonical S3 object', () => {
    const path = imageRoute('albums/dunes/original/Blue sky.jpg')
    const request = select(path, {}, { method: 'HEAD' })
    assert.equal(request.uri, '/albums/dunes/original/Blue%20sky.jpg')
    assert.equal(request.headers.range, undefined)
    assert.equal(select(path + 'a').statusCode, 404)
    assert.equal(select(path, { cache: { value: 'bust' } }).statusCode, 404)
    assert.equal(select(imageRoute('albums/dunes/../private.jpg')).statusCode, 404)
    assert.equal(select(imageRoute('protected/private.jpg')).statusCode, 404)
})
