(function (global) {
  "use strict";

  var STYLE_ID = "yatrify-error-page-style";
  var HANDLER_FLAG = "__YATRIFY_404_HANDLERS_INSTALLED__";

  var DEFAULTS = {
    imageSrc: "/images/404 Error.png",
    imageAlt: "404 error illustration",
    titleText: "Lost Your Way?",
    messageText:
      "Looks like you've taken a detour. Don't worry, we'll help you get back on track to planning your perfect journey.",
    homeHref: "/index.html",
    homeLabel: "Return to Home",
    pageTitle: "",
    replaceBody: true,
  };

  var SCENARIOS = {
    MISTYPED_URL: {
      titleText: "Page Not Found",
      messageText: "The URL may have a typo. Please check the address and try again.",
    },
    CASE_SENSITIVITY_MISMATCH: {
      titleText: "Page Not Found",
      messageText: "This link may have uppercase/lowercase mismatch in the URL path.",
    },
    EXPIRED_BOOKMARK: {
      titleText: "Bookmark Outdated",
      messageText: "This bookmarked page has moved or no longer exists.",
    },
    COPY_PASTE_URL_ERROR: {
      titleText: "Invalid Link",
      messageText: "The copied link appears incomplete or broken.",
    },
    DELETED_CONTENT: {
      titleText: "Content Removed",
      messageText: "This page was removed and is no longer available.",
    },
    MOVED_PAGE_MISSING_REDIRECT: {
      titleText: "Page Moved",
      messageText: "This page has moved to a new URL and a redirect is missing.",
    },
    BROKEN_INTERNAL_LINK: {
      titleText: "Broken Link",
      messageText: "A link on this site points to a page that does not exist.",
    },
    UNPUBLISHED_DRAFT: {
      titleText: "Not Public",
      messageText: "This content is currently draft/private and cannot be viewed.",
    },
    LINK_ROT: {
      titleText: "Link Expired",
      messageText: "An old external link points to a page that no longer exists.",
    },
    MISSING_ASSET: {
      titleText: "Resource Not Found",
      messageText: "A required page resource could not be loaded.",
    },
    CACHE_STALE_ROUTE: {
      titleText: "Stale Route",
      messageText: "Your browser cache is pointing to an old page route.",
    },
    DNS_PROPAGATION_ISSUE: {
      titleText: "Temporary Route Issue",
      messageText: "Domain changes may still be propagating. Please try again shortly.",
    },
    SERVER_MISCONFIGURATION_ROUTE: {
      titleText: "Route Misconfigured",
      messageText: "Server route configuration could not locate this page.",
    },
    SECURITY_MASKED_AS_404: {
      titleText: "Not Found",
      messageText: "This resource is intentionally hidden.",
    },
    API_ENDPOINT_NOT_FOUND: {
      titleText: "API Endpoint Missing",
      messageText: "The requested API endpoint could not be found.",
    },
    LEGAL_REMOVAL_MASKED_AS_404: {
      titleText: "Content Unavailable",
      messageText: "This content is no longer available.",
    },
  };

  function ensureStyles() {
    if (document.getElementById(STYLE_ID)) return;

    var style = document.createElement("style");
    style.id = STYLE_ID;
    style.textContent = [
      '@font-face{font-family:"Yatrify Alt";src:url("/fonts/9e84385130e79dc9-s.woff2") format("woff2");font-style:normal;font-weight:500;font-display:swap;}',
      ":root{--page-bg:#efeff2;--title:#0e1732;--copy:#5f6f89;--btn-accent:#3f7de6;--btn-accent-hover:#2f69ce;}",
      "*{box-sizing:border-box;}",
      "body.yatrify-error-page{margin:0;min-height:100vh;display:grid;place-items:center;padding:26px;font-family:\"Yatrify Alt\",\"Montserrat Alternates\",\"Segoe UI\",sans-serif;background:radial-gradient(1200px 520px at 50% -120px,rgba(66,133,244,.08),transparent 58%),var(--page-bg);color:var(--title);}",
      ".yatrify-error-wrap{width:min(700px,94vw);text-align:center;animation:yatrify-rise-in .45s ease-out both;}",
      ".yatrify-error-art{display:block;width:380px;max-width:100%;height:auto;margin:0 auto 0;object-fit:contain;filter:drop-shadow(0 12px 28px rgba(9,21,45,.14));}",
      ".yatrify-error-title{margin:0 0 14px;font-size:40px;line-height:1.05;letter-spacing:-.02em;font-weight:700;}",
      ".yatrify-error-copy{margin:0 auto 34px;max-width:600px;font-size:16px;line-height:1.6;color:var(--copy);}",
      ".yatrify-error-home-btn{display:inline-flex;align-items:center;justify-content:center;min-height:40px;padding:0 34px;border-radius:999px;border:0;text-decoration:none;font-size:20px;font-weight:400;color:#fff;background:var(--btn-accent);box-shadow:0 14px 34px rgba(63,125,230,.3);transition:transform .18s ease,background-color .18s ease,box-shadow .18s ease;}",
      ".yatrify-error-home-btn:hover{background:var(--btn-accent-hover);transform:translateY(-2px);box-shadow:0 18px 36px rgba(63,125,230,.34);}",
      ".yatrify-error-home-btn:focus-visible{outline:3px solid rgba(66,133,244,.36);outline-offset:4px;}",
      "@keyframes yatrify-rise-in{from{opacity:0;transform:translateY(16px);}to{opacity:1;transform:translateY(0);}}",
    ].join("");

    document.head.appendChild(style);
  }

  function normalizeScenarioKey(input) {
    if (!input) return "";
    return String(input).trim().toUpperCase().replace(/[^A-Z0-9_]+/g, "_");
  }

  function scenarioConfigFor(key) {
    var normalized = normalizeScenarioKey(key);
    if (!normalized) return null;
    return SCENARIOS[normalized] || null;
  }

  function firstDefined(values) {
    for (var i = 0; i < values.length; i++) {
      if (values[i] !== undefined && values[i] !== null && values[i] !== "") {
        return values[i];
      }
    }
    return "";
  }

  function getLocationQueryScenario() {
    try {
      var params = new URLSearchParams(global.location.search || "");
      var scenario = params.get("scenario") || "";
      var resource = params.get("resource") || "";
      return {
        scenario: normalizeScenarioKey(scenario),
        resource: resource,
      };
    } catch (_err) {
      return { scenario: "", resource: "" };
    }
  }

  function resolveRenderConfig(options) {
    var config = Object.assign({}, DEFAULTS, options || {});
    var directScenario = normalizeScenarioKey(config.scenario);
    var queryMeta = getLocationQueryScenario();
    var scenario = directScenario || queryMeta.scenario;
    var scenarioDefaults = scenarioConfigFor(scenario) || {};

    config.titleText = firstDefined([config.titleText, scenarioDefaults.titleText, DEFAULTS.titleText]);
    config.messageText = firstDefined([
      config.messageText,
      scenarioDefaults.messageText,
      DEFAULTS.messageText,
    ]);
    config.homeHref = firstDefined([config.homeHref, DEFAULTS.homeHref]);
    config.homeLabel = firstDefined([config.homeLabel, DEFAULTS.homeLabel]);

    var resourceText = firstDefined([config.resource, queryMeta.resource]);
    if (resourceText) {
      config.messageText += " (" + resourceText + ")";
    }

    config.scenario = scenario;
    return config;
  }

  function render(options) {
    var config = resolveRenderConfig(options);
    var mount = config.mount || document.body;
    if (!mount) return null;

    ensureStyles();
    document.body.classList.add("yatrify-error-page");
    if (config.pageTitle) document.title = config.pageTitle;

    var wrap = document.createElement("main");
    wrap.className = "yatrify-error-wrap";

    var art = document.createElement("img");
    art.className = "yatrify-error-art";
    art.src = config.imageSrc;
    art.alt = config.imageAlt;

    var title = document.createElement("h1");
    title.className = "yatrify-error-title";
    title.textContent = config.titleText;

    var copy = document.createElement("p");
    copy.className = "yatrify-error-copy";
    copy.textContent = config.messageText;

    var homeBtn = document.createElement("a");
    homeBtn.className = "yatrify-error-home-btn";
    homeBtn.href = config.homeHref;
    homeBtn.textContent = config.homeLabel;

    wrap.appendChild(art);
    wrap.appendChild(title);
    wrap.appendChild(copy);
    wrap.appendChild(homeBtn);

    if (config.replaceBody) {
      mount.innerHTML = "";
    }
    mount.appendChild(wrap);
    return wrap;
  }

  function build404Url(input) {
    var options = typeof input === "string" ? { url: input } : Object.assign({}, input || {});
    var target = options.url || "/404.html";
    var absolute = new URL(target, global.location.href);
    var scenario = normalizeScenarioKey(options.scenario);
    var resource = options.resource ? String(options.resource) : "";
    if (scenario) absolute.searchParams.set("scenario", scenario);
    if (resource) absolute.searchParams.set("resource", resource);
    return absolute.pathname + absolute.search + absolute.hash;
  }

  function goTo404(input) {
    var href = build404Url(input);
    if (global.location.pathname + global.location.search === href) return;
    global.location.href = href;
  }

  function inferScenario(details) {
    var d = details || {};
    if (d.scenario) return normalizeScenarioKey(d.scenario);

    var status = Number(firstDefined([d.status, d.httpStatus, d.code]));
    var resource = String(firstDefined([d.resource, d.path, d.url]) || "");
    var source = String(firstDefined([d.source, d.type]) || "").toLowerCase();
    var targetTag = String(firstDefined([d.targetTag, d.tagName]) || "").toUpperCase();

    if (source === "asset" || targetTag === "IMG" || targetTag === "SCRIPT" || targetTag === "LINK") {
      return "MISSING_ASSET";
    }
    if (status === 404 && /^\/?api\//i.test(resource.replace(/^\//, ""))) {
      return "API_ENDPOINT_NOT_FOUND";
    }
    if (status === 404) return "BROKEN_INTERNAL_LINK";
    return "MISTYPED_URL";
  }

  function handle(details) {
    var d = Object.assign({}, details || {});
    var scenario = inferScenario(d);
    var mode = String(d.mode || "").toLowerCase();
    var renderInline = mode === "inline" || d.renderInline === true;
    var shouldRedirect = mode === "redirect" || d.redirect === true;

    if (!shouldRedirect || renderInline || global.location.pathname.toLowerCase().endsWith("/404.html")) {
      return render({
        scenario: scenario,
        resource: d.resource || d.path || d.url || "",
        titleText: d.titleText,
        messageText: d.messageText,
        homeHref: d.homeHref,
        homeLabel: d.homeLabel,
        pageTitle: d.pageTitle,
      });
    }

    goTo404({
      scenario: scenario,
      resource: d.resource || d.path || d.url || "",
      url: d.url404 || "/404.html",
    });
    return null;
  }

  function installGlobalHandlers() {
    if (global[HANDLER_FLAG]) return;
    global[HANDLER_FLAG] = true;

    global.addEventListener(
      "error",
      function (event) {
        var target = event && event.target;
        if (!target || target === global) return;
        var tagName = String(target.tagName || "").toUpperCase();
        if (tagName === "IMG" || tagName === "SCRIPT" || tagName === "LINK") {
          handle({
            source: "asset",
            targetTag: tagName,
            resource: target.currentSrc || target.src || target.href || "",
          });
        }
      },
      true
    );

    global.addEventListener("unhandledrejection", function (event) {
      var reason = event && event.reason;
      var status = reason && Number(reason.status || (reason.response && reason.response.status));
      if (status === 404) {
        handle({
          scenario: "API_ENDPOINT_NOT_FOUND",
          status: 404,
          resource: reason && (reason.path || reason.url || ""),
        });
      }
    });
  }

  function listScenarios() {
    return Object.keys(SCENARIOS);
  }

  global.YatrifyErrorPage = {
    render: render,
    renderFromLocation: function (options) {
      return render(options || {});
    },
    show: render,
    goTo404: goTo404,
    handle: handle,
    inferScenario: inferScenario,
    installGlobalHandlers: installGlobalHandlers,
    scenarios: SCENARIOS,
    listScenarios: listScenarios,
  };
})(window);
