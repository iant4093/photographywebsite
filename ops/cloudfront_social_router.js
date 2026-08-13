function appendQueryPair(parts, key, value) {
  parts.push(key + '=' + (value || ''));
}

function handler(event) {
  var request = event.request;
  var host = request.headers.host && request.headers.host.value.toLowerCase();
  if (host === '__WWW_HOST__') {
    var parts = [];
    var query = request.querystring || {};
    for (var key in query) {
      if (!Object.prototype.hasOwnProperty.call(query, key)) continue;
      var entry = query[key];
      if (entry.multiValue) {
        for (var i = 0; i < entry.multiValue.length; i++) {
          appendQueryPair(parts, key, entry.multiValue[i].value);
        }
      } else {
        appendQueryPair(parts, key, entry.value);
      }
    }
    var suffix = parts.length ? '?' + parts.join('&') : '';
    return {
      statusCode: 301,
      statusDescription: 'Moved Permanently',
      headers: {
        location: { value: 'https://__APEX_HOST__' + request.uri + suffix },
        'cache-control': { value: 'public, max-age=300' }
      }
    };
  }

  if (request.method !== 'GET' && request.method !== 'HEAD') return request;
  var match = request.uri.match(/^\/(album|video)\/([0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})\/?$/i);
  var routeKind = match && match[1].toLowerCase() === 'video' ? 'video' : 'album';
  var albumId = match ? match[2].toLowerCase() : 'invalid';
  request.uri = '/api/public/social/' + routeKind + '/' + albumId;
  return request;
}
