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

  // S3's REST origin has no history fallback. Rewrite only extensionless
  // frontend navigation paths; real assets and well-known files pass through.
  var segment = request.uri.substring(request.uri.lastIndexOf('/') + 1);
  if (request.uri !== '/' && segment.indexOf('.') === -1) {
    request.uri = '/index.html';
  }
  return request;
}
