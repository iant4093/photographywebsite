function appendQueryPair(parts, key, value) {
  // CloudFront supplies query keys and values in their URI-encoded form.
  // Re-encoding here would turn `%20` into `%2520` during the redirect.
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

  // Keep API routing and error semantics entirely separate from the SPA.
  // This function is associated with every behavior to preserve www redirects.
  if (request.uri === '/api' || request.uri.indexOf('/api/') === 0) return request;
  if (request.method !== 'GET' && request.method !== 'HEAD') return request;

  // Album and video document paths are handled by an API-origin cache behavior
  // so social crawlers receive per-album metadata. Keep this routing here as
  // well as in the dedicated social router: the canonical redirect function is
  // deliberately associated broadly and must never rewrite these requests to
  // /index.html on the API origin.
  var socialPath = request.uri.match(/^\/(album|video)(?:\/([^/]*))?\/?$/i);
  if (socialPath) {
    var routeKind = socialPath[1].toLowerCase() === 'video' ? 'video' : 'album';
    var candidate = socialPath[2] || '';
    var albumId = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(candidate)
      ? candidate.toLowerCase()
      : 'invalid';
    request.uri = '/api/public/social/' + routeKind + '/' + albumId;
    return request;
  }

  // S3's REST origin has no history fallback. Rewrite only extensionless
  // frontend navigation paths; real assets and well-known files pass through.
  var segment = request.uri.substring(request.uri.lastIndexOf('/') + 1);
  if (request.uri !== '/' && segment.indexOf('.') === -1) {
    request.uri = '/index.html';
  }
  return request;
}
