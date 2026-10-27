// Trading by TLUXE - sign-in. The password is sent once over HTTPS to /api/auth/login; the gateway answers with an
// HttpOnly cookie that this script cannot read. Nothing is stored in the browser by this page.
(function () {
  'use strict';
  var form = document.getElementById('lg-form');
  var email = document.getElementById('lg-email');
  var pw = document.getElementById('lg-password');
  var eye = document.getElementById('lg-eye');
  var err = document.getElementById('lg-error');
  var caps = document.getElementById('lg-caps');
  var btn = document.getElementById('lg-submit');
  var label = btn.querySelector('.lg__btn-text');
  var busy = false;

  function safeNext() {
    var n = new URLSearchParams(window.location.search).get('next') || '/';
    // Same-site path only. Whitespace / control characters are refused too: browsers drop tab and newline, so
    // "/<TAB>/evil.example" would otherwise become the off-site //evil.example.
    if (n.charAt(0) !== '/' || n.charAt(1) === '/' || n.indexOf('\\') >= 0 || n.indexOf('/login') === 0 || n.length > 500 || /[\u0000-\u0020\u007f]/.test(n)) n = '/';
    return n;
  }
  function show(msg) {
    err.textContent = msg;
    err.hidden = !msg;
  }
  function setBusy(on) {
    busy = on;
    btn.disabled = on;
    btn.setAttribute('aria-busy', on ? 'true' : 'false');
    label.textContent = on ? 'Signing in…' : 'Secure Sign In';
  }
  eye.addEventListener('click', function () {
    var visible = pw.type === 'password';
    pw.type = visible ? 'text' : 'password';
    eye.setAttribute('aria-pressed', visible ? 'true' : 'false');
    eye.setAttribute('aria-label', visible ? 'Hide password' : 'Show password');
    pw.focus();
  });
  pw.addEventListener('keyup', function (e) {
    caps.hidden = !(e.getModifierState && e.getModifierState('CapsLock'));
  });
  [email, pw].forEach(function (el) {
    el.addEventListener('input', function () {
      el.removeAttribute('aria-invalid');
      if (!err.hidden) show('');
    });
  });
  if (/[?&]expired=1/.test(window.location.search)) show('Your session ended. Please sign in again.');
  email.focus();

  form.addEventListener('submit', function (e) {
    e.preventDefault();
    if (busy) return;
    var em = email.value.trim();
    var p = pw.value;
    if (!em || em.indexOf('@') < 1) { email.setAttribute('aria-invalid', 'true'); show('Enter your e-mail address.'); email.focus(); return; }
    if (!p) { pw.setAttribute('aria-invalid', 'true'); show('Enter your password.'); pw.focus(); return; }
    setBusy(true);
    show('');
    fetch('/api/auth/login', { method: 'POST', credentials: 'same-origin', cache: 'no-store', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email: em, password: p }) })
      .then(function (res) {
        if (res.ok) {
          pw.value = '';
          window.location.replace(safeNext() + (window.location.hash || ''));
          return null;
        }
        return res.json().catch(function () { return null; }).then(function (b) {
          var code = b && b.error && b.error.code;
          var msg = b && b.error && b.error.message;
          if (res.status === 401) msg = 'E-mail or password is incorrect.';
          else if (res.status === 429) msg = msg || 'Too many attempts. Please wait and try again.';
          else if (code === 'AUTH_NOT_CONFIGURED') msg = 'Sign-in is not configured yet.';
          else msg = msg || 'Sign-in failed (HTTP ' + res.status + ').';
          pw.value = '';
          pw.setAttribute('aria-invalid', res.status === 401 ? 'true' : 'false');
          show(msg);
          setBusy(false);
          pw.focus();
        });
      })
      .catch(function () {
        show('The TLUXE server is not reachable. Check your connection and try again.');
        setBusy(false);
      });
  });
})();
