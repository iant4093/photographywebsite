/* global require, Buffer */
const crypto = require('crypto');
const snapshot = null; // Replaced by the catalog publisher.
const PAGE_SIZE = 200;

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
    const allowed = allowCursor ? ['album', 'featured', 'cursor'] : ['album', 'featured'];
    const names = Object.keys(query);
    if (names.some(name => !allowed.includes(name) || query[name].multiValue)) {
        return error(400, 'invalid_parameters');
    }
    const slug = query.album && query.album.value;
    const featured = query.featured ? query.featured.value : 'false';
    const rawCursor = allowCursor && query.cursor ? query.cursor.value : '0';
    if ((query.album && (slug.length > 60 || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(slug))) ||
        !['true', 'false'].includes(featured) ||
        !/^(?:0|[1-9][0-9]*)$/.test(rawCursor)) {
        return error(400, 'invalid_parameters');
    }
    return { slug: query.album ? slug : null, featured: featured === 'true', page: Number(rawCursor) };
}

function albumPool(slug, featured) {
    const album = Object.prototype.hasOwnProperty.call(snapshot.albums, slug) && snapshot.albums[slug];
    if (!album || !album[1]) return error(404, 'no_photos');
    return {
        version: album[0],
        count: featured ? album[2] || album[1] : album[1],
        pool: featured ? (album[2] ? 'featured' : 'fallback') : 'all',
    };
}

function photoPath(query) {
    const filter = parseFilter(query, false);
    if (filter.statusCode) return filter;

    if (filter.slug !== null) {
        const target = albumPool(filter.slug, filter.featured);
        if (target.statusCode) return target;
        return '/catalog/' + target.version + '/' + target.pool + '/' + Math.floor(Math.random() * target.count) + '.json';
    }

    const index = filter.featured ? 2 : 1;
    const albums = Object.values(snapshot.albums);
    const count = albums.reduce((total, album) => total + album[index], 0);
    if (!count) return error(404, 'no_photos');
    let position = Math.floor(Math.random() * count);
    for (let albumIndex = 0; albumIndex < albums.length; albumIndex++) {
        const album = albums[albumIndex];
        if (position < album[index]) {
            return '/catalog/' + album[0] + '/' + (index === 2 ? 'featured' : 'all') + '/' + position + '.json';
        }
        position -= album[index];
    }
    return error(503, 'catalog_unavailable', '60');
}

function listPath(query) {
    const filter = parseFilter(query, true);
    if (filter.statusCode) return filter;

    let target;
    if (filter.slug !== null) {
        target = albumPool(filter.slug, filter.featured);
        if (target.statusCode) return target;
    } else {
        const poolInfo = snapshot.global;
        const index = filter.featured ? 2 : 1;
        if (!poolInfo || !poolInfo[index]) return error(404, 'no_photos');
        target = { version: poolInfo[0], count: poolInfo[index], pool: filter.featured ? 'featured' : 'all' };
    }
    if (filter.page >= Math.ceil(target.count / PAGE_SIZE)) return error(400, 'invalid_parameters');
    return '/catalog/' + target.version + '/' + target.pool + '/page-' + filter.page + '.json';
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

    const path = isPick ? photoPath(request.querystring) : isList ? listPath(request.querystring) : imagePath(request);
    if (typeof path !== 'string') return path;
    request.uri = path;
    request.querystring = {};
    delete request.headers.range;
    delete request.headers['if-none-match'];
    delete request.headers['if-modified-since'];
    return request;
}
