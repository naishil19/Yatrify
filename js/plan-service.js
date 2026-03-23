(function () {
  var api = window.YatrifyApiClient;

  function json(res) {
    return res.json();
  }

  function getUserMe() {
    return api.authFetch("/api/users/me").then(json);
  }

  function listPlans() {
    return api.authFetch("/api/plans").then(json);
  }

  function generatePlan(payload) {
    return api.authFetch("/api/plans/generate", {
      method: "POST",
      body: JSON.stringify(payload || {}),
    }).then(json);
  }

  function getPlan(planId, options) {
    var opts = options && typeof options === "object" ? options : {};
    var query = [];
    if (opts.inviteId) query.push("inviteId=" + encodeURIComponent(String(opts.inviteId)));
    var suffix = query.length ? "?" + query.join("&") : "";
    return api
      .authFetch("/api/plans/" + encodeURIComponent(planId) + suffix)
      .then(json)
      .then(function (payload) {
        if (typeof window !== "undefined" && typeof window.dispatchEvent === "function") {
          try {
            window.dispatchEvent(new CustomEvent("yatrify:plan-loaded", { detail: payload }));
          } catch (_) {}
        }
        return payload;
      });
  }

  function updatePlan(planId, payload) {
    return api.authFetch("/api/plans/" + encodeURIComponent(planId), {
      method: "PATCH",
      body: JSON.stringify(payload || {}),
    }).then(json);
  }

  function deletePlan(planId) {
    return api.authFetch("/api/plans/" + encodeURIComponent(planId), {
      method: "DELETE",
    }).then(json);
  }

  function refinePlan(planId, payload) {
    return api.authFetch("/api/plans/" + encodeURIComponent(planId) + "/refine", {
      method: "POST",
      body: JSON.stringify(payload || {}),
    }).then(json);
  }

  function updateItinerary(planId, payload) {
    return api.authFetch("/api/plans/" + encodeURIComponent(planId) + "/itinerary", {
      method: "PATCH",
      body: JSON.stringify(payload || {}),
    }).then(json);
  }

  function publishPlan(planId, payload) {
    return api.authFetch("/api/plans/" + encodeURIComponent(planId) + "/publish", {
      method: "POST",
      body: JSON.stringify(payload || {}),
    }).then(json);
  }

  function unpublishPlan(planId) {
    return api.authFetch("/api/plans/" + encodeURIComponent(planId) + "/unpublish", {
      method: "POST",
    }).then(json);
  }

  function listCollaborators(planId) {
    return api.authFetch("/api/plans/" + encodeURIComponent(planId) + "/collaborators").then(json);
  }

  function inviteCollaborator(planId, email) {
    return api.authFetch("/api/plans/" + encodeURIComponent(planId) + "/collaborators", {
      method: "POST",
      body: JSON.stringify({ email: email }),
    }).then(json);
  }

  function acceptInvite(planId, inviteId) {
    return api.authFetch("/api/plans/" + encodeURIComponent(planId) + "/collaborators/accept", {
      method: "POST",
      body: JSON.stringify(inviteId ? { inviteId: inviteId } : {}),
    }).then(json);
  }

  function revokeCollaborator(planId, collaboratorId, collaboratorEmail) {
    var path = "/api/plans/" + encodeURIComponent(planId) + "/collaborators/" + encodeURIComponent(collaboratorId || "");
    var email = String(collaboratorEmail || "").trim();
    if (email) {
      path += "?email=" + encodeURIComponent(email);
    }
    return api.authFetch(path, {
      method: "DELETE",
    }).then(json);
  }

  function listExpenses(planId) {
    return api.authFetch("/api/plans/" + encodeURIComponent(planId) + "/expenses").then(json);
  }

  function createExpense(planId, payload) {
    return api.authFetch("/api/plans/" + encodeURIComponent(planId) + "/expenses", {
      method: "POST",
      body: JSON.stringify(payload || {}),
    }).then(json);
  }

  function updateExpense(planId, expenseId, payload) {
    return api.authFetch("/api/plans/" + encodeURIComponent(planId) + "/expenses/" + encodeURIComponent(expenseId), {
      method: "PATCH",
      body: JSON.stringify(payload || {}),
    }).then(json);
  }

  function deleteExpense(planId, expenseId) {
    return api.authFetch("/api/plans/" + encodeURIComponent(planId) + "/expenses/" + encodeURIComponent(expenseId), {
      method: "DELETE",
    }).then(json);
  }

  function listCommunityPlans() {
    return api.apiFetch("/api/community/plans").then(json);
  }

  function getCommunityPlan(planId) {
    return api.apiFetch("/api/community/plans/" + encodeURIComponent(planId)).then(json);
  }

  window.YatrifyPlanService = {
    getUserMe: getUserMe,
    listPlans: listPlans,
    generatePlan: generatePlan,
    getPlan: getPlan,
    updatePlan: updatePlan,
    deletePlan: deletePlan,
    refinePlan: refinePlan,
    updateItinerary: updateItinerary,
    publishPlan: publishPlan,
    unpublishPlan: unpublishPlan,
    listCollaborators: listCollaborators,
    inviteCollaborator: inviteCollaborator,
    acceptInvite: acceptInvite,
    revokeCollaborator: revokeCollaborator,
    listExpenses: listExpenses,
    createExpense: createExpense,
    updateExpense: updateExpense,
    deleteExpense: deleteExpense,
    listCommunityPlans: listCommunityPlans,
    getCommunityPlan: getCommunityPlan,
  };
})();

