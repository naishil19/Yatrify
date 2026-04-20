(function () {
  function getApiBaseUrl() {
    if (window.YatrifyApiClient && typeof window.YatrifyApiClient.getApiBase === "function") {
      return window.YatrifyApiClient.getApiBase();
    }
    var value = String(window.__YATRIFY_API_BASE_URL || window.YATRIFY_API_BASE_URL || "").replace(/\/+$/, "");
    if (/^https?:\/\/(localhost|127\.0\.0\.1|0\.0\.0\.0|\[::1\])(?::\d+)?$/i.test(value)) {
      return "";
    }
    return value;
  }

  function isNewsletterForm(form) {
    if (!form || form.dataset.newsletterBound === "true") return false;

    var emailInput = form.querySelector('input[type="email"]');
    var submitButton = form.querySelector('button[type="submit"], input[type="submit"]');
    if (!emailInput || !submitButton) return false;

    var buttonLabel = String(submitButton.textContent || submitButton.value || "").trim();
    if (!/subscribe/i.test(buttonLabel)) return false;

    if (!form.closest("footer")) return false;

    var heading = form.previousElementSibling;
    if (!heading || !/newsletter/i.test(String(heading.textContent || "").trim())) return false;

    return true;
  }

  function ensureFeedbackNode(form) {
    var feedback = form.nextElementSibling;
    if (feedback && feedback.dataset.newsletterFeedback === "true") {
      return feedback;
    }

    feedback = document.createElement("div");
    feedback.dataset.newsletterFeedback = "true";
    feedback.setAttribute("aria-live", "polite");
    feedback.style.display = "none";
    feedback.style.marginTop = "8px";
    feedback.style.marginLeft = "4px";
    feedback.style.fontSize = "12px";
    feedback.style.fontWeight = "500";
    feedback.style.lineHeight = "1.5";
    form.insertAdjacentElement("afterend", feedback);
    return feedback;
  }

  function setFeedback(feedback, type, message) {
    if (!feedback) return;

    if (!message) {
      feedback.textContent = "";
      feedback.style.display = "none";
      return;
    }

    feedback.textContent = message;
    feedback.style.display = "block";
    if (type === "success") {
      feedback.style.color = "#15803d";
    } else {
      feedback.style.color = "#be123c";
    }
  }

  async function submitNewsletterEmail(email) {
    var response = await fetch(getApiBaseUrl() + "/api/newsletter/subscribe", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        email: email,
        source: "footer_newsletter",
        pageUrl: window.location.href,
      }),
    });

    var result = await response.json().catch(function () {
      return {};
    });

    if (!response.ok) {
      throw new Error(result && result.error ? result.error : "Unable to subscribe right now.");
    }

    return result;
  }

  function bindNewsletterForm(form) {
    var emailInput = form.querySelector('input[type="email"]');
    var submitButton = form.querySelector('button[type="submit"], input[type="submit"]');
    var feedback = ensureFeedbackNode(form);
    var originalLabel = String(submitButton.textContent || submitButton.value || "Subscribe").trim() || "Subscribe";

    form.dataset.newsletterBound = "true";

    emailInput.addEventListener("input", function () {
      setFeedback(feedback, "", "");
    });

    form.addEventListener("submit", async function (event) {
      event.preventDefault();

      if (typeof emailInput.reportValidity === "function" && !emailInput.reportValidity()) {
        return;
      }

      var email = String(emailInput.value || "").trim();
      if (!email) {
        setFeedback(feedback, "error", "Please enter your email address.");
        return;
      }

      emailInput.disabled = true;
      submitButton.disabled = true;
      if ("textContent" in submitButton) {
        submitButton.textContent = "Subscribing...";
      } else {
        submitButton.value = "Subscribing...";
      }
      setFeedback(feedback, "", "");

      try {
        await submitNewsletterEmail(email);
        form.reset();
        setFeedback(feedback, "success", "Thanks for subscribing to the newsletter.");
      } catch (error) {
        setFeedback(
          feedback,
          "error",
          error && error.message ? error.message : "Unable to subscribe right now."
        );
      } finally {
        emailInput.disabled = false;
        submitButton.disabled = false;
        if ("textContent" in submitButton) {
          submitButton.textContent = originalLabel;
        } else {
          submitButton.value = originalLabel;
        }
      }
    });
  }

  function initNewsletterForms() {
    Array.prototype.forEach.call(document.querySelectorAll("form"), function (form) {
      if (isNewsletterForm(form)) {
        bindNewsletterForm(form);
      }
    });
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", initNewsletterForms, { once: true });
  } else {
    initNewsletterForms();
  }
})();
