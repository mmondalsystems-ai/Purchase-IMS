/*
 * Replaces Google Apps Script's google.script.run with calls to this server.
 *
 *   google.script.run.withSuccessHandler(ok).withFailureHandler(fail).someFunction(a, b)
 *
 * becomes  POST /api/someFunction  with body {"args": [a, b]}.
 * The page code does not need to change.
 */
(function () {
  function makeRunner(onSuccess, onFailure) {
    return new Proxy({}, {
      get: function (_target, name) {
        if (typeof name !== 'string' || name === 'then') return undefined;
        if (name === 'withSuccessHandler') {
          return function (fn) { return makeRunner(fn, onFailure); };
        }
        if (name === 'withFailureHandler') {
          return function (fn) { return makeRunner(onSuccess, fn); };
        }
        if (name === 'withUserObject') {
          return function () { return makeRunner(onSuccess, onFailure); };
        }
        return function () {
          var args = Array.prototype.slice.call(arguments);
          var fail = function (message) {
            if (onFailure) {
              try { onFailure({ message: message }); } catch (e) { console.error(e); }
            } else {
              console.error('Server call failed:', name, message);
            }
          };
          fetch('/api/' + encodeURIComponent(name), {
            method: 'POST',
            credentials: 'same-origin',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ args: args })
          })
            .then(function (resp) {
              if (resp.status === 401) {
                window.location.href = '/login';
                throw new Error('Your session has expired. Please sign in again.');
              }
              return resp.json();
            })
            .then(function (data) {
              if (data && data.ok) {
                if (onSuccess) {
                  try { onSuccess(data.result); } catch (e) { console.error(e); }
                }
              } else {
                fail((data && data.error) || 'Request failed.');
              }
            }, function (err) {
              fail((err && err.message) || 'Network error.');
            });
        };
      }
    });
  }

  window.google = window.google || {};
  window.google.script = { run: makeRunner(null, null), host: { close: function () {} } };
})();
