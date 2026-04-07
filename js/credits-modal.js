(function () {
  var FREE_CREDIT_CAP = 2;
  var MODAL_ID = "yatrify-credits-modal";
  var STYLE_ID = "yatrify-credits-modal-styles";
  var CHECKOUT_SCRIPT_ID = "yatrify-razorpay-checkout";
  var CHECKOUT_SCRIPT_SRC = "https://checkout.razorpay.com/v1/checkout.js";
  var DEFAULT_PURCHASE_LABEL = "Purchase Credits";
  var state = {
    modal: null,
    closeButton: null,
    freeValue: null,
    boughtValue: null,
    purchaseButton: null,
    statusNode: null,
    bodyOverflow: "",
    initialized: false,
    currentPayload: null,
    currentTotalCredits: 0,
    checkoutScriptPromise: null
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

  function injectStyles() {
    if (document.getElementById(STYLE_ID)) return;
    var style = document.createElement("style");
    style.id = STYLE_ID;
    style.textContent = [
      ".yatrify-credits-trigger{cursor:pointer;}",
      ".yatrify-credits-trigger:focus-visible{outline:2px solid #3b82f6;outline-offset:4px;border-radius:10px;}",
      ".yatrify-credits-backdrop{position:fixed;inset:0;z-index:1600;display:none;align-items:center;justify-content:center;padding:clamp(12px,2.4vw,22px);background:rgba(15,23,42,.22);backdrop-filter:blur(6px);}",
      ".yatrify-credits-backdrop.open{display:flex;}",
      
      ".yatrify-credits-dialog{position:relative;width:min(100%,630px);max-height:min(86vh,660px);overflow:visible;border:1px solid #d9e3ef;border-radius:16px;background:#ffffff;box-shadow:0 20px 50px rgba(15,23,42,.12);padding:30px;}",
      ".yatrify-credits-dialog *{box-sizing:border-box;}",
      
      ".yatrify-credits-toolbar{height:0;min-height:0;padding:0;margin:0;overflow:visible;}",
      
      ".yatrify-credits-close{position:absolute;top:10px;right:15px;width:24px;height:24px;border:1px solid #6b7280;border-radius:6px;background:#ffffff;color:#374151;display:inline-flex;align-items:center;justify-content:center;cursor:pointer;transition:background-color .2s ease,border-color .2s ease,color .2s ease;z-index:10;flex:0 0 24px;}",
      ".yatrify-credits-close svg{width:13px;height:13px;display:block;flex:0 0 13px;stroke-width:2.4;}",
      ".yatrify-credits-close:hover{background:#f8fafc;border-color:#374151;color:#111827;}",
      
      /* CHANGED: Added margin: 0 14px; to squeeze the top boxes inward */
      ".yatrify-credits-grid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:12px;margin:0 14px;}",
      
      ".yatrify-credits-card{border:1px solid #d7e2f0;border-radius:12px;background:#ffffff;padding:22px 8px 12px;text-align:center;min-height:161px;display:flex;flex-direction:column;align-items:center;justify-content:center;}",
      ".yatrify-credits-label{margin:0;font-size:17px;font-weight:500;line-height:1.3;color:#0f172a;letter-spacing:.01em;}",
      ".yatrify-credits-value{margin:14px 0 0;font-size:clamp(58px,8vw,76px);font-weight:700;line-height:.92;color:#020617;letter-spacing:-0.06em;}",
      ".yatrify-credits-purchase{margin-top:12px;border:1px solid #d7e2f0;border-radius:16px;background:#ffffff;padding:24px 22px 18px;box-shadow:0 6px 22px rgba(15,23,42,.04);}",
      ".yatrify-credits-head{display:flex;align-items:center;gap:10px;margin-bottom:10px;color:#3b82f6;}",
      ".yatrify-credits-head svg,.yatrify-credits-note svg{width:20px;height:20px;flex:0 0 20px;}",
      ".yatrify-credits-title{margin:0;font-size:17px;font-weight:600;color:#111827;letter-spacing:.01em;}",
      ".yatrify-credits-text,.yatrify-credits-note{margin:0;color:#5f708c;font-size:14px;line-height:1.4;font-weight:500;}",
      ".yatrify-credits-note{display:flex;align-items:flex-start;gap:10px;margin-top:12px;}",
      ".yatrify-credits-note span{padding-top:1px;}",
      ".yatrify-credits-cta{margin-top:22px;display:inline-flex;width:100%;align-items:center;justify-content:center;gap:10px;border:none;border-radius:8px;background:#4a82ea;color:#ffffff;padding:12px 16px;font-size:16px;font-weight:600;text-decoration:none;transition:background-color .2s ease,transform .2s ease;box-shadow:none;}",
      ".yatrify-credits-cta svg{width:20px;height:20px;display:block;flex:0 0 20px;}",
      ".yatrify-credits-cta span{display:inline-block;line-height:1.2;}",
      ".yatrify-credits-cta:hover{background:#3f74dc;transform:translateY(-1px);}",
      ".yatrify-credits-cta[disabled]{cursor:not-allowed;opacity:.72;transform:none;}",
      ".yatrify-credits-status{margin:10px 0 0;font-size:13px;line-height:1.45;color:#64748b;min-height:0;}",
      ".yatrify-credits-status.error{color:#dc2626;}",
      ".yatrify-credits-status.success{color:#15803d;}",
      ".yatrify-credits-provider{margin-top:8px;display:flex;align-items:center;justify-content:flex-end;gap:6px;font-size:12px;font-weight:500;color:#111827;}",
      ".yatrify-credits-provider svg{width:14px;height:14px;display:block;flex:0 0 14px;}",
      "html.dark .yatrify-credits-dialog,html.dark .yatrify-credits-card,html.dark .yatrify-credits-purchase{background:#0f172a;border-color:#334155;box-shadow:0 32px 76px rgba(2,6,23,.55);}",
      "html.dark .yatrify-credits-close{background:#0f172a;border-color:#94a3b8;color:#cbd5e1;}",
      "html.dark .yatrify-credits-close:hover{background:#1e293b;border-color:#e2e8f0;color:#f8fafc;}",
      "html.dark .yatrify-credits-label,html.dark .yatrify-credits-title,html.dark .yatrify-credits-value,html.dark .yatrify-credits-provider{color:#f8fafc;}",
      "html.dark .yatrify-credits-text,html.dark .yatrify-credits-note,html.dark .yatrify-credits-status{color:#94a3b8;}",
      "html.dark .yatrify-credits-status.error{color:#fca5a5;}",
      "html.dark .yatrify-credits-status.success{color:#86efac;}",
      
      /* CHANGED: Mobile layout margin updated to 0 8px to keep the inset look on small screens */
      "@media (max-width: 640px){.yatrify-credits-dialog{padding:20px;border-radius:14px;}.yatrify-credits-toolbar{height:0;min-height:0;padding:0;}.yatrify-credits-grid{grid-template-columns:1fr;gap:10px;margin:0 8px;}.yatrify-credits-card{padding:12px 4px 8px;min-height:auto;}.yatrify-credits-label{font-size:16px;}.yatrify-credits-value{font-size:56px;}.yatrify-credits-purchase{padding:18px 16px 14px;}.yatrify-credits-provider{justify-content:flex-start;}.yatrify-credits-cta{font-size:15px;padding:12px 14px;}}"
    ].join("");
    document.head.appendChild(style);
  }

  function createIcon(pathMarkup) {
    return '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' + pathMarkup + "</svg>";
  }

  function ensureModal() {
    if (state.modal && state.closeButton && state.freeValue && state.boughtValue && state.purchaseButton && state.statusNode) return;

    state.modal = document.getElementById(MODAL_ID);
    if (state.modal) {
      state.closeButton = document.getElementById("yatrify-credits-close");
      state.freeValue = document.getElementById("yatrify-credits-free-value");
      state.boughtValue = document.getElementById("yatrify-credits-bought-value");
      state.purchaseButton = document.getElementById("yatrify-credits-purchase-button");
      state.statusNode = document.getElementById("yatrify-credits-status");
    }

    if (!state.modal || !state.closeButton || !state.freeValue || !state.boughtValue || !state.purchaseButton || !state.statusNode) {
      var wrapper = document.createElement("div");
      wrapper.innerHTML = [
        '<div id="' + MODAL_ID + '" class="yatrify-credits-backdrop" aria-hidden="true">',
        '  <div class="yatrify-credits-dialog" role="dialog" aria-modal="true" aria-labelledby="yatrify-credits-title">',
        '    <h2 id="yatrify-credits-title" style="' + visuallyHiddenStyle() + '">Credits wallet</h2>',
        '    <div class="yatrify-credits-toolbar">',
        '      <button id="yatrify-credits-close" class="yatrify-credits-close" type="button" aria-label="Close credits dialog">',
               createIcon('<path d="M18 6 6 18"></path><path d="m6 6 12 12"></path>'),
        "      </button>",
        "    </div>",
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
        '      <button id="yatrify-credits-purchase-button" class="yatrify-credits-cta" type="button">',
                 createIcon('<rect width="14" height="8" x="5" y="11" rx="2"></rect><path d="M8 11V8a4 4 0 0 1 8 0v3"></path>'),
        '        <span>' + DEFAULT_PURCHASE_LABEL + "</span>",
        "      </button>",
        '      <p id="yatrify-credits-status" class="yatrify-credits-status" aria-live="polite"></p>',
        '      <div class="yatrify-credits-provider">' +
        '        <svg viewBox="0 0 18 20" fill="none" aria-hidden="true">' +
        '          <path d="M7.077 6.476l-.988 3.569 5.65-3.589-3.695 13.54 3.752.004 5.457-20L7.077 6.476z" fill="#3b82f6"></path>' +
        '          <path d="M1.455 14.308L0 20h7.202L10.149 8.42l-8.694 5.887z" fill="#072654"></path>' +
        "        </svg>" +
        "        <span>Secured by Razorpay</span>" +
        "      </div>",
        "    </section>",
        "  </div>",
        "</div>"
      ].join("");
      document.body.appendChild(wrapper.firstChild);
      state.modal = document.getElementById(MODAL_ID);
      state.closeButton = document.getElementById("yatrify-credits-close");
      state.freeValue = document.getElementById("yatrify-credits-free-value");
      state.boughtValue = document.getElementById("yatrify-credits-bought-value");
      state.purchaseButton = document.getElementById("yatrify-credits-purchase-button");
      state.statusNode = document.getElementById("yatrify-credits-status");
    }

    if (state.modal && state.modal.dataset.creditsModalBound !== "1") {
      state.modal.dataset.creditsModalBound = "1";
      state.closeButton.addEventListener("click", closeModal);
      if (state.purchaseButton) {
        state.purchaseButton.addEventListener("click", function (event) {
          event.preventDefault();
          startPurchaseFlow();
        });
      }
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

  function updateHeaderCreditCount(totalCredits) {
    var countNode = document.getElementById("credits-count");
    if (countNode) {
      countNode.textContent = formatCreditValue(totalCredits);
    }
  }

  function setPurchaseStatus(message, tone) {
    ensureModal();
    if (!state.statusNode) return;
    state.statusNode.textContent = String(message || "");
    state.statusNode.className = "yatrify-credits-status" + (tone ? " " + tone : "");
  }

  function setPurchaseButtonBusy(isBusy, label) {
    ensureModal();
    if (!state.purchaseButton) return;
    state.purchaseButton.disabled = !!isBusy;
    var labelNode = state.purchaseButton.querySelector("span");
    if (labelNode) {
      labelNode.textContent = label || DEFAULT_PURCHASE_LABEL;
    }
  }

  function setModalValues(payload, totalCredits) {
    ensureModal();
    var parts = splitCredits(totalCredits, payload);
    state.currentPayload = payload || {};
    state.currentTotalCredits = totalCredits;
    state.freeValue.textContent = formatCreditValue(parts.freeCredits);
    state.boughtValue.textContent = formatCreditValue(parts.boughtCredits);
    setPurchaseStatus("", "");
    setPurchaseButtonBusy(false, DEFAULT_PURCHASE_LABEL);
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

  function ensureRazorpayLoaded() {
    if (window.Razorpay) return Promise.resolve(window.Razorpay);
    if (state.checkoutScriptPromise) return state.checkoutScriptPromise;

    state.checkoutScriptPromise = new Promise(function (resolve, reject) {
      var existing = document.getElementById(CHECKOUT_SCRIPT_ID);
      if (existing) {
        existing.addEventListener("load", function () {
          if (window.Razorpay) resolve(window.Razorpay);
          else reject(new Error("Razorpay SDK did not initialize"));
        }, { once: true });
        existing.addEventListener("error", function () {
          reject(new Error("Unable to load Razorpay Checkout"));
        }, { once: true });
        return;
      }

      var script = document.createElement("script");
      script.id = CHECKOUT_SCRIPT_ID;
      script.src = CHECKOUT_SCRIPT_SRC;
      script.async = true;
      script.onload = function () {
        if (window.Razorpay) resolve(window.Razorpay);
        else reject(new Error("Razorpay SDK did not initialize"));
      };
      script.onerror = function () {
        reject(new Error("Unable to load Razorpay Checkout"));
      };
      document.head.appendChild(script);
    }).catch(function (error) {
      state.checkoutScriptPromise = null;
      throw error;
    });

    return state.checkoutScriptPromise;
  }

  function getApiErrorMessage(error, fallback) {
    var fallbackMessage = fallback || "Something went wrong.";
    if (error && error.response && typeof error.response.json === "function") {
      return error.response.json().then(function (payload) {
        return payload && payload.error ? String(payload.error) : fallbackMessage;
      }).catch(function () {
        return fallbackMessage;
      });
    }
    return Promise.resolve(error && error.message ? String(error.message) : fallbackMessage);
  }

  function createCreditsOrder() {
    if (!window.YatrifyApiClient || typeof window.YatrifyApiClient.authFetch !== "function") {
      return Promise.reject(new Error("API client not available"));
    }

    return window.YatrifyApiClient.authFetch("/api/payments/credits/order", {
      method: "POST",
      body: JSON.stringify({})
    }).then(function (response) {
      return response.json();
    });
  }

  function verifyCreditsPayment(paymentResult) {
    if (!window.YatrifyApiClient || typeof window.YatrifyApiClient.authFetch !== "function") {
      return Promise.reject(new Error("API client not available"));
    }

    return window.YatrifyApiClient.authFetch("/api/payments/credits/verify", {
      method: "POST",
      body: JSON.stringify(paymentResult || {})
    }).then(function (response) {
      return response.json();
    });
  }

  function refreshCreditsAfterPurchase(verified) {
    return fetchUserCredits().then(function (result) {
      if (!result || result.requiresAuth) {
        var verifiedCredits = verified && Number.isFinite(Number(verified.credits))
          ? Number(verified.credits)
          : state.currentTotalCredits;
        var payload = Object.assign({}, state.currentPayload || {}, {
          credits: verifiedCredits
        });
        updateHeaderCreditCount(verifiedCredits);
        setModalValues(payload, verifiedCredits);
        return;
      }

      updateHeaderCreditCount(result.totalCredits);
      setModalValues(result.payload, result.totalCredits);
    });
  }

  function startPurchaseFlow() {
    ensureModal();
    if (!isSignedIn()) {
      openAuthFallback();
      return;
    }

    var currentPayload = state.currentPayload || {};
    setPurchaseStatus("Preparing secure checkout...", "");
    setPurchaseButtonBusy(true, "Starting checkout...");

    Promise.all([ensureRazorpayLoaded(), createCreditsOrder()])
      .then(function (results) {
        var order = results[1] || {};
        if (!window.Razorpay || !order.orderId || !order.key) {
          throw new Error("Unable to initialize Razorpay Checkout");
        }

        setPurchaseButtonBusy(false, DEFAULT_PURCHASE_LABEL);
        setPurchaseStatus("", "");

        var customerName = String([order.firstName || "", order.lastName || ""].join(" ").trim());
        var checkout = new window.Razorpay({
          key: order.key,
          amount: String(order.amount || ""),
          currency: order.currency || "INR",
          name: order.name || "Yatrify",
          description: order.description || DEFAULT_PURCHASE_LABEL,
          order_id: order.orderId,
          handler: function (paymentResult) {
            setPurchaseButtonBusy(true, "Verifying payment...");
            setPurchaseStatus("Payment received. Verifying and adding credits...", "");

            verifyCreditsPayment(paymentResult).then(function (verified) {
              return refreshCreditsAfterPurchase(verified).then(function () {
                setPurchaseButtonBusy(false, DEFAULT_PURCHASE_LABEL);
                setPurchaseStatus(
                  verified && verified.duplicated
                    ? "Payment already confirmed. Credits are up to date."
                    : "Payment successful. Credits added to your wallet.",
                  "success"
                );
              });
            }).catch(function (error) {
              return getApiErrorMessage(
                error,
                "Payment completed, but verification failed. Please contact support if credits do not appear."
              ).then(function (message) {
                setPurchaseButtonBusy(false, DEFAULT_PURCHASE_LABEL);
                setPurchaseStatus(message, "error");
              });
            });
          },
          prefill: {
            name: customerName,
            email: currentPayload.email || order.email || ""
          },
          notes: {
            userId: currentPayload.id ? String(currentPayload.id) : ""
          },
          readonly: {
            email: !!(currentPayload.email || order.email)
          },
          theme: {
            color: "#3b82f6"
          },
          modal: {
            ondismiss: function () {
              setPurchaseButtonBusy(false, DEFAULT_PURCHASE_LABEL);
            }
          }
        });

        if (typeof checkout.on === "function") {
          checkout.on("payment.failed", function (response) {
            var description =
              response &&
              response.error &&
              response.error.description
                ? String(response.error.description)
                : "Payment was not completed. Please try again.";
            setPurchaseButtonBusy(false, DEFAULT_PURCHASE_LABEL);
            setPurchaseStatus(description, "error");
          });
        }

        checkout.open();
      })
      .catch(function (error) {
        return getApiErrorMessage(error, "Unable to start Razorpay Checkout right now.").then(function (message) {
          setPurchaseButtonBusy(false, DEFAULT_PURCHASE_LABEL);
          setPurchaseStatus(message, "error");
        });
      });
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
