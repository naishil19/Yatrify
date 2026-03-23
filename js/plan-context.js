(function () {
  var service = window.YatrifyPlanService;
  var ACTIVE_PLAN_STORAGE_KEY = "yatrify.activePlanId";

  function getStoredPlanId() {
    try {
      return String(window.sessionStorage.getItem(ACTIVE_PLAN_STORAGE_KEY) || "").trim();
    } catch (_) {
      return "";
    }
  }

  function setStoredPlanId(planId) {
    var value = String(planId || "").trim();
    if (!value) return;
    try {
      window.sessionStorage.setItem(ACTIVE_PLAN_STORAGE_KEY, value);
    } catch (_) {}
  }

  function getPlanIdFromUrl() {
    try {
      var params = new URLSearchParams(window.location.search);
      var planId = String(params.get("planId") || "").trim();
      if (planId) setStoredPlanId(planId);
      return planId;
    } catch (_) {
      return "";
    }
  }

  function replacePlanId(planId) {
    if (!planId) return;
    setStoredPlanId(planId);
    try {
      var url = new URL(window.location.href);
      url.searchParams.set("planId", planId);
      window.history.replaceState({}, "", url.toString());
    } catch (_) {}
  }

  function buildPlanAwareUrl(path, planId, hash) {
    var target = String(path || "").trim() || "/";
    var pid = String(planId || getPlanIdFromUrl() || "").trim();
    var hashValue = String(hash || "").trim();
    var hashIndex = target.indexOf("#");
    if (hashIndex !== -1) target = target.slice(0, hashIndex);
    if (pid) {
      target += (target.indexOf("?") === -1 ? "?" : "&") + "planId=" + encodeURIComponent(pid);
    }
    if (hashValue) target += "#" + hashValue;
    return target;
  }

  function resolvePlanId() {
    var planId = getPlanIdFromUrl();
    if (planId) return Promise.resolve(planId);
    var storedPlanId = getStoredPlanId();
    if (storedPlanId) return Promise.resolve(storedPlanId);
    return service.listPlans().then(function (plans) {
      var list = Array.isArray(plans) ? plans : (plans && plans.plans ? plans.plans : []);
      if (!list.length) return "";
      var id = list[0].id;
      replacePlanId(id);
      return id;
    });
  }

  function loadPlan() {
    return resolvePlanId().then(function (planId) {
      if (!planId) return null;
      return service.getPlan(planId).then(function (payload) {
        return payload && payload.plan ? payload.plan : null;
      });
    });
  }

  window.YatrifyPlanContext = {
    getPlanIdFromUrl: getPlanIdFromUrl,
    resolvePlanId: resolvePlanId,
    loadPlan: loadPlan,
    buildPlanAwareUrl: buildPlanAwareUrl,
    replacePlanId: replacePlanId,
  };
})();
