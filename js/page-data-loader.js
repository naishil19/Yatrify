(function () {
  if (window.__yatrifyDataLoader) return;
  window.__yatrifyDataLoader = true;
  if (document.documentElement && document.documentElement.classList.contains("yatrify-page-transition-modern")) {
    document.documentElement.classList.remove("yatrify-data-loading", "yatrify-icons-loading");
    return;
  }
  var state = {
    pageReady: false,
    iconsReady: false,
    finished: false
  };

  function ensureStyle() {
    if (document.getElementById("yatrify-data-loader-style")) return;
    var style = document.createElement("style");
    style.id = "yatrify-data-loader-style";
    style.textContent =
      "#yatrify-data-loader{" +
      "position:fixed;top:0;left:0;width:100%;height:3px;z-index:2005;" +
      "pointer-events:none;opacity:0;transition:opacity .2s ease;" +
      "}" +
      "#yatrify-data-loader::before{" +
      "content:'';position:absolute;left:-40%;top:0;height:100%;width:40%;" +
      "background:linear-gradient(90deg,rgba(59,130,246,0) 0%,rgba(59,130,246,.85) 50%,rgba(59,130,246,0) 100%);" +
      "animation:yatrifyDataLoad 1.1s linear infinite;" +
      "}" +
      "#yatrify-data-loader.active{opacity:1;}" +
      "html.yatrify-icons-loading [data-lucide]{" +
      "opacity:0;" +
      "}" +
      "html.yatrify-data-loading header," +
      "html.yatrify-data-loading .topbar," +
      "html.yatrify-data-loading .main-grid," +
      "html.yatrify-data-loading .page-shell," +
      "html.yatrify-data-loading main," +
      "html.yatrify-data-loading footer," +
      "html.yatrify-data-loading .sidebar{" +
      "opacity:0;pointer-events:none;" +
      "}" +
      "header,.topbar,.main-grid,.page-shell,main,footer,.sidebar{" +
      "transition:opacity .2s ease;" +
      "}" +
      "@keyframes yatrifyDataLoad{from{transform:translateX(0);}to{transform:translateX(350%);}}";
    document.head.appendChild(style);
  }

  function ensureBar() {
    var bar = document.getElementById("yatrify-data-loader");
    if (!bar) {
      bar = document.createElement("div");
      bar.id = "yatrify-data-loader";
      document.body.appendChild(bar);
    }
    return bar;
  }

  function show() {
    ensureStyle();
    var bar = ensureBar();
    bar.classList.add("active");
    if (document.documentElement) document.documentElement.classList.add("yatrify-data-loading");
  }

  function hide() {
    if (state.finished) return;
    state.finished = true;
    var bar = document.getElementById("yatrify-data-loader");
    if (bar) bar.classList.remove("active");
    if (document.documentElement) document.documentElement.classList.remove("yatrify-data-loading");
  }

  var finishTimer = null;

  function maybeFinish() {
    if (state.pageReady && state.iconsReady) {
      if (finishTimer) {
        clearTimeout(finishTimer);
        finishTimer = null;
      }
      hide();
    }
  }

  function markReadyClass(name) {
    if (!document.documentElement) return;
    document.documentElement.classList.add(name);
  }

  function waitForIcons() {
    if (!document.querySelector("[data-lucide]")) {
      if (document.documentElement) document.documentElement.classList.remove("yatrify-icons-loading");
      markReadyClass("yatrify-icons-ready");
      state.iconsReady = true;
      maybeFinish();
      if (typeof window.dispatchEvent === "function" && typeof window.CustomEvent === "function") {
        try {
          window.dispatchEvent(new CustomEvent("yatrify:icons-ready"));
        } catch (_) {}
      }
      return Promise.resolve();
    }
    return new Promise(function (resolve) {
      var attempts = 0;
      function check() {
        if (window.lucide && typeof window.lucide.createIcons === "function") {
          try {
            window.lucide.createIcons();
          } catch (_) {}
          if (document.querySelector("svg.lucide")) {
            if (document.documentElement) document.documentElement.classList.remove("yatrify-icons-loading");
            markReadyClass("yatrify-icons-ready");
            state.iconsReady = true;
            maybeFinish();
            if (typeof window.dispatchEvent === "function" && typeof window.CustomEvent === "function") {
              try {
                window.dispatchEvent(new CustomEvent("yatrify:icons-ready"));
              } catch (_) {}
            }
            resolve();
            return;
          }
        }
        attempts += 1;
        if (attempts > 60) {
          if (document.documentElement) document.documentElement.classList.remove("yatrify-icons-loading");
          markReadyClass("yatrify-icons-ready");
          state.iconsReady = true;
          maybeFinish();
          if (typeof window.dispatchEvent === "function" && typeof window.CustomEvent === "function") {
            try {
              window.dispatchEvent(new CustomEvent("yatrify:icons-ready"));
            } catch (_) {}
          }
          resolve();
          return;
        }
        setTimeout(check, 100);
      }
      check();
    });
  }

  function arm() {
    if (!document.documentElement || !document.documentElement.classList.contains("yatrify-data-loading")) {
      return;
    }
    state.pageReady = document.documentElement.classList.contains("yatrify-page-ready");
    state.iconsReady = document.documentElement.classList.contains("yatrify-icons-ready") || !document.querySelector("[data-lucide]");
    show();
    waitForIcons();
    if (finishTimer) clearTimeout(finishTimer);
    finishTimer = setTimeout(function () {
      hide();
    }, 8000);
    window.addEventListener("yatrify:plan-loaded", function () {
      markReadyClass("yatrify-page-ready");
      state.pageReady = true;
      maybeFinish();
    }, { once: true });
    window.addEventListener("yatrify:page-ready", function () {
      markReadyClass("yatrify-page-ready");
      state.pageReady = true;
      maybeFinish();
    }, { once: true });

    if (!document.querySelector("[data-lucide]")) {
      state.iconsReady = true;
    }
    maybeFinish();
  }

  document.addEventListener("DOMContentLoaded", arm);
})();
