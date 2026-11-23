(function () {
  'use strict';
  var form = document.getElementById('loginForm');
  var input = document.getElementById('password');
  var remember = document.getElementById('remember');
  var errorEl = document.getElementById('loginError');
  var button = document.getElementById('loginBtn');

  function showError(message) {
    errorEl.textContent = message;
    errorEl.hidden = false;
  }

  function resetButton() {
    button.disabled = false;
    button.textContent = '登录';
  }

  form.addEventListener('submit', function (event) {
    event.preventDefault();
    var password = input.value;
    if (!password) {
      showError('请输入密码');
      return;
    }
    errorEl.hidden = true;
    button.disabled = true;
    button.textContent = '正在登录…';
    fetch('/api/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ password: password, remember: remember.checked })
    }).then(function (response) {
      return response.json().catch(function () { return {}; }).then(function (data) {
        return { ok: response.ok, data: data };
      });
    }).then(function (result) {
      if (result.ok && result.data && result.data.ok) {
        location.replace('/');
        return;
      }
      showError((result.data && result.data.error) || '登录失败，请重试');
      resetButton();
      input.select();
    }).catch(function () {
      showError('无法连接服务器，请稍后重试');
      resetButton();
    });
  });
})();
