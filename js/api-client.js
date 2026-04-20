(function () {
  var authTokenCacheTtlMs = 15000;

  function normalizeApiBase(base) {
    var value = String(base || "").trim().replace(/\/+$/, "");
    if (!value) return "";
    if (/^https?:\/\/(localhost|127\.0\.0\.1|0\.0\.0\.0|\[::1\])(?::\d+)?$/i.test(value)) {
      return "";
    }
    return value;
  }

  function getApiBase() {
    var base =
      (typeof window !== "undefined" && (window.__YATRIFY_API_BASE_URL || window.YATRIFY_API_BASE_URL)) ||
      "";
    return normalizeApiBase(base);
  }

  function getAuthCache() {
    if (!window.YatrifyAuthCache || typeof window.YatrifyAuthCache !== "object") return null;
    return window.YatrifyAuthCache;
  }

  function getCachedUserProfile(options) {
    var cache = getAuthCache();
    if (!cache || typeof cache.getProfile !== "function") return null;
    return cache.getProfile(options);
  }

  function mergeUserProfilePayload(payload) {
    var merged = {};
    var cached = getCachedUserProfile({ maxAgeMs: 0 });
    if (cached && typeof cached === "object") {
      Object.keys(cached).forEach(function (key) {
        merged[key] = cached[key];
      });
    }
    if (window.Clerk && window.Clerk.user) {
      var user = window.Clerk.user;
      var fullName = [user.firstName, user.lastName].filter(Boolean).join(" ").trim();
      if (user.id && !merged.userId) merged.userId = user.id;
      if (user.firstName && !merged.firstName) merged.firstName = user.firstName;
      if (user.lastName && !merged.lastName) merged.lastName = user.lastName;
      if (fullName && !merged.fullName) merged.fullName = fullName;
      if (user.imageUrl && !merged.imageUrl) merged.imageUrl = user.imageUrl;
      if (user.primaryEmailAddress && user.primaryEmailAddress.emailAddress && !merged.email) {
        merged.email = user.primaryEmailAddress.emailAddress;
      }
    }
    if (payload && typeof payload === "object") {
      Object.keys(payload).forEach(function (key) {
        merged[key] = payload[key];
      });
    }
    return merged;
  }

  function ensureClerkLoaded(requireUser) {
    if (window.Clerk && window.Clerk.loaded) {
      return Promise.resolve(window.Clerk);
    }
    if (typeof window.__loadYatrifyClerk === "function") {
      return window.__loadYatrifyClerk(false).then(function (clerk) {
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
    var cachedTokenRecord = window.__YATRIFY_AUTH_TOKEN_CACHE;
    if (cachedTokenRecord && typeof cachedTokenRecord === "object") {
      var expiresAt = Number(cachedTokenRecord.expiresAt || 0);
      if (cachedTokenRecord.token && expiresAt > Date.now()) {
        return Promise.resolve(cachedTokenRecord.token);
      }
    }
    return ensureClerkLoaded(true).then(function (clerk) {
      if (!clerk || !clerk.session || typeof clerk.session.getToken !== "function") {
        throw new Error("User session not available");
      }
      return clerk.session.getToken().then(function (token) {
        if (!token) return token;
        window.__YATRIFY_AUTH_TOKEN_CACHE = {
          token: token,
          expiresAt: Date.now() + authTokenCacheTtlMs
        };
        return token;
      });
    });
  }

  function fetchUserProfile(options) {
    var opts = options && typeof options === "object" ? options : {};
    if (opts.forceRefresh !== true) {
      var cached = getCachedUserProfile(
        Number.isFinite(Number(opts.maxAgeMs)) ? { maxAgeMs: Number(opts.maxAgeMs) } : undefined
      );
      if (cached && cached.userId) {
        return Promise.resolve(cached);
      }
    }

    return authFetch("/api/users/me")
      .then(function (response) {
        return response.json();
      })
      .then(function (payload) {
        var merged = mergeUserProfilePayload(payload);
        var cache = getAuthCache();
        if (cache && typeof cache.setProfile === "function") {
          cache.setProfile(merged);
        }
        if (cache && typeof cache.applyToDom === "function") {
          cache.applyToDom();
        }
        return getCachedUserProfile({ maxAgeMs: 0 }) || merged;
      });
  }

  function authFetch(path, options) {
    var opts = options && typeof options === "object" ? Object.assign({}, options) : {};
    var normalizedPath = String(path || "");
    return getAuthToken().then(function (token) {
      var headers = new Headers(opts.headers || {});
      headers.set("Authorization", "Bearer " + token);
      if (!headers.has("Content-Type") && !(opts.body instanceof FormData)) {
        headers.set("Content-Type", "application/json");
      }
      opts.headers = headers;
      return fetch(getApiBase() + path, opts).then(function (res) {
        if (!res.ok) {
          if (res.status === 404) {
            redirectNotFound({
              scenario: "API_ENDPOINT_NOT_FOUND",
              resource: normalizedPath || "/api",
            });
          }
          var err = new Error("Request failed");
          err.status = res.status;
          err.response = res;
          err.path = normalizedPath;
          throw err;
        }
        return res;
      });
    });
  }

  function apiFetch(path, options) {
    var opts = options && typeof options === "object" ? Object.assign({}, options) : {};
    var normalizedPath = String(path || "");
    var headers = new Headers(opts.headers || {});
    if (!headers.has("Content-Type") && !(opts.body instanceof FormData)) {
      headers.set("Content-Type", "application/json");
    }
    opts.headers = headers;
    return fetch(getApiBase() + path, opts).then(function (res) {
      if (!res.ok) {
        if (res.status === 404) {
          redirectNotFound({
            scenario: "API_ENDPOINT_NOT_FOUND",
            resource: normalizedPath || "/api",
          });
        }
        var err = new Error("Request failed");
        err.status = res.status;
        err.response = res;
        err.path = normalizedPath;
        throw err;
      }
      return res;
    });
  }

  function redirectNotFound(input) {
    var details = input && typeof input === "object" ? input : {};
    var scenario = String(details.scenario || "BROKEN_INTERNAL_LINK");
    var resource = String(details.resource || "");
    var target = "/404.html?scenario=" + encodeURIComponent(scenario);
    if (resource) {
      target += "&resource=" + encodeURIComponent(resource);
    }

    if (window.YatrifyErrorPage && typeof window.YatrifyErrorPage.handle === "function") {
      window.YatrifyErrorPage.handle({
        scenario: scenario,
        resource: resource,
        renderInline: true,
        url404: target,
      });
      return;
    }

    if (window.location && window.location.pathname !== "/404.html") {
      window.location.href = target;
    }
  }

  window.YatrifyApiClient = {
    getApiBase: getApiBase,
    ensureClerkLoaded: ensureClerkLoaded,
    getCachedUserProfile: getCachedUserProfile,
    getAuthToken: getAuthToken,
    fetchUserProfile: fetchUserProfile,
    authFetch: authFetch,
    apiFetch: apiFetch,
  };
})();
