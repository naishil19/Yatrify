(function () {
  var configuredBase = window.__YATRIFY_API_BASE_URL;
  var defaultBase = "http://localhost:4000";
  var apiBase = (typeof configuredBase === "string" && configuredBase.trim()) ? configuredBase.trim() : defaultBase;
  var clerkCdnUrl = "https://cdn.jsdelivr.net/npm/@clerk/clerk-js@5/dist/clerk.browser.js";
  var cachedKeyStorageName = "YATRIFY_CLERK_PUBLISHABLE_KEY";

  function normalizeConfig(raw) {
    if (!raw || typeof raw !== "object") return {};
    return {
      clerkPublishableKey: typeof raw.clerkPublishableKey === "string" ? raw.clerkPublishableKey.trim() : "",
      apiBaseUrl: typeof raw.apiBaseUrl === "string" ? raw.apiBaseUrl.trim() : "",
    };
  }

  function fetchPublicConfig() {
    var url = apiBase.replace(/\/+$/, "") + "/api/public-config";
    return fetch(url, { method: "GET" })
      .then(function (res) {
        if (!res.ok) throw new Error("Public config request failed");
        return res.json();
      })
      .then(normalizeConfig)
      .catch(function () {
        return {};
      });
  }

  function readCachedPublishableKey() {
    try {
      return String(localStorage.getItem(cachedKeyStorageName) || "").trim();
    } catch (_e) {
      return "";
    }
  }

  function cachePublishableKey(key) {
    var value = String(key || "").trim();
    if (!value) return;
    try {
      localStorage.setItem(cachedKeyStorageName, value);
    } catch (_e) {
    }
  }

  function loadScriptOnce(id, src, publishableKey) {
    var key = String(publishableKey || "").trim();
    var existing = document.getElementById(id);
    if (existing && !window.Clerk) {
      var existingKey = String(existing.getAttribute("data-clerk-publishable-key") || "").trim();
      var existingStatus = String(existing.getAttribute("data-yatrify-status") || "").trim();
      if ((key && existingKey !== key) || existingStatus === "error") {
        if (existing.parentNode) existing.parentNode.removeChild(existing);
        existing = null;
      }
    }

    if (existing) {
      return new Promise(function (resolve, reject) {
        if (window.Clerk) {
          resolve();
          return;
        }
        existing.addEventListener("load", function () { resolve(); }, { once: true });
        existing.addEventListener("error", function () { reject(new Error("Failed loading Clerk SDK")); }, { once: true });
        setTimeout(function () {
          if (!window.Clerk) reject(new Error("Clerk SDK did not initialize"));
        }, 3000);
      });
    }
    return new Promise(function (resolve, reject) {
      var script = document.createElement("script");
      script.id = id;
      script.src = src;
      script.async = true;
      script.crossOrigin = "anonymous";
      if (key) {
        script.setAttribute("data-clerk-publishable-key", key);
        window.__clerk_publishable_key = key;
      }
      script.setAttribute("data-yatrify-status", "loading");
      script.onload = function () {
        script.setAttribute("data-yatrify-status", "loaded");
        resolve();
      };
      script.onerror = function () {
        script.setAttribute("data-yatrify-status", "error");
        reject(new Error("Failed loading Clerk SDK"));
      };
      document.head.appendChild(script);
    });
  }

  function patchClerkLoad(publishableKey) {
    if (!window.Clerk || typeof window.Clerk.load !== "function" || !publishableKey) return;
    if (window.Clerk.__yatrifyLoadPatched === true) return;

    var originalLoad = window.Clerk.load.bind(window.Clerk);
    window.Clerk.load = function (options) {
      var opts = options && typeof options === "object" ? Object.assign({}, options) : {};
      if (!opts.publishableKey) {
        opts.publishableKey = publishableKey;
      }
      return originalLoad(opts);
    };
    window.Clerk.__yatrifyLoadPatched = true;
  }

  function initClerkFromEnv() {
    return loadClerkInternal(false);
  }

  function loadClerkInternal(forceRetry) {
    if (!forceRetry && window.__YATRIFY_CLERK_LOADING_PROMISE) {
      return window.__YATRIFY_CLERK_LOADING_PROMISE;
    }

    window.__YATRIFY_CLERK_LOADING_PROMISE = fetchPublicConfig()
      .then(function (config) {
        if (config.apiBaseUrl) {
          apiBase = config.apiBaseUrl;
          window.__YATRIFY_API_BASE_URL = config.apiBaseUrl;
        }

        var publishableKey =
          config.clerkPublishableKey ||
          window.__YATRIFY_CLERK_PUBLISHABLE_KEY ||
          readCachedPublishableKey();
        if (!publishableKey) {
          window.__YATRIFY_CLERK_LOADING_PROMISE = null;
          return null;
        }

        window.__YATRIFY_CLERK_PUBLISHABLE_KEY = publishableKey;
        cachePublishableKey(publishableKey);
        return loadScriptOnce("yatrify-clerk-sdk", clerkCdnUrl, publishableKey).then(function () {
          patchClerkLoad(publishableKey);
          if (!window.Clerk) {
            window.__YATRIFY_CLERK_LOADING_PROMISE = null;
            return null;
          }
          return window.Clerk;
        });
      })
      .catch(function () {
        window.__YATRIFY_CLERK_LOADING_PROMISE = null;
        return null;
      });

    return window.__YATRIFY_CLERK_LOADING_PROMISE;
  }

  window.__loadYatrifyClerk = function (forceRetry) {
    return loadClerkInternal(!!forceRetry);
  };
  initClerkFromEnv();
})();
