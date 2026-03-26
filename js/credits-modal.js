(function () {
  var FREE_CREDIT_CAP = 2;
  var PURCHASE_URL = "https://pages.razorpay.com/Yatrify";
  var MODAL_ID = "yatrify-credits-modal";
  var STYLE_ID = "yatrify-credits-modal-styles";
  var state = {
    modal: null,
    closeButton: null,
    freeValue: null,
    boughtValue: null,
    purchaseLink: null,
    bodyOverflow: "",
    initialized: false
  };

  function visuallyHiddenStyle() {
    return "position:absolute;width:1px;height:1px;padding:0;margin:-1px;overflow:hidden;clip:rect(0,0,0,0);white-space:nowrap;border:0;";
  }

  function formatCreditValue(value) {
    var numeric = Number(value);
    if (!Number.isFinite(numeric)) return "0";
    if (Math.abs(numeric - Math.round(numeric)) < 1e-9) return String(Math.round(numeric));
    return numeric.toFixed(2).replace(/\.?0+$/, "");
  }

  function parseCreditValue(value) {
    if (typeof value === "number" && Number.isFinite(value)) return value;
    var numeric = Number.parseFloat(String(value == null ? "" : value).replace(/[^\d.]/g, ""));
    return Number.isFinite(numeric) ? numeric : 0;
  }

  function splitCredits(totalCredits, payload) {
    var freeCredits = payload && Number.isFinite(Number(payload.freeCredits))
      ? Math.max(0, Number(payload.freeCredits))
      : Math.min(Math.max(0, totalCredits), FREE_CREDIT_CAP);
    var boughtCredits = payload && Number.isFinite(Number(payload.boughtCredits))
      ? Math.max(0, Number(payload.boughtCredits))
      : Math.max(0, totalCredits - freeCredits);

    return {
      freeCredits: freeCredits,
      boughtCredits: boughtCredits
    };
  }

  function getHeaderCreditFallback() {
    var countNode = document.getElementById("credits-count");
    if (!countNode) return 0;
    return parseCreditValue(countNode.textContent);
  }

  function buildPurchaseUrl(payload) {
    var url;
    try {
      url = new URL(PURCHASE_URL);
    } catch (_) {
      return PURCHASE_URL;
    }

    if (payload && payload.email) {
      url.searchParams.set("email", String(payload.email));
    }
    if (payload && payload.id) {
      url.searchParams.set("userId", String(payload.id));
    }
    return url.toString();
  }

  function injectStyles() {
    if (document.getElementById(STYLE_ID)) return;
    var style = document.createElement("style");
    style.id = STYLE_ID;
    style.textContent = [
      ".yatrify-credits-trigger{cursor:pointer;}",
      ".yatrify-credits-trigger:focus-visible{outline:2px solid #3b82f6;outline-offset:4px;border-radius:10px;}",
      ".yatrify-credits-backdrop{position:fixed;inset:0;z-index:1600;display:none;align-items:center;justify-content:center;padding:clamp(18px,4vw,32px);background:rgba(15,23,42,.36);backdrop-filter:blur(8px);}",
      ".yatrify-credits-backdrop.open{display:flex;}",
      ".yatrify-credits-dialog{position:relative;width:min(100%,720px);max-height:min(86vh,760px);overflow:auto;border:1px solid #dbe3ef;border-radius:28px;background:#ffffff;box-shadow:0 28px 70px rgba(15,23,42,.18);padding:40px 30px 28px;}",
      ".yatrify-credits-dialog *{box-sizing:border-box;}",
      ".yatrify-credits-close{position:absolute;top:16px;right:16px;width:40px;height:40px;border:1px solid #cbd5e1;border-radius:999px;background:#ffffff;color:#334155;display:inline-flex;align-items:center;justify-content:center;cursor:pointer;transition:background-color .2s ease,border-color .2s ease,color .2s ease;}",
      ".yatrify-credits-close svg{width:22px;height:22px;display:block;flex:0 0 22px;}",
      ".yatrify-credits-close:hover{background:#f8fafc;border-color:#94a3b8;color:#0f172a;}",
      ".yatrify-credits-grid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:12px;}",
      ".yatrify-credits-card{border:1px solid #dbe3ef;border-radius:16px;background:#ffffff;padding:26px 18px 20px;text-align:center;}",
      ".yatrify-credits-label{margin:0;font-size:18px;font-weight:600;line-height:1.3;color:#111827;}",
      ".yatrify-credits-value{margin:14px 0 0;font-size:clamp(48px,7vw,88px);font-weight:700;line-height:.95;color:#020617;letter-spacing:-0.04em;}",
      ".yatrify-credits-purchase{margin-top:12px;border:1px solid #dbe3ef;border-radius:18px;background:#ffffff;padding:22px 20px 18px;}",
      ".yatrify-credits-head{display:flex;align-items:center;gap:12px;margin-bottom:12px;color:#3b82f6;}",
      ".yatrify-credits-head svg,.yatrify-credits-note svg{width:20px;height:20px;flex:0 0 20px;}",
      ".yatrify-credits-title{margin:0;font-size:17px;font-weight:600;color:#111827;}",
      ".yatrify-credits-text,.yatrify-credits-note{margin:0;color:#64748b;font-size:15px;line-height:1.45;}",
      ".yatrify-credits-note{display:flex;align-items:flex-start;gap:10px;margin-top:12px;}",
      ".yatrify-credits-cta{margin-top:22px;display:inline-flex;width:100%;align-items:center;justify-content:center;gap:10px;border:none;border-radius:10px;background:#3b82f6;color:#ffffff;padding:14px 18px;font-size:17px;font-weight:600;text-decoration:none;transition:background-color .2s ease,transform .2s ease;}",
      ".yatrify-credits-cta svg{width:20px;height:20px;display:block;flex:0 0 20px;}",
      ".yatrify-credits-cta span{display:inline-block;line-height:1.2;}",
      ".yatrify-credits-cta:hover{background:#2563eb;transform:translateY(-1px);}",
      ".yatrify-credits-provider{margin-top:10px;text-align:right;font-size:14px;font-weight:500;color:#0f172a;opacity:.8;}",
      "html.dark .yatrify-credits-dialog,html.dark .yatrify-credits-card,html.dark .yatrify-credits-purchase{background:#0f172a;border-color:#334155;box-shadow:0 32px 76px rgba(2,6,23,.55);}",
      "html.dark .yatrify-credits-close{background:#0f172a;border-color:#334155;color:#cbd5e1;}",
      "html.dark .yatrify-credits-close:hover{background:#1e293b;border-color:#475569;color:#f8fafc;}",
      "html.dark .yatrify-credits-label,html.dark .yatrify-credits-title,html.dark .yatrify-credits-value,html.dark .yatrify-credits-provider{color:#f8fafc;}",
      "html.dark .yatrify-credits-text,html.dark .yatrify-credits-note{color:#94a3b8;}",
      "@media (max-width: 640px){.yatrify-credits-dialog{padding:28px 18px 18px;border-radius:22px;}.yatrify-credits-grid{grid-template-columns:1fr;}.yatrify-credits-card{padding:20px 16px 16px;}.yatrify-credits-label{font-size:17px;}.yatrify-credits-purchase{padding:18px 16px 16px;}.yatrify-credits-provider{text-align:left;}.yatrify-credits-cta{font-size:16px;padding:13px 16px;}}"
    ].join("");
    document.head.appendChild(style);
  }

  function createIcon(pathMarkup) {
    return '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' + pathMarkup + "</svg>";
  }

  function ensureModal() {
    if (state.modal && state.closeButton && state.freeValue && state.boughtValue && state.purchaseLink) return;

    var existingModal = document.getElementById("credits-modal");
    if (existingModal) {
      state.modal = existingModal;
      state.closeButton = document.getElementById("credits-modal-close");
      state.freeValue = document.getElementById("credits-free-value");
      state.boughtValue = document.getElementById("credits-bought-value");
      state.purchaseLink = document.getElementById("credits-purchase-link");
    }

    if (!state.modal || !state.closeButton || !state.freeValue || !state.boughtValue || !state.purchaseLink) {
      var wrapper = document.createElement("div");
      wrapper.innerHTML = [
        '<div id="' + MODAL_ID + '" class="yatrify-credits-backdrop" aria-hidden="true">',
        '  <div class="yatrify-credits-dialog" role="dialog" aria-modal="true" aria-labelledby="yatrify-credits-title">',
        '    <h2 id="yatrify-credits-title" style="' + visuallyHiddenStyle() + '">Credits wallet</h2>',
        '    <button id="yatrify-credits-close" class="yatrify-credits-close" type="button" aria-label="Close credits dialog">',
             createIcon('<path d="M18 6 6 18"></path><path d="m6 6 12 12"></path>'),
        "    </button>",
        '    <div class="yatrify-credits-grid">',
        '      <article class="yatrify-credits-card">',
        '        <p class="yatrify-credits-label">Free Credits</p>',
        '        <p id="yatrify-credits-free-value" class="yatrify-credits-value">0</p>',
        "      </article>",
        '      <article class="yatrify-credits-card">',
        '        <p class="yatrify-credits-label">Bought Credits</p>',
        '        <p id="yatrify-credits-bought-value" class="yatrify-credits-value">0</p>',
        "      </article>",
        "    </div>",
        '    <section class="yatrify-credits-purchase" aria-label="Purchase credits">',
        '      <div class="yatrify-credits-head">',
               createIcon('<path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"></path>'),
        '        <h3 class="yatrify-credits-title">Secure Purchase</h3>',
        "      </div>",
        '      <p class="yatrify-credits-text">Your payment information is encrypted and secure. We partner with trusted payment providers to ensure your data is protected.</p>',
        '      <p class="yatrify-credits-note">',
               createIcon('<rect width="20" height="14" x="2" y="5" rx="2"></rect><path d="M2 10h20"></path>'),
        '        <span>We accept all major credit cards, digital wallets and UPIs</span>',
        "      </p>",
        '      <a id="yatrify-credits-purchase-link" class="yatrify-credits-cta" href="' + PURCHASE_URL + '" target="_blank" rel="noopener noreferrer">',
                 createIcon('<rect width="18" height="11" x="3" y="6.5" rx="2"></rect><path d="M7 12h10"></path>'),
        '        <span>Purchase Credits</span>',
        "      </a>",
        '      <div class="yatrify-credits-provider">Secured by Razorpay</div>',
        "    </section>",
        "  </div>",
        "</div>"
      ].join("");
      document.body.appendChild(wrapper.firstChild);
      state.modal = document.getElementById(MODAL_ID);
      state.closeButton = document.getElementById("yatrify-credits-close");
      state.freeValue = document.getElementById("yatrify-credits-free-value");
      state.boughtValue = document.getElementById("yatrify-credits-bought-value");
      state.purchaseLink = document.getElementById("yatrify-credits-purchase-link");
    }

    if (state.modal && state.modal.dataset.creditsModalBound !== "1") {
      state.modal.dataset.creditsModalBound = "1";
      state.closeButton.addEventListener("click", closeModal);
      state.modal.addEventListener("click", function (event) {
        if (event.target === state.modal) closeModal();
      });
      document.addEventListener("keydown", function (event) {
        if (event.key === "Escape" && state.modal && isModalOpen()) {
          closeModal();
        }
      });
    }
  }

  function isModalOpen() {
    if (!state.modal) return false;
    return state.modal.classList.contains("open");
  }

  function setModalValues(payload, totalCredits) {
    ensureModal();
    var parts = splitCredits(totalCredits, payload);
    state.freeValue.textContent = formatCreditValue(parts.freeCredits);
    state.boughtValue.textContent = formatCreditValue(parts.boughtCredits);
    state.purchaseLink.href = buildPurchaseUrl(payload);
  }

  function openModal() {
    ensureModal();
    state.bodyOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    state.modal.classList.add("open");
    state.modal.setAttribute("aria-hidden", "false");
  }

  function closeModal() {
    if (!state.modal) return;
    state.modal.classList.remove("open");
    state.modal.setAttribute("aria-hidden", "true");
    document.body.style.overflow = state.bodyOverflow || "";
  }

  function openAuthFallback() {
    var signInButton = document.getElementById("open-signin");
    if (signInButton && typeof signInButton.click === "function") {
      signInButton.click();
      return;
    }
    if (window.location.pathname !== "/" && window.location.pathname !== "/index.html") {
      window.location.href = "/";
    }
  }

  function getTriggerTargets() {
    var targets = [];
    var headerCredits = document.querySelectorAll(".header-credits");
    for (var i = 0; i < headerCredits.length; i += 1) {
      targets.push(headerCredits[i]);
    }
    var headerCreditsButton = document.getElementById("header-credits-btn");
    if (headerCreditsButton) targets.push(headerCreditsButton);
    var buyCreditsButton = document.getElementById("btn-buy-credits");
    if (buyCreditsButton) targets.push(buyCreditsButton);

    return targets.filter(function (node, index, arr) {
      return node && arr.indexOf(node) === index;
    });
  }

  function makeTriggerAccessible(node) {
    if (!node) return;
    node.classList.add("yatrify-credits-trigger");
    node.setAttribute("aria-haspopup", "dialog");
    if (node.tagName !== "BUTTON" && node.tagName !== "A") {
      node.setAttribute("role", "button");
      if (!node.hasAttribute("tabindex")) node.tabIndex = 0;
    }
  }

  function isSignedIn() {
    return !!(window.Clerk && window.Clerk.user);
  }

  function fetchUserCredits() {
    var fallbackCredits = getHeaderCreditFallback();
    if (!window.YatrifyApiClient || typeof window.YatrifyApiClient.ensureClerkLoaded !== "function") {
      return Promise.resolve({
        payload: { credits: fallbackCredits },
        totalCredits: fallbackCredits
      });
    }

    return window.YatrifyApiClient.ensureClerkLoaded(false).catch(function () {
      return null;
    }).then(function () {
      if (!isSignedIn()) {
        return { requiresAuth: true };
      }
      return window.YatrifyApiClient.authFetch("/api/users/me").then(function (response) {
        return response.json();
      }).then(function (payload) {
        var totalCredits = Number.isFinite(Number(payload && payload.credits))
          ? Math.max(0, Number(payload.credits))
          : fallbackCredits;
        return {
          payload: payload || {},
          totalCredits: totalCredits
        };
      });
    }).catch(function () {
      if (!isSignedIn()) {
        return { requiresAuth: true };
      }
      return {
        payload: { credits: fallbackCredits },
        totalCredits: fallbackCredits
      };
    });
  }

  function handleTrigger(event) {
    var keyboardEvent = event.type === "keydown";
    if (keyboardEvent && event.key !== "Enter" && event.key !== " ") return;
    if (keyboardEvent) event.preventDefault();

    event.preventDefault();
    if (typeof event.stopPropagation === "function") event.stopPropagation();
    if (typeof event.stopImmediatePropagation === "function") event.stopImmediatePropagation();

    fetchUserCredits().then(function (result) {
      if (result && result.requiresAuth) {
        openAuthFallback();
        return;
      }
      setModalValues(result && result.payload ? result.payload : null, result ? result.totalCredits : 0);
      openModal();
    });
  }

  function bindTriggers() {
    var targets = getTriggerTargets();
    for (var i = 0; i < targets.length; i += 1) {
      var node = targets[i];
      if (node.dataset.creditsTriggerBound === "1") continue;
      node.dataset.creditsTriggerBound = "1";
      makeTriggerAccessible(node);
      node.addEventListener("click", handleTrigger, true);
      node.addEventListener("keydown", handleTrigger, true);
    }
  }

  function init() {
    if (state.initialized) return;
    state.initialized = true;
    injectStyles();
    ensureModal();
    bindTriggers();
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init, { once: true });
  } else {
    init();
  }

  window.YatrifyCreditsModal = {
    open: function () {
      fetchUserCredits().then(function (result) {
        if (result && result.requiresAuth) {
          openAuthFallback();
          return;
        }
        setModalValues(result && result.payload ? result.payload : null, result ? result.totalCredits : 0);
        openModal();
      });
    }
  };
})();
