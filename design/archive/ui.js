/* ============================================================
   OpsPilot · UI 交互增强
   1) 自定义 Apple 风格下拉框：替换所有原生 <select class="select">
      - 毛玻璃浮层 + 弹出动画 + 键盘导航 + 溢出自动对齐
      - 保留原生 select 作为值容器（display:none）
   2) 侧边栏向左收起 / 展开
      - 状态持久化到 localStorage（'opspilot.sidebar'）
      - 收起后图标居中，悬停 title 提示
   ============================================================ */
(function () {
  'use strict';

  function ready(fn) {
    if (document.readyState === 'loading') {
      document.addEventListener('DOMContentLoaded', fn);
    } else {
      fn();
    }
  }

  /* ================= 1. Sidebar Collapse ================= */
  var SIDEBAR_KEY = 'opspilot.sidebar';
  var root = document.documentElement;

  function sidebarState() {
    try { return localStorage.getItem(SIDEBAR_KEY) === 'collapsed' ? 'collapsed' : 'expanded'; }
    catch { return 'expanded'; }
  }

  function applySidebar(state) {
    root.dataset.sidebar = state;
    var collapsed = state === 'collapsed';

    document.querySelectorAll('.sidebar-collapse-btn').forEach(function (btn) {
      btn.setAttribute('aria-label', collapsed ? '展开侧边栏' : '收起侧边栏');
      btn.setAttribute('title', collapsed ? '展开侧边栏' : '收起侧边栏');
    });

    document.querySelectorAll('.nav-item').forEach(function (item) {
      if (collapsed) {
        var label = item.querySelector('span:not(.nav-badge)');
        if (label) item.setAttribute('title', label.textContent.trim());
      } else {
        item.removeAttribute('title');
      }
    });
  }

  // 在 <head> 同步执行，避免页面闪烁
  applySidebar(sidebarState());

  function initSidebar() {
    applySidebar(sidebarState());
    document.querySelectorAll('.sidebar-collapse-btn').forEach(function (btn) {
      btn.addEventListener('click', function () {
        var next = root.dataset.sidebar === 'collapsed' ? 'expanded' : 'collapsed';
        try { localStorage.setItem(SIDEBAR_KEY, next); } catch { /* noop */ }
        applySidebar(next);
      });
    });
  }

  /* ================= 2. Custom Select ================= */

  var SELECT_CHEVRON =
    '<svg class="select-chevron" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="6 9 12 15 18 9"/></svg>';
  var SELECT_CHECK =
    '<svg class="select-check" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg>';

  function buildCustomSelect(native) {
    if (native.dataset.customSelect === '1') return;
    native.dataset.customSelect = '1';
    native.classList.add('select-native');

    var wrapper = document.createElement('div');
    wrapper.className = 'select-custom';
    wrapper.style.width = native.style.width || '100%';

    var trigger = document.createElement('button');
    trigger.type = 'button';
    trigger.className = 'select-trigger';
    trigger.setAttribute('aria-haspopup', 'listbox');
    trigger.setAttribute('aria-expanded', 'false');
    trigger.innerHTML = '<span class="select-value"></span>' + SELECT_CHEVRON;

    var menu = document.createElement('ul');
    menu.className = 'select-menu';
    menu.setAttribute('role', 'listbox');
    menu.setAttribute('aria-label', native.getAttribute('aria-label') || '');

    var options = Array.prototype.slice.call(native.options);
    var items = options.map(function (opt, i) {
      var li = document.createElement('li');
      li.className = 'select-option';
      li.setAttribute('role', 'option');
      li.setAttribute('data-index', String(i));
      li.setAttribute('aria-selected', i === native.selectedIndex ? 'true' : 'false');
      li.setAttribute('tabindex', '-1');
      if (opt.disabled) {
        li.classList.add('disabled');
        li.setAttribute('aria-disabled', 'true');
      }
      li.innerHTML = '<span></span>' + SELECT_CHECK;
      li.firstChild.textContent = opt.textContent;
      menu.appendChild(li);
      return li;
    });

    function updateSelected() {
      var idx = native.selectedIndex;
      items.forEach(function (li, i) {
        var sel = i === idx;
        li.classList.toggle('selected', sel);
        li.setAttribute('aria-selected', String(sel));
      });
      var opt = native.options[idx];
      trigger.querySelector('.select-value').textContent = opt ? opt.textContent : '';
    }

    function highlight(li, focus) {
      items.forEach(function (el) { el.classList.remove('highlighted'); });
      if (li) {
        li.classList.add('highlighted');
        if (focus) li.focus({ preventScroll: true });
        li.scrollIntoView({ block: 'nearest' });
      }
    }

    function openMenu() {
      // 同一时间只允许一个下拉打开
      document.querySelectorAll('.select-custom.open').forEach(function (w) {
        if (w !== wrapper && w._close) w._close(false);
      });

      wrapper.classList.add('open');
      trigger.setAttribute('aria-expanded', 'true');
      menu.classList.add('open');
      // 挂到 body：完全脱离文本流，不受父级 overflow 裁剪，永远在最上层
      document.body.appendChild(menu);

      // 宽度：内容宽度与触发器宽度取较大者，封顶 320px
      var triggerW = wrapper.getBoundingClientRect().width;
      var naturalW = menu.offsetWidth;
      var menuW = Math.min(Math.max(naturalW, triggerW), 320);
      menu.style.maxWidth = '320px';

      // 固定定位到触发器正下方（视口坐标）
      var rect = wrapper.getBoundingClientRect();
      var left = rect.left;
      if (rect.left + menuW > window.innerWidth - 8) left = rect.right - menuW;

      var top = rect.bottom + 6;
      var openUp = top + menu.offsetHeight > window.innerHeight - 8 && rect.top > menu.offsetHeight + 6 + 8;
      if (openUp) top = rect.top - menu.offsetHeight - 6;

      menu.style.position = 'fixed';
      menu.style.left = Math.max(8, left) + 'px';
      menu.style.top = Math.max(8, top) + 'px';
      menu.style.width = menuW + 'px';
      menu.style.minWidth = '';
      menu.classList.toggle('align-right', rect.left + menuW > window.innerWidth - 8);
      menu.classList.toggle('open-up', openUp);

      // 聚焦当前选中项
      var selected = items[native.selectedIndex];
      highlight(selected && !selected.classList.contains('disabled') ? selected : items[0], true);
    }

    function closeMenu(returnFocus) {
      if (!wrapper.classList.contains('open')) return;
      wrapper.classList.remove('open');
      trigger.setAttribute('aria-expanded', 'false');
      menu.classList.remove('open');
      if (menu.parentNode === document.body) menu.parentNode.removeChild(menu);
      if (returnFocus) trigger.focus();
    }

    function selectIndex(idx) {
      if (idx < 0 || idx >= native.options.length) return;
      if (native.options[idx].disabled) return;
      native.selectedIndex = idx;
      try { native.dispatchEvent(new Event('change', { bubbles: true })); } catch { /* noop */ }
      updateSelected();
      closeMenu(true);
    }

    trigger.addEventListener('click', function (e) {
      e.stopPropagation();
      if (wrapper.classList.contains('open')) closeMenu(true);
      else openMenu();
    });

    trigger.addEventListener('keydown', function (e) {
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp' || e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        openMenu();
      }
    });

    menu.addEventListener('keydown', function (e) {
      var current = items.findIndex(function (li) { return li.classList.contains('highlighted'); });
      var move = function (dir) {
        var i = current;
        for (var step = 0; step < items.length; step++) {
          i = (i + dir + items.length) % items.length;
          if (!items[i].classList.contains('disabled')) break;
        }
        highlight(items[i], true);
      };
      switch (e.key) {
        case 'ArrowDown': e.preventDefault(); move(1); break;
        case 'ArrowUp': e.preventDefault(); move(-1); break;
        case 'Home': e.preventDefault(); highlight(items[0], true); break;
        case 'End': e.preventDefault(); highlight(items[items.length - 1], true); break;
        case 'Enter':
        case ' ':
          e.preventDefault();
          if (current >= 0) selectIndex(parseInt(items[current].getAttribute('data-index'), 10));
          break;
        case 'Escape':
          e.preventDefault();
          closeMenu(true);
          break;
        case 'Tab':
          closeMenu(false);
          break;
      }
    });

    menu.addEventListener('click', function (e) {
      var li = e.target.closest('.select-option');
      if (!li || li.classList.contains('disabled')) return;
      selectIndex(parseInt(li.getAttribute('data-index'), 10));
    });

    menu.addEventListener('mousemove', function (e) {
      var li = e.target.closest('.select-option');
      if (li && !li.classList.contains('disabled')) highlight(li, false);
    });

    // 点击外部关闭（menu 已挂到 body，需同时检查）
    document.addEventListener('pointerdown', function (e) {
      if (wrapper.classList.contains('open') && !wrapper.contains(e.target) && !menu.contains(e.target)) {
        closeMenu(false);
      }
    });

    // 滚动 / 缩放时关闭（菜单为 fixed 定位，位置会失效）
    window.addEventListener('scroll', function () { closeMenu(false); }, true);
    window.addEventListener('resize', function () { closeMenu(false); });

    native.parentNode.insertBefore(wrapper, native);
    wrapper.appendChild(native);
    wrapper.appendChild(trigger);
    wrapper.appendChild(menu);
    wrapper._close = closeMenu;
    updateSelected();
  }

  function initSelects() {
    document.querySelectorAll('select.select').forEach(buildCustomSelect);
  }

  /* ================= Boot ================= */
  ready(function () {
    initSidebar();
    initSelects();
  });
})();
