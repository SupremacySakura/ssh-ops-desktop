/* ============================================================
   OpsPilot · Theme 控制
   - 默认跟随系统（prefers-color-scheme）
   - 手动选择持久化到 localStorage（'opspilot.theme': light | dark | system）
   - 顶栏按钮：浅色 ⇄ 深色 快速切换
   - 设置页分段控件：跟随系统 / 浅色 / 深色
   - 设置页开关：减少透明度（data-reduce-transparency）
   在 <head> 中同步加载，避免主题闪烁（FOUC）。
   ============================================================ */
(function () {
  'use strict';

  var STORAGE_KEY = 'opspilot.theme';
  var root = document.documentElement;
  var mq = window.matchMedia('(prefers-color-scheme: dark)');

  function readSaved() {
    try {
      var v = localStorage.getItem(STORAGE_KEY);
      return v === 'light' || v === 'dark' ? v : null;
    } catch (e) { return null; }
  }

  function systemTheme() { return mq.matches ? 'dark' : 'light'; }

  /* 当前生效主题：显式选择优先，否则跟随系统 */
  function resolve() { return readSaved() || systemTheme(); }

  /* 用户选择的模式：'system' 表示跟随系统 */
  function savedMode() {
    try {
      var v = localStorage.getItem(STORAGE_KEY);
      return v === 'light' || v === 'dark' ? v : 'system';
    } catch (e) { return 'system'; }
  }

  function syncUI(theme) {
    // 顶栏切换按钮
    var btn = document.querySelector('.theme-toggle');
    if (btn) {
      var dark = theme === 'dark';
      btn.setAttribute('aria-pressed', String(dark));
      btn.setAttribute('aria-label', dark ? '切换到浅色模式' : '切换到深色模式');
      btn.setAttribute('title', dark ? '切换到浅色模式' : '切换到深色模式');
    }
    // 设置页分段控件
    var mode = savedMode();
    document.querySelectorAll('[data-theme-option]').forEach(function (el) {
      var active = el.getAttribute('data-theme-option') === mode;
      el.classList.toggle('active', active);
      el.setAttribute('aria-checked', String(active));
    });
  }

  function apply(theme) {
    root.dataset.theme = theme;
    try { root.style.colorScheme = theme; } catch (e) { /* noop */ }
    syncUI(theme);
  }

  /* 应用初始主题（head 内同步执行，防闪烁） */
  apply(resolve());

  /* ---------- 顶栏切换按钮 ---------- */
  function initToggle() {
    var btn = document.querySelector('.theme-toggle');
    if (!btn) return;
    btn.addEventListener('click', function () {
      var next = resolve() === 'dark' ? 'light' : 'dark';
      try { localStorage.setItem(STORAGE_KEY, next); } catch (e) { /* noop */ }
      apply(next);
    });
  }

  /* ---------- 设置页分段控件 ---------- */
  function initSegment() {
    document.querySelectorAll('[data-theme-option]').forEach(function (el) {
      el.addEventListener('click', function () {
        var mode = el.getAttribute('data-theme-option');
        try {
          if (mode === 'system') localStorage.removeItem(STORAGE_KEY);
          else localStorage.setItem(STORAGE_KEY, mode);
        } catch (e) { /* noop */ }
        apply(resolve());
      });
    });
  }

  /* ---------- 设置页开关（role="switch"） ---------- */
  function initToggles() {
    document.querySelectorAll('.toggle').forEach(function (el) {
      el.setAttribute('role', 'switch');
      el.setAttribute('tabindex', '0');
      var on = el.classList.contains('active');
      el.setAttribute('aria-checked', String(on));

      el.addEventListener('click', function () {
        on = !el.classList.contains('active');
        el.classList.toggle('active', on);
        el.setAttribute('aria-checked', String(on));

        var action = el.getAttribute('data-action');
        if (action === 'reduce-transparency') {
          root.dataset.reduceTransparency = String(on);
        }
      });

      el.addEventListener('keydown', function (e) {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          el.click();
        }
      });
    });

    // 恢复「减少透明度」开关的持久状态（会话内）
    if (root.dataset.reduceTransparency === 'true') {
      document.querySelectorAll('.toggle[data-action="reduce-transparency"]').forEach(function (el) {
        el.classList.add('active');
        el.setAttribute('aria-checked', 'true');
      });
    }
  }

  /* ---------- 系统主题变化时自动跟随（未手动选择时） ---------- */
  try {
    mq.addEventListener('change', function () {
      if (!readSaved()) apply(systemTheme());
    });
  } catch (e) {
    if (mq.addListener) mq.addListener(function () {
      if (!readSaved()) apply(systemTheme());
    });
  }

  function ready(fn) {
    if (document.readyState === 'loading') {
      document.addEventListener('DOMContentLoaded', fn);
    } else {
      fn();
    }
  }

  ready(function () {
    syncUI(resolve());
    initToggle();
    initSegment();
    initToggles();
  });
})();
