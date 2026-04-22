(function () {
  function isLocalDevHost() {
    if (typeof window === "undefined" || !window.location) return false;
    var hostname = String(window.location.hostname || "").toLowerCase();
    var protocol = String(window.location.protocol || "").toLowerCase();
    return (
      protocol === "file:" ||
      hostname === "localhost" ||
      hostname === "127.0.0.1" ||
      hostname === "0.0.0.0" ||
      hostname === "::1"
    );
  }

  var apiBase = isLocalDevHost() ? "" : "https://yatrify-production.up.railway.app";
  window.__YATRIFY_API_BASE_URL = apiBase;
  window.YATRIFY_API_BASE_URL = apiBase;
})();
