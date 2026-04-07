function applySavedTheme() {
  try {
    var savedTheme = localStorage.getItem('theme') || 'light';
    var html = document.documentElement;
    if (savedTheme === 'dark') {
      html.classList.add('dark');
      html.style.colorScheme = 'dark';
    } else {
      html.classList.remove('dark');
      html.style.colorScheme = 'light';
    }
  } catch (e) {
    // If storage is blocked, keep the default theme.
  }
}

applySavedTheme();

window.addEventListener('load', function () {
  function getAuthRedirectTarget() {
    var fromGlobal = String(window.__YATRIFY_AUTH_REDIRECT_URL || "").trim();
    if (fromGlobal) return fromGlobal;
    try {
      var params = new URLSearchParams(window.location.search || "");
      var fromQuery =
        String(
          params.get("redirect_url") ||
          params.get("redirect") ||
          params.get("returnTo") ||
          params.get("return_to") ||
          ""
        ).trim();
      if (fromQuery) return fromQuery;
    } catch (_) {}
    return "";
  }

  var authRedirectTarget = getAuthRedirectTarget();
  var defaultPostAuthUrl = "/plans-newplan.html";

  function getPostAuthUrl() {
    return authRedirectTarget || defaultPostAuthUrl;
  }

  function appendAuthRedirect(path) {
    var targetPath = String(path || "").trim();
    if (!targetPath) return targetPath;
    if (!authRedirectTarget) return targetPath;
    var separator = targetPath.indexOf("?") === -1 ? "?" : "&";
    return targetPath + separator + "redirect_url=" + encodeURIComponent(authRedirectTarget);
  }

  function applyRedirectToAuthLinks() {
    var signInLink = document.getElementById("signin-link");
    var signUpLink = document.getElementById("signup-link");
    if (signInLink) signInLink.setAttribute("href", appendAuthRedirect("/sign-in.html"));
    if (signUpLink) signUpLink.setAttribute("href", appendAuthRedirect("/sign-up.html"));
  }


  function ensureHeaderStyles() {
    if (document.getElementById('global-header-auth-styles')) return;
    var style = document.createElement('style');
    style.id = 'global-header-auth-styles';
    style.textContent = [
      'header nav .auth-actions{display:flex;align-items:center;gap:18px;transition:opacity .2s ease}',
      'header nav .auth-actions.is-loading{opacity:0;pointer-events:none}',
      'html.auth-loading header nav .auth-actions, html.auth-loading header nav .flex.items-center.gap-3, html.auth-loading header nav .flex.items-center.gap-5{opacity:0;pointer-events:none}',
      '.theme-toggle{display:inline-flex;align-items:center;justify-content:center;width:34px;height:34px;flex:0 0 34px;padding:0;border:0;background:transparent;color:inherit;cursor:pointer;position:relative;transition:color .2s ease,opacity .2s ease}',
      '.theme-toggle:hover{opacity:.9}',
      'html.dark .theme-toggle{color:#e5e7eb}',
      'html.dark .theme-toggle:hover{color:#fff}',
      '.theme-toggle svg{position:absolute;top:50%;left:50%;width:24px;height:24px;display:block;transform:translate(-50%,-50%);transform-origin:center;transition:transform .2s ease,opacity .2s ease}',
      '.theme-toggle:hover svg{transform:translate(-50%,-50%) rotate(12deg)}','html:not(.dark) .theme-toggle #moon-icon{opacity:0;pointer-events:none}','html.dark .theme-toggle #sun-icon{opacity:0;pointer-events:none}','html.dark .theme-toggle #moon-icon{opacity:1}' ,
      '#profile-menu{position:absolute;right:0;top:50px;min-width:240px;background:#fff;border:1px solid #e5e7eb;border-radius:12px;box-shadow:0 10px 25px rgba(0,0,0,.15);padding:12px;z-index:10001}',
      '#profile-menu .menu-btn{width:100%;text-align:left;border:0;background:transparent;padding:10px 12px;cursor:pointer;font-size:14px;font-weight:500;border-radius:8px;transition:all .2s ease}',
      '#profile-menu .menu-btn:hover{background:#f3f4f6}',
      '#profile-menu .menu-signout{color:#dc2626}',
      'html.dark #profile-menu{background:#0f172a;border-color:#1f2937;color:#e5e7eb}',
      'html.dark #profile-menu .menu-btn:hover{background:#1f2937}',
      '#dashboard-link{font-size:14px;font-weight:500;color:#111827!important;text-decoration:none!important;transition:color .2s ease;text-underline-offset:4px;padding:0!important;border-radius:0!important;background:transparent!important}',
      '#dashboard-link:hover{color:#111827!important;background:transparent!important;text-decoration:underline!important}',
      'html.dark #dashboard-link{color:#e5e7eb!important}',
      'html.dark #dashboard-link:hover{color:#ffffff!important}',
      '#signin-link{display:inline-flex;align-items:center;justify-content:center;font-size:15px;font-weight:500;color:#111827!important;text-decoration:none!important;text-underline-offset:4px;padding:0!important;border:0!important;background:transparent!important;border-radius:0!important;white-space:nowrap}',
      '#signin-link:hover{color:#111827!important;background:transparent!important;text-decoration:underline!important}',
      'html.dark #signin-link{color:#e5e7eb!important}',
      'html.dark #signin-link:hover{color:#ffffff!important}',
      '#user-profile{display:inline-flex;align-items:center}',
      '#profile-btn{width:34px;height:34px;border-radius:999px;overflow:hidden;display:flex;align-items:center;justify-content:center}',
      '#user-avatar{width:34px;height:34px;border-radius:999px;object-fit:cover}'
    ].join('');
    document.head.appendChild(style);
  }

  function getHeaderActionsContainer() {
    var container = document.querySelector('header nav .flex.items-center.gap-3');
    if (container) return container;
    var nav = document.querySelector('header nav');
    if (!nav) return null;
    var flexes = nav.querySelectorAll('div.flex');
    return flexes.length ? flexes[flexes.length - 1] : null;
  }

  function ensureThemeToggle(container) {
    if (!container || document.getElementById('theme-toggle-btn')) return;
    var btn = document.createElement('button');
    btn.id = 'theme-toggle-btn';
    btn.className = 'theme-toggle';
    btn.title = 'Toggle theme';
    btn.innerHTML = '<svg id="sun-icon" class="dark:hidden lucide lucide-sun-icon lucide-sun" xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="4"/><path d="M12 2v2"/><path d="M12 20v2"/><path d="m4.93 4.93 1.41 1.41"/><path d="m17.66 17.66 1.41 1.41"/><path d="M2 12h2"/><path d="M20 12h2"/><path d="m6.34 17.66-1.41 1.41"/><path d="m19.07 4.93-1.41 1.41"/></svg><svg id="moon-icon" class="hidden dark:block lucide lucide-moon-icon lucide-moon" xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M20.985 12.486a9 9 0 1 1-9.473-9.472c.405-.022.617.46.402.803a6 6 0 0 0 8.268 8.268c.344-.215.825-.004.803.401"/></svg>';
    container.appendChild(btn);
    btn.addEventListener('click', function () {
      var html = document.documentElement;
      var isDark = html.classList.contains('dark');
      var newTheme = isDark ? 'light' : 'dark';
      html.classList.toggle('dark');
      html.style.colorScheme = newTheme;
      localStorage.setItem('theme', newTheme);
    });
  }

  function orderHeaderActions() {
    var container = getHeaderActionsContainer();
    if (!container) return;
    if (!container.classList.contains('auth-actions')) {
      container.classList.add('auth-actions', 'is-loading');
    }
    var dashboardLink = document.getElementById('dashboard-link');
    var themeBtn = document.getElementById('theme-toggle-btn');
    var profile = document.getElementById('user-profile');
    var signInLink = document.getElementById('signin-link');
    if (dashboardLink) container.appendChild(dashboardLink);
    if (themeBtn) container.appendChild(themeBtn);
    if (profile) container.appendChild(profile);
    if (signInLink) container.appendChild(signInLink);
  }

  function ensureProfileMenu(profile) {
    if (!profile || document.getElementById('profile-menu')) return;
    var menu = document.createElement('div');
    menu.id = 'profile-menu';
    menu.style.display = 'none';
    menu.innerHTML = [
      '<div style="padding:12px 14px;border-bottom:1px solid #f3f4f6;margin-bottom:8px;">',
      '<div id="profile-name" style="font-weight:700;font-size:15px;letter-spacing:-0.3px;"></div>',
      '<div id="profile-email" style="font-size:12px;color:#6b7280;word-break:break-all;margin-top:4px;"></div>',
      '</div>',
      '<button id="manage-account" class="menu-btn">&#9881;&#65039; Manage account</button>',
      '<button id="signout-btn" class="menu-btn menu-signout">&#128682; Sign out</button>'
    ].join('');
    profile.appendChild(menu);
  }

  function wireProfileMenu() {
    var profile = document.getElementById('user-profile');
    var profileBtn = document.getElementById('profile-btn');
    var profileMenu = document.getElementById('profile-menu');
    if (!profile || !profileBtn || !profileMenu) return;
    if (profileBtn.dataset.bound === 'true') return;
    profileBtn.dataset.bound = 'true';
    profileBtn.addEventListener('click', function (e) {
      e.preventDefault();
      e.stopPropagation();
      profileMenu.style.display = profileMenu.style.display === 'block' ? 'none' : 'block';
    });
    profileMenu.addEventListener('click', function (e) {
      e.stopPropagation();
    });
    document.addEventListener('click', function () {
      profileMenu.style.display = 'none';
    });
  }

  function updateHeaderAuth() {
    var dashboardLink = document.getElementById('dashboard-link');
    var signInLink = document.getElementById('signin-link');
    var profile = document.getElementById('user-profile');
    var avatar = document.getElementById('user-avatar');
    var nameEl = document.getElementById('profile-name');
    var emailEl = document.getElementById('profile-email');
    var container = getHeaderActionsContainer();

    if (!window.Clerk || !window.Clerk.user) {
      applyRedirectToAuthLinks();
      if (dashboardLink) dashboardLink.style.display = 'none';
      if (profile) profile.style.display = 'none';
      if (signInLink) signInLink.style.display = 'inline-flex';
      if (container) container.classList.remove('is-loading');
      document.documentElement.classList.remove('auth-loading');
      return;
    }

    if (dashboardLink) dashboardLink.style.display = 'inline-block';
    if (profile) profile.style.display = 'inline-flex';
    if (signInLink) signInLink.style.display = 'none';
    if (avatar) avatar.src = window.Clerk.user.imageUrl || '';
    if (nameEl) {
      var name = [window.Clerk.user.firstName, window.Clerk.user.lastName].filter(Boolean).join(' ');
      nameEl.textContent = name || 'Account';
    }
    if (emailEl) {
      emailEl.textContent = window.Clerk.user.primaryEmailAddress ? window.Clerk.user.primaryEmailAddress.emailAddress : '';
    }
    if (container) container.classList.remove('is-loading');
    document.documentElement.classList.remove('auth-loading');
  }

  function bindMenuActions() {
    var manageBtn = document.getElementById('manage-account');
    var signOutBtn = document.getElementById('signout-btn');
    if (manageBtn && !manageBtn.dataset.bound) {
      manageBtn.dataset.bound = 'true';
      manageBtn.addEventListener('click', function () {
        if (window.Clerk) window.Clerk.openUserProfile();
      });
    }
    if (signOutBtn && !signOutBtn.dataset.bound) {
      signOutBtn.dataset.bound = 'true';
      signOutBtn.addEventListener('click', function () {
        if (window.Clerk) window.Clerk.signOut({ redirectUrl: window.location.href });
      });
    }
  }

  function ensureGlobalAuthModal() {
    if (document.getElementById('signin-modal')) return null;

    var existing = document.getElementById('global-auth-modal');
    if (existing) return existing.__api || null;

    var modal = document.createElement('div');
    modal.id = 'global-auth-modal';
    modal.style.cssText = 'position:fixed;inset:0;display:none;align-items:center;justify-content:center;background:rgba(17,24,39,.62);z-index:9999;padding:20px;opacity:0;transition:opacity .25s ease;overflow-y:auto;font-family:inherit;';
    modal.innerHTML = [
      '<div style="max-width:500px;width:100%;background:#fff;border:1px solid #e5e7eb;border-radius:12px;box-shadow:0 20px 60px rgba(0,0,0,.28);padding:26px 34px 22px;position:relative;">',
      '<button id="global-auth-close" style="position:absolute;top:14px;right:16px;border:0;background:none;color:#6b7280;cursor:pointer;font-size:38px;line-height:1;" title="Close">&times;</button>',
      '<img src="/images/image.png" alt="Yatrify logo" style="width:94px;margin-bottom:12px;" class="dark:hidden" />',
      '<img src="/images/image_2.png" alt="Yatrify logo" style="width:94px;margin-bottom:12px;" class="hidden dark:block" />',
      '<h2 id="global-auth-title" style="font-size:35px;line-height:1.02;font-weight:700;color:#0f172a;margin:0 0 6px;letter-spacing:-0.02em;">Sign in</h2>',
      '<p id="global-auth-subtitle" style="font-size:15px;color:#64748b;margin:0 0 16px;letter-spacing:-0.01em;">to continue to Yatrify</p>',
      '<div id="global-clerk-signin"></div>',
      '<div id="global-clerk-signup" style="display:none;"></div>',
      '<p style="margin:16px 0 2px;text-align:center;font-size:14px;color:#64748b;">',
      '<span id="global-auth-toggle-text">No account?</span>',
      '<a id="global-auth-toggle-link" href="#" style="margin-left:6px;color:#0b1638;text-decoration:underline;font-weight:600;">Sign up</a>',
      '</p>',
      '</div>'
    ].join('');
    document.body.appendChild(modal);

    if (!document.getElementById('global-auth-modal-styles')) {
      var style = document.createElement('style');
      style.id = 'global-auth-modal-styles';
      style.textContent = [
        '#global-auth-modal,#global-auth-modal *{font-family:inherit!important}',
        '#global-auth-modal .cl-root,#global-auth-modal .cl-main,#global-auth-modal .cl-signIn-root,#global-auth-modal .cl-signUp-root{margin:0!important;padding:0!important;width:100%!important;max-width:100%!important;font-family:inherit!important}',
        '#global-auth-modal .cl-card,#global-auth-modal .cl-cardBox{border:0!important;box-shadow:none!important;background:transparent!important;margin:0!important;padding:0!important;width:100%!important;max-width:100%!important}',
        '#global-auth-modal .cl-header,#global-auth-modal .cl-footer{display:none!important}',
        '#global-auth-modal .cl-formButtonPrimary{background:#0b1638!important;border-radius:10px!important;font-weight:700!important;min-height:46px!important;letter-spacing:.03em!important;text-transform:none!important}',
        '#global-auth-modal .cl-socialButtonsBlockButton,#global-auth-modal .cl-formFieldInput{border-radius:8px!important;border-color:#cbd5e1!important;min-height:50px!important;font-family:inherit!important}',
        '#global-auth-modal .cl-socialButtonsBlockButton{position:relative!important;overflow:visible!important}',
        '#global-auth-modal [class*="socialButtonsBlock"]{overflow:visible!important}',
        '#global-auth-modal [class*="socialButtonsBlockButton"]{overflow:visible!important;position:relative!important}',
        '#global-auth-modal [class*="badge"]{display:none!important}',
        '#global-auth-modal .cl-formFieldLabel,#global-auth-modal .cl-footerAction,#global-auth-modal .cl-formFieldHintText,#global-auth-modal .cl-identityPreviewText,#global-auth-modal .cl-dividerText{font-family:inherit!important}',
        '#global-auth-modal .cl-dividerLine{background:#cbd5e1!important}',
        '.dark #global-auth-modal > div{background:#0b1220!important;border-color:#334155!important;box-shadow:0 20px 60px rgba(2,6,23,.65)!important}',
        '.dark #global-auth-modal #global-auth-close{color:#94a3b8!important}',
        '.dark #global-auth-modal #global-auth-title{color:#f8fafc!important}',
        '.dark #global-auth-modal #global-auth-subtitle,.dark #global-auth-modal #global-auth-toggle-text{color:#94a3b8!important}',
        '.dark #global-auth-modal #global-auth-toggle-link{color:#dbeafe!important}',
        '.dark #global-auth-modal .cl-socialButtonsBlockButton,.dark #global-auth-modal .cl-formFieldInput{background:#0f172a!important;border-color:#334155!important;color:#e2e8f0!important}',
        '.dark #global-auth-modal .cl-dividerLine{background:#334155!important}',
        '.dark #global-auth-modal .cl-formButtonPrimary{background:linear-gradient(135deg,#2563eb,#1d4ed8)!important;color:#fff!important;border:1px solid #3b82f6!important;box-shadow:0 8px 22px rgba(37,99,235,.4)!important}',
        '.dark #global-auth-modal .cl-formButtonPrimary:hover{background:linear-gradient(135deg,#3b82f6,#2563eb)!important}'
      ].join('');
      document.head.appendChild(style);
    }

    var closeBtn = document.getElementById('global-auth-close');
    var titleEl = document.getElementById('global-auth-title');
    var subtitleEl = document.getElementById('global-auth-subtitle');
    var toggleTextEl = document.getElementById('global-auth-toggle-text');
    var toggleLink = document.getElementById('global-auth-toggle-link');
    var signInNode = document.getElementById('global-clerk-signin');
    var signUpNode = document.getElementById('global-clerk-signup');
    var mode = 'sign-in';
    var signInMounted = false;
    var signUpMounted = false;

    function render(nextMode) {
      mode = nextMode === 'sign-up' ? 'sign-up' : 'sign-in';
      if (titleEl) titleEl.textContent = mode === 'sign-up' ? 'Create your account' : 'Sign in';
      if (subtitleEl) subtitleEl.textContent = 'to continue to Yatrify';
      if (toggleTextEl) toggleTextEl.textContent = mode === 'sign-up' ? 'Already have an account?' : 'No account?';
      if (toggleLink) toggleLink.textContent = mode === 'sign-up' ? 'Sign in' : 'Sign up';
      if (signInNode) signInNode.style.display = mode === 'sign-in' ? 'block' : 'none';
      if (signUpNode) signUpNode.style.display = mode === 'sign-up' ? 'block' : 'none';
    }

    function open(nextMode) {
      render(nextMode);
      modal.style.display = 'flex';
      requestAnimationFrame(function () { modal.style.opacity = '1'; });
      document.body.style.overflow = 'hidden';
      if (window.Clerk && !signInMounted && signInNode) {
        window.Clerk.mountSignIn(signInNode, {
          signUpUrl: appendAuthRedirect('/sign-up.html'),
          afterSignInUrl: getPostAuthUrl()
        });
        signInMounted = true;
      }
      if (window.Clerk && !signUpMounted && signUpNode) {
        window.Clerk.mountSignUp(signUpNode, {
          signInUrl: appendAuthRedirect('/sign-in.html'),
          afterSignInUrl: getPostAuthUrl(),
          afterSignUpUrl: getPostAuthUrl()
        });
        signUpMounted = true;
      }
    }

    function close() {
      modal.style.opacity = '0';
      setTimeout(function () { modal.style.display = 'none'; }, 200);
      document.body.style.overflow = '';
    }

    if (closeBtn) closeBtn.addEventListener('click', close);
    modal.addEventListener('click', function (e) {
      if (e.target === modal) close();
    });
    if (toggleLink) {
      toggleLink.addEventListener('click', function (e) {
        e.preventDefault();
        open(mode === 'sign-up' ? 'sign-in' : 'sign-up');
      });
    }

    var api = { open: open, close: close };
    modal.__api = api;
    return api;
  }

  function bindAuthLinkModals(authApi) {
    if (!authApi) return;
    if (document.getElementById('signin-modal')) return;

    var signInLink = document.getElementById('signin-link');
    var signUpLink = document.getElementById('signup-link');

    if (signInLink && signInLink.dataset.authBound !== 'true') {
      signInLink.dataset.authBound = 'true';
      signInLink.addEventListener('click', function (e) {
        e.preventDefault();
        authApi.open('sign-in');
      });
    }
    if (signUpLink && signUpLink.dataset.authBound !== 'true') {
      signUpLink.dataset.authBound = 'true';
      signUpLink.addEventListener('click', function (e) {
        e.preventDefault();
        authApi.open('sign-up');
      });
    }
  }

  var clerkInitStarted = false;

  function initClerk() {
    if (!window.Clerk) return false;
    if (clerkInitStarted) return true;
    clerkInitStarted = true;
    window.Clerk.load().then(function () {
      var authApi = ensureGlobalAuthModal();
      var signInNode = document.getElementById('clerk-sign-in');
      if (signInNode) {
        window.Clerk.mountSignIn(signInNode, {
          signUpUrl: appendAuthRedirect('/sign-up.html'),
          afterSignInUrl: getPostAuthUrl()
        });
      }

      var signUpNode = document.getElementById('clerk-sign-up');
      if (signUpNode) {
        window.Clerk.mountSignUp(signUpNode, {
          signInUrl: appendAuthRedirect('/sign-in.html'),
          afterSignInUrl: getPostAuthUrl(),
          afterSignUpUrl: getPostAuthUrl()
        });
      }

      ensureHeaderStyles();
      applyRedirectToAuthLinks();
      var headerActions = getHeaderActionsContainer();
      ensureThemeToggle(headerActions);
      ensureProfileMenu(document.getElementById('user-profile'));
      wireProfileMenu();
      bindMenuActions();
      orderHeaderActions();
      bindAuthLinkModals(authApi);
      updateHeaderAuth();
      window.Clerk.addListener(function () {
        updateHeaderAuth();
        bindMenuActions();
        orderHeaderActions();
        bindAuthLinkModals(authApi);
      });
    }).catch(function () {
      clerkInitStarted = false;
      if (typeof window.__loadYatrifyClerk === 'function') {
        window.__loadYatrifyClerk(true).finally(function () {
          waitForClerk(80);
        });
      }
    });
    return true;
  }

  function waitForClerk(retries) {
    if (initClerk()) return;
    if (retries <= 0) return;
    setTimeout(function () { waitForClerk(retries - 1); }, 50);
  }

  function bootstrapClerk() {
    if (window.Clerk) {
      waitForClerk(180);
      return;
    }
    if (typeof window.__loadYatrifyClerk === 'function') {
      window.__loadYatrifyClerk(true).finally(function () {
        waitForClerk(180);
      });
      return;
    }
    waitForClerk(180);
  }

  bootstrapClerk();
});





