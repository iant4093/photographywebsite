/* global require, Buffer */
const crypto = require('crypto');
const snapshot = null; // Replaced by the catalog publisher.
const PAGE_SIZE = 200;
const PREVIEW_WIDTHS = ['640', '960', '1440', '1920'];

function error(statusCode, code, retryAfter) {
    const headers = {
        'content-type': { value: 'application/json' },
        'cache-control': { value: 'no-store' },
        'access-control-allow-origin': { value: '*' },
    };
    if (retryAfter) headers['retry-after'] = { value: retryAfter };
    return { statusCode, headers, body: JSON.stringify({ error: code }) };
}

function parseFilter(query, allowCursor) {
    const allowed = ['album', 'featured', 'preview', 'width'];
    if (allowCursor) allowed.push('cursor');
    const names = Object.keys(query);
    if (names.some(name => !allowed.includes(name) || query[name].multiValue)) {
        return error(400, 'invalid_parameters');
    }
    const slug = query.album && query.album.value;
    const featured = query.featured ? query.featured.value : 'false';
    const width = query.preview ? (query.width ? query.width.value : '960') : '';
    const rawCursor = allowCursor && query.cursor ? query.cursor.value : '0';
    if ((query.album && (slug.length > 60 || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(slug))) ||
        !['true', 'false'].includes(featured) ||
        (query.preview && (query.preview.value !== 'webp' || !PREVIEW_WIDTHS.includes(width))) ||
        (query.width && !query.preview) ||
        !/^(?:0|[1-9][0-9]*)$/.test(rawCursor)) {
        return error(400, 'invalid_parameters');
    }
    return { slug: query.album ? slug : null, featured: featured === 'true', width, page: Number(rawCursor) };
}

function catalogPath(version, pool, width, file) {
    return '/catalog/' + version + '/' + (width ? 'webp/' + width + '/' : '') + pool + '/' + file + '.json';
}

function poolCount(entry, tier, index) {
    if (!entry) return 0;
    if (tier < 0) return entry[index + 1];
    const counts = entry[3] && entry[3].split(',')[tier];
    if (counts === '*') return entry[index + 1];
    return counts ? Number(counts.split(':')[index]) : 0;
}

function photoPath(query, isList) {
    const filter = parseFilter(query, isList);
    if (filter.statusCode) return filter;

    const tier = PREVIEW_WIDTHS.indexOf(filter.width);
    const index = filter.featured ? 1 : 0;
    const pool = filter.featured ? 'featured' : 'all';
    if (filter.slug !== null) {
        const album = Object.prototype.hasOwnProperty.call(snapshot.albums, filter.slug) && snapshot.albums[filter.slug];
        const all = poolCount(album, tier, 0);
        if (!all) return error(404, 'no_photos');
        const count = filter.featured ? poolCount(album, tier, index) : all;
        return poolPath(album[0], count || all, count ? pool : 'fallback', filter, isList);
    }
    if (isList) {
        const globalPool = snapshot.global;
        const count = poolCount(globalPool, tier, index);
        if (!count) return error(404, 'no_photos');
        return poolPath(globalPool[0], count, pool, filter, isList);
    }

    const albums = Object.values(snapshot.albums);
    const count = albums.reduce((total, album) => total + poolCount(album, tier, index), 0);
    if (!count) return error(404, 'no_photos');
    let position = Math.floor(Math.random() * count);
    for (let albumIndex = 0; albumIndex < albums.length; albumIndex++) {
        const album = albums[albumIndex];
        const length = poolCount(album, tier, index);
        if (position < length) {
            return catalogPath(album[0], pool, filter.width, position);
        }
        position -= length;
    }
    return error(503, 'catalog_unavailable', '60');
}

function poolPath(version, count, pool, filter, isList) {
    if (!isList) return catalogPath(version, pool, filter.width, Math.floor(Math.random() * count));
    if (filter.page >= Math.ceil(count / PAGE_SIZE)) return error(400, 'invalid_parameters');
    return catalogPath(version, pool, filter.width, 'page-' + filter.page);
}

function imagePath(request) {
    const match = /^\/v1\/images\/([a-f0-9]{64})\/([A-Za-z0-9_-]{1,1366})$/.exec(request.uri);
    if (!match || Object.keys(request.querystring).length) return error(404, 'image_not_found');
    const signature = crypto.createHmac('sha256', snapshot.signingKey).update(match[2]).digest('hex');
    let difference = 0;
    for (let index = 0; index < signature.length; index++) {
        difference |= signature.charCodeAt(index) ^ match[1].charCodeAt(index);
    }
    if (difference) return error(404, 'image_not_found');

    const key = Buffer.from(match[2].replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8');
    const parts = key.split('/');
    if (!key.startsWith('albums/') || !/\.(?:jpe?g|png|webp)$/i.test(key) ||
        // eslint-disable-next-line no-control-regex -- Reject control characters in origin keys.
        parts.some(part => !part || part === '.' || part === '..' || /[\\\u0000-\u001f\u007f]/.test(part))) {
        return error(404, 'image_not_found');
    }
    return '/' + parts.map(encodeURIComponent).join('/');
}

// eslint-disable-next-line no-unused-vars -- CloudFront invokes the named entry point.
function handler(event) {
    const request = event.request;
    if (!['GET', 'HEAD'].includes(request.method)) return error(405, 'method_not_allowed');
    const isPick = request.uri === '/v1/photos/random';
    const isList = request.uri === '/v1/photos';
    if (!isPick && !isList && !request.uri.startsWith('/v1/images/')) return error(404, 'not_found');
    if (!snapshot || Date.now() >= snapshot.expires) return error(503, 'catalog_unavailable', '60');

    const path = isPick || isList ? photoPath(request.querystring, isList) : imagePath(request);
    if (typeof path !== 'string') return path;
    request.uri = path;
    request.querystring = {};
    delete request.headers.range;
    delete request.headers['if-none-match'];
    delete request.headers['if-modified-since'];
    return request;
}
