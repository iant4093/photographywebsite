function handler(event) {
    var request = event.request;
    var uri = request.uri;
    var publicPath = '/media/';
    var parts = uri.slice(publicPath.length).split('/');
    var allowed = uri.indexOf(publicPath) === 0 && parts.length > 1;

    for (var index = 0; allowed && index < parts.length; index += 1) {
        var part;
        try {
            part = decodeURIComponent(parts[index]);
        } catch (_error) {
            allowed = false;
            break;
        }
        allowed = part !== '' && part !== '.' && part !== '..'
            && part.indexOf('/') === -1 && part.indexOf('\\') === -1;
        for (var character = 0; allowed && character < part.length; character += 1) {
            var code = part.charCodeAt(character);
            allowed = code >= 32 && code !== 127;
        }
    }

    if (allowed && parts[0] === 'public-previews') {
        var album = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
        var filename = /^(?:[a-f0-9]{24}-w(?:640|960|1440|1920)\.webp|hover-[a-f0-9]{24}\.json)$/;
        allowed = parts.length === 4 && album.test(parts[1]) && parts[2] === 'v3' && filename.test(parts[3]);
        request.uri = '/albums/' + parts[1] + '/preview/v3/' + parts[3];
    } else if (allowed) {
        allowed = parts[0] === 'albums' || parts[0] === 'fotomoto' || parts[0] === 'main-image'
            || (parts[0] === 'site' && parts[1] === 'hero' && parts.length > 2);
        request.uri = '/' + parts.join('/');
    }

    if (!allowed) {
        return {
            statusCode: 404,
            statusDescription: 'Not Found',
            headers: { 'cache-control': { value: 'private, no-store' } }
        };
    }

    // Keep public cache keys distinct from signed requests for the same object.
    request.headers['x-public-media-cache'] = { value: 'public' };
    return request;
}
