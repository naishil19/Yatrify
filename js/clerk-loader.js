(function () {
  var configuredBase = window.__YATRIFY_API_BASE_URL;
  var defaultBase = "";
  var clerkCdnUrl = "https://cdn.jsdelivr.net/npm/@clerk/clerk-js@5/dist/clerk.browser.js";
  var cachedKeyStorageName = "YATRIFY_CLERK_PUBLISHABLE_KEY";
  var cachedApiBaseStorageName = "YATRIFY_API_BASE_URL";
  var cachedProfileStorageName = "YATRIFY_USER_PROFILE_CACHE";
  var userProfileCacheMaxAgeMs = 15 * 60 * 1000;
  var apiBase = normalizeApiBase(configuredBase) || readCachedApiBase() || defaultBase;

  function normalizeApiBase(base) {
    var value = String(base || "").trim().replace(/\/+$/, "");
    if (!value) return "";
    if (/^https?:\/\/(localhost|127\.0\.0\.1|0\.0\.0\.0|\[::1\])(?::\d+)?$/i.test(value)) {
      return "";
    }
    return value;
  }

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
      .then(function (config) {
        if (config.apiBaseUrl) {
          apiBase = normalizeApiBase(config.apiBaseUrl);
          window.__YATRIFY_API_BASE_URL = apiBase;
          cacheApiBase(apiBase);
        }
        if (config.clerkPublishableKey) {
          cachePublishableKey(config.clerkPublishableKey);
          window.__YATRIFY_CLERK_PUBLISHABLE_KEY = config.clerkPublishableKey;
        }
        return config;
      })
      .catch(function () {
        return {};
      });
  }

  function readCachedApiBase() {
    try {
      return normalizeApiBase(localStorage.getItem(cachedApiBaseStorageName) || "");
    } catch (_e) {
      return "";
    }
  }

  function cacheApiBase(base) {
    var value = normalizeApiBase(base);
    if (!value) return;
    try {
      localStorage.setItem(cachedApiBaseStorageName, value);
    } catch (_e) {
    }
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

  function buildClerkSnapshot(clerkOrUser) {
    var user = clerkOrUser && clerkOrUser.user ? clerkOrUser.user : clerkOrUser;
    if (!user || typeof user !== "object") return {};
    var email =
      user.primaryEmailAddress && user.primaryEmailAddress.emailAddress
        ? String(user.primaryEmailAddress.emailAddress).trim()
        : "";
    var firstName = String(user.firstName || "").trim();
    var lastName = String(user.lastName || "").trim();
    var fullName = [firstName, lastName].filter(Boolean).join(" ").trim();
    return {
      userId: String(user.id || user.userId || "").trim(),
      firstName: firstName,
      lastName: lastName,
      fullName: fullName,
      email: email,
      imageUrl: String(user.imageUrl || user.profileImageUrl || "").trim()
    };
  }

  function normalizeUserProfile(raw) {
    if (!raw || typeof raw !== "object") return null;
    var profile = {
      userId: String(raw.userId || raw.id || "").trim(),
      firstName: String(raw.firstName || "").trim(),
      lastName: String(raw.lastName || "").trim(),
      fullName: String(raw.fullName || "").trim(),
      email: String(raw.email || "").trim(),
      imageUrl: String(raw.imageUrl || raw.profileImageUrl || "").trim(),
      planTier: String(raw.planTier || "").trim()
    };
    var credits = Number(raw.credits);
    if (Number.isFinite(credits)) profile.credits = Math.max(0, credits);
    return profile;
  }

  function mergeUserProfile(profile, clerkOrUser) {
    var normalized = normalizeUserProfile(profile) || {};
    var snapshot = buildClerkSnapshot(clerkOrUser);
    if (snapshot.userId && !normalized.userId) normalized.userId = snapshot.userId;
    if (snapshot.firstName && !normalized.firstName) normalized.firstName = snapshot.firstName;
    if (snapshot.lastName && !normalized.lastName) normalized.lastName = snapshot.lastName;
    if (snapshot.fullName) normalized.fullName = snapshot.fullName;
    if (snapshot.email) normalized.email = snapshot.email;
    if (snapshot.imageUrl) normalized.imageUrl = snapshot.imageUrl;
    return normalizeUserProfile(normalized);
  }

  function readCachedUserProfileRecord() {
    if (window.__YATRIFY_USER_PROFILE_CACHE && typeof window.__YATRIFY_USER_PROFILE_CACHE === "object") {
      return window.__YATRIFY_USER_PROFILE_CACHE;
    }
    try {
      var raw = sessionStorage.getItem(cachedProfileStorageName);
      if (!raw) return null;
      var parsed = JSON.parse(raw);
      if (!parsed || typeof parsed !== "object") return null;
      window.__YATRIFY_USER_PROFILE_CACHE = parsed;
      return parsed;
    } catch (_e) {
      return null;
    }
  }

  function writeCachedUserProfile(profile) {
    var normalized = normalizeUserProfile(profile);
    if (!normalized || !normalized.userId) return null;
    var record = {
      savedAt: Date.now(),
      profile: normalized
    };
    window.__YATRIFY_USER_PROFILE_CACHE = record;
    try {
      sessionStorage.setItem(cachedProfileStorageName, JSON.stringify(record));
    } catch (_e) {
    }
    return normalized;
  }

  function clearCachedUserProfile() {
    window.__YATRIFY_USER_PROFILE_CACHE = null;
    try {
      sessionStorage.removeItem(cachedProfileStorageName);
    } catch (_e) {
    }
  }

  function getCachedUserProfile(options) {
    var opts = options && typeof options === "object" ? options : {};
    var maxAgeMs = Number.isFinite(Number(opts.maxAgeMs)) ? Number(opts.maxAgeMs) : userProfileCacheMaxAgeMs;
    var record = readCachedUserProfileRecord();
    if (!record || !record.profile) return null;
    if (maxAgeMs > 0) {
      var savedAt = Number(record.savedAt || 0);
      if (!savedAt || (Date.now() - savedAt) > maxAgeMs) return null;
    }
    return normalizeUserProfile(record.profile);
  }

  function updateCachedUserProfile(profile, clerkOrUser) {
    var merged = mergeUserProfile(profile, clerkOrUser);
    if (!merged || !merged.userId) return null;
    return writeCachedUserProfile(merged);
  }

  function applyCachedProfileToDom() {
    var profile = getCachedUserProfile();
    if (!profile || !profile.userId) return null;

    var dashboardLink = document.getElementById("dashboard-link");
    var signInLink = document.getElementById("signin-link");
    var communitySignInLink = document.getElementById("community-signin-link");
    var headerSignInLink = document.getElementById("header-signin-link");
    var profileWrap = document.getElementById("user-profile");
    var avatar = document.getElementById("user-avatar");
    var nameEl = document.getElementById("profile-name");
    var emailEl = document.getElementById("profile-email");
    var creditsCount = document.getElementById("credits-count");
    var creditsWrap = document.getElementById("community-credits-wrap");
    var desktopDashboardNav = document.getElementById("community-dashboard-nav");
    var mobileDashboardNav = document.getElementById("community-mobile-dashboard-nav");
    var mobileSignInNav = document.getElementById("community-mobile-signin-nav");

    if (dashboardLink) dashboardLink.style.display = "inline-block";
    if (signInLink) signInLink.style.display = "none";
    if (communitySignInLink) communitySignInLink.style.display = "none";
    if (headerSignInLink) headerSignInLink.style.display = "none";
    if (desktopDashboardNav) desktopDashboardNav.style.display = "";
    if (mobileDashboardNav) mobileDashboardNav.style.display = "";
    if (mobileSignInNav) mobileSignInNav.style.display = "none";
    if (profileWrap) profileWrap.style.display = "inline-flex";
    if (creditsWrap) creditsWrap.style.display = "inline-block";
    if (nameEl) nameEl.textContent = profile.fullName || profile.firstName || "Account";
    if (emailEl) emailEl.textContent = profile.email || "";
    if (avatar && profile.imageUrl) {
      avatar.src = profile.imageUrl;
    }
    if (creditsCount && Number.isFinite(Number(profile.credits))) {
      creditsCount.textContent = String(Math.max(0, Number(profile.credits)));
    }
    return profile;
  }

  function scheduleCachedProfileHydration() {
    if (document.readyState === "loading") {
      document.addEventListener("DOMContentLoaded", applyCachedProfileToDom, { once: true });
      return;
    }
    applyCachedProfileToDom();
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

  function syncCurrentUser(clerk) {
    if (!clerk || !clerk.user || !clerk.session || typeof clerk.session.getToken !== "function") {
      window.__YATRIFY_LAST_SYNCED_USER_ID = "";
      clearCachedUserProfile();
      return Promise.resolve(null);
    }

    var userId = String(clerk.user.id || "").trim();
    if (!userId) return Promise.resolve(null);
    updateCachedUserProfile(null, clerk.user);
    applyCachedProfileToDom();
    if (window.__YATRIFY_LAST_SYNCED_USER_ID === userId) return Promise.resolve(null);
    if (window.__YATRIFY_USER_SYNC_PROMISE && window.__YATRIFY_USER_SYNC_USER_ID === userId) {
      return window.__YATRIFY_USER_SYNC_PROMISE;
    }

    var syncPromise = clerk.session.getToken().then(function (token) {
      if (!token) throw new Error("Clerk token unavailable");
      return fetch(apiBase.replace(/\/+$/, "") + "/api/users/me", {
        method: "GET",
        headers: {
          "Authorization": "Bearer " + token,
          "Content-Type": "application/json"
        }
      });
      }).then(function (res) {
        if (!res.ok) throw new Error("User sync failed with status " + res.status);
        return res.json().catch(function () { return null; });
      }).then(function (payload) {
        window.__YATRIFY_LAST_SYNCED_USER_ID = userId;
        var cachedProfile = updateCachedUserProfile(payload, clerk.user);
        applyCachedProfileToDom();
        return cachedProfile;
      }).catch(function (error) {
        console.error("Yatrify user sync failed", error);
        return getCachedUserProfile({ maxAgeMs: userProfileCacheMaxAgeMs });
      }).finally(function () {
        if (window.__YATRIFY_USER_SYNC_USER_ID === userId) {
          window.__YATRIFY_USER_SYNC_PROMISE = null;
          window.__YATRIFY_USER_SYNC_USER_ID = "";
        }
    });

    window.__YATRIFY_USER_SYNC_USER_ID = userId;
    window.__YATRIFY_USER_SYNC_PROMISE = syncPromise;
    return syncPromise;
  }

  function attachClerkSyncListener(clerk) {
    if (!clerk || typeof clerk.addListener !== "function" || clerk.__yatrifySyncListenerAttached === true) return;
    clerk.addListener(function () {
      syncCurrentUser(window.Clerk || clerk);
    });
    clerk.__yatrifySyncListenerAttached = true;
  }

  function patchClerkLoad(publishableKey) {
    if (!window.Clerk || typeof window.Clerk.load !== "function" || !publishableKey) return;
    if (window.Clerk.__yatrifyLoadPatched === true) {
      attachClerkSyncListener(window.Clerk);
      syncCurrentUser(window.Clerk);
      return;
    }

    var originalLoad = window.Clerk.load.bind(window.Clerk);
    window.Clerk.load = function (options) {
      var opts = options && typeof options === "object" ? Object.assign({}, options) : {};
      if (!opts.publishableKey) {
        opts.publishableKey = publishableKey;
      }
      return originalLoad(opts).then(function (result) {
        attachClerkSyncListener(window.Clerk || result);
        return syncCurrentUser(window.Clerk || result).then(function () {
          return result;
        });
      });
    };
    window.Clerk.__yatrifyLoadPatched = true;
    attachClerkSyncListener(window.Clerk);
    syncCurrentUser(window.Clerk);
  }

  function initClerkFromEnv() {
    return loadClerkInternal(false);
  }

  function loadClerkInternal(forceRetry) {
    if (window.Clerk && window.Clerk.loaded) {
      return Promise.resolve(window.Clerk);
    }
    if (window.__YATRIFY_CLERK_LOADING_PROMISE) {
      return window.__YATRIFY_CLERK_LOADING_PROMISE;
    }

    var knownPublishableKey =
      String(window.__YATRIFY_CLERK_PUBLISHABLE_KEY || "").trim() ||
      readCachedPublishableKey();

    function finalizeClerkLoad(publishableKey) {
      if (!publishableKey) return Promise.resolve(null);
      window.__YATRIFY_CLERK_PUBLISHABLE_KEY = publishableKey;
      cachePublishableKey(publishableKey);
      return loadScriptOnce("yatrify-clerk-sdk", clerkCdnUrl, publishableKey).then(function () {
        patchClerkLoad(publishableKey);
        return window.Clerk || null;
      });
    }

    function refreshPublicConfigInBackground() {
      return fetchPublicConfig().catch(function () {
        return {};
      });
    }

    if (knownPublishableKey) {
      window.__YATRIFY_CLERK_LOADING_PROMISE = finalizeClerkLoad(knownPublishableKey)
        .then(function (clerk) {
          refreshPublicConfigInBackground();
          return clerk;
        })
        .catch(function () {
          return fetchPublicConfig().then(function (config) {
            var publishableKey = config.clerkPublishableKey || knownPublishableKey;
            return finalizeClerkLoad(publishableKey);
          });
        })
        .catch(function () {
          window.__YATRIFY_CLERK_LOADING_PROMISE = null;
          return null;
        });
      return window.__YATRIFY_CLERK_LOADING_PROMISE;
    }

    window.__YATRIFY_CLERK_LOADING_PROMISE = fetchPublicConfig()
      .then(function (config) {
        return finalizeClerkLoad(config.clerkPublishableKey);
      })
      .catch(function () {
        window.__YATRIFY_CLERK_LOADING_PROMISE = null;
        return null;
      });

    return window.__YATRIFY_CLERK_LOADING_PROMISE;
  }

  window.YatrifyAuthCache = {
    getProfile: getCachedUserProfile,
    setProfile: writeCachedUserProfile,
    clearProfile: clearCachedUserProfile,
    applyToDom: applyCachedProfileToDom
  };
  window.__loadYatrifyClerk = function (forceRetry) {
    return loadClerkInternal(!!forceRetry);
  };
  scheduleCachedProfileHydration();
  initClerkFromEnv();
})();

