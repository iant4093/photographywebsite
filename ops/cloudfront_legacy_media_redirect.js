function handler(event) {
    var request = event.request;
    var apex = 'https://__APEX_HOST__';
    var headers = { 'cache-control': { value: 'no-store' } };
    if (!/^\/(?:albums|public-previews|site\/hero|main-image|fotomoto)\//.test(request.uri)) {
        return { statusCode: 403, statusDescription: 'Forbidden', headers: headers };
    }

    var origin = request.headers.origin && request.headers.origin.value;
    if (origin === apex) {
        headers['access-control-allow-origin'] = { value: apex };
        headers.vary = { value: 'Origin' };
    }
    if (request.method === 'OPTIONS') {
        var method = request.headers['access-control-request-method'];
        var requested = request.headers['access-control-request-headers'];
        if (origin !== apex || !method || !/^(GET|HEAD)$/.test(method.value)
                || (requested && !/^\s*(?:content-type|range)(?:\s*,\s*(?:content-type|range))*\s*$/i.test(requested.value))) {
            return { statusCode: 403, statusDescription: 'Forbidden', headers: headers };
        }
        headers['access-control-allow-methods'] = { value: 'GET, HEAD, OPTIONS' };
        headers['access-control-allow-headers'] = { value: 'Content-Type, Range' };
        headers['access-control-max-age'] = { value: '600' };
        return { statusCode: 204, statusDescription: 'No Content', headers: headers };
    }

    var query = [];
    Object.keys(request.querystring).forEach(function (name) {
        var entry = request.querystring[name];
        (entry.multiValue || [entry]).forEach(function (item) {
            query.push(name + '=' + item.value);
        });
    });
    var suffix = query.length ? '?' + query.join('&') : '';
    headers.location = { value: apex + '/media' + request.uri + suffix };
    return { statusCode: 307, statusDescription: 'Temporary Redirect', headers: headers };
}
