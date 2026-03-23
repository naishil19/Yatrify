(function () {
  function getApiBase() {
    var base =
      (typeof window !== "undefined" && (window.__YATRIFY_API_BASE_URL || window.YATRIFY_API_BASE_URL)) ||
      "http://localhost:4000";
    return String(base || "").replace(/\/+$/, "");
  }

  function ensureClerkLoaded(requireUser) {
    if (window.Clerk && window.Clerk.loaded) {
      return Promise.resolve(window.Clerk);
    }
    if (typeof window.__loadYatrifyClerk === "function") {
      return window.__loadYatrifyClerk(true).then(function (clerk) {
        if (!clerk) {
          if (requireUser) throw new Error("Clerk SDK not available");
          return null;
        }
        if (typeof clerk.load === "function" && !clerk.loaded) {
          return clerk.load().then(function () {
            return window.Clerk || clerk;
          });
        }
        return window.Clerk || clerk;
      });
    }
    if (requireUser) return Promise.reject(new Error("Clerk SDK not available"));
    return Promise.resolve(null);
  }

  function getAuthToken() {
    return ensureClerkLoaded(true).then(function (clerk) {
      if (!clerk || !clerk.session || typeof clerk.session.getToken !== "function") {
        throw new Error("User session not available");
      }
      return clerk.session.getToken();
    });
  }

  function authFetch(path, options) {
    var opts = options && typeof options === "object" ? Object.assign({}, options) : {};
    return getAuthToken().then(function (token) {
      var headers = new Headers(opts.headers || {});
      headers.set("Authorization", "Bearer " + token);
      if (!headers.has("Content-Type") && !(opts.body instanceof FormData)) {
        headers.set("Content-Type", "application/json");
      }
      opts.headers = headers;
      return fetch(getApiBase() + path, opts).then(function (res) {
        if (!res.ok) {
          var err = new Error("Request failed");
          err.status = res.status;
          err.response = res;
          throw err;
        }
        return res;
      });
    });
  }

  function apiFetch(path, options) {
    var opts = options && typeof options === "object" ? Object.assign({}, options) : {};
    var headers = new Headers(opts.headers || {});
    if (!headers.has("Content-Type") && !(opts.body instanceof FormData)) {
      headers.set("Content-Type", "application/json");
    }
    opts.headers = headers;
    return fetch(getApiBase() + path, opts).then(function (res) {
      if (!res.ok) {
        var err = new Error("Request failed");
        err.status = res.status;
        err.response = res;
        throw err;
      }
      return res;
    });
  }

  window.YatrifyApiClient = {
    getApiBase: getApiBase,
    ensureClerkLoaded: ensureClerkLoaded,
    getAuthToken: getAuthToken,
    authFetch: authFetch,
    apiFetch: apiFetch,
  };
})();
