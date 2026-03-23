(function () {
  if (window.__yatrifyPageLoader) return;
  window.__yatrifyPageLoader = true;

  var root = document.documentElement;
  var modernMode = root.classList.contains("yatrify-page-transition-modern");

  function isPrefetchableLink(link) {
    if (!link || !link.href) return false;
    if (link.hasAttribute("download")) return false;
    if (link.target && link.target.toLowerCase() === "_blank") return false;
    var href = link.getAttribute("href") || "";
    if (!href || href.charAt(0) === "#") return false;
    if (href.indexOf("mailto:") === 0 || href.indexOf("tel:") === 0) return false;
    try {
      var url = new URL(link.href, window.location.href);
      if (url.origin !== window.location.origin) return false;
      if (!/\.html($|[?#])|\/$/.test(url.pathname)) return false;
      return true;
    } catch (_) {
      return false;
    }
  }

  function setupPrefetch() {
    var prefetched = Object.create(null);

    function prefetch(link) {
      if (!isPrefetchableLink(link)) return;
      var href = link.href;
      if (prefetched[href]) return;
      prefetched[href] = true;

      try {
        var existing = document.querySelector('link[rel="prefetch"][href="' + href.replace(/"/g, '\\"') + '"]');
        if (existing) return;
      } catch (_) {}

      var node = document.createElement("link");
      node.rel = "prefetch";
      node.as = "document";
      node.href = href;
      document.head.appendChild(node);
    }

    document.addEventListener("mouseenter", function (event) {
      var link = event.target && event.target.closest ? event.target.closest("a") : null;
      prefetch(link);
    }, true);

    document.addEventListener("focusin", function (event) {
      var link = event.target && event.target.closest ? event.target.closest("a") : null;
      prefetch(link);
    });

    document.addEventListener("touchstart", function (event) {
      var link = event.target && event.target.closest ? event.target.closest("a") : null;
      prefetch(link);
    }, { passive: true });
  }

  if (modernMode) {
    var revealed = root.classList.contains("yatrify-page-revealed");
    var fallbackTimer = null;
    var loaderRemoved = false;

    function ensureModernLoader() {
      var loader = document.getElementById("yatrify-modern-loader");
      var contentHost = document.querySelector(".content");
      if (loader) {
        if (contentHost && loader.parentNode !== contentHost) {
          contentHost.insertBefore(loader, contentHost.firstChild || null);
        }
        return loader;
      }
      if (!document.body) return null;
      loader = document.createElement("div");
      loader.id = "yatrify-modern-loader";
      loader.setAttribute("aria-hidden", "true");
      loader.innerHTML =
        '<div class="yatrify-modern-loader-card">' +
        '<div class="yatrify-modern-loader-head">' +
        '<span class="yatrify-modern-loader-badge"></span>' +
        '<div>' +
        '<p class="yatrify-modern-loader-title">Loading your journey</p>' +
        '<p class="yatrify-modern-loader-text">Preparing the latest travel details for this page.</p>' +
        '</div>' +
        '</div>' +
        '<div class="yatrify-modern-loader-lines">' +
        '<span class="yatrify-modern-loader-line long"></span>' +
        '<span class="yatrify-modern-loader-line medium"></span>' +
        '<span class="yatrify-modern-loader-line short"></span>' +
        '</div>' +
        '</div>';
      if (contentHost) {
        contentHost.insertBefore(loader, contentHost.firstChild || null);
      } else {
        document.body.insertBefore(loader, document.body.firstChild || null);
      }
      return loader;
    }

    function revealModern() {
      if (revealed) return;
      ensureModernLoader();
      root.classList.add("yatrify-shell-revealing", "yatrify-page-revealed");
      window.setTimeout(function () {
        root.classList.remove("yatrify-shell-loading", "yatrify-shell-revealing", "yatrify-page-loading", "yatrify-page-revealing", "yatrify-nav-loading");
        revealed = true;
        if (fallbackTimer) {
          clearTimeout(fallbackTimer);
          fallbackTimer = null;
        }
        if (!loaderRemoved) {
          loaderRemoved = true;
          window.setTimeout(function () {
            var loader = document.getElementById("yatrify-modern-loader");
            if (loader && loader.parentNode) loader.parentNode.removeChild(loader);
          }, 220);
        }
      }, 180);
    }

    function revealSoon() {
      if (revealed) return;
      if (typeof window.requestAnimationFrame === "function") {
        window.requestAnimationFrame(revealModern);
      } else {
        setTimeout(revealModern, 0);
      }
    }

    if (root.classList.contains("yatrify-page-ready")) {
      revealSoon();
    }

    ensureModernLoader();

    window.addEventListener("yatrify:page-ready", revealSoon, { once: true });
    window.addEventListener("pageshow", function () {
      if (root.classList.contains("yatrify-page-ready")) revealSoon();
    });

    fallbackTimer = setTimeout(function () {
      if (!revealed) revealModern();
    }, 3200);

    document.addEventListener("click", function (event) {
      var link = event.target && event.target.closest ? event.target.closest("a") : null;
      if (!isPrefetchableLink(link)) return;
      root.classList.add("yatrify-nav-loading");
    });

    window.addEventListener("beforeunload", function () {
      root.classList.add("yatrify-nav-loading");
    });

    setupPrefetch();
    return;
  }

  function ensureStyle() {
    if (document.getElementById("yatrify-page-loader-style")) return;
    var style = document.createElement("style");
    style.id = "yatrify-page-loader-style";
    style.textContent =
      "#yatrify-page-loader{" +
      "position:fixed;top:0;left:0;width:100%;height:3px;z-index:4000;" +
      "pointer-events:none;opacity:0;transition:opacity .2s ease;" +
      "}" +
      "#yatrify-page-loader::before{" +
      "content:'';position:absolute;left:-40%;top:0;height:100%;width:40%;" +
      "background:linear-gradient(90deg,rgba(59,130,246,0) 0%,rgba(59,130,246,.85) 50%,rgba(59,130,246,0) 100%);" +
      "animation:yatrifyPageLoad 1.1s linear infinite;" +
      "}" +
      "#yatrify-page-loader.active{opacity:1;}" +
      "@keyframes yatrifyPageLoad{from{transform:translateX(0);}to{transform:translateX(350%);}}";
    document.head.appendChild(style);
  }

  function ensureBar() {
    var bar = document.getElementById("yatrify-page-loader");
    if (!bar) {
      bar = document.createElement("div");
      bar.id = "yatrify-page-loader";
      document.body.appendChild(bar);
    }
    return bar;
  }

  function show() {
    ensureStyle();
    ensureBar().classList.add("active");
  }

  function hide() {
    var bar = document.getElementById("yatrify-page-loader");
    if (bar) bar.classList.remove("active");
  }

  if (document.readyState === "complete") {
    hide();
  } else {
    window.addEventListener("load", hide);
  }

  window.addEventListener("pageshow", hide);
  window.addEventListener("beforeunload", show);

  document.addEventListener("click", function (event) {
    var link = event.target && event.target.closest ? event.target.closest("a") : null;
    if (!isPrefetchableLink(link)) return;
    show();
  });
})();
