/* ============================================================
   RD Flow - renderer.js (هيكلة سنة/شهر كاملة)
   ============================================================ */

let DATA = null;
let DEVICE_ID = 'device';
let saveTimer = null;
let activeView = 'dashboard';
let openDays = new Set();
// آخر نسخة من أقسام البيانات القابلة للمزامنة، بعد آخر حفظ ناجح — تُستخدم عشان
// نكتشف تلقائيًا أي عنصر تغيّر محتواه (تعديل، تبديل حالة/مفتاح، إلخ) ولو نسي
// الكود اللي غيّره يحدّث "وقت التعديل" يدويًا. هذا يحمي كل قسم بالتطبيق من نفس
// نوع البق اللي صار مع حذف الديون والتراجع — بدل ما نلاحق كل مكان يدويًا
// ونخاطر ننسى واحد (زي ما صار مع "وصل/لم يصل" بالزكاة)
let lastPersistedSnapshot = null;
function snapshotMergeArrays() {
  const o = {};
  ((window.Sync && Sync.MERGE_ARRAYS) || []).forEach(k => { o[k] = DATA[k]; });
  ((window.Sync && Sync.MERGE_BUCKETED) || []).forEach(k => { o[k] = DATA[k]; });
  return JSON.stringify(o);
}

// بصمة كامل البيانات (بلا meta.lastSavedAt/lastSavedDevice، لأنها تتغيّر بكل
// حفظ بحد ذاتها) — تُستخدم فقط لاكتشاف هل الحفظ الدوري (كل دقيقة افتراضيًا)
// له داعٍ فعلي أو لا. بدونها، كل "تكة" حفظ دوري كانت تحدّث meta.lastSavedAt
// حتى لو المستخدم ما غيّر شيء إطلاقًا — وهالحقل بالذات هو اللي تعتمد عليه كل
// مقارنات "مين نسخة الإعدادات الأحدث" بالمزامنة (mergeData بملف sync.js).
// النتيجة: جهاز فاتح لفترة طويلة (والحفظ التلقائي شغّال، وهو الوضع الافتراضي)
// كان "يبدو" دايمًا الأحدث زمنيًا حتى بلا أي تعديل حقيقي، فيرفض تلقائيًا قبول
// أي تحديث إعدادات وصل من جهاز ثاني (تفعيل/إيقاف ميزة، تغيير مظهر، إلخ) —
// نفس الأثر بالضبط اللي وُصف مع "تفعيل/إيقاف النسخة الاحتياطية التلقائية"
let lastAutoSaveFingerprint = null;
function dataFingerprintForAutoSave() {
  const clone = JSON.parse(JSON.stringify(DATA));
  if (clone.meta) { delete clone.meta.lastSavedAt; delete clone.meta.lastSavedDevice; }
  return JSON.stringify(clone);
}

let editingRowId = null, editingProjectId = null, editingCalId = null, editingZakatId = null, editingInvId = null;
let statsMode = { income: 'together', expense: 'together' };
let statsCurrency = { income: null, expense: null };

let navYear = null, navMonth = null, monthTab = 'income';
let yearlyCompareMode = false, compareCurrency = null;
let yearBarMode = 'general', compareBarMode = 'general';
let investCurrency = null;

const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));

/* ============================================================
   حالة فتح/إغلاق "النوافذ" القابلة للطي (نماذج الإضافة ولوحات مركز التحكم)
   - تبدأ كلها مغلقة تلقائيًا عند كل تشغيل جديد للتطبيق (المتغيّر يُصفَّر مع كل تحميل).
   - تبقى مفتوحة طوال الجلسة الحالية إن فتحها المستخدم (لا تُغلق نفسها عند أي إعادة رسم/تعديل).
   ============================================================ */
const panelState = {};
function isPanelOpen(key) { return !!panelState[key]; }
function setPanelOpen(key, val) { panelState[key] = !!val; }
function panelOpenAttr(key) { return panelState[key] ? ' open' : ''; }
// يربط كل <details data-panel="..."> داخل حاوية معيّنة بحالة الفتح/الإغلاق المحفوظة،
// ويحدّثها فور تبديل المستخدم لها يدويًا، حتى لا تُغلق فجأة عند أي إعادة رسم لاحقة (مهم خصوصًا في مركز التحكم).
function bindPanelToggles(container) {
  if (!container || !container.querySelectorAll) return;
  container.querySelectorAll('details[data-panel]').forEach(d => {
    d.addEventListener('toggle', () => setPanelOpen(d.dataset.panel, d.open));
  });
}

function uid() { return `${DEVICE_ID}_${Date.now()}_${Math.random().toString(16).slice(2, 6)}`; }

/* ================================================================
   منتقي التاريخ/الوقت الفخم — يستبدل الشكل الافتراضي البدائي لحقول
   التاريخ/الوقت بواجهة مخصّصة متحركة تتماشى مع تصميم التطبيق وكل الثيمات،
   مع إبقاء نفس حقل <input> الأصلي (بنفس الـ id/القيمة) مخفيًّا داخل الصفحة،
   فيستمر كل الكود القديم (القراءة/الكتابة عبر .value) في العمل بلا أي تعديل.
   ================================================================ */
const AR_WEEKDAYS_SHORT = ['أحد', 'اثن', 'ثلا', 'أرب', 'خمي', 'جمع', 'سبت'];
let fancyDatePopupEl = null, fancyDateOutsideHandler = null, fancyDateEscHandler = null, fancyDateScrollHandler = null;

// مراقب واحد عام: يفعّل المنتقي الفخم على حقول التاريخ، ويفعّل حركة الدخول للرسوم البيانية (منحنيات/أعمدة/أقراص) عند وصولها فعليًا للشاشة (سكرول) — بلا حاجة لاستدعاء أي منهما يدويًا من كل شاشة
// يراقب تمرير محتوى الشاشة: عند النزول للأسفل يضيف كلاس يخفي صف التبويبات
// (يفيد بالذات على الشاشات الضيقة بعد ما صار التبويبات صف مستقل تحت الترويسة)،
// وعند الصعود للأعلى يرجعه يظهر فورًا. بدون أي تأثير على شاشات الحاسوب العريضة
// (الكلاس ما له أثر بصري إلا داخل استعلام الوسائط الخاص بالشاشات الضيقة في CSS).
/* شريط الأقسام العلوي: لو كثرت الأقسام أو طالت أسماؤها (أو ضاقت النافذة، مثل فتح أدوات المطوّر) صار قابلًا للتمرير الأفقي بوضوح:
   عجلة الماوس + سحب بالماوس + أسهم ‹ › + شريط تمرير رفيع + تلاشي عند الحافة التي فيها بقية الأقسام، والقسم النشط يُمرَّر إلى الظهور تلقائيًا */
function initNavScroll() {
  const nav = $('#mainNav'); if (!nav || nav.dataset.scrollInit) return; nav.dataset.scrollInit = '1';
  const mk = (id, ch, title) => { const b = document.createElement('button'); b.id = id; b.type = 'button'; b.className = 'nav-arrow'; b.textContent = ch; b.title = title; return b; };
  const right = mk('navArrowRight', '›', 'تمرير الأقسام لليمين'), left = mk('navArrowLeft', '‹', 'تمرير الأقسام لليسار');
  nav.parentNode.insertBefore(right, nav); nav.parentNode.insertBefore(left, nav.nextSibling);
  const step = () => Math.max(160, nav.clientWidth * 0.6);
  right.addEventListener('click', () => nav.scrollBy({ left: step(), behavior: 'smooth' }));
  left.addEventListener('click', () => nav.scrollBy({ left: -step(), behavior: 'smooth' }));
  // عجلة الماوس العمودية تحرّك الشريط أفقيًا (على ويندوز لا يوجد تمرير أفقي بالماوس عادةً)
  nav.addEventListener('wheel', (e) => {
    if (nav.scrollWidth <= nav.clientWidth + 1 || Math.abs(e.deltaX) > Math.abs(e.deltaY) || !e.deltaY) return;
    const rtl = getComputedStyle(nav).direction === 'rtl';
    nav.scrollBy({ left: rtl ? -e.deltaY : e.deltaY }); e.preventDefault();
  }, { passive: false });
  // سحب بالماوس (لا يُفعَّل ضغط القسم لو كان الحدث سحبًا)
  let drag = null, suppress = false;
  nav.addEventListener('mousedown', (e) => { if (e.button === 0 && nav.scrollWidth > nav.clientWidth + 1) drag = { x: e.clientX, sl: nav.scrollLeft, moved: false }; });
  window.addEventListener('mousemove', (e) => {
    if (!drag) return; const dx = e.clientX - drag.x;
    if (Math.abs(dx) > 5) { drag.moved = true; nav.classList.add('dragging'); }
    if (drag.moved) nav.scrollLeft = drag.sl - dx;
  });
  window.addEventListener('mouseup', () => { if (drag && drag.moved) { suppress = true; setTimeout(() => { suppress = false; }, 0); } drag = null; nav.classList.remove('dragging'); });
  nav.addEventListener('click', (e) => { if (suppress) { e.stopPropagation(); e.preventDefault(); } }, true);
  const update = () => {
    const max = nav.scrollWidth - nav.clientWidth, overflow = max > 2;
    const rtl = getComputedStyle(nav).direction === 'rtl', pos = Math.abs(nav.scrollLeft); // المسافة عن حافة البداية
    const hiddenStart = overflow && pos > 2, hiddenEnd = overflow && pos < max - 2;
    const physLeft = rtl ? hiddenEnd : hiddenStart, physRight = rtl ? hiddenStart : hiddenEnd;
    left.style.display = physLeft ? 'inline-flex' : 'none'; right.style.display = physRight ? 'inline-flex' : 'none';
    nav.classList.toggle('nav-overflow', overflow);
    nav.classList.toggle('nav-fade-left', physLeft); nav.classList.toggle('nav-fade-right', physRight);
  };
  nav.addEventListener('scroll', update, { passive: true });
  window.addEventListener('resize', update);
  if (window.ResizeObserver) new ResizeObserver(update).observe(nav);
  new MutationObserver(update).observe(nav, { childList: true, subtree: true, characterData: true });
  update();
}
function scrollActiveNavIntoView() {
  const nav = $('#mainNav'); const btn = nav && nav.querySelector('.nav-btn.active'); if (!btn) return;
  const nr = nav.getBoundingClientRect(), br = btn.getBoundingClientRect(), pad = 40;
  if (br.left < nr.left + pad) nav.scrollBy({ left: br.left - nr.left - pad, behavior: 'smooth' });
  else if (br.right > nr.right - pad) nav.scrollBy({ left: br.right - nr.right + pad, behavior: 'smooth' });
}
function initNavAutoHide() {
  const scrollEl = $('#viewport');
  const app = $('#app');
  if (!scrollEl || !app) return;
  let lastY = scrollEl.scrollTop;
  let lastToggleAt = 0;
  let ticking = false;
  scrollEl.addEventListener('scroll', () => {
    if (ticking) return;
    ticking = true;
    requestAnimationFrame(() => {
      const y = scrollEl.scrollTop;
      const delta = y - lastY;
      const now = Date.now();
      if (y < 24) {
        app.classList.remove('nav-collapsed');
      } else if (Math.abs(delta) > 10 && now - lastToggleAt > 150) {
        // عتبة أعلى + فترة تهدئة بين كل تبديل تمنع الرجّات الصغيرة أثناء التمرير
        // (خصوصًا عند التباطؤ/التوقف) من قلب الاتجاه بسرعة وتسبيب تشنّج بصري
        if (delta > 0) app.classList.add('nav-collapsed'); else app.classList.remove('nav-collapsed');
        lastToggleAt = now;
      }
      lastY = y;
      ticking = false;
    });
  }, { passive: true });
}

function initFancyDateObserver() {

  enhanceDateInputs(document);
  observeChartsForEntrance(document);
  const target = $('#app') || document.body;
  new MutationObserver((mutations) => {
    mutations.forEach(m => m.addedNodes.forEach(node => {
      if (node.nodeType !== 1) return;
      if (node.matches && (node.matches('input[type="date"]') || node.matches('input[type="datetime-local"]'))) setupFancyDateInput(node);
      if (node.matches && node.matches('svg[data-chart-anim]')) observeChartEntranceEl(node);
      if (node.querySelectorAll) { enhanceDateInputs(node); observeChartsForEntrance(node); }
    }));
  }).observe(target, { childList: true, subtree: true });
}
/* ---------------- حركة دخول الرسوم البيانية عند وصولها فعليًا للشاشة (سكرول) ---------------- */
const chartEntranceObserver = new IntersectionObserver((entries) => {
  entries.forEach(entry => {
    if (!entry.isIntersecting) return;
    const svg = entry.target;
    chartEntranceObserver.unobserve(svg);
    svg.classList.add('chart-in-view');
    const path = svg.querySelector('.chart-draw-path');
    if (path) {
      try {
        const len = path.getTotalLength();
        path.style.strokeDasharray = len; path.style.strokeDashoffset = len;
        path.getBoundingClientRect();
        path.style.transition = 'stroke-dashoffset 1.1s ease';
        requestAnimationFrame(() => { path.style.strokeDashoffset = 0; });
      } catch (e) { /* تجاهل إن لم يدعمه المتصفح */ }
    }
    const ring = svg.querySelector('.health-score-ring .fg, circle.fg');
    if (ring && ring.dataset.targetOffset) {
      requestAnimationFrame(() => { ring.style.strokeDashoffset = ring.dataset.targetOffset; });
    }
  });
}, { threshold: 0.15 });
function observeChartEntranceEl(svg) {
  if (svg.hasAttribute('data-chart-observed')) return;
  svg.setAttribute('data-chart-observed', '1');
  bindChartTooltips(svg); // ربط تلميحات التمرير فورًا (لا داعي لانتظار ظهور الرسم في الشاشة)
  chartEntranceObserver.observe(svg);
}
function observeChartsForEntrance(root) {
  const scope = (root && root.querySelectorAll) ? root : document;
  scope.querySelectorAll('svg[data-chart-anim]:not([data-chart-observed])').forEach(observeChartEntranceEl);
}
function enhanceDateInputs(root) {
  const scope = (root && root.querySelectorAll) ? root : document;
  scope.querySelectorAll('input[type="date"]:not([data-fancy-bound]), input[type="datetime-local"]:not([data-fancy-bound])').forEach(setupFancyDateInput);
}
function setupFancyDateInput(input) {
  if (input.hasAttribute('data-fancy-bound')) return;
  input.setAttribute('data-fancy-bound', '1');
  input.classList.add('fancydate-native');
  const isDateTime = input.type === 'datetime-local';
  const wrap = document.createElement('span');
  wrap.className = 'fancydate';
  wrap.style.width = input.style.width || '100%'; // يحافظ على أي عرض ضيّق مقصود أصلًا (صفوف الجداول المدمجة) بدل تمديده دائمًا
  input.parentNode.insertBefore(wrap, input);
  wrap.appendChild(input);
  const display = document.createElement('button');
  display.type = 'button';
  display.className = 'fancydate-display';
  wrap.appendChild(display);
  function refresh() {
    const v = input.value;
    display.innerHTML = v
      ? `<span class="fancydate-ico">${isDateTime ? '🕐' : '📅'}</span><span class="fancydate-txt">${escHtml(formatFancyDisplay(v, isDateTime))}</span>`
      : `<span class="fancydate-ico">${isDateTime ? '🕐' : '📅'}</span><span class="fancydate-txt fancydate-ph">${isDateTime ? 'اختر تاريخًا ووقتًا' : 'اختر تاريخًا'}</span>`;
  }
  input._fancyRefresh = refresh;
  refresh();
  display.addEventListener('click', (e) => { e.preventDefault(); e.stopPropagation(); openFancyDatePicker(input, isDateTime, display); });
}
function formatFancyDisplay(value, isDateTime) {
  const [datePart, timePart] = value.split('T');
  const parts = datePart.split('-').map(Number);
  const y = parts[0], m = parts[1], d = parts[2];
  if (!y) return '';
  let out = `${d} ${MONTH_NAMES[m - 1]} ${y}`;
  if (isDateTime && timePart) out += ` — ${timePart}`;
  return out;
}
function closeFancyDatePopup() {
  if (!fancyDatePopupEl) return;
  const el = fancyDatePopupEl, forInput = el._forInput, forDisplay = el._forDisplay;
  fancyDatePopupEl = null;
  el.classList.remove('open');
  if (forDisplay) forDisplay.classList.remove('is-open');
  if (forInput && forInput._fancyRefresh) forInput._fancyRefresh();
  document.removeEventListener('mousedown', fancyDateOutsideHandler, true);
  document.removeEventListener('keydown', fancyDateEscHandler, true);
  window.removeEventListener('scroll', fancyDateScrollHandler, true);
  setTimeout(() => el.remove(), 180);
}
function openFancyDatePicker(input, isDateTime, displayBtn) {
  if (fancyDatePopupEl && fancyDatePopupEl._forInput === input) { closeFancyDatePopup(); return; }
  closeFancyDatePopup();
  const raw = input.value;
  const rawParts = (raw || '').split('T');
  const datePart = rawParts[0], timePart = rawParts[1];
  const now = new Date();
  let selY = now.getFullYear(), selM = now.getMonth() + 1, selD = now.getDate();
  let hasSelection = !!datePart;
  if (datePart) { const dp = datePart.split('-').map(Number); if (dp[0]) { selY = dp[0]; selM = dp[1]; selD = dp[2]; } }
  let hh = now.getHours(), mi = now.getMinutes();
  if (isDateTime && timePart) { const tp = timePart.split(':').map(Number); hh = tp[0]; mi = tp[1]; }
  let viewY = selY, viewM = selM, mode = 'days'; // mode: days | months | years

  const pop = document.createElement('div');
  pop.className = 'fancydate-pop';
  pop._forInput = input; pop._forDisplay = displayBtn;
  document.body.appendChild(pop);
  fancyDatePopupEl = pop;
  displayBtn.classList.add('is-open');

  function daysInMonth(y, m) { return new Date(y, m, 0).getDate(); }
  function positionPop() {
    const r = displayBtn.getBoundingClientRect();
    const pw = pop.offsetWidth || 300, ph = pop.offsetHeight || 360;
    let top = r.bottom + 8;
    if (top + ph > window.innerHeight - 10) top = Math.max(10, r.top - ph - 8);
    let left = r.left;
    if (left + pw > window.innerWidth - 10) left = window.innerWidth - pw - 10;
    if (left < 10) left = 10;
    pop.style.top = top + 'px'; pop.style.left = left + 'px';
  }
  function renderPop() {
    let bodyHtml;
    if (mode === 'years') {
      const baseY = Math.floor(viewY / 12) * 12;
      const yrs = Array.from({ length: 12 }, (_, i) => baseY + i);
      bodyHtml = `<div class="fancydate-years">${yrs.map(y => `<div class="fancydate-year ${y === selY ? 'is-selected' : ''}" data-year="${y}">${y}</div>`).join('')}</div>`;
    } else if (mode === 'months') {
      bodyHtml = `<div class="fancydate-months">${MONTH_NAMES.map((n, i) => `<div class="fancydate-month ${i + 1 === viewM && viewY === selY ? 'is-selected' : ''}" data-month="${i + 1}">${n}</div>`).join('')}</div>`;
    } else {
      const first = new Date(viewY, viewM - 1, 1);
      const startOffset = first.getDay();
      const totalDays = daysInMonth(viewY, viewM);
      const prevY = viewM === 1 ? viewY - 1 : viewY, prevM = viewM === 1 ? 12 : viewM - 1;
      const prevTotalDays = daysInMonth(prevY, prevM);
      const cells = [];
      for (let i = 0; i < startOffset; i++) cells.push({ d: prevTotalDays - startOffset + 1 + i, muted: true });
      for (let d = 1; d <= totalDays; d++) cells.push({ d, muted: false });
      while (cells.length < 42) cells.push({ d: cells.length - startOffset - totalDays + 1, muted: true });
      bodyHtml = `<div class="fancydate-grid">
        ${AR_WEEKDAYS_SHORT.map(w => `<div class="fancydate-wd">${w}</div>`).join('')}
        ${cells.map(c => {
          const isToday = !c.muted && viewY === now.getFullYear() && viewM === now.getMonth() + 1 && c.d === now.getDate();
          const isSel = hasSelection && !c.muted && viewY === selY && viewM === selM && c.d === selD;
          return `<div class="fancydate-day ${c.muted ? 'is-muted' : ''} ${isToday ? 'is-today' : ''} ${isSel ? 'is-selected' : ''}" ${c.muted ? '' : `data-day="${c.d}"`}>${c.d}</div>`;
        }).join('')}
      </div>`;
    }
    const timeHtml = isDateTime ? `
      <div class="fancydate-time">
        <div class="fancydate-time-unit"><button type="button" class="fancydate-time-btn" data-tstep="h+">▲</button><div class="fancydate-time-val">${pad2(hh)}</div><button type="button" class="fancydate-time-btn" data-tstep="h-">▼</button></div>
        <div class="fancydate-time-sep">:</div>
        <div class="fancydate-time-unit"><button type="button" class="fancydate-time-btn" data-tstep="m+">▲</button><div class="fancydate-time-val">${pad2(mi)}</div><button type="button" class="fancydate-time-btn" data-tstep="m-">▼</button></div>
        <button type="button" class="fancydate-time-now" data-tnow="1">الآن</button>
      </div>` : '';
    pop.innerHTML = `
      <div class="fancydate-head">
        <button type="button" class="fancydate-nav" data-nav="prev">‹</button>
        <span class="fancydate-title" data-titleclick="1">${mode === 'years' ? 'اختر سنة' : mode === 'months' ? viewY : `${MONTH_NAMES[viewM - 1]} ${viewY}`}</span>
        <button type="button" class="fancydate-nav" data-nav="next">›</button>
      </div>
      ${bodyHtml}${timeHtml}
      <div class="fancydate-foot">
        <button type="button" class="fancydate-btn ghost" data-act="today">اليوم</button>
        <div style="display:flex; gap:6px;">
          <button type="button" class="fancydate-btn ghost" data-act="clear">مسح</button>
          <button type="button" class="fancydate-btn primary" data-act="ok">تأكيد</button>
        </div>
      </div>`;
    positionPop();
    bindPopEvents();
  }
  function step(dir) {
    if (mode === 'years') viewY += dir * 12;
    else if (mode === 'months') viewY += dir;
    else { viewM += dir; if (viewM > 12) { viewM = 1; viewY++; } else if (viewM < 1) { viewM = 12; viewY--; } }
    renderPop();
  }
  function bindPopEvents() {
    pop.querySelector('[data-nav="prev"]').addEventListener('click', () => step(-1));
    pop.querySelector('[data-nav="next"]').addEventListener('click', () => step(1));
    pop.querySelector('[data-titleclick]').addEventListener('click', () => { mode = mode === 'years' ? 'months' : 'years'; renderPop(); });
    pop.querySelectorAll('[data-day]').forEach(el => el.addEventListener('click', () => { selY = viewY; selM = viewM; selD = parseInt(el.dataset.day); hasSelection = true; renderPop(); }));
    pop.querySelectorAll('[data-year]').forEach(el => el.addEventListener('click', () => { viewY = parseInt(el.dataset.year); mode = 'months'; renderPop(); }));
    pop.querySelectorAll('[data-month]').forEach(el => el.addEventListener('click', () => { viewM = parseInt(el.dataset.month); selY = viewY; mode = 'days'; renderPop(); }));
    pop.querySelectorAll('[data-tstep]').forEach(el => el.addEventListener('click', () => {
      const k = el.dataset.tstep;
      if (k === 'h+') hh = (hh + 1) % 24; else if (k === 'h-') hh = (hh + 23) % 24;
      else if (k === 'm+') mi = (mi + 1) % 60; else if (k === 'm-') mi = (mi + 59) % 60;
      renderPop();
    }));
    const nowBtn = pop.querySelector('[data-tnow]');
    if (nowBtn) nowBtn.addEventListener('click', () => { const n = new Date(); hh = n.getHours(); mi = n.getMinutes(); renderPop(); });
    pop.querySelector('[data-act="today"]').addEventListener('click', () => {
      const n = new Date(); selY = n.getFullYear(); selM = n.getMonth() + 1; selD = n.getDate(); viewY = selY; viewM = selM; hasSelection = true; mode = 'days';
      if (isDateTime) { hh = n.getHours(); mi = n.getMinutes(); }
      renderPop();
    });
    pop.querySelector('[data-act="clear"]').addEventListener('click', () => {
      input.value = '';
      input.dispatchEvent(new Event('input', { bubbles: true })); input.dispatchEvent(new Event('change', { bubbles: true }));
      closeFancyDatePopup();
    });
    pop.querySelector('[data-act="ok"]').addEventListener('click', () => {
      const val = isDateTime ? `${selY}-${pad2(selM)}-${pad2(selD)}T${pad2(hh)}:${pad2(mi)}` : `${selY}-${pad2(selM)}-${pad2(selD)}`;
      input.value = val;
      input.dispatchEvent(new Event('input', { bubbles: true })); input.dispatchEvent(new Event('change', { bubbles: true }));
      closeFancyDatePopup();
    });
  }
  renderPop();
  requestAnimationFrame(() => pop.classList.add('open'));
  fancyDateOutsideHandler = (e) => { if (!pop.contains(e.target) && e.target !== displayBtn && !displayBtn.contains(e.target)) closeFancyDatePopup(); };
  fancyDateEscHandler = (e) => { if (e.key === 'Escape') closeFancyDatePopup(); };
  fancyDateScrollHandler = (e) => { if (!pop.contains(e.target)) closeFancyDatePopup(); };
  document.addEventListener('mousedown', fancyDateOutsideHandler, true);
  document.addEventListener('keydown', fancyDateEscHandler, true);
  window.addEventListener('scroll', fancyDateScrollHandler, true);
}
function fmt(n) { return Number(n || 0).toLocaleString('en-US', { maximumFractionDigits: 2 }); }
function bidi(html) { return `<bdi dir="ltr">${html}</bdi>`; } // يمنع تشوّه ترتيب الأرقام/العملات داخل سياق عربي RTL

/* ============================================================
   حقول الملاحظات/التفاصيل: تكبر تلقائيًا أثناء الكتابة (بدل نص يواصل الكتابة مخفيًا)
   + معاينة كاملة عند تمرير الماوس في القوائم (بدل الاضطرار للدخول للتعديل)
   ============================================================ */
function escHtml(s) { return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;'); }
function autoGrowTextarea(el) {
  el.style.height = 'auto';
  el.style.height = el.scrollHeight + 'px';
}
function initAutoGrowTextareas() {
  // إعادة الحساب أثناء الكتابة مباشرة
  document.addEventListener('input', (e) => {
    if (e.target && e.target.matches && e.target.matches('textarea.autogrow')) autoGrowTextarea(e.target);
  });
  // أي textarea.autogrow جديدة تُضاف للصفحة (فتح نموذج تعديل فيه نص محفوظ طويل مثلًا) تُضبط ارتفاعها فورًا لعرض كامل محتواها
  const observer = new MutationObserver((mutations) => {
    mutations.forEach(m => {
      m.addedNodes.forEach(node => {
        if (node.nodeType !== 1) return;
        if (node.matches && node.matches('textarea.autogrow')) autoGrowTextarea(node);
        node.querySelectorAll && node.querySelectorAll('textarea.autogrow').forEach(autoGrowTextarea);
      });
    });
  });
  observer.observe(document.body, { childList: true, subtree: true });
}
// معاينة نص طويل (ملاحظة/تفاصيل) في القوائم: يظهر مقتطف قصير، وعند تمرير الماوس فوقه (title) يظهر النص كاملًا بدون الحاجة للدخول للتعديل
function notePreviewHtml(note, icon) {
  if (!note) return '';
  const full = String(note);
  const esc = full.replace(/"/g, '&quot;');
  const short = full.length > 26 ? full.slice(0, 25) + '…' : full;
  return ` <span class="note-hint" title="${esc}">${icon || '📝'} ${short}</span>`;
}
const CURRENCY_COLORS = ['#4f7cff', '#22d3a8', '#f5a623', '#c77dff', '#ff6b9d', '#3ddc97', '#ff9f5a'];
function curColor(cur) {
  let hash = 0; for (let i = 0; i < cur.length; i++) hash = cur.charCodeAt(i) + ((hash << 5) - hash);
  return CURRENCY_COLORS[Math.abs(hash) % CURRENCY_COLORS.length];
}
// لوحة ألوان فئات المصاريف/الدخل - أوسع من ألوان العملات حتى لا تتكرر بصريًا في الرسوم الدائرية
const CATEGORY_COLORS = ['#4f7cff', '#22d3a8', '#f5a623', '#c77dff', '#ff6b9d', '#3ddc97', '#ff9f5a', '#5ac8fa', '#ff5a5a', '#a78bfa', '#34d399', '#fbbf24', '#f472b6', '#60a5fa', '#2dd4bf', '#fb923c'];
// يختار أقل لون استعمالًا حاليًا بين الفئات الفعّالة، حتى تختلف كل فئة جديدة عن سابقاتها تلقائيًا
function nextCategoryColor() {
  const used = {};
  (DATA.categories || []).filter(c => !c.deleted).forEach(c => { const col = c.color || '#4f7cff'; used[col] = (used[col] || 0) + 1; });
  let best = CATEGORY_COLORS[0], bestCount = Infinity;
  for (const col of CATEGORY_COLORS) {
    const count = used[col] || 0;
    if (count < bestCount) { bestCount = count; best = col; if (count === 0) break; }
  }
  return best;
}
function todayISO() { return new Date().toISOString().slice(0, 10); }
function pad2(n) { return String(n).padStart(2, '0'); }
function label(key) { return (DATA.labels && DATA.labels[key]) || key; }
function toast(msg) {
  const host = $('#toastHost'); const el = document.createElement('div');
  el.className = 'toast'; el.textContent = msg; host.appendChild(el);
  setTimeout(() => el.remove(), 3200);
}

/* ---------------- تحميل/حفظ ---------------- */
const DEFAULT_LABELS = {
  nav_dashboard: 'الرئيسية', nav_income: 'جدول العمل', nav_expenses: 'المصاريف', nav_clients: 'العملاء',
  nav_investment: 'الاستثمار', nav_outflows: 'الإخراجات', nav_yearly: 'الأرشيف الزمني',
  nav_calendar: 'الرزنامة', nav_notes: 'المذكرة', nav_planning: 'التخطيط والتسعير', nav_wealth: 'أموالي', nav_control: 'مركز التحكم', nav_settings: 'الإعدادات',
  source_general: 'مصدر عادي', source_client: 'عميل / مشروع',
  debt_type_i_owe: 'شخص سلفني / سلفت من شخص', debt_type_they_owe_me: 'أنا سلفت لشخص / أخرجت من صندوقي',
  debts_summary_title: 'صافي وضعك بالديون',
  // عناوين بطاقات صفحة الإعدادات
  settings_theme: '🎨 المظهر', settings_lang: '🌐 اللغة / Language', settings_nav_order: '↕️ ترتيب التبويبات',
  settings_perf: '⚡ وضع الأداء', settings_autosave: '💾 الحفظ التلقائي', settings_monthcompare: '📊 تنبيه مقارنة الشهور', settings_sections: '🧩 تفعيل/تعطيل الأقسام',
  settings_schedmodes: '🗓️ أقسام الجدول المتكرر', settings_ai: '🧠 الوضع الذكي الكامل', settings_backup: '💾 النسخ الاحتياطي', settings_danger: '⚠️ منطقة الخطر — مسح البيانات',
  // عناوين بطاقات مركز التحكم
  control_currencies: 'العملات', control_sources: 'مصادر الدخل العادية', control_clients: 'العملاء (الأسماء والعملة)',
  control_alerts: 'التنبيهات الذكية', control_labels: 'تخصيص العناوين', control_export: '📄 مركز التصدير', control_assettypes: 'أنواع الأصول (قسم "أموالي")',
};
// تجميع مفاتيح العناوين حسب القسم لعرضها بشكل منظّم في "تخصيص العناوين" — أي مفتاح جديد يُضاف مستقبلًا لأي مجموعة يظهر هنا تلقائيًا بلا أي عمل إضافي
const LABEL_GROUPS = [
  { title: 'التنقّل الرئيسي (كل الأقسام)', keys: ['nav_dashboard', 'nav_yearly', 'nav_income', 'nav_expenses', 'nav_investment', 'nav_outflows', 'nav_clients', 'nav_calendar', 'nav_notes', 'nav_planning', 'nav_wealth', 'nav_control', 'nav_settings'] },
  { title: 'مصادر الدخل والديون', keys: ['source_general', 'source_client', 'debt_type_i_owe', 'debt_type_they_owe_me', 'debts_summary_title'] },
  { title: 'صفحة الإعدادات', keys: ['settings_theme', 'settings_lang', 'settings_nav_order', 'settings_perf', 'settings_autosave', 'settings_monthcompare', 'settings_sections', 'settings_schedmodes', 'settings_ai', 'settings_backup', 'settings_danger'] },
  { title: 'مركز التحكم', keys: ['control_currencies', 'control_sources', 'control_clients', 'control_alerts', 'control_labels', 'control_export', 'control_assettypes'] },
];
/* ==================== خبير التطبيق العائم (بدون إنترنت) ==================== */
let assistantOpen = false;
let assistantView = 'chat'; // 'chat' | 'search'
let assistantSearchQuery = '';
const assistantMessages = [{ id: 'welcome', role: 'bot', text: 'أهلًا 👋 أنا خبير التطبيق.\nتقدر:\n• تضغط 🔍 فوق (بجانب الإغلاق) وتكتب كلمة وحدة من سؤالك، وتضغط على أي سؤال يطلع لك يجاوبك مباشرة.\n• تختار من الأسئلة الجاهزة تحت — كلها مجرَّبة، وتجاوب فورًا ومحليًا من بياناتك الحقيقية أو بشرح استخدام أي قسم.\nالكتابة الحرة (سؤال بكلماتك) تتفعّل تلقائيًا بمجرد ما تضيف مفتاح API واحد من الإعدادات ← 🧠 الوضع الذكي الكامل.' }];

function normalizeArabic(s) {
  return (s || '')
    .replace(/[\u064B-\u065F\u0670]/g, '')
    .replace(/[إأآا]/g, 'ا').replace(/ى/g, 'ي').replace(/ة/g, 'ه').replace(/ؤ/g, 'و').replace(/ئ/g, 'ي')
    .replace(/[^\u0600-\u06FF0-9a-zA-Z\s]/g, ' ')
    .toLowerCase().replace(/\s+/g, ' ').trim();
}
function fmtByCurrency(dict) {
  const entries = Object.entries(dict).filter(([, v]) => Math.abs(v) > 0.001);
  if (!entries.length) return null;
  return entries.map(([cur, v]) => `${bidi(fmt(v))} ${cur}`).join(' · ');
}
function assistantSumByCurrency(list) {
  const out = {}; list.forEach(t => { out[t.currency] = (out[t.currency] || 0) + t.amount; }); return out;
}

const ASSISTANT_INTENTS = [
  { kw: ['كم صافي ثروتي', 'صافي ثروتي', 'ثروتي كم', 'كم أملك'],
    a: () => { const s = fmtByCurrency(Object.fromEntries(DATA.settings.currencies.map(c => [c, computeNetWorth(c).netWorth]))); return s ? `صافي ثروتك الحالي: ${s}` : 'أضف أصولك من قسم "أموالي" حتى أقدر أحسبها لك.'; } },

  { kw: ['اقتطاعاتي المتكرره', 'كم اقتطاع عندي', 'عملياتي المتكرره'],
    a: () => { const items = DATA.recurringTx.filter(r => !r.deleted && r.active); if (!items.length) return 'ما عندك أي اقتطاع متكرر مفعّل حاليًا — تقدر تضيف من "أموالي" ← "الاقتطاعات المتكررة".'; return `عندك ${items.length} اقتطاع متكرر نشط:\n` + items.slice(0, 6).map(r => { const c = DATA.categories.find(x => x.id === r.categoryId); return `• ${c ? c.name : '—'} — ${bidi(fmt(r.amount))} ${r.currency} (يوم ${r.dayOfMonth})`; }).join('\n'); } },
  { kw: ['من انت', 'مين انت', 'ماذا تفعل', 'شنو تسوي', 'ماذا تستطيع', 'مساعده', 'وش تسوي', 'ساعدني'],
    a: () => `أنا خبير التطبيق 🤖 أقدر أجاوبك على نوعين من الأسئلة:\n1) أسئلة عن بياناتك الحقيقية (مثال: "كم دين عليّ؟"، "صافي هذا الشهر؟"، "تذكيراتي القادمة؟")\n2) أسئلة عن استعمال أي قسم بالتطبيق (مثال: "وين أضيف مصروف؟"، "كيف أصدّر PDF؟")\nجرّب سؤالًا جاهزًا، أو اضغط 🔍 وابحث بكلمة من سؤالك.` },

  { kw: ['كم علي دين', 'ديون علي', 'عندي دين', 'اديون علي', 'كم عليه'],
    a: () => { const r = assistantSumByCurrency(DATA.debts.filter(d => !d.deleted && d.type === 'i_owe').map(d => ({ currency: d.currency, amount: d.amount - computeDebtPaid(d) }))); const s = fmtByCurrency(r); return s ? `عليك حاليًا: ${s}` : 'ما عليك أي دين حاليًا 👍'; } },

  { kw: ['كم لي دين', 'ديون لي', 'لي عند الناس', 'مالي عند الناس', 'كم يديون الناس لي'],
    a: () => { const r = assistantSumByCurrency(DATA.debts.filter(d => !d.deleted && d.type === 'they_owe_me').map(d => ({ currency: d.currency, amount: d.amount - computeDebtPaid(d) }))); const s = fmtByCurrency(r); return s ? `لك عند الناس حاليًا: ${s}` : 'ما لك دين عند أحد حاليًا.'; } },

  { kw: ['صافي وضعك بالديون', 'صافي الديون', 'وضعي بالديون', 'رصيدي مع الديون'],
    a: () => { const s = fmtByCurrency(Object.fromEntries(DATA.settings.currencies.map(c => [c, debtAdjustment(c)]).filter(([, v]) => v))); return s ? `صافي وضعك بالديون (لو حصّلت وسدّدت كل شيء الآن): ${s}` : 'وضعك بالديون متوازن حاليًا (لا شيء معلّق).'; } },

  { kw: ['دخل هذا الشهر', 'كم دخلت هذا الشهر', 'دخلي الشهر'],
    a: () => { const now = new Date(); const s = fmtByCurrency(Object.fromEntries(DATA.settings.currencies.map(c => [c, realSum('income', t => t.currency === c && inMonth(t.date, now.getFullYear(), now.getMonth() + 1))]))); return s ? `دخل هذا الشهر: ${s}` : 'ما فيه دخل مسجَّل هذا الشهر بعد.'; } },

  { kw: ['مصاريف هذا الشهر', 'كم صرفت هذا الشهر', 'مصروفي الشهر'],
    a: () => { const now = new Date(); const s = fmtByCurrency(Object.fromEntries(DATA.settings.currencies.map(c => [c, realSum('expense', t => t.currency === c && inMonth(t.date, now.getFullYear(), now.getMonth() + 1))]))); return s ? `مصاريف هذا الشهر: ${s}` : 'ما فيه مصاريف مسجَّلة هذا الشهر بعد.'; } },

  { kw: ['صافي هذا الشهر', 'ربحي هذا الشهر', 'كم صافيت هذا الشهر'],
    a: () => { const now = new Date(); const y = now.getFullYear(), m = now.getMonth() + 1; const s = fmtByCurrency(Object.fromEntries(DATA.settings.currencies.map(c => {
        const income = realSum('income', t => t.currency === c && inMonth(t.date, y, m)), expense = realSum('expense', t => t.currency === c && inMonth(t.date, y, m));
        const outflows = DATA.zakatPayments.filter(z => !z.deleted && z.currency === c && inMonth(z.date, y, m)).reduce((s2, z) => s2 + z.amount, 0);
        const debtFlow = debtFlowSum(t => t.currency === c && inMonth(t.date, y, m));
        return [c, income - expense - outflows + debtFlow];
      }))); return s ? `صافي هذا الشهر بعد الإخراجات: ${s}` : 'لا توجد بيانات كافية لهذا الشهر بعد.'; } },

  { kw: ['صافي هذه السنه', 'صافي السنه', 'ربحي هذه السنه'],
    a: () => { const y = new Date().getFullYear(); const s = fmtByCurrency(Object.fromEntries(DATA.settings.currencies.map(c => {
        const income = realSum('income', t => t.currency === c && inYear(t.date, y)), expense = realSum('expense', t => t.currency === c && inYear(t.date, y));
        const outflows = DATA.zakatPayments.filter(z => !z.deleted && z.currency === c && inYear(z.date, y)).reduce((s2, z) => s2 + z.amount, 0);
        const debtFlow = debtFlowSum(t => t.currency === c && inYear(t.date, y));
        return [c, income - expense - outflows + debtFlow];
      }))); return s ? `صافي سنة ${y}: ${s}` : 'لا توجد بيانات كافية لهذه السنة بعد.'; } },

  { kw: ['الاخراجات هذا الشهر', 'زكاه هذا الشهر', 'كم اخرجت هذا الشهر'],
    a: () => { const now = new Date(); const s = fmtByCurrency(Object.fromEntries(DATA.settings.currencies.map(c => [c, DATA.zakatPayments.filter(z => !z.deleted && z.currency === c && inMonth(z.date, now.getFullYear(), now.getMonth() + 1)).reduce((s2, z) => s2 + z.amount, 0)]))); return s ? `إخراجات هذا الشهر: ${s}` : 'ما فيه إخراجات مسجَّلة هذا الشهر.'; } },

  { kw: ['تذكيراتي القادمه', 'اقرب تذكير', 'شنو باقي علي', 'مواعيدي القادمه'],
    a: () => {
      const now = Date.now(); const all = [];
      DATA.calendarItems.filter(i => !i.deleted && i.reminderAt && !i.notifiedAt && i.reminderAt > now).forEach(i => all.push({ t: i.reminderAt, label: (i.kind === 'event' ? '📅 ' : '📝 ') + i.title }));
      (DATA.debts || []).filter(d => !d.deleted && d.reminderAt && !d.notifiedAt && d.reminderAt > now).forEach(d => all.push({ t: d.reminderAt, label: '💳 دين: ' + d.name }));
      (DATA.plans || []).filter(p => !p.deleted && p.status !== 'archived' && p.nextReminderAt && !p.notifiedAt && p.nextReminderAt > now).forEach(p => all.push({ t: p.nextReminderAt, label: (p.kind === 'goal' ? '🎯 ' : '🔁 ') + p.title }));
      all.sort((a, b) => a.t - b.t);
      if (!all.length) return 'لا توجد تذكيرات قادمة مجدولة حاليًا.';
      return 'أقرب تذكيراتك:\n' + all.slice(0, 5).map(x => `• ${x.label} — ${new Date(x.t).toLocaleString('ar-DZ')}`).join('\n');
    } },

  { kw: ['الفئه الاكثر صرفا', 'وين اصرف اكثر', 'اكبر مصروف'],
    a: () => {
      const now = new Date(); const y = now.getFullYear(), m = now.getMonth() + 1;
      const byCat = {};
      DATA.transactions.filter(t => !t.deleted && t.kind === 'expense' && t.mode !== 'debt' && inMonth(t.date, y, m)).forEach(t => { const key = sourceName(t) + '|' + t.currency; byCat[key] = (byCat[key] || 0) + t.amount; });
      const top = Object.entries(byCat).sort((a, b) => b[1] - a[1])[0];
      if (!top) return 'لا توجد مصاريف كافية هذا الشهر لتحديد الفئة الأكثر.';
      const [key, amount] = top; const [name, cur] = key.split('|');
      return `أكثر ما تصرف عليه هذا الشهر: ${name} بمبلغ ${bidi(fmt(amount))} ${cur}`;
    } },

  { kw: ['رصيد الاستثمار', 'كم استثمرت', 'استثماري'],
    a: () => { const s = fmtByCurrency(assistantSumByCurrency(DATA.investments.filter(t => !t.deleted))); return s ? `رصيد استثمارك التراكمي: ${s}` : 'لا توجد حركات استثمار مسجَّلة بعد.'; } },

  { kw: ['اهدافي النشطه', 'خططي النشطه', 'كم هدف عندي'],
    a: () => { const active = DATA.plans.filter(p => !p.deleted && p.status !== 'archived'); if (!active.length) return 'لا توجد خطط أو أهداف نشطة حاليًا — تقدر تضيف من قسم "التخطيط والتسعير".'; return `عندك ${active.length} خطة/هدف نشط:\n` + active.slice(0, 6).map(p => `• ${p.kind === 'goal' ? '🎯' : '🔁'} ${p.title}`).join('\n'); } },

  { kw: ['وين اضيف مصروف', 'كيف اضيف مصروف'],
    a: () => 'من الشهر المطلوب ← تبويب "مصاريف" ← تعبّي المبلغ والفئة والتاريخ ← زر "إضافة". تقدر تضيف فئة جديدة من مركز التحكم إذا ما كانت موجودة.' },

  { kw: ['وين اضيف دخل', 'كيف اضيف دخل'],
    a: () => 'من الشهر المطلوب ← تبويب "دخل" ← اختر "مصدر عادي" أو "عميل/مشروع" حسب نوع الدخل ← عبّي البيانات ← "إضافة".' },

  { kw: ['كيف اسدد دين', 'الفرق بين تسديد كامل وجزئي', 'كيف اسدد جزء من الدين'],
    a: () => '"تسديد كامل" يقفل الدين دفعة واحدة بكل المتبقي. "تسديد جزئي" يفتح خانة تكتب فيها أي مبلغ تحب (حتى لو أقل من الكل)، وتقدر تكررها كل ما استلمت أو دفعت دفعة جديدة. كل تسديد يُسجَّل تلقائيًا في جرد ذلك اليوم.' },

  { kw: ['كيف اصدر بيدياف', 'كيف احفظ تقرير', 'تصدير تقرير'],
    a: () => 'كل قسم فيه زر "📄 تصدير PDF" مباشر بأعلاه. أو من "مركز التحكم" ← "مركز التصدير": تحدد أكثر من تقرير مرة وحدة وتختار مجلد حفظ واحد، ويحفظهم كلهم فيه دفعة واحدة.' },

  { kw: ['كيف اضيف تذكير', 'كيف اعدل تذكير', 'كيف الغي تذكير'],
    a: () => 'أي عنصر فيه حقل "وقت التذكير" (الرزنامة، المذكرة، الديون، التخطيط) — تقدر تحطه وقت الإنشاء أو تعدّله لاحقًا من زر "تعديل"، وتفضيه لو تبي تلغيه.' },

  { kw: ['ما هي الاخراجات', 'شنو يعني اخراجات', 'الزكاه شنو'],
    a: () => 'الإخراجات هي زكاة/صدقة تحسبها كنسبة من صافي الشهر (دخل - مصاريف)، وتُطرح في خطوة منفصلة بعد الصافي — تقدر تعدّل النسبة أو تضيف بندًا يدويًا من صفحة "الجرد الشهري".' },

  { kw: ['ليش يظهر بعد تسويه الديون', 'شنو يعني بعد تسويه الديون'],
    a: () => '"الإجمالي الحالي" هو رقمك الحقيقي الآن. "بعد تسوية كل الديون" يفترض أنك حصّلت كل ما لك وسددت كل ما عليك، أينما كانت هذه الديون بالزمن — يعطيك صورة لحقوقك القادمة.' },

  { kw: ['كيف احسب سعر مشروع', 'كيف اسعر فيديو', 'حاسبه التسعير'],
    a: () => 'من "التخطيط والتسعير" ← تبويب "تسعير": أول أضف أسعارك الأساسية (سوق + نوع فيديو + سعر)، بعدها من "احسب عرض سعر" اختر السوق والنوع وأضف الكمية ومستوى التعقيد والاستعجال والخصم، ويحسب لك السعر فورًا.' },

  { kw: ['كيف اضيف هدف', 'كيف اضيف خطه', 'اضافه هدف'],
    a: () => 'من "التخطيط والتسعير" ← تبويب "تخطيط وأهداف": عبّي العنوان، اختر نوعه (خطة متكررة أو هدف)، حدد التكرار وأول موعد تذكير، واضغط إضافة. راح يذكّرك تلقائيًا في موعده ويسألك عن تقدّمك.' },

  { kw: ['سؤال حر', 'اي سؤال', 'اسئله عامه', 'تقدر تجاوب اي شيء'],
    a: () => 'حاليًا أنا مبني بدون إنترنت، فأجاوب فقط عن بياناتك الحقيقية وعن كيفية استعمال التطبيق. الإجابة على أي سؤال حر خارج هذا (زي ChatGPT/Claude فعليًا) تحتاج تفعيل "الوضع الذكي الكامل" لاحقًا بمفتاح API من الإعدادات — وهذا قرارك واختيارك متى ما حبيت.' },
];

// بنك أسئلة "مجرَّبة" جاهز للبحث والاقتراح: يُبنى تلقائيًا من نفس نيّات الأجوبة أعلاه،
// فكل سؤال هنا مضمون أنه يطابق نيّته الصحيحة (السؤال الأول لكل نيّة هو أوضح صياغة لها).
// نطاقات زمنية جاهزة تُستعمل في كل الأسئلة الديناميكية (مصاريف/دخل/مصدر/عميل...)
const ASSISTANT_RANGES = [['today', 'اليوم'], ['week', 'هذا الأسبوع'], ['month', 'هذا الشهر'], ['half', 'آخر 6 أشهر'], ['year', 'هذا العام'], ['all', 'كل السنوات']];
function assistantRangeFilter(rangeKey) {
  const now = new Date(), todayStr = todayISO();
  if (rangeKey === 'today') return t => t.date === todayStr;
  if (rangeKey === 'week') { const d = new Date(now); d.setDate(d.getDate() - 6); const s = `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`; return t => t.date >= s && t.date <= todayStr; }
  if (rangeKey === 'month') return t => inMonth(t.date, now.getFullYear(), now.getMonth() + 1);
  if (rangeKey === 'half') { const d = new Date(now); d.setMonth(d.getMonth() - 6); const s = `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`; return t => t.date >= s && t.date <= todayStr; }
  if (rangeKey === 'year') return t => inYear(t.date, now.getFullYear());
  return () => true; // all
}
// أسئلة ديناميكية تُبنى من بياناتك الحالية (تُعاد فورًا عند أي إضافة/تعديل/حذف مصدر، عميل، نوع أصل، أو عملة — بلا أي عمل يدوي إضافي)
function buildDynamicAssistantIntents() {
  const list = [];
  [['expense', 'مصاريفي', 'مصروف'], ['income', 'دخلي', 'دخل']].forEach(([kind, kindLabel, singular]) => {
    ASSISTANT_RANGES.forEach(([rk, rl]) => list.push({
      kw: [`كم ${kindLabel} ${rl}`],
      a: () => {
        const f = assistantRangeFilter(rk);
        const s = fmtByCurrency(assistantSumByCurrency(DATA.transactions.filter(t => !t.deleted && t.kind === kind && t.mode !== 'debt' && f(t))));
        return s ? `${kindLabel} ${rl}: ${s}` : `ما سجّلت أي ${singular} ${rl}.`;
      }
    }));
  });
  // كل مصدر دخل عادي (فئة دخل) — حتى لو أضفت مصدرًا جديدًا الآن من مركز التحكم، أسئلته تُبنى تلقائيًا من هنا
  DATA.categories.filter(c => !c.deleted && c.type === 'income').forEach(cat => {
    ASSISTANT_RANGES.forEach(([rk, rl]) => list.push({
      kw: [`مصدر ${cat.name} كم ${rl}`, `دخل ${cat.name} ${rl}`],
      a: () => {
        const f = assistantRangeFilter(rk);
        const s = fmtByCurrency(assistantSumByCurrency(DATA.transactions.filter(t => !t.deleted && t.kind === 'income' && t.mode === 'general' && t.categoryId === cat.id && f(t))));
        return s ? `دخل "${cat.name}" ${rl}: ${s}` : `ما سجّلت دخلًا من "${cat.name}" ${rl}.`;
      }
    }));
  });
  // كل عميل — نفس الأسئلة بالضبط، حتى لو أضفت عميلًا الآن
  DATA.clients.filter(c => !c.deleted).forEach(client => {
    const projectIds = DATA.projects.filter(p => p.clientId === client.id).map(p => p.id);
    ASSISTANT_RANGES.forEach(([rk, rl]) => list.push({
      kw: [`عميل ${client.name} كم ${rl}`, `دخل ${client.name} ${rl}`],
      a: () => {
        const f = assistantRangeFilter(rk);
        const sum = DATA.transactions.filter(t => !t.deleted && t.mode === 'client' && projectIds.includes(t.projectId) && f(t)).reduce((s, t) => s + t.amount, 0);
        return sum > 0 ? `دخلك من "${client.name}" ${rl}: ${bidi(fmt(sum))} ${client.currency}` : `ما وصلك دخل من "${client.name}" ${rl}.`;
      }
    }));
  });
  // كل نوع أصل في "أموالي" — يتحدّث تلقائيًا عند إضافة/تعديل الأنواع من مركز التحكم
  DATA.assetTypes.filter(at => !at.deleted).forEach(at => list.push({
    kw: [`أصولي من نوع ${at.name} كم`, `كم عندي ${at.name}`],
    a: () => {
      const s = fmtByCurrency(assistantSumByCurrency(DATA.assets.filter(a => !a.deleted && a.type === at.id).map(a => ({ currency: a.currency, amount: assetValue(a) }))));
      return s ? `${at.icon} ${at.name} حاليًا: ${s}` : `ما عندك أصول من نوع "${at.name}" مسجّلة بعد.`;
    }
  }));
  // كل عملة نشطة — صافي ثروتك بها تحديدًا
  DATA.settings.currencies.forEach(cur => list.push({
    kw: [`صافي ثروتي ب${cur}`, `كم عندي ${cur}`],
    a: () => { const nw = computeNetWorth(cur); return `صافي ثروتك بـ${cur}: ${bidi(fmt(nw.netWorth))} ${cur} (أصول: ${bidi(fmt(nw.totalAssets))}، ديون عليك: ${bidi(fmt(nw.totalLiabilities))})`; }
  }));
  return list;
}
function getAllAssistantIntents() { return [...ASSISTANT_INTENTS, ...buildDynamicAssistantIntents()]; }
function getAssistantQuestionBank() {
  return getAllAssistantIntents().map(intent => { const base = intent.kw[0]; return { text: /[؟?]\s*$/.test(base) ? base : base + '؟', kw: intent.kw }; });
}

function matchAssistantIntent(query) {
  const nq = normalizeArabic(query);
  if (!nq) return null;
  let best = null, bestScore = 0;
  getAllAssistantIntents().forEach(intent => {
    let score = 0;
    intent.kw.forEach(k => {
      const kWords = normalizeArabic(k).split(' ').filter(Boolean);
      const matchedWords = kWords.filter(w => nq.includes(w));
      // نطابق حتى لو ترتيب الكلمات مختلف عن العبارة المحفوظة (مثال: "كم دين عليّ" تطابق "كم علي دين")
      if (kWords.length && matchedWords.length / kWords.length >= 0.8) score = Math.max(score, matchedWords.length);
    });
    if (score > bestScore) { bestScore = score; best = intent; }
  });
  return best;
}
function answerAssistantQuery(query) {
  const intent = matchAssistantIntent(query);
  if (!intent) return 'ما فهمت سؤالك بالضبط 🤔 جرّب صياغة أوضح، أو اضغط 🔍 بالأعلى وابحث بكلمة وحدة من سؤالك لتلقى أقرب سؤال جاهز. ملاحظة: الأسئلة الحرة تمامًا (خارج بياناتك وشرح التطبيق) تحتاج "الوضع الذكي الكامل" لاحقًا بمفتاح API.';
  try { return intent.a(); } catch (e) { return 'صار خطأ بسيط بجلب الجواب، جرّب مرة ثانية.'; }
}

// 3 أسئلة سريعة تظهر دائمًا فوق منطقة الإرسال (البقية تُكتشف عبر 🔍 البحث)
const ASSISTANT_SUGGESTIONS = ['كم دين عليّ؟', 'صافي هذا الشهر؟', 'تذكيراتي القادمة؟'];

function initFloatingAssistant() {
  const host = $('#assistantHost');
  host.innerHTML = `
    <button id="assistantFab" title="إسألني">
      <span class="assistant-fab-icon">💬</span><span class="assistant-fab-label">إسألني</span>
    </button>
    <div id="assistantPanel" class="hidden">
      <div class="assistant-header">
        <span>🤖 خبيرك</span>
        <div class="assistant-header-actions">
          <button id="assistantSearchBtn" title="ابحث عن سؤال">🔍</button>
          <button id="assistantCloseBtn" title="إغلاق">✕</button>
        </div>
      </div>
      <div id="assistantBody" class="assistant-body"></div>
    </div>`;
  $('#assistantFab').addEventListener('click', () => { assistantOpen = !assistantOpen; if (assistantOpen) assistantView = 'chat'; renderAssistantPanel(); });
  $('#assistantCloseBtn').addEventListener('click', () => { assistantOpen = false; renderAssistantPanel(); });
  $('#assistantSearchBtn').addEventListener('click', () => {
    assistantView = assistantView === 'search' ? 'chat' : 'search';
    assistantSearchQuery = '';
    renderAssistantPanel();
  });
  renderAssistantPanel();
}

function assistantMsgHtml(m) {
  if (m.thinking) {
    return `<div class="assistant-msg bot thinking" data-mid="${m.id}">${m.label ? `<div class="assistant-msg-caption">${escHtml(m.label)}</div>` : ''}<span class="assistant-dots"><span></span><span></span><span></span></span></div>`;
  }
  return `<div class="assistant-msg ${m.role}" data-mid="${m.id}">${(m.text || '').replace(/\n/g, '<br>')}</div>`;
}

function renderAssistantSearchResults() {
  const box = $('#assistantSearchResults'); if (!box) return;
  const nq = normalizeArabic(assistantSearchQuery);
  const list = getAssistantQuestionBank().filter(item => {
    if (!nq) return true;
    if (normalizeArabic(item.text).includes(nq)) return true;
    return item.kw.some(k => normalizeArabic(k).includes(nq));
  });
  box.innerHTML = list.length
    ? list.map(item => `<button class="assistant-search-result" data-q="${item.text.replace(/"/g, '&quot;')}">${item.text}</button>`).join('')
    : `<p class="assistant-search-empty">ما لقيت سؤالًا جاهزًا فيه هذي الكلمة 🤔 جرّب كلمة ثانية (مثلاً: دين، تذكير، PDF، هدف، مصروف...).</p>`;
  $$('.assistant-search-result', box).forEach(btn => btn.addEventListener('click', () => {
    const q = btn.dataset.q;
    assistantView = 'chat';
    renderAssistantPanel();
    sendAssistantMessage(q);
  }));
}

function renderAssistantPanel() {
  const panel = $('#assistantPanel'); if (!panel) return;
  panel.classList.toggle('hidden', !assistantOpen);
  if (!assistantOpen) return;

  const searchBtn = $('#assistantSearchBtn');
  if (searchBtn) { searchBtn.textContent = assistantView === 'search' ? '💬' : '🔍'; searchBtn.title = assistantView === 'search' ? 'رجوع للمحادثة' : 'ابحث عن سؤال'; }

  const body = $('#assistantBody'); if (!body) return;

  if (assistantView === 'search') {
    body.innerHTML = `<div class="assistant-search-view">
      <input type="text" id="assistantSearchInput" placeholder="اكتب كلمة من سؤالك، مثلاً: دين، تذكير، PDF..." value="${assistantSearchQuery.replace(/"/g, '&quot;')}">
      <p class="assistant-search-hint">ابحث بكلمة وحدة، واضغط على أي سؤال يطلع لك ليجاوبك مباشرة.</p>
      <div class="assistant-search-results" id="assistantSearchResults"></div>
    </div>`;
    const sInput = $('#assistantSearchInput');
    sInput.addEventListener('input', () => { assistantSearchQuery = sInput.value; renderAssistantSearchResults(); });
    sInput.focus();
    const v = sInput.value; sInput.value = ''; sInput.value = v; // يضع المؤشر بنهاية النص
    renderAssistantSearchResults();
    return;
  }

  body.innerHTML = `
    <div id="assistantMessages" class="assistant-messages"></div>
    <div class="assistant-suggestions" id="assistantSuggestions"></div>
    <div id="assistantInputArea"></div>`;

  const box = $('#assistantMessages');
  box.innerHTML = assistantMessages.map(assistantMsgHtml).join('');
  box.scrollTop = box.scrollHeight;

  $('#assistantSuggestions').innerHTML =
    ASSISTANT_SUGGESTIONS.map(q => `<button class="assistant-chip" data-sq="${q.replace(/"/g, '&quot;')}">${q}</button>`).join('')
    + `<button class="assistant-chip assistant-chip-more" id="assistantMoreBtn">➕ المزيد من الأسئلة</button>`;
  $$('.assistant-chip[data-sq]', $('#assistantSuggestions')).forEach(el => el.addEventListener('click', () => sendAssistantMessage(el.dataset.sq)));
  const moreBtn = $('#assistantMoreBtn');
  if (moreBtn) moreBtn.addEventListener('click', () => { assistantView = 'search'; assistantSearchQuery = ''; renderAssistantPanel(); });

  const inputArea = $('#assistantInputArea');
  const hasApi = DATA.settings.aiProviders && DATA.settings.aiProviders.length > 0;
  if (hasApi) {
    inputArea.innerHTML = `<div class="assistant-input-row">
      <input type="text" id="assistantInput" placeholder="اكتب سؤالك هنا...">
      <button id="assistantSendBtn">إرسال</button>
    </div>`;
    $('#assistantSendBtn').addEventListener('click', () => sendAssistantMessage());
    $('#assistantInput').addEventListener('keydown', (e) => { if (e.key === 'Enter') sendAssistantMessage(); });
    $('#assistantInput').focus();
  } else {
    inputArea.innerHTML = `<div class="assistant-disabled-hint">🔒 الكتابة الحرة مقفولة حاليًا، وتتفعّل تلقائيًا بمجرد ما تضيف مفتاح API واحد من الإعدادات ← 🧠 "الوضع الذكي الكامل". لحد ذلك الوقت، استخدم 🔍 البحث بالأعلى أو الأسئلة الجاهزة تحت — كلها مجرَّبة وتجاوب فورًا ومحليًا بدون إنترنت.</div>`;
  }
}

function eligibleAiProviders() {
  const now = Date.now();
  return DATA.settings.aiProviders.filter(p => p.enabled && (!p.failedUntil || p.failedUntil < now));
}

// يكشف الجواب تدريجيًا (حرفًا حرفًا) بدل ظهوره دفعة واحدة، حتى يبدو المساعد وكأنه يكتب فعليًا
function typeOutAnswer(text, msgObj) {
  return new Promise(resolve => {
    const total = text.length;
    if (!total) { resolve(); return; }
    const step = Math.max(1, Math.ceil(total / 220)); // يسرّع تدريجيًا على الأجوبة الطويلة حتى لا يطول الانتظار
    let i = 0;
    const box = $('#assistantMessages');
    const tick = () => {
      i += step;
      const shown = text.slice(0, Math.min(i, total));
      msgObj.text = shown;
      const bubble = document.querySelector(`.assistant-msg[data-mid="${msgObj.id}"]`);
      if (bubble) bubble.innerHTML = shown.replace(/\n/g, '<br>');
      if (box) box.scrollTop = box.scrollHeight;
      if (i >= total) { resolve(); return; }
      setTimeout(tick, 16);
    };
    tick();
  });
}

async function sendAssistantMessage(customText) {
  const existingInput = $('#assistantInput');
  const q = (customText != null ? String(customText) : (existingInput ? existingInput.value : '')).trim();
  if (!q) return;
  assistantMessages.push({ id: uid(), role: 'user', text: q });
  if (existingInput) existingInput.value = '';
  assistantView = 'chat';
  renderAssistantPanel();

  // فقاعة "يفكّر" (نقاط متحركة) تظهر فورًا قبل أي حساب أو انتظار
  const thinkingMsg = { id: uid(), role: 'bot', thinking: true, label: null };
  assistantMessages.push(thinkingMsg);
  renderAssistantPanel();

  const localIntentMatched = !!matchAssistantIntent(q);
  let finalText;

  if (localIntentMatched || !DATA.settings.aiSmartModeEnabled) {
    // جواب محلي فوري فعليًا — ننتظر لحظة قصيرة فقط حتى تبدو حركة "التفكير" طبيعية بدل قفزة مفاجئة
    await new Promise(r => setTimeout(r, 550 + Math.random() * 350));
    finalText = answerAssistantQuery(q);
  } else {
    const providers = eligibleAiProviders();
    if (!providers.length) {
      await new Promise(r => setTimeout(r, 400));
      const hasAny = DATA.settings.aiProviders.length > 0;
      finalText = hasAny
        ? '⏳ ما فهمت سؤالك محليًا، وكل نماذجك متوقفة مؤقتًا حاليًا (بعد فشل أخير — يُعاد تفعيلها تلقائيًا خلال ساعة). تقدر تضغط "اختبار" بجانب أي نموذج بالإعدادات لإعادة تفعيله فورًا لو صلّحت المشكلة.'
        : 'ما فهمت سؤالك محليًا، وما عندك أي نموذج ذكاء اصطناعي مضاف بعد. أضف واحدًا من الإعدادات ← "الوضع الذكي الكامل"، أو جرّب 🔍 البحث للوصول لأقرب سؤال جاهز.';
    } else {
      // ما فيه تطابق محلي، والوضع الذكي مفعّل وفيه نموذج متاح فعلًا ← يجرّب النماذج بالترتيب المحفوظ
      thinkingMsg.label = '🌐 يفكّر عبر النموذج الذكي...';
      renderAssistantPanel();
      let res;
      try {
        res = await Platform.aiChat(providers, q);
      } catch (e) {
        res = { ok: false, failed: [{ id: providers[0] && providers[0].id, error: String((e && e.message) || e) }] };
      }
      if (res.failed && res.failed.length) {
        const now = Date.now();
        res.failed.forEach(f => { const p = DATA.settings.aiProviders.find(x => x.id === f.id); if (p) { p.failedUntil = now + 60 * 60 * 1000; p.lastError = f.error; } });
        persist(true);
      }
      if (res.ok) finalText = '🌐 ' + res.text;
      else {
        const lastErr = res.failed && res.failed.length ? res.failed[res.failed.length - 1].error : 'خطأ غير معروف';
        finalText = `كل النماذج المتاحة فشلت الآن. آخر خطأ: ${lastErr}\nراجع مفاتيحك بالإعدادات أو جرّب زر "اختبار" هناك لمعرفة السبب بالضبط.`;
      }
    }
  }

  const idx = assistantMessages.findIndex(m => m.id === thinkingMsg.id);
  if (idx === -1) return; // احتياط: لو تغيّرت القائمة أثناء الانتظار (مثلًا تجاوزت الحد الأقصى)
  const realMsg = { id: thinkingMsg.id, role: 'bot', text: '' };
  assistantMessages[idx] = realMsg;
  renderAssistantPanel();
  await typeOutAnswer(finalText, realMsg);
  if (assistantMessages.length > 60) assistantMessages.splice(0, assistantMessages.length - 60);
}

// بوابة الدخول: قبل ما نحمّل أي بيانات أو نرسم أي واجهة، نتأكد إن في جلسة
// محفوظة صالحة. ⚠️ هذا الفحص محلي بالكامل وما ينتظر أي شبكة أبدًا — الشرط
// الوحيد اللي يوقف الدخول هو عدم وجود جلسة إطلاقًا، أو مرور 6 أشهر كاملة
// بلا فتح التطبيق (راجع isSessionStale بملف auth.js). انقطاع النت وحده
// أبدًا لا يمنع فتح التطبيق أو يطلب تسجيل دخول من جديد.
// ملاحظة: هذا يتحكم فقط بمن يقدر يفتح التطبيق — بيانات RD Flow نفسها لسا
// محفوظة محليًا بنفس آلية Platform.load/save القديمة، بدون أي تغيير.
async function boot() {
  // قبل أي فحص، نرجّع نسخة الجلسة الدائمة (المحفوظة جوا نفس ملف بيانات
  // التطبيق المضمون) للـlocalStorage لو انمسحت لأي سبب — هذا يمنع "يطلب
  // تسجيل دخول كل مرة" حتى لو تخزين المتصفح نفسه انمسح
  if (Platform.platformName === 'demo') { showDemoBanner(); await bootApp(); return; } // وضع التجربة: لا تسجيل دخول إطلاقًا
  if (window.Auth && Auth.restoreFromDurableIfNeeded) await Auth.restoreFromDurableIfNeeded();
  const session = window.Auth ? await Auth.ensureValidSession() : null;
  if (!session) {
    window.Auth.mount(() => bootApp());
    return;
  }
  if (window.Auth && Auth.touchLastOpened) Auth.touchLastOpened(); // يجدّد عداد الأشهر الـ6 — فتح التطبيق بنجاح (بنت أو بدونه) يكفي
  await bootApp();
}

async function bootApp() {
  DEVICE_ID = await Platform.deviceId();
  DATA = await Platform.load();
  // مزامنة: نجيب نسخة الحساب من Supabase وندمجها مع النسخة المحلية قبل أي رسم.
  // لو ما فيه نت أو ما فيه sync.js أصلاً، هذا السطر يرجّع نفس DATA المحلية بدون توقف.
  // وضع التجربة: لا مزامنة ولا حساب إطلاقًا — نتجاوز هذا القسم بالكامل
  if (window.Sync && Platform.platformName !== 'demo') {
    DATA = await Sync.pullAndMerge(DATA);
    await Platform.save(DATA);
    Sync.pingKeepAlive();
    // ⚠️ إصلاح جوهري: لو تسكّرت التطبيق وانت أوفلاين بعد ما ضفت عمليات (فشل
    // رفعها وقتها)، علامة "فيه رفع فاشل معلّق" (hasFailedPush) هي متغيّر بالذاكرة
    // بس — تنمسح كليًا لما التطبيق يتسكر، فحتى لو رجع النت، محاولة إعادة الرفع
    // التلقائية (اللي بتعتمد عليها بـinitPeriodicSync) ما عندها أي فكرة إنه
    // فيه شي معلّق أصلًا، وتبقى العمليات القديمة عالقة محليًا بلا رفع للأبد إلا
    // لو ضفت عملية جديدة تشغّل دورة رفع من الصفر. الحل: نرفع دايمًا مرة وحدة هنا
    // عند كل فتح للتطبيق (push() نفسها فيها سحب+دمج داخلي قبل الإرسال، فمضمونة
    // ما تكتب فوق أي تغيير جهاز ثاني حتى لو استخدمناها بلا شرط كذا)
    if (Sync.pushNow) Sync.pushNow(DATA);
  }
  DATA.labels = Object.assign({}, DEFAULT_LABELS, DATA.labels || {}); // يملأ أي عنوان ناقص من نسخة قديمة محفوظة
  DATA.meta = DATA.meta || {}; DATA.meta.seenDates = DATA.meta.seenDates || [];
  DATA.investments = DATA.investments || [];
  DATA.settings.investmentInitial = DATA.settings.investmentInitial || {};
  DATA.settings.exchangeRates = DATA.settings.exchangeRates || {};
  DATA.zakatPayments = DATA.zakatPayments || [];
  DATA.settings.years = DATA.settings.years || [];
  DATA.settings.theme = DATA.settings.theme || 'black';
  DATA.notifications = DATA.notifications || [];
  DATA.settings.autoSaveEnabled = DATA.settings.autoSaveEnabled !== false; // مفعّل افتراضيًا
  DATA.settings.disabledSections = DATA.settings.disabledSections || [];
  DATA.settings.navOrder = DATA.settings.navOrder || NAV_ITEMS.map(([k]) => k);
  DATA.plans = DATA.plans || []; // خطط/أهداف دورية: { id, kind:'routine'|'goal', title, recurrence, time, weekday, dayOfMonth, targetDate, notes, progressLog, nextReminderAt, notifiedAt, status, flagged, createdAt, updatedAt, deleted }
  DATA.priceItems = DATA.priceItems || []; // بنود قائمة الأسعار: { id, market, videoType, unit, basePrice, currency, notes, deleted }
  DATA.priceAddons = DATA.priceAddons || []; // خيارات/عوامل تسعير حرة (يضيفها المستخدم بنفسه): { id, name, price, currency, unit:'fixed'|'perUnit', notes, deleted }
  DATA.quotes = DATA.quotes || []; // عروض أسعار محسوبة ومحفوظة: { id, market, videoType, description, complexity, duration, rushPct, discountPct, currency, total, addons:[{name,amount}], clientId, projectId, createdAt, deleted }
  DATA.pricingPresets = DATA.pricingPresets || []; // قوالب مشاريع جاهزة لتعبئة الحاسبة سريعًا: { id, name, itemId, qty, complexity, rush, discount, priceOverride, addons:[{id, price}], description, createdAt, deleted }
  DATA.settings.aiProviders = DATA.settings.aiProviders || []; // نماذج الذكاء الاصطناعي الاختيارية بترتيب الأولوية: { id, provider, label, apiKey, model, endpoint, enabled, failedUntil }
  if (DATA.settings.aiSmartModeEnabled === undefined) DATA.settings.aiSmartModeEnabled = false;
  DATA.assets = DATA.assets || []; // أصول يدوية: { id, type:'cash'|'bank'|'card'|'ewallet'|'project'|'other', name, currency, value, lastUpdatedAt, notes, deleted }
  DATA.assetTransfers = DATA.assetTransfers || []; // تحويلات بين أصولك الخاصة: { id, fromAssetId, toAssetId, amount, currency, date, note, createdAt, deleted }
  DATA.assetOps = DATA.assetOps || []; // عمليات داخل كل أصل (نافذة الأصل): { id, assetId, kind:'in'|'out'|'adjust'|'transfer_in'|'transfer_out', amount (موجب=دخل/سالب=خروج), who (اسم اختياري: شخص/مصدر), date, note, transferId, counterAssetId, createdAt, updatedAt, deleted } — قيمة الأصل الحالية = a.value (رصيد افتتاحي قديم) + مجموع عملياته
  DATA.assetTypes = DATA.assetTypes || DEFAULT_ASSET_TYPES.map(t => ({ ...t })); // أنواع الأصول قابلة للتعديل من مركز التحكم: { id, icon, name }
  DATA.assetSnapshots = DATA.assetSnapshots || []; // لقطات يومية لصافي الثروة: { id:'snap_YYYY-MM-DD', date:'YYYY-MM-DD', netWorth:{DA:120000,...}, updatedAt, deleted } — تتزامن
  DATA.syncFlags = DATA.syncFlags || []; // حالات صغيرة تتزامن: مقروء الجرس + علامات مقارنة الشهر
  DATA.recurringTx = DATA.recurringTx || []; // عمليات متكررة تلقائية: { id, kind:'income'|'expense', categoryId, amount, currency, dayOfMonth, note, active, lastGeneratedYM, createdAt, deleted }
  DATA.weeklySchedule = DATA.weeklySchedule || { 0: [], 1: [], 2: [], 3: [], 4: [], 5: [], 6: [] }; // جدول أسبوعي متكرر: يوم(0-6) → [{id, from, to, title}]
  DATA.dailySchedule = DATA.dailySchedule || []; // جدول يومي متكرر (قائمة واحدة تتكرر كل يوم): [{id, from, to, title}]
  DATA.quarterlySchedule = DATA.quarterlySchedule || { 1: [], 2: [], 3: [], 4: [] }; // جدول فصلي: فصل(1-4) → [{id, from, to, title}]
  DATA.yearlySchedule = DATA.yearlySchedule || { 1: [], 2: [], 3: [], 4: [], 5: [], 6: [], 7: [], 8: [], 9: [], 10: [], 11: [], 12: [] }; // جدول سنوي: شهر(1-12) → [{id, from, to, title}]
  DATA.settings.scheduleModesEnabled = DATA.settings.scheduleModesEnabled || { daily: true, weekly: true, quarterly: true, yearly: true };
  if (DATA.settings.scheduleReminderEnabled === undefined) DATA.settings.scheduleReminderEnabled = true;
  DATA.settings.scheduleReminderTime = DATA.settings.scheduleReminderTime || '08:00';
  DATA.meta.lastScheduleNotifyDate = DATA.meta.lastScheduleNotifyDate || null;
  // نظام المواعيد: أنواع خدمات حرة يضيفها المستخدم (ليست مقتصرة على مهنة معيّنة)، مواعيد محجوزة، ساعات دوام أسبوعية، وفاصل راحة بين موعد وآخر
  DATA.serviceTypes = DATA.serviceTypes || []; // { id, name, durationMin, deleted }
  DATA.appointments = DATA.appointments || []; // { id, serviceTypeId, customTitle, clientName, date, startTime, endTime, recurEveryDays, notes, createdAt, updatedAt, deleted }
  DATA.settings.workHours = DATA.settings.workHours || { 0: { enabled: true, start: '09:00', end: '20:00' }, 1: { enabled: true, start: '09:00', end: '20:00' }, 2: { enabled: true, start: '09:00', end: '20:00' }, 3: { enabled: true, start: '09:00', end: '20:00' }, 4: { enabled: true, start: '09:00', end: '20:00' }, 5: { enabled: false, start: '09:00', end: '20:00' }, 6: { enabled: true, start: '09:00', end: '20:00' } };
  DATA.settings.appointmentBufferMin = DATA.settings.appointmentBufferMin ?? 10;
  DATA.meta.scheduleNotifyMarkers = DATA.meta.scheduleNotifyMarkers || { daily: null, weekly: null, quarterly: null, yearly: null };
  DATA.debts = DATA.debts || []; // ديون: { id, type:'i_owe'|'they_owe_me', name, amount, currency, ... } - لازم تكون معرّفة قبل أي استخدام لها بالأسفل
  if (!DATA.settings.debtTypesMigrated) { // ترحيل تسميات نوع الدين القديمة المربكة مرة واحدة فقط
    DATA.debts.forEach(d => { d.type = d.type === 'owed_to_me' ? 'i_owe' : d.type === 'i_owe' ? 'they_owe_me' : d.type; });
    DATA.settings.debtTypesMigrated = true;
  }
  if (!DATA.settings.categoryColorsMigrated) { // إصلاح تكرار نفس اللون (الأزرق الافتراضي غالبًا) بين فئات مختلفة، مرة واحدة فقط
    const colorCount = {};
    DATA.categories.filter(c => !c.deleted).forEach(c => { const col = c.color || '#4f7cff'; colorCount[col] = (colorCount[col] || 0) + 1; });
    const seenSoFar = {};
    DATA.categories.filter(c => !c.deleted).forEach(c => {
      const col = c.color || '#4f7cff';
      seenSoFar[col] = (seenSoFar[col] || 0) + 1;
      if (!c.color || (colorCount[col] > 1 && seenSoFar[col] > 1)) c.color = nextCategoryColor();
    });
    DATA.settings.categoryColorsMigrated = true;
  }
  DATA.settings.performanceMode = DATA.settings.performanceMode || 'auto'; // 'auto' | 'high' | 'low'
  DATA.settings.autoBackupEnabled = DATA.settings.autoBackupEnabled !== false; // نسخة احتياطية محلية تلقائية يوميًا (نسختين بس) — مفعّلة افتراضيًا. الإعداد (تفعيل/إيقاف) نفسه يتزامن بين الأجهزة زي باقي الإعدادات؛ اللي يبقى محليًا بحتًا هو فعل كتابة ملف النسخة نفسه (ما يحتاج نت)
  DATA.settings.clientsPageMode = DATA.settings.clientsPageMode || 'clients';
  DATA.settings.monthComparisonAlertsEnabled = DATA.settings.monthComparisonAlertsEnabled !== false;
  DATA.monthComparisonLog = DATA.monthComparisonLog || [];
  ensureSyncExtras(); // مقروء الجرس + علامات مقارنة الشهر + لقطات صافي الثروة: صارت تتزامن بين الأجهزة
  purgeOldTombstones();
  const thisYear = new Date().getFullYear();
  if (!DATA.settings.years.includes(thisYear)) DATA.settings.years.push(thisYear);
  DATA.settings.years.sort((a, b) => b - a);

  investCurrency = DATA.settings.currencies[0];
  statsCurrency.income = DATA.settings.currencies[0];
  statsCurrency.expense = DATA.settings.currencies[0];

  applyTheme();
  applyPerfMode();
  buildNav();
  bindGlobalEvents();
  renderTopbarAccount();
  initAutoGrowTextareas();
  initNavScroll(); // شريط الأقسام يتمرّر أفقيًا عند ضيق المساحة/طول الأسماء
  initNavAutoHide(); // يخفي شريط التبويبات عند التمرير للأسفل ويظهره عند التمرير للأعلى (مهم على الشاشات الضيقة بعد ما صار التبويبات بصف مستقل تحت الترويسة)
  initFancyDateObserver(); // يفعّل منتقي التاريخ/الوقت الفخم على كل حقول التاريخ الحالية والمستقبلية تلقائيًا
  showView(!DATA.settings.disabledSections.includes('dashboard') ? 'dashboard' : (orderedNavItems().find(([k]) => k === 'settings' || !DATA.settings.disabledSections.includes(k)) || ['settings'])[0]);
  updateNotifBadge();
  pruneReadFlags();
  initFloatingAssistant();
  snapshotHistory(); // نقطة البداية للتراجع/التقدّم
  scheduleAutoSave();
  setInterval(checkReminders, 10 * 1000);
  checkReminders();
  generateDueRecurringTx(); // يعوّض أي اقتطاعات شهرية فاتتك أثناء غياب التطبيق
  setInterval(generateDueRecurringTx, 6 * 60 * 60 * 1000); // فحص إضافي كل بضع ساعات للجلسات الطويلة المفتوحة عبر منتصف الليل
  Platform.onNavigate?.((view) => {
    goToNotifTarget(view); // يدعم كل أنواع الانتقال (n:{...} وسلاسل الجدول والمواعيد القديمة)
  });
  if (Platform.platformName !== 'demo') initPeriodicSync(); // يجيب أي تحديث من جهاز ثاني بدون ما تحتاج تعيد فتح التطبيق — لا داعي له بوضع التجربة
  if (window.Sync && Sync.setOnMerged && Platform.platformName !== 'demo') {
    Sync.setOnMerged((merged) => {
      // الرفع نفسه اكتشف تغييرات من جهاز ثاني (عبر سحبه التمهيدي) — نحدّث
      // الشاشة فورًا بدل ما ننتظر دورة السحب الدورية العادية
      DATA = merged;
      Platform.save(DATA);
      lastPersistedSnapshot = snapshotMergeArrays();
      lastAutoSaveFingerprint = dataFingerprintForAutoSave();
      applyTheme(); applyPerfMode(); buildNav(); updateNotifBadge();
      render(activeView);
    });
  }
  lastPersistedSnapshot = snapshotMergeArrays(); // خط أساس البيانات فور اكتمال التحميل والدمج الأولي، قبل أي تعديل من المستخدم
  lastAutoSaveFingerprint = dataFingerprintForAutoSave(); // نفس الفكرة، لتفادي أول "تكة" حفظ دوري وهمية بعد فتح التطبيق مباشرة
  if (Platform.platformName !== 'demo') checkDailyAutoBackup(); // نسخة احتياطية محلية تلقائية — لا معنى لها بوضع التجربة (لا قرص يُكتب إليه)
}
// شريط علوي ثابت يوضّح أن هذه بيانات تجريبية لا تُحفظ، مع زر يوجّه لتحميل التطبيق الحقيقي
function showDemoBanner() {
  const b = document.getElementById('demoBanner'); if (!b) return;
  b.classList.remove('hidden');
  const btn = document.getElementById('demoDownloadBtn');
  if (btn) btn.addEventListener('click', () => { toast(DEMO_DOWNLOAD_URL ? '' : 'رابط التحميل سيُضاف قريبًا'); if (DEMO_DOWNLOAD_URL) location.href = DEMO_DOWNLOAD_URL; });
}
// نفس الرابط الموجود بـupdate-check.js (SITE_URL) وpackage.json (build.publish.url) — استبدل الثلاثة معًا عند تجهيز الاستضافة
const SITE_URL = (window.UpdateCheck && UpdateCheck.getSiteUrl) ? UpdateCheck.getSiteUrl() : 'https://REPLACE-ME.github.io/rdflow-site/';
const DEMO_DOWNLOAD_URL = SITE_URL;

// نسخة احتياطية محلية تلقائية، مرة وحدة باليوم بالكثير، بلا أي علاقة بمزامنة
// السحابة (ملف يُنسخ لملف تاني بنفس الجهاز فقط). نتحقق أول شي هل صار نسخ
// اليوم أصلًا (عبر localStorage، محلي بحت) قبل ما نكلّف الجهاز بأي شغل زيادة
async function checkDailyAutoBackup() {
  if (!DATA.settings.autoBackupEnabled) return;
  if (!window.Platform || !Platform.autoBackup) return;
  const today = todayISO();
  if (localStorage.getItem('rdflow_last_auto_backup_date') === today) return;
  const res = await Platform.autoBackup(DATA);
  if (res && res.ok) localStorage.setItem('rdflow_last_auto_backup_date', today);
}

// مزامنة خفيفة أثناء الاستخدام: كل 30 ثانية، وأيضًا فور ما ترجع للتطبيق (تبديل
// نافذة/تطبيق ثم رجوع) — طلب شبكة صغير واحد بس، ولا يعمل أي شي مرئي إذا ما
// فيه جديد فعلي (يقارن النتيجة قبل ما يعيد الرسم، فما فيه "ثقل" محسوس)
let _syncInFlight = false;
async function initPeriodicSync() {
  if (!window.Sync) return;
  const runOnce = async () => {
    if (_syncInFlight) return;
    if (window.Sync && Sync.isPushPending && Sync.isPushPending()) return; // فيه رفع لسا معلّق، ننتظره قبل أي سحب
    _syncInFlight = true;
    console.log('🔄 RD-SYNC: دورة فحص جديدة بدأت');
    try {
      const before = JSON.stringify(window.Sync.normalize ? Sync.normalize(DATA) : DATA);
      const merged = await Sync.pullAndMerge(DATA);
      if (JSON.stringify(window.Sync.normalize ? Sync.normalize(merged) : merged) !== before) {
        DATA = merged;
        await Platform.save(DATA);
        lastPersistedSnapshot = snapshotMergeArrays(); // الدمج نفسه هو الحقيقة الجديدة، ما نحتاج نلمس تواريخه
        lastAutoSaveFingerprint = dataFingerprintForAutoSave();
        applyTheme(); applyPerfMode(); buildNav(); updateNotifBadge();
        render(activeView);
        toast('تحديثات جديدة من جهاز آخر');
      }
      // نفس الدورة نستغلها لجيب آخر اسم/صورة للحساب — بدون انتظار تجديد
      // الجلسة الطبيعي (اللي يصير مرة كل ساعة تقريبًا وهو سبب تأخر ظهور
      // الصورة الشخصية بين الأجهزة)
      if (window.Auth && Auth.fetchLatestUser) {
        const beforeAvatar = window.Auth.getSession && window.Auth.getSession().user.avatar_url;
        const updated = await Auth.fetchLatestUser();
        if (updated && updated.user.avatar_url !== beforeAvatar) renderTopbarAccount();
      }
      // ⚠️ لو آخر محاولة رفع فشلت (كان النت مقطوع وقتها تحديدًا)، التعديلات
      // المحلية (زي عمليات أضفتها وانت أوفلاين) تفضل محفوظة بجهازك بس ما
      // توصل للجهاز الثاني إلا بتعديل جديد يشغّل رفع من الصفر. هالسطر يعيد
      // محاولة الرفع تلقائيًا أول ما توصل هالدورة الدورية (كل 30 ثانية، أو
      // فورًا لو رجعت للتطبيق) بدل ما تبقى العمليات القديمة معلّقة للأبد
      if (window.Sync && Sync.hasUnsyncedChanges && Sync.hasUnsyncedChanges()) {
        Sync.pushNow(DATA);
      }
    } catch (e) { /* بدون نت أو أي خلل مؤقت: نتجاهل ونحاول تاني بالدورة الجاية */ }
    _syncInFlight = false;
  };
  setInterval(runOnce, 30000);
  document.addEventListener('visibilitychange', () => { if (!document.hidden) runOnce(); });
  window.addEventListener('focus', runOnce);

  // ⚠️ على أندرويد تحديدًا: أحداث DOM العادية (visibilitychange/focus) مو
  // مضمونة تنطلق صح لما التطبيق يرجع من الخلفية جوا WebView حقيقي — الطريقة
  // الموثوقة هي استماع دورة حياة Android نفسها عبر إضافة Capacitor الأساسية
  // "App" (يفترض أنها مركّبة أصلًا بأي مشروع Capacitor عادي؛ إن ما كانت
  // موجودة، هالسطر ما يعمل شي وما يكسر شي — يحتاج وقتها `npm i @capacitor/app`
  // ثم `npx cap sync android`). هذا يخلي أي تحديث وصل من جهاز ثاني وأنت
  // بعيد عن التطبيق يظهر لك فورًا لحظة ما ترجّعه، بدل انتظار لين 30 ثانية
  const CapApp = window.Capacitor && window.Capacitor.Plugins && window.Capacitor.Plugins.App;
  if (CapApp && CapApp.addListener) {
    CapApp.addListener('resume', () => {
      if (window.Auth && Auth.touchLastOpened) Auth.touchLastOpened();
      runOnce();
    });
    // زر الرجوع بأندرويد: بلا هذا المستمع، أندرويد يتصرف بسلوكه الافتراضي غير
    // المضمون جوا تطبيق صفحة واحدة بلا تنقّل متصفح حقيقي (كان يتسبب بسلوك
    // غير متوقع). الآن صريح: يقفل أي نافذة/لوحة مفتوحة أولًا، وإلا يرجع
    // للرئيسية، وإلا يخرج من التطبيق — لا علاقة له بتراجع/إعادة البيانات إطلاقًا
    CapApp.addListener('backButton', () => {
      const openPanels = ['#assetAllocPanel', '#updateBlockScreen', '#confirmPanel', '#notifPanel'];
      for (const sel of openPanels) {
        const el = $(sel);
        if (el && !el.classList.contains('hidden')) {
          if (sel === '#assetAllocPanel') return; // نافذة توزيع الأصول إلزامية — لا تُغلق بزر الرجوع
          el.classList.add('hidden');
          return;
        }
      }
      const openDetail = document.querySelector('main details[open]');
      if (openDetail) { openDetail.removeAttribute('open'); return; }
      if (activeView !== 'dashboard') { showView('dashboard'); return; }
      CapApp.exitApp();
    });
  }
}

function navigateToScheduleToday(navTarget) {
  const mode = navTarget.includes(':') ? navTarget.split(':')[1] : 'weekly';
  scheduleActiveMode = mode;
  const now = new Date();
  if (mode === 'weekly') scheduleActiveBucket.weekly = now.getDay();
  else if (mode === 'quarterly') scheduleActiveBucket.quarterly = Math.floor(now.getMonth() / 3) + 1;
  else if (mode === 'yearly') scheduleActiveBucket.yearly = now.getMonth() + 1;
  planningTab = 'schedule'; showView('planning');
}
/* ============================================================
   🔔 مركز الإشعارات الموحّد
   يجمع في نافذة الجرس كل تنبيهات وتذكيرات التطبيق بلا استثناء — الواصلة والقادمة، المفعَّلة والمعطَّلة، المُضافة بيدك والتلقائية،
   ومنها ما يظهر في الرئيسية — في "نوافذ" لكل قسم: غير المقروء أولًا، والمقروء تحت «عرض المزيد». والضغط على أي عنصر يأخذك إلى قسمه/عنصره مباشرة.
   المصادر: (1) سجل الإشعارات الواصلة DATA.notifications  (2) عناصر حيّة تُحسب من البيانات لحظة الفتح (تذكيرات قادمة، تنبيهات مُعدّة، حالات، مؤشرات الرئيسية…)
   ============================================================ */
const NOTIF_SECTIONS = [
  { id: 'home', icon: '🏠', name: 'الرئيسية — تنبيهات ذكية' },
  { id: 'flagged', icon: '⭐', name: 'المهم (المعلَّم)' },
  { id: 'calendar', icon: '📅', name: 'الرزنامة' },
  { id: 'notes', icon: '📝', name: 'المذكرة' },
  { id: 'debts', icon: '💳', name: 'الديون' },
  { id: 'clients', icon: '👥', name: 'العملاء' },
  { id: 'planning', icon: '🎯', name: 'التخطيط والأهداف' },
  { id: 'schedule', icon: '🗓️', name: 'الجدول' },
  { id: 'appointments', icon: '🕐', name: 'المواعيد' },
  { id: 'wealth', icon: '🏦', name: 'أموالي' },
  { id: 'outflows', icon: '🕌', name: 'الإخراجات' },
  { id: 'smart', icon: '🔔', name: 'التنبيهات الذكية' },
  { id: 'stats', icon: '📊', name: 'إحصائيات' },
  { id: 'other', icon: '🔖', name: 'أخرى' },
];
const NOTIF_CAT_TO_SECTION = { 'الرزنامة': 'calendar', 'المذكرة': 'notes', 'الديون': 'debts', 'العملاء': 'clients', 'التخطيط': 'planning', 'الجدول': 'schedule',
  'المواعيد': 'appointments', 'التنبيهات الذكية': 'smart', 'إحصائيات': 'stats', 'أموالي': 'wealth' };
const NOTIF_STATE = { fired: ['وصل', 0], due: ['حان وقته', 1], warn: ['يحتاج انتباه', 2], pending: ['معلّق', 3], upcoming: ['قادم', 4], active: ['مفعّل', 5], info: ['معلومة', 6], disabled: ['معطّل', 7] };

// نداءات الانتقال: كائن { v: القسم، tab، mode، panels، focus، ym/mtab/day، sched/today } — يُخزَّن مع الإشعار ويُنقل كنص إلى إشعار النظام
function notifNavToString(nav) { return nav ? 'n:' + JSON.stringify(nav) : null; }
function parseNotifNav(x) {
  if (!x) return null;
  if (typeof x === 'object') return x;
  if (x.startsWith('n:')) { try { return JSON.parse(x.slice(2)); } catch (e) { return null; } }
  if (x.startsWith('schedule-today')) return { v: 'planning', tab: 'schedule', sched: x.includes(':') ? x.split(':')[1] : 'weekly', today: true };
  if (x === 'planning-appointments') return { v: 'planning', tab: 'appointments' };
  return null;
}
function defaultNavForCategory(cat) {
  switch (NOTIF_CAT_TO_SECTION[cat]) {
    case 'calendar': return { v: 'calendar' };
    case 'notes': return { v: 'notes' };
    case 'debts': return { v: 'clients', mode: 'debts' };
    case 'clients': return { v: 'clients', mode: 'clients' };
    case 'planning': return { v: 'planning', tab: 'plans' };
    case 'schedule': return { v: 'planning', tab: 'schedule' };
    case 'appointments': return { v: 'planning', tab: 'appointments' };
    case 'smart': return { v: 'control', panels: ['ctrl_alerts'], focus: 'panel:ctrl_alerts' };
    case 'wealth': return { v: 'wealth', tab: 'recurring' };
    default: return { v: 'dashboard' };
  }
}
function focusByToken(token) {
  const view = document.querySelector('.view.active'); if (!view || !token) return false;
  let el = null;
  if (token.startsWith('panel:')) el = view.querySelector(`details[data-panel="${token.slice(6)}"]`);
  else if (token.startsWith('day:')) el = view.querySelector(`.day-group[data-date="${token.slice(4)}"]`);
  else el = Array.from(view.querySelectorAll('[data-focus]')).find(x => x.dataset.focus === token);
  if (!el) return false;
  for (let p = el; p && p !== view; p = p.parentElement) { if (p.tagName === 'DETAILS') p.open = true; } // يفتح النوافذ المطويّة التي تحتويه
  el.scrollIntoView({ behavior: 'smooth', block: 'center' });
  el.classList.remove('jump-highlight'); void el.offsetWidth; el.classList.add('jump-highlight');
  setTimeout(() => el.classList.remove('jump-highlight'), 1800);
  return true;
}
function goToNotifTarget(navIn) {
  const nav = parseNotifNav(navIn);
  if (!nav || !nav.v) return;
  closeNotifPanel();
  (nav.panels || []).forEach(k => setPanelOpen(k, true));
  if (nav.v === 'planning') { if (nav.tab) planningTab = nav.tab; if (nav.sched) scheduleActiveMode = nav.sched; }
  if (nav.v === 'clients' && nav.mode && DATA.settings.clientsPageMode !== nav.mode) { DATA.settings.clientsPageMode = nav.mode; persist(); }
  if (nav.v === 'wealth' && nav.tab) wealthTab = nav.tab;
  if (nav.v === 'yearly' && nav.ym) {
    navYear = nav.ym[0]; navMonth = nav.ym[1]; monthTab = nav.mtab || 'income';
    if (nav.day && (monthTab === 'income' || monthTab === 'expense')) openDays.add(nav.day + '_' + monthTab);
  }
  if (nav.today && nav.sched) navigateToScheduleToday('schedule-today:' + nav.sched); else showView(nav.v);
  if (DATA.settings.disabledSections.includes(nav.v)) toast('هذا القسم معطَّل من الإعدادات — فُتح للاطلاع فقط');
  if (nav.focus) { requestAnimationFrame(() => { if (!focusByToken(nav.focus)) setTimeout(() => focusByToken(nav.focus), 250); }); }
}
/* ---------- حالات صغيرة تتزامن بين الأجهزة (DATA.syncFlags) ----------
   كل سجل: { id, type:'read'|'mc', key, on, deleted, updatedAt } — المعرّف ثابت من (النوع + المفتاح) فيندمج بين الأجهزة بدل أن يتكرر.
   'read' = حالة «مقروء» للعناصر الحيّة في الجرس · 'mc' = علامة «أُرسل تنبيه مقارنة هذا الشهر» (حتى لا يصل مرتين من جهازين) */
function _fh(str, mul) { let h = 7; for (let i = 0; i < str.length; i++) h = (h * mul + str.charCodeAt(i)) | 0; return (h >>> 0).toString(36); }
function syncFlagId(type, key) { const k = String(key); return `flag_${type}_${_fh(k, 31)}${_fh(k, 37)}${k.length}`; }
function getSyncFlag(type, key) {
  const f = (DATA.syncFlags || []).find(x => x.id === syncFlagId(type, key));
  return f && !f.deleted && f.key === String(key) ? f : null;
}
function isSyncFlagOn(type, key) { const f = getSyncFlag(type, key); return !!(f && f.on); }
function setSyncFlag(type, key, on, at) {
  DATA.syncFlags = DATA.syncFlags || [];
  const id = syncFlagId(type, key), now = at || Date.now();
  const f = DATA.syncFlags.find(x => x.id === id);
  if (f) { f.type = type; f.key = String(key); f.on = !!on; f.deleted = false; f.updatedAt = now; }
  else DATA.syncFlags.push({ id, type, key: String(key), on: !!on, deleted: false, updatedAt: now });
}
function readFlagSet() { const set = new Set(); (DATA.syncFlags || []).forEach(f => { if (f && !f.deleted && f.type === 'read' && f.on) set.add(f.key); }); return set; }

/* ---------- سجل الإشعارات: الحذف دائمًا «ناعم» (deleted:true) وإلا عادت الإشعارات من السحابة بأول مزامنة ---------- */
function liveNotifs() { return (DATA.notifications || []).filter(n => n && !n.deleted); }
function softDeleteNotifs(list) { const now = Date.now(); list.forEach(n => { if (n && !n.deleted) { n.deleted = true; n.updatedAt = now; } }); }
// لقطات صافي الثروة: المعرّف ثابت لكل يوم (snap_YYYY-MM-DD) فتندمج لقطات الأجهزة بدل أن تتكرر
function liveSnapshots() { return (DATA.assetSnapshots || []).filter(s => s && !s.deleted && s.date).sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0)); }
// يجهّز ما كان محليًا فقط ليتزامن: مقروء الجرس القديم، علامات مقارنة الشهر، ومعرّفات اللقطات القديمة (مرة واحدة، آمن للتكرار)
function ensureSyncExtras() {
  DATA.syncFlags = DATA.syncFlags || []; DATA.assetSnapshots = DATA.assetSnapshots || []; DATA.meta = DATA.meta || {};
  if (DATA.meta.notifRead && typeof DATA.meta.notifRead === 'object') {
    Object.keys(DATA.meta.notifRead).forEach(k => { if (!DATA.syncFlags.some(f => f.id === syncFlagId('read', k))) setSyncFlag('read', k, true, Number(DATA.meta.notifRead[k]) || 1); });
    delete DATA.meta.notifRead;
  }
  if (Array.isArray(DATA.monthComparisonLog) && DATA.monthComparisonLog.length) {
    DATA.monthComparisonLog.forEach(k => { if (!DATA.syncFlags.some(f => f.id === syncFlagId('mc', k))) setSyncFlag('mc', k, true); });
  }
  DATA.monthComparisonLog = [];
  const seen = new Set();
  DATA.assetSnapshots.forEach(sn => { if (sn && !sn.id && sn.date) { sn.id = 'snap_' + sn.date; if (sn.updatedAt == null) sn.updatedAt = 1; if (sn.deleted == null) sn.deleted = false; } });
  DATA.assetSnapshots = DATA.assetSnapshots.filter(sn => { if (!sn || !sn.id || seen.has(sn.id)) return false; seen.add(sn.id); return true; });
}
// تنظيف دوري خفيف: علامات الحذف القديمة (أكثر من 120 يومًا) وعلامات «مقارنة الشهر» القديمة
function purgeOldTombstones() {
  const limit = Date.now() - 120 * 24 * 3600 * 1000, mcLimit = Date.now() - 60 * 24 * 3600 * 1000;
  ['notifications', 'assetSnapshots', 'syncFlags'].forEach(k => { if (Array.isArray(DATA[k])) DATA[k] = DATA[k].filter(x => !(x && x.deleted && (x.updatedAt || 0) < limit)); });
  DATA.syncFlags = (DATA.syncFlags || []).filter(f => !(f && f.type === 'mc' && (f.updatedAt || 0) < mcLimit));
}
// يحذف علامات «مقروء» القديمة (أكثر من 30 يومًا) التي لم يعد لها عنصر حيّ في الجرس — حتى لا تتراكم للأبد
function pruneReadFlags() {
  try {
    const keys = new Set(collectNotifItems().map(i => i.key)), limit = Date.now() - 30 * 24 * 3600 * 1000;
    DATA.syncFlags = (DATA.syncFlags || []).filter(f => !(f && f.type === 'read' && (f.updatedAt || 0) < limit && !keys.has(f.key)));
  } catch (e) { /* تجاهل */ }
}
// opts.id: معرّف ثابت للإشعارات التلقائية (يمنع تكرارها لو ولّدها جهازان معًا، ويمنع عودتها بعد حذفها)
function logNotify(category, title, body, navigateTo, nav, opts) {
  const id = (opts && opts.id) || uid();
  if (opts && opts.id && (DATA.notifications || []).some(n => n.id === id)) return;
  Platform.notify(title, body, nav ? notifNavToString(nav) : navigateTo);
  DATA.notifications.push({ id, category, title, body, navigateTo: navigateTo || null, nav: nav || null, createdAt: Date.now(), updatedAt: Date.now(), read: false, deleted: false });
  const live = liveNotifs().sort((a, b) => (a.createdAt || 0) - (b.createdAt || 0)); // نحافظ على حجم معقول: الأقدم يُحذف حذفًا ناعمًا
  if (live.length > 300) softDeleteNotifs(live.slice(0, live.length - 300));
  updateNotifBadge();
  persist();
}
const ymOf = (dateStr) => { const m = /^(\d{4})-(\d{2})/.exec(dateStr || ''); return m ? [parseInt(m[1]), parseInt(m[2])] : [new Date().getFullYear(), new Date().getMonth() + 1]; };
function notifHash(str) { let h = 0; for (let i = 0; i < str.length; i++) h = (h * 31 + str.charCodeAt(i)) | 0; return (h >>> 0).toString(36); }
// يبني قائمة كل عناصر مركز الإشعارات: { key, section, title, body, time, state, read, nav, logId? }
function collectNotifItems() {
  const items = []; const now = Date.now(); const readSet = readFlagSet();
  const add = (it) => { it.read = it.logId ? !!it.read : readSet.has(it.key); items.push(it); };
  const money = (n, c) => bidi(fmt(n) + ' ' + c);
  const dt = (ms) => new Date(ms).toLocaleString('ar-DZ');

  // (1) الإشعارات الواصلة (السجل)
  liveNotifs().forEach(n => add({ key: 'log:' + n.id, logId: n.id, read: n.read, section: NOTIF_CAT_TO_SECTION[n.category] || 'other', title: n.title, body: n.body,
    time: n.createdAt, state: 'fired', nav: parseNotifNav(n.nav) || parseNotifNav(n.navigateTo) || defaultNavForCategory(n.category) }));

  // (2) تذكيرات الرزنامة/المذكرة/المواعيد المضبوطة ولم تصل بعد
  DATA.calendarItems.filter(i => !i.deleted && i.reminderAt && !i.notifiedAt).forEach(i => {
    const isAppt = !!i.apptId;
    add({ key: `cal:${i.id}:${i.reminderAt}`, section: isAppt ? 'appointments' : i.kind === 'event' ? 'calendar' : 'notes',
      title: `⏰ ${i.kind === 'event' ? 'تذكير' : 'ملاحظة'}: ${i.title}`, body: `${i.date || ''}${i.note ? ' — ' + i.note : ''}`, time: i.reminderAt, state: i.reminderAt <= now ? 'due' : 'upcoming',
      nav: isAppt ? { v: 'planning', tab: 'appointments', focus: 'appt:' + i.apptId } : { v: i.kind === 'event' ? 'calendar' : 'notes', focus: 'cal:' + i.id } });
  });
  // تذكيرات الديون
  DATA.debts.filter(d => !d.deleted && d.reminderAt && !d.notifiedAt).forEach(d => add({ key: `debt:${d.id}:${d.reminderAt}`, section: 'debts',
    title: `💳 تذكير دين: ${d.name}`, body: `${d.type === 'they_owe_me' ? 'دين لي' : 'دين عليّ'} — المتبقي ${money(Math.max(0, d.amount - computeDebtPaid(d)), d.currency)}`, time: d.reminderAt,
    state: d.reminderAt <= now ? 'due' : 'upcoming', nav: { v: 'clients', mode: 'debts', panels: [debtPanelKey(d.name)], focus: 'debt:' + d.id } }));
  // تذكيرات الخطط والأهداف
  DATA.plans.filter(p => !p.deleted && p.status !== 'archived' && p.nextReminderAt && !p.notifiedAt).forEach(p => add({ key: `plan:${p.id}:${p.nextReminderAt}`, section: 'planning',
    title: `${p.kind === 'goal' ? '🎯 متابعة هدف' : '🔁 تذكير خطة'}: ${p.title}`, body: p.notes || '', time: p.nextReminderAt, state: p.nextReminderAt <= now ? 'due' : 'upcoming',
    nav: { v: 'planning', tab: 'plans', focus: 'plan:' + p.id } }));
  // اقتراحات المواعيد المتكررة (حان وقت موعد جديد لزبون)
  DATA.appointments.filter(a => !a.deleted && a.recurEveryDays && !a.recurNotifiedAt).forEach(a => {
    const due = new Date(a.date + 'T00:00:00'); due.setDate(due.getDate() + a.recurEveryDays);
    add({ key: `apptrec:${a.id}:${a.recurEveryDays}`, section: 'appointments', title: `🔁 اقتراح موعد جديد لـ ${a.clientName || apptServiceName(a)}`, body: `آخر زيارة ${a.date} — يتكرر كل ${a.recurEveryDays} يوم`,
      time: due.getTime(), state: due.toISOString().slice(0, 10) <= todayISO() ? 'due' : 'upcoming', nav: { v: 'planning', tab: 'appointments', focus: 'appt:' + a.id } });
  });

  // (3) تذكير الجدول (يومي/أسبوعي/فصلي/سنوي): مفعّل أو معطّل
  const schedTime = DATA.settings.scheduleReminderTime || '08:00';
  const modesEn = DATA.settings.scheduleModesEnabled || {};
  const schedDesc = { daily: `كل يوم الساعة ${schedTime}`, weekly: `كل يوم الساعة ${schedTime} بجدول يوم الأسبوع`, quarterly: `عند دخول كل فصل جديد (بعد ${schedTime})`, yearly: `عند دخول شهره من كل عام (بعد ${schedTime})` };
  Object.keys(SCHEDULE_MODES_CFG).forEach(mode => {
    const cfg = SCHEDULE_MODES_CFG[mode]; const on = !!DATA.settings.scheduleReminderEnabled && modesEn[mode] !== false;
    add({ key: `sched:${mode}:${on}:${schedTime}`, section: 'schedule', title: `${cfg.icon} تذكير الجدول ${cfg.label}`,
      body: on ? `مفعّل — ${schedDesc[mode]}` : (!DATA.settings.scheduleReminderEnabled ? 'معطّل (التذكير العام للجدول متوقّف)' : 'معطّل (هذا النوع مخفي من الإعدادات)'),
      time: null, state: on ? 'active' : 'disabled', nav: { v: 'planning', tab: 'schedule', sched: mode, focus: 'sched-notify' } });
  });

  // (4) التنبيهات الذكية المُعدَّة (مفعّلة/موقوفة/سبق أن أُطلقت)
  DATA.alerts.filter(a => !a.deleted).forEach(a => add({ key: `alert:${a.id}:${a.active}:${a.lastTriggeredAt || 0}`, section: 'smart', title: '🔔 ' + alertDesc(a),
    body: !a.active ? 'موقوف — لن يُطلَق حتى تفعّله' : a.lastTriggeredAt ? `أُطلق بتاريخ ${dt(a.lastTriggeredAt)}` : 'مفعّل — في انتظار تحقّق الشرط',
    time: a.lastTriggeredAt || null, state: !a.active ? 'disabled' : 'active', nav: { v: 'control', panels: ['ctrl_alerts'], focus: 'alert:' + a.id } }));

  // (5) الإحصائيات: تنبيه مقارنة الشهر بالسابق
  const mcOn = DATA.settings.monthComparisonAlertsEnabled !== false;
  add({ key: `stats:monthcmp:${mcOn}`, section: 'stats', title: '📊 تنبيه مقارنة الشهر بالشهر السابق', body: mcOn ? 'مفعّل — يصلك بعد 15 يومًا من الشهر، وتذكير إضافي بعد أسبوع' : 'معطّل من الإعدادات',
    time: null, state: mcOn ? 'active' : 'disabled', nav: { v: 'settings', panels: ['set_monthcompare'], focus: 'panel:set_monthcompare' } });

  // (6) الرئيسية: التنبيهات الذكية المعروضة في بطاقة المقارنة لكل عملة
  const nowD = new Date(); const cy = nowD.getFullYear(), cm = nowD.getMonth() + 1; const [py, pm] = prevYM(cy, cm);
  allTimeCurrenciesWithActivity().forEach(cur => {
    const curS = computeMonthStats(cy, cm, cur), prevS = computeMonthStats(py, pm, cur);
    if (!curS.hasData && !prevS.hasData) return;
    buildMonthlyInsights(cur, curS, prevS).forEach(it => add({ key: `ins:${cur}:${notifHash(it.text)}`, section: 'home', title: `${it.icon} ${it.text}`, body: `${MONTH_NAMES[cm - 1]} ${cy}`,
      time: null, state: it.tone === 'pos' ? 'info' : 'warn', nav: { v: 'dashboard', focus: 'insights:' + cur } }));
  });
  // الرئيسية: عملاء لم يكتمل دفعهم (بطاقة "وين واصل") → قسم العملاء
  DATA.projects.filter(p => !p.deleted && computeProjectPaid(p) < p.agreedAmount).forEach(p => {
    const c = DATA.clients.find(x => x.id === p.clientId); const cur = c ? c.currency : '';
    add({ key: `unpaid:${p.id}:${computeProjectPaid(p)}:${p.agreedAmount}`, section: 'clients', title: `💰 ${c ? c.name : '—'} — ${p.title}`,
      body: `مدفوع ${money(computeProjectPaid(p), cur)} من ${money(p.agreedAmount, cur)} — لم يكتمل الدفع`, time: p.createdAt || null, state: 'warn', nav: { v: 'clients', mode: 'clients', focus: 'client:' + p.clientId } });
  });
  // المهم (المعلَّم بنجمة) من حركات ومشاريع وخطط وديون
  DATA.transactions.filter(t => !t.deleted && t.flagged).forEach(t => add({ key: `flag:tx:${t.id}`, section: 'flagged', title: `⭐ ${sourceName(t)}`, body: `${t.kind === 'income' ? 'دخل' : 'مصروف'} ${money(t.amount, t.currency)} · ${t.date}`,
    time: t.createdAt || null, state: 'warn', nav: { v: 'yearly', ym: ymOf(t.date), mtab: t.kind === 'income' ? 'income' : 'expense', day: t.date, focus: 'day:' + t.date } }));
  DATA.projects.filter(p => !p.deleted && p.flagged).forEach(p => { const c = DATA.clients.find(x => x.id === p.clientId);
    add({ key: `flag:proj:${p.id}`, section: 'flagged', title: `⭐ ${c ? c.name : ''} — ${p.title}`, body: `مشروع عميل: مدفوع ${money(computeProjectPaid(p), c ? c.currency : '')} من ${fmt(p.agreedAmount)}`,
      time: p.createdAt || null, state: 'warn', nav: { v: 'clients', mode: 'clients', focus: 'client:' + p.clientId } }); });
  DATA.plans.filter(p => !p.deleted && p.flagged).forEach(p => add({ key: `flag:plan:${p.id}`, section: 'flagged', title: `⭐ ${p.title}`, body: p.kind === 'goal' ? 'هدف مهم' : 'خطة مهمة',
    time: p.nextReminderAt || null, state: 'warn', nav: { v: 'planning', tab: 'plans', focus: 'plan:' + p.id } }));
  DATA.debts.filter(d => !d.deleted && d.flagged).forEach(d => add({ key: `flag:debt:${d.id}`, section: 'flagged', title: `⭐ دين: ${d.name}`, body: `${d.type === 'they_owe_me' ? 'دين لي' : 'دين عليّ'} — ${money(d.amount, d.currency)}`,
    time: d.createdAt || null, state: 'warn', nav: { v: 'clients', mode: 'debts', panels: [debtPanelKey(d.name)], focus: 'debt:' + d.id } }));

  // (7) الإخراجات التي لم تُسلَّم بعد
  DATA.zakatPayments.filter(z => !z.deleted && !z.delivered).forEach(z => add({ key: `zk:${z.id}:${z.amount}`, section: 'outflows', title: `🕌 ${z.name}`, body: `${money(z.amount, z.currency)} — لم يُسلَّم بعد · ${z.date}`,
    time: null, state: 'pending', nav: { v: 'yearly', ym: ymOf(z.date), mtab: 'outflows' } }));

  // (8) أموالي: الاقتطاعات المتكررة (مفعّلة/معطّلة) + أصول لم تُراجَع قيمتها
  DATA.recurringTx.filter(r => !r.deleted).forEach(r => { const cat = DATA.categories.find(c => c.id === r.categoryId); const next = nextRecurringDate(r);
    add({ key: `rec:${r.id}:${r.active}:${next}`, section: 'wealth', title: `🔁 ${cat ? cat.name : '—'} — ${money(r.amount, r.currency)}`,
      body: r.active ? `اقتطاع ${r.kind === 'income' ? 'دخل' : 'مصروف'} متكرر — القادم: ${next} (يوم ${r.dayOfMonth} من كل شهر)` : 'اقتطاع متكرر معطّل — لن يُضاف تلقائيًا', time: null,
      state: r.active ? 'active' : 'disabled', nav: { v: 'wealth', tab: 'recurring', focus: 'rec:' + r.id } }); });
  { const pend = pendingRecurringTxs(); if (pend.length) add({ key: `recpend:${pend.length}:${_fh(pend.map(t => t.id).sort().join('|'), 31)}`, section: 'wealth', title: `⏳ ${pend.length} اقتطاع بانتظار اختيار الأصل`,
      body: 'اقتطاعات ولّدها التطبيق ولم يُسجَّل أثرها على أصولك بعد', time: null, state: 'warn', nav: { v: 'wealth', tab: 'recurring', focus: 'panel:rec_pending' } }); }
  DATA.assets.filter(a => !a.deleted && a.lastUpdatedAt && (now - a.lastUpdatedAt) > 120 * 24 * 3600 * 1000).forEach(a => add({ key: `stale:${a.id}:${a.lastUpdatedAt}`, section: 'wealth',
    title: `🕰️ ${a.name}: لم تُراجَع قيمته منذ فترة`, body: `آخر تحديث ${new Date(a.lastUpdatedAt).toLocaleDateString('ar-DZ')} — القيمة الحالية ${money(assetValue(a), a.currency)}`, time: a.lastUpdatedAt, state: 'warn',
    nav: { v: 'wealth', tab: 'assets', panels: ['assetwin_' + a.id], focus: 'asset:' + a.id } }));
  return items;
}
function notifSortItems(list) {
  return list.sort((x, y) => {
    const wx = NOTIF_STATE[x.state][1], wy = NOTIF_STATE[y.state][1]; if (wx !== wy) return wx - wy;
    if (x.state === 'upcoming' || x.state === 'due') return (x.time || 0) - (y.time || 0); // الأقرب موعدًا أولًا
    return (y.time || 0) - (x.time || 0); // الأحدث أولًا
  });
}
function updateNotifBadge() {
  const btn = $('#notifBtn'); if (!btn) return;
  let unread = 0;
  try { unread = collectNotifItems().filter(i => !i.read).length; } catch (e) { unread = liveNotifs().filter(n => !n.read).length; }
  btn.classList.toggle('has-unread', unread > 0);
  btn.title = unread ? `الإشعارات — ${unread} غير مقروء` : 'الإشعارات';
}
let _notifBadgeT = null;
function scheduleNotifBadgeUpdate() { clearTimeout(_notifBadgeT); _notifBadgeT = setTimeout(() => { if (DATA) updateNotifBadge(); }, 900); }
function openNotifPanel() {
  renderNotifPanel();
  $('#notifPanel').classList.remove('hidden');
}
function closeNotifPanel() { $('#notifPanel').classList.add('hidden'); }
function setNotifRead(it, val) {
  if (it.logId) { const n = DATA.notifications.find(x => x.id === it.logId); if (n) { n.read = val; n.updatedAt = Date.now(); } }
  else setSyncFlag('read', it.key, !!val); // حالة المقروء تتزامن بين الأجهزة
}
function notifItemHtml(it, idx) {
  const [stLabel] = NOTIF_STATE[it.state];
  return `<div class="notif-item ${it.read ? '' : 'unread'}" data-ni="${idx}" role="button" tabindex="0">
    <div class="notif-item-main">
      <div class="notif-item-title">${escHtml(it.title)}</div>
      ${it.body ? `<div class="notif-item-body">${escHtml(it.body)}</div>` : ''}
      <div class="notif-item-meta"><span class="nstate ns-${it.state}">${stLabel}</span>${it.time ? `<span>${escHtml(new Date(it.time).toLocaleString('ar-DZ'))}</span>` : ''}<span class="notif-go">اذهب ‹</span></div>
    </div>
    <button class="notif-read-btn" data-nread="${idx}" title="${it.read ? 'أعده كغير مقروء' : 'تعليم كمقروء'}">${it.read ? '↺' : '✓'}</button>
  </div>`;
}
function renderNotifPanel() {
  const panel = $('#notifPanel');
  const prevScroll = panel.querySelector('.notif-panel-body')?.scrollTop || 0;
  const items = collectNotifItems();
  const totalUnread = items.filter(i => !i.read).length;
  const secs = NOTIF_SECTIONS.map(sec => ({ sec, list: notifSortItems(items.filter(i => i.section === sec.id)) })).filter(x => x.list.length);
  const idxOf = new Map(items.map((it, i) => [it, i]));
  panel.innerHTML = `
    <div class="notif-panel-header">
      <div class="notif-head-row"><strong>🔔 الإشعارات</strong><span class="notif-total ${totalUnread ? 'has' : ''}">${totalUnread ? totalUnread + ' غير مقروء' : 'كل شيء مقروء ✓'}</span>
        <button class="btn ghost sm" id="closeNotifBtn" title="إغلاق">✕</button></div>
      <div class="notif-panel-actions">
        <button class="btn ghost sm" id="markAllReadBtn">تعليم الكل كمقروء</button>
        ${liveNotifs().length ? '<button class="btn danger sm" id="clearAllNotifBtn">حذف سجل الواصل</button>' : ''}
      </div>
    </div>
    <div class="notif-panel-body">
      ${secs.map(({ sec, list }) => {
        const unread = list.filter(i => !i.read), read = list.filter(i => i.read); const key = 'notif_sec_' + sec.id;
        return `<details class="collapse-card notif-sec" data-panel="${key}"${panelOpenAttr(key)}>
          <summary><span class="notif-sec-title">${sec.icon} ${sec.name}</span>
            <span class="notif-sec-badges">${unread.length ? `<b class="nbadge unread">${unread.length}</b>` : ''}<span class="nbadge">${list.length}</span></span></summary>
          ${unread.length ? unread.map(it => notifItemHtml(it, idxOf.get(it))).join('') : '<p class="muted notif-none">لا يوجد غير مقروء ✓</p>'}
          ${read.length ? `<details class="notif-more" data-panel="notif_more_${sec.id}"${panelOpenAttr('notif_more_' + sec.id)}><summary>عرض المزيد (${read.length} مقروء)</summary>${read.map(it => notifItemHtml(it, idxOf.get(it))).join('')}</details>` : ''}
          ${unread.length ? `<div class="notif-sec-actions"><button class="btn ghost sm" data-readsec="${sec.id}">تعليم هذا القسم كمقروء</button></div>` : ''}
        </details>`;
      }).join('')}
    </div>`;
  const body = panel.querySelector('.notif-panel-body'); if (body) body.scrollTop = prevScroll;
  bindPanelToggles(panel);
  const refresh = () => { persist(); updateNotifBadge(); renderNotifPanel(); };
  $('#closeNotifBtn', panel)?.addEventListener('click', closeNotifPanel);
  $('#markAllReadBtn', panel)?.addEventListener('click', () => { items.forEach(it => { if (!it.read) setNotifRead(it, true); }); refresh(); });
  $$('[data-readsec]', panel).forEach(b => b.addEventListener('click', () => { items.filter(i => i.section === b.dataset.readsec && !i.read).forEach(it => setNotifRead(it, true)); refresh(); }));
  $$('[data-nread]', panel).forEach(b => b.addEventListener('click', (e) => { e.stopPropagation(); const it = items[parseInt(b.dataset.nread)]; if (it) { setNotifRead(it, !it.read); refresh(); } }));
  $$('[data-ni]', panel).forEach(el => {
    const go = () => { const it = items[parseInt(el.dataset.ni)]; if (!it) return; if (!it.read) { setNotifRead(it, true); persist(); updateNotifBadge(); } goToNotifTarget(it.nav); };
    el.addEventListener('click', go);
    el.addEventListener('keydown', (e) => { if (e.key === 'Enter') go(); });
  });
  $('#clearAllNotifBtn', panel)?.addEventListener('click', () => {
    confirmDialog({
      title: 'حذف سجل الإشعارات الواصلة',
      message: 'سيتم حذف سجل الإشعارات التي وصلتك سابقًا نهائيًا من كل أجهزتك (التذكيرات والتنبيهات المُعدّة نفسها تبقى كما هي). هل تريد المتابعة؟',
      confirmLabel: 'حذف السجل',
      dangerous: true,
      onConfirm: () => { softDeleteNotifs(liveNotifs()); persist(); updateNotifBadge(); renderNotifPanel(); }
    });
  });
}

function applyTheme() { document.body.setAttribute('data-theme', DATA.settings.theme || 'black'); }

/* ---------------- وضع الأداء: يخفف/يوقف التأثيرات البصرية الثقيلة (زجاج، توهج، حركة) على الأجهزة الضعيفة ---------------- */
function isLikelyWeakDevice() {
  try {
    // navigator.deviceMemory (بالجيجابايت) و navigator.hardwareConcurrency (عدد الأنوية) مدعومين
    // بمعظم متصفحات Chromium (اللي يشتغل عليها WebView الأندرويد)؛ لو غير متوفرين نفترض الجهاز عادي.
    if (typeof navigator.deviceMemory === 'number' && navigator.deviceMemory > 0 && navigator.deviceMemory <= 3) return true;
    if (typeof navigator.hardwareConcurrency === 'number' && navigator.hardwareConcurrency > 0 && navigator.hardwareConcurrency <= 4) return true;
  } catch (e) { /* تجاهل: نفترض جهاز عادي لو فشل الفحص */ }
  return false;
}
function applyPerfMode() {
  const mode = DATA.settings.performanceMode || 'auto';
  const low = mode === 'low' || (mode === 'auto' && isLikelyWeakDevice());
  document.body.setAttribute('data-perf', low ? 'low' : 'normal');
}

function scheduleAutoSave() {
  if (saveTimer) clearInterval(saveTimer);
  if (!DATA.settings.autoSaveEnabled) return;
  const unitMs = { seconds: 1000, minutes: 60000, hours: 3600000 }[DATA.settings.autoSaveUnit] || 60000;
  const every = Math.max(DATA.settings.autoSaveMinutes || 1, 1) * unitMs;
  saveTimer = setInterval(autoSaveTick, every);
}
function autoSaveTick() {
  // نتفادى حفظ دوري "وهمي" بلا أي تغيير حقيقي بالبيانات (راجع تعليق
  // dataFingerprintForAutoSave أعلاه لتفصيل سبب أهمية هذا بالذات للمزامنة)
  const fp = dataFingerprintForAutoSave();
  if (fp === lastAutoSaveFingerprint) return;
  persist();
}
async function persist(showToast) {
  // نكتشف تلقائيًا أي عنصر تغيّر منذ آخر حفظ (حتى لو الكود اللي غيّره ما حدّث
  // "وقت التعديل" يدويًا) ونعلّمه — شبكة أمان عامة لكل قسم بالتطبيق
  if (lastPersistedSnapshot) {
    try { touchChangedTimestamps(JSON.parse(lastPersistedSnapshot), DATA); } catch (e) { /* تجاهل */ }
  }
  await Platform.save(DATA);
  lastPersistedSnapshot = snapshotMergeArrays();
  lastAutoSaveFingerprint = dataFingerprintForAutoSave(); // نحدّثها هنا دايمًا (مو بس بالحفظ الدوري) عشان تعكس آخر حالة محفوظة فعليًا أيًا كان سبب الحفظ
  if (window.Sync) Sync.schedulePush(DATA); // يرسل للسيرفر بتأخير بسيط بدون ما يعطّل الحفظ المحلي الفوري
  const s = $('#saveStatus'); if (s) s.textContent = 'محفوظ الآن';
  if (showToast) toast('تم الحفظ');
  scheduleNotifBadgeUpdate(); // شارة الجرس تتبع أي تغيير بالبيانات (تذكير جديد، تعطيل تنبيه...)
  setTimeout(() => { const el = $('#saveStatus'); if (el) el.textContent = 'محفوظ'; }, 2000);
  snapshotHistory();
}

/* ---------------- تراجع/إعادة (رجوع/تقدّم عبر كل عمليات هذه الجلسة) ---------------- */
let historyStack = [];
let historyIndex = -1;
let isRestoringHistory = false;

function snapshotHistory() {
  if (isRestoringHistory) return;
  const snap = JSON.stringify(DATA);
  if (historyStack[historyIndex] === snap) return;
  historyStack = historyStack.slice(0, historyIndex + 1);
  historyStack.push(snap);
  if (historyStack.length > 80) historyStack.shift();
  historyIndex = historyStack.length - 1;
  updateHistoryButtons();
}
function updateHistoryButtons() {
  const back = $('#historyBackBtn'), fwd = $('#historyFwdBtn');
  if (back) back.disabled = historyIndex <= 0;
  if (fwd) fwd.disabled = historyIndex >= historyStack.length - 1;
}
// بعد التراجع/الإعادة، DATA بيكون نسخة قديمة (بتواريخ تعديل قديمة داخل عناصرها).
// لو ما لمسناها، أي مزامنة لاحقة (سحب من جهاز ثاني ما لمس نفس العنصر) بتفتكر
// نسخة السحابة (الأحدث توقيتًا) هي الصحيحة وترجّع التراجع لأصله بصمت — بالضبط
// المشكلة اللي صارت. الحل: نعلّم فقط العناصر اللي *فعليًا* تغيّرت بين قبل/بعد
// بتاريخ الآن، عشان تكسب أي مقارنة توقيت لاحقة، بدون ما نزوّر تاريخ عناصر
// ثانية ما لها علاقة بالتراجع (يحافظ على دقة حل التعارضات لبقية البيانات)
function touchChangedTimestamps(before, after) {
  const arrays = (window.Sync && Sync.MERGE_ARRAYS) || [];
  arrays.forEach(k => {
    const beforeMap = new Map((before[k] || []).map(x => [x.id, JSON.stringify(x)]));
    (after[k] || []).forEach(item => {
      if (!item || !item.id) return;
      if (beforeMap.get(item.id) !== JSON.stringify(item)) item.updatedAt = Date.now();
    });
  });
  const bucketed = (window.Sync && Sync.MERGE_BUCKETED) || [];
  bucketed.forEach(k => {
    const beforeBuckets = before[k] || {};
    const afterBuckets = after[k] || {};
    Object.keys(afterBuckets).forEach(bucket => {
      const beforeMap = new Map((beforeBuckets[bucket] || []).map(x => [x.id, JSON.stringify(x)]));
      (afterBuckets[bucket] || []).forEach(item => {
        if (!item || !item.id) return;
        if (beforeMap.get(item.id) !== JSON.stringify(item)) item.updatedAt = Date.now();
      });
    });
  });
}
async function undoHistory() {
  if (historyIndex <= 0) return toast('لا يوجد رجوع أبعد من هذا');
  const before = DATA;
  historyIndex--;
  isRestoringHistory = true;
  DATA = JSON.parse(historyStack[historyIndex]);
  touchChangedTimestamps(before, DATA);
  await Platform.save(DATA);
  lastPersistedSnapshot = snapshotMergeArrays();
  lastAutoSaveFingerprint = dataFingerprintForAutoSave();
  isRestoringHistory = false;
  applyTheme(); applyPerfMode(); buildNav(); updateNotifBadge(); updateHistoryButtons();
  render(activeView);
  if (window.Sync) Sync.pushNow(DATA); // رفع فوري بدل الانتظار، عشان يفوز أي سباق مع سحب من جهاز ثاني بنفس اللحظة
  toast('تم الرجوع لخطوة سابقة');
}
async function redoHistory() {
  if (historyIndex >= historyStack.length - 1) return toast('لا يوجد تقدّم أبعد من هذا');
  const before = DATA;
  historyIndex++;
  isRestoringHistory = true;
  DATA = JSON.parse(historyStack[historyIndex]);
  touchChangedTimestamps(before, DATA);
  await Platform.save(DATA);
  lastPersistedSnapshot = snapshotMergeArrays();
  lastAutoSaveFingerprint = dataFingerprintForAutoSave();
  isRestoringHistory = false;
  applyTheme(); applyPerfMode(); buildNav(); updateNotifBadge(); updateHistoryButtons();
  render(activeView);
  if (window.Sync) Sync.pushNow(DATA);
  toast('تم التقدّم للأمام');
}

/* ---------------- التنقل ---------------- */
const NAV_ITEMS = [
  ['dashboard', 'nav_dashboard'], ['yearly', 'nav_yearly'], ['clients', 'nav_clients'],
  ['calendar', 'nav_calendar'], ['notes', 'nav_notes'], ['planning', 'nav_planning'], ['wealth', 'nav_wealth'], ['control', 'nav_control'], ['settings', 'nav_settings'],
];
// ترتيب التبويبات قابل للتخصيص بالكامل من الإعدادات (سحب/تحريك) — settings.navOrder يخزّن ترتيب المفاتيح فقط
function orderedNavItems() {
  const order = (DATA.settings.navOrder && DATA.settings.navOrder.length) ? DATA.settings.navOrder : NAV_ITEMS.map(([k]) => k);
  const byKey = Object.fromEntries(NAV_ITEMS);
  const seen = new Set();
  const ordered = order.filter(k => byKey[k] && !seen.has(k) && seen.add(k)).map(k => [k, byKey[k]]);
  NAV_ITEMS.forEach(([k, lk]) => { if (!seen.has(k)) { ordered.push([k, lk]); seen.add(k); } }); // أي قسم جديد يُضاف مستقبلًا يظهر تلقائيًا في الآخر
  return ordered;
}
function buildNav() {
  const nav = $('#mainNav'); nav.innerHTML = '';
  orderedNavItems().filter(([key]) => key === 'settings' || !DATA.settings.disabledSections.includes(key)).forEach(([key, labelKey]) => {
    const btn = document.createElement('button');
    btn.className = 'nav-btn'; btn.dataset.view = key; btn.textContent = label(labelKey);
    btn.addEventListener('click', () => showView(key)); // لا نصفّر مكان التصفح عند الانتقال - يبقى في آخر سنة/شهر كان فيهما المستخدم
    nav.appendChild(btn);
  });
}
function renderTopbarAccount() {
  const el = $('#topbarAccountAvatar');
  if (!el) return;
  const s = window.Auth && Auth.getSession();
  if (!s) { el.innerHTML = ''; return; }
  const initial = (s.user.username || s.user.email || '؟').trim().charAt(0).toUpperCase();
  el.innerHTML = s.user.avatar_url ? `<img src="${s.user.avatar_url}" alt="">` : `<span>${initial}</span>`;
}

function showView(key) {
  activeView = key;
  $$('.nav-btn').forEach(b => b.classList.toggle('active', b.dataset.view === key));
  $$('.view').forEach(v => v.classList.remove('active'));
  $(`#view-${key}`).classList.add('active');
  render(key);
  requestAnimationFrame(scrollActiveNavIntoView); // لو كان القسم مخفيًا خارج الشريط يظهر تلقائيًا
}
function render(key) {
  const r = { dashboard: renderDashboard, yearly: renderYearly, clients: renderClients,
    calendar: renderCalendar, notes: renderNotes, planning: renderPlanning, wealth: renderWealth, control: renderControl, settings: renderSettings };
  (r[key] || (() => {}))();
}
function bindGlobalEvents() {
  window.addEventListener('beforeunload', () => { Platform.save(DATA); });
  $('#searchBtn').addEventListener('click', openSearch);
  $('#searchPanel').addEventListener('click', (e) => { if (e.target.id === 'searchPanel') closeSearch(); });
  document.addEventListener('keydown', (e) => {
    if ((e.ctrlKey || e.metaKey) && e.key === 'k') { e.preventDefault(); openSearch(); }
    if ((e.ctrlKey || e.metaKey) && !e.shiftKey && e.key.toLowerCase() === 'z') { e.preventDefault(); undoHistory(); }
    if ((e.ctrlKey || e.metaKey) && (e.key.toLowerCase() === 'y' || (e.shiftKey && e.key.toLowerCase() === 'z'))) { e.preventDefault(); redoHistory(); }
    if (e.key === 'Escape') closeSearch();
  });
  $('#historyBackBtn').addEventListener('click', undoHistory);
  $('#topbarAccountBtn')?.addEventListener('click', () => showView('settings'));
  $('#historyFwdBtn').addEventListener('click', redoHistory);
  $('#searchInput').addEventListener('input', () => runSearch($('#searchInput').value));
  $('#notifBtn').addEventListener('click', () => { $('#notifPanel').classList.contains('hidden') ? openNotifPanel() : closeNotifPanel(); });
  document.addEventListener('click', (e) => {
    const panel = $('#notifPanel'), btn = $('#notifBtn');
    const inside = (e.composedPath ? e.composedPath() : []).includes(panel) || panel.contains(e.target) || (e.target && e.target.closest && e.target.closest('#confirmPanel'));
    if (!panel.classList.contains('hidden') && !inside && !btn.contains(e.target)) closeNotifPanel();
  });
}
function openSearch() { $('#searchPanel').classList.remove('hidden'); $('#searchInput').value = ''; $('#searchResults').innerHTML = ''; $('#searchInput').focus(); }
function closeSearch() { $('#searchPanel').classList.add('hidden'); }

function runSearch(qRaw) {
  const q = qRaw.trim().toLowerCase();
  const host = $('#searchResults');
  if (!q) { host.innerHTML = '<p class="muted" style="font-size:13px;">اكتب كلمة للبحث عن حركة، عميل، أو ملاحظة عبر كل السنين.</p>'; return; }
  const results = [];

  DATA.transactions.filter(t => !t.deleted).forEach(t => {
    const name = sourceName(t);
    if (name.toLowerCase().includes(q) || (t.note || '').toLowerCase().includes(q)) {
      results.push({ label: `${t.kind === 'income' ? '💰' : '🔻'} ${name} — ${bidiPlain(fmt(t.amount) + ' ' + t.currency)} · ${t.date}`,
        action: () => { const [y, m] = t.date.split('-').map(Number); navYear = y; navMonth = m; monthTab = t.kind; showView('yearly'); closeSearch(); } });
    }
  });
  DATA.clients.filter(c => !c.deleted).forEach(c => {
    if (c.name.toLowerCase().includes(q)) results.push({ label: `👤 عميل: ${c.name}`, action: () => { showView('clients'); closeSearch(); } });
  });
  DATA.projects.filter(p => !p.deleted).forEach(p => {
    if ((p.title || '').toLowerCase().includes(q) || (p.notes || '').toLowerCase().includes(q)) {
      const c = DATA.clients.find(c => c.id === p.clientId);
      results.push({ label: `📁 مشروع: ${c ? c.name : ''} — ${p.title}`, action: () => { showView('clients'); closeSearch(); } });
    }
  });
  DATA.calendarItems.filter(i => !i.deleted).forEach(i => {
    if ((i.title || '').toLowerCase().includes(q) || (i.note || '').toLowerCase().includes(q)) {
      results.push({ label: `${i.kind === 'event' ? '📅' : '📝'} ${i.title} · ${i.date}`, action: () => { showView(i.kind === 'event' ? 'calendar' : 'notes'); closeSearch(); } });
    }
  });

  host.innerHTML = results.length === 0 ? '<p class="muted" style="font-size:13px;">لا نتائج</p>' :
    results.slice(0, 30).map((r, i) => `<div class="list-row" data-searchresult="${i}" style="cursor:pointer;">${r.label}</div>`).join('');
  $$('[data-searchresult]', host).forEach((el, i) => el.addEventListener('click', () => results[i].action()));
}
function bidiPlain(s) { return s; } // للاستخدام في النصوص العادية بدون HTML

/* ============================================================
   أدوات مشتركة
   ============================================================ */
function txByKind(kind) { return DATA.transactions.filter(t => t.kind === kind && !t.deleted); }
// دخل/مصاريف "حقيقية" فقط (تستثني حركات الديون التلقائية) — تُستعمل لعرض إجمالي الدخل/المصاريف حتى لا تتضخم بأرقام سلف/تسديد
function realSum(kind, filterFn) { return txByKind(kind).filter(t => t.mode !== 'debt' && filterFn(t)).reduce((s, t) => s + t.amount, 0); }
// صافي حركة الديون فقط (دخل الديون - مصاريف الديون) لنفس النطاق — تُضاف للصافي العام حتى يبقى دقيقًا رغم استثناء الديون من "الدخل/المصاريف"
function debtFlowSum(filterFn) {
  const inflow = txByKind('income').filter(t => t.mode === 'debt' && filterFn(t)).reduce((s, t) => s + t.amount, 0);
  const outflow = txByKind('expense').filter(t => t.mode === 'debt' && filterFn(t)).reduce((s, t) => s + t.amount, 0);
  return inflow - outflow;
}
function inMonth(dateStr, y, m) { return dateStr && dateStr.startsWith(`${y}-${pad2(m)}`); }
function inYear(dateStr, y) { return dateStr && dateStr.startsWith(String(y)); }

function currenciesWithActivity(list) {
  const set = new Set();
  list.forEach(t => { if (Number(t.amount) !== 0) set.add(t.currency); });
  return DATA.settings.currencies.filter(c => set.has(c));
}
function allTimeCurrenciesWithActivity() {
  const all = [...DATA.transactions.filter(t => !t.deleted), ...DATA.investments.filter(t => !t.deleted)];
  return currenciesWithActivity(all);
}

function groupByDate(list) {
  const map = new Map();
  list.forEach(t => { if (!map.has(t.date)) map.set(t.date, []); map.get(t.date).push(t); });
  return Array.from(map.entries()).sort((a, b) => b[0].localeCompare(a[0]));
}
function sourceName(t) {
  if (t.mode === 'client') {
    const project = DATA.projects.find(p => p.id === t.projectId);
    const client = project ? DATA.clients.find(c => c.id === project.clientId) : null;
    return `${client ? client.name : 'عميل محذوف'} — ${project ? (project.title || 'مشروع') : ''}`;
  }
  if (t.mode === 'debt') return `👤 ${t.debtName || 'دين'}`;
  const cat = DATA.categories.find(c => c.id === t.categoryId);
  return cat ? cat.name : 'مصدر';
}
function formatDateLabel(dateStr) {
  const d = new Date(dateStr + 'T00:00:00');
  return d.toLocaleDateString('ar-DZ', { day: 'numeric', month: 'long', year: 'numeric' });
}
const MONTH_NAMES = ['يناير','فبراير','مارس','أبريل','مايو','يونيو','يوليو','أغسطس','سبتمبر','أكتوبر','نوفمبر','ديسمبر'];

/* ============================================================
   الرئيسية - نظرة شاملة + "وين واصل"
   ============================================================ */
/* ============================================================
   مقارنة الشهر الحالي بالشهر السابق + تنبيهات ذكية (تظهر في الرئيسية)
   ============================================================ */
function computeMonthStats(y, m, cur) {
  const income = txByKind('income').filter(t => t.currency === cur && t.mode !== 'debt' && inMonth(t.date, y, m)).reduce((s, t) => s + t.amount, 0);
  const expense = txByKind('expense').filter(t => t.currency === cur && t.mode !== 'debt' && inMonth(t.date, y, m)).reduce((s, t) => s + t.amount, 0);
  const outflows = DATA.zakatPayments.filter(z => !z.deleted && z.currency === cur && inMonth(z.date, y, m)).reduce((s, z) => s + z.amount, 0);
  const net = income - expense - outflows;
  const savingsRate = income > 0 ? (net / income) * 100 : null;
  return { y, m, income, expense, outflows, net, savingsRate, hasData: !!(income || expense) };
}
function pctChange(curVal, prevVal) {
  if (!prevVal) return null; // لا يمكن حساب نسبة تغيّر بلا قاعدة سابقة (صفر أو غير موجود)
  return ((curVal - prevVal) / Math.abs(prevVal)) * 100;
}
function prevYM(y, m) { let mm = m - 1, yy = y; if (mm < 1) { mm = 12; yy--; } return [yy, mm]; }
function monthCategoryTotals(y, m, cur) {
  const map = {};
  DATA.transactions.filter(t => !t.deleted && t.kind === 'expense' && t.mode !== 'debt' && t.currency === cur && inMonth(t.date, y, m)).forEach(t => {
    const cat = DATA.categories.find(c => c.id === t.categoryId);
    const key = cat ? cat.id : 'other';
    if (!map[key]) map[key] = { label: cat ? cat.name : 'أخرى', value: 0 };
    map[key].value += t.amount;
  });
  return map;
}
function avgExpenseLastNMonths(y, m, cur, n) {
  let total = 0, count = 0, yy = y, mm = m;
  for (let i = 0; i < n; i++) {
    [yy, mm] = prevYM(yy, mm);
    const v = txByKind('expense').filter(t => t.currency === cur && t.mode !== 'debt' && inMonth(t.date, yy, mm)).reduce((s, t) => s + t.amount, 0);
    if (v > 0) { total += v; count++; }
  }
  return count ? total / count : null;
}

function buildMonthlyInsights(cur, curS, prevS) {
  const items = []; // { icon, text, tone: 'pos'|'neg'|'warn' }
  const incChange = pctChange(curS.income, prevS.income);
  if (incChange !== null) items.push({ icon: incChange >= 0 ? '📈' : '📉', tone: incChange >= 0 ? 'pos' : 'neg',
    text: `دخلك ${incChange >= 0 ? 'ارتفع' : 'انخفض'} ${Math.abs(incChange).toFixed(1)}% مقارنة بالشهر السابق (${cur}).` });

  const expChange = pctChange(curS.expense, prevS.expense);
  if (expChange !== null) items.push({ icon: expChange <= 0 ? '📉' : '📈', tone: expChange <= 0 ? 'pos' : 'neg',
    text: `مصاريفك ${expChange >= 0 ? 'ارتفعت' : 'انخفضت'} ${Math.abs(expChange).toFixed(1)}% مقارنة بالشهر السابق (${cur}).` });

  const netChange = pctChange(curS.net, prevS.net);
  if (netChange !== null) items.push({ icon: '💰', tone: netChange >= 0 ? 'pos' : 'neg',
    text: `صافي أموالك ${netChange >= 0 ? 'تحسّن' : 'تراجع'} بنسبة ${Math.abs(netChange).toFixed(1)}% (${cur}).` });

  // 🔴 مصاريف الشهر تجاوزت متوسط آخر 3 أشهر
  const avg3 = avgExpenseLastNMonths(curS.y, curS.m, cur, 3);
  if (avg3 && curS.expense > avg3 * 1.2) {
    const over = ((curS.expense - avg3) / avg3) * 100;
    items.push({ icon: '🔴', tone: 'neg', text: `المصاريف تجاوزت متوسطك المعتاد (آخر 3 أشهر) بنسبة ${over.toFixed(0)}% (${cur}).` });
  }

  // 🟠 ديون مستحقة قريبًا (تذكير خلال 7 أيام القادمة)
  const now = Date.now(), weekMs = 7 * 24 * 3600 * 1000;
  const dueSoon = DATA.debts.filter(d => !d.deleted && d.currency === cur && (d.amount - computeDebtPaid(d)) > 0 && d.reminderAt && d.reminderAt >= now && d.reminderAt <= now + weekMs);
  if (dueSoon.length) items.push({ icon: '🟠', tone: 'warn', text: `لديك ${dueSoon.length} دين مستحق قريبًا (خلال أسبوع) — ${cur}.` });

  // 🟢 نسبة ادخار جيدة هذا الشهر (بديل عملي عن "هدف ادخار" محدد مسبقًا)
  if (curS.savingsRate !== null && curS.savingsRate >= 20) {
    items.push({ icon: '🟢', tone: 'pos', text: `وصلت إلى نسبة ادخار جيدة هذا الشهر: ${curS.savingsRate.toFixed(0)}% من دخلك (${cur}).` });
  }

  // 🔴 فئة معينة ارتفع إنفاقها كثيرًا
  const curCats = monthCategoryTotals(curS.y, curS.m, cur), prevCats = monthCategoryTotals(prevS.y, prevS.m, cur);
  let worstCat = null, worstPct = 0;
  Object.keys(curCats).forEach(key => {
    const prevVal = prevCats[key] ? prevCats[key].value : 0;
    if (prevVal <= 0) return;
    const pct = ((curCats[key].value - prevVal) / prevVal) * 100;
    if (pct >= 50 && pct > worstPct) { worstPct = pct; worstCat = curCats[key].label; }
  });
  if (worstCat) items.push({ icon: '🔴', tone: 'neg', text: `إنفاق فئة "${worstCat}" ارتفع كثيرًا: +${worstPct.toFixed(0)}% مقارنة بالشهر السابق (${cur}).` });

  // 🟢 أفضل صافي منذ بداية السنة
  let hasOtherMonthData = false, isBest = true;
  for (let mm = 1; mm <= 12; mm++) {
    if (mm === curS.m) continue;
    const s = computeMonthStats(curS.y, mm, cur);
    if (s.hasData) { hasOtherMonthData = true; if (s.net >= curS.net) { isBest = false; break; } }
  }
  if (hasOtherMonthData && isBest && curS.hasData) items.push({ icon: '🟢', tone: 'pos', text: `هذا الشهر حققت أفضل صافي منذ بداية سنة ${curS.y} (${cur}) 🎉` });

  return items;
}

function monthComparisonCardHtml(cur) {
  const now = new Date();
  const y = now.getFullYear(), m = now.getMonth() + 1;
  const [py, pm] = prevYM(y, m);
  const curS = computeMonthStats(y, m, cur), prevS = computeMonthStats(py, pm, cur);
  if (!curS.hasData && !prevS.hasData) return '';
  const insights = buildMonthlyInsights(cur, curS, prevS);
  const row = (label, curVal, prevVal, extra) => `<tr><td>${label}</td>
    <td class="${curVal >= 0 ? '' : 'neg-cell'}">${bidi(fmt(curVal))}${extra ? ` <span class="muted" style="font-size:10.5px;">${extra(curS)}</span>` : ''}</td>
    <td class="${prevVal >= 0 ? '' : 'neg-cell'}">${bidi(fmt(prevVal))}${extra ? ` <span class="muted" style="font-size:10.5px;">${extra(prevS)}</span>` : ''}</td></tr>`;
  return `<div class="card glass-panel" data-focus="insights:${cur}" style="margin-top:14px;">
    <strong>📊 مقارنة الشهر الحالي بالشهر السابق — ${cur}</strong>
    <div style="overflow-x:auto; margin-top:10px;">
      <table class="compare-table">
        <thead><tr><th></th><th>${MONTH_NAMES[m - 1]} ${y}</th><th>${MONTH_NAMES[pm - 1]} ${py}</th></tr></thead>
        <tbody>
          ${row('دخل', curS.income, prevS.income)}
          ${row('مصاريف', curS.expense, prevS.expense)}
          ${row('الصافي', curS.net, prevS.net)}
          ${row('الادخار', curS.net, prevS.net, s => s.savingsRate === null ? '' : `(${s.savingsRate.toFixed(0)}%)`)}
        </tbody>
      </table>
    </div>
    ${insights.length ? `<div class="insight-list" style="margin-top:12px;">${insights.map(it => `<div class="insight-item insight-${it.tone}"><span>${it.icon}</span><span>${it.text}</span></div>`).join('')}</div>` : ''}
  </div>`;
}

function renderDashboard() {
  const view = $('#view-dashboard');
  const currencies = allTimeCurrenciesWithActivity();
  const now = new Date();

  const cards = currencies.length ? currencies.map((cur, idx) => {
    const income = txByKind('income').filter(t => t.currency === cur).reduce((s, t) => s + t.amount, 0);
    const expense = txByKind('expense').filter(t => t.currency === cur).reduce((s, t) => s + t.amount, 0);
    const outflows = DATA.zakatPayments.filter(z => !z.deleted && z.currency === cur).reduce((s, z) => s + z.amount, 0);
    const net = income - expense - outflows;
    let sub = '';
    if (net === 0) {
      const lastTx = [...DATA.transactions].filter(t => !t.deleted && t.currency === cur).sort((a, b) => b.date.localeCompare(a.date))[0];
      sub = lastTx ? `<div class="muted" style="font-size:11px; margin-top:4px;">آخر نشاط: ${lastTx.date}</div>` : '';
    }
    const icon = net > 0 ? '📈' : net < 0 ? '📉' : '➖';
    return `<div class="stat-card dash-card ${net > 0 ? 'positive' : net < 0 ? 'negative' : ''}" style="animation-delay:${idx * 70}ms">
      <div class="label">${icon} الصافي · <span class="cur-badge" style="color:${curColor(cur)}">${cur}</span></div>
      <div class="value">${bidi(fmt(net))}</div>${sub}${netAfterDebtsRow(net, cur)}${currentNetRow(cur)}</div>`;
  }).join('') : '<p class="muted">لا توجد بيانات بعد — ابدأ بإضافة أول حركة من الشهر الحالي.</p>';

  // العناصر المهمة/المعلّمة عبر كل الوقت
  const flaggedTx = DATA.transactions.filter(t => !t.deleted && t.flagged);
  const flaggedProj = DATA.projects.filter(p => !p.deleted && p.flagged);
  const unpaidProjects = DATA.projects.filter(p => !p.deleted && computeProjectPaid(p) < p.agreedAmount);
  const activeAlerts = DATA.alerts.filter(a => a.active && !a.deleted).length;

  const recent = [...DATA.transactions].filter(t => !t.deleted).sort((a, b) => b.createdAt - a.createdAt).slice(0, 6);

  view.innerHTML = `
    <div class="dash-hero">
      <div><h2 class="view-title">مرحبًا 👋</h2><p class="view-sub">نظرة شاملة لكل الوقت</p></div>
      <button class="btn" id="goCurrentMonth">اذهب للشهر الحالي ‹</button>
    </div>

    <div class="grid grid-3">${cards}</div>

    ${currencies.map(c => monthComparisonCardHtml(c)).join('')}

    <div class="card glass-panel" data-focus="wherenow" style="margin-top:16px;">
      <strong>🔎 وين واصل</strong>
      <div style="margin-top:10px;">
        ${unpaidProjects.length === 0 && flaggedTx.length === 0 && flaggedProj.length === 0
          ? '<p class="muted">لا توجد عناصر معلّقة أو مهمة حاليًا — كل شيء متابَع 👌</p>' : ''}
        ${flaggedTx.length + flaggedProj.length > 0 ? `<p class="muted" style="font-size:12px;">⭐ عناصر معلّمة كمهمة</p>` : ''}
        ${flaggedTx.map(t => `<div class="list-row"><span>⭐ ${sourceName(t)}</span><span>${fmt(t.amount)} ${t.currency} <span class="muted">· ${t.date}</span></span></div>`).join('')}
        ${flaggedProj.map(p => { const c = DATA.clients.find(c => c.id === p.clientId); return `<div class="list-row"><span>⭐ ${c ? c.name : ''} — ${p.title}</span><span>${bidi(fmt(computeProjectPaid(p))+'/'+fmt(p.agreedAmount)+' '+(c ? c.currency : ''))}</span></div>`; }).join('')}
        ${unpaidProjects.length > 0 ? `<p class="muted" style="font-size:12px; margin-top:${flaggedTx.length + flaggedProj.length ? '10px' : '0'};">💰 عملاء لم يكتمل الدفع بعد</p>` : ''}
        ${unpaidProjects.map(p => { const c = DATA.clients.find(c => c.id === p.clientId); return `<div class="list-row"><span>${c ? c.name : ''} — ${p.title}</span><span>${bidi(fmt(computeProjectPaid(p))+'/'+fmt(p.agreedAmount)+' '+(c ? c.currency : ''))}</span></div>`; }).join('')}
      </div>
    </div>

    <div class="card glass-panel" style="margin-top:14px;">
      <div style="display:flex; justify-content:space-between; align-items:center;">
        <strong>🕘 آخر الحركات</strong><span class="muted" style="font-size:12px;">${activeAlerts} تنبيه نشط</span>
      </div>
      <div style="margin-top:10px;">
        ${recent.length === 0 ? '<p class="muted">لا توجد حركات بعد</p>' : recent.map((t, i) => `
          <div class="list-row" style="animation:fadeSlideIn .3s ease ${i * 50}ms both;"><span>${t.kind === 'income' ? '💰' : '🔻'} ${sourceName(t)}</span>
          <span class="${t.kind === 'expense' ? 'total-emph neg' : ''}">${bidi((t.kind === 'expense' ? '-' : '') + fmt(t.amount) + ' ' + t.currency)} <span class="muted">· ${t.date}</span></span></div>`).join('')}
      </div>
    </div>`;

  $('#goCurrentMonth').addEventListener('click', () => {
    navYear = now.getFullYear(); navMonth = now.getMonth() + 1; monthTab = 'income';
    showView('yearly');
  });
}

/* ============================================================
   الجرد الكلي للسنوات: سنوات → نظرة سنة → شهر
   ============================================================ */
function renderYearly() {
  if (yearlyCompareMode) return renderYearlyCompareOverview();
  if (navYear === null) return renderYearsGrid();
  if (navMonth === null) return renderYearOverview();
  return renderMonthView();
}

function renderYearlyCompareOverview() {
  const view = $('#view-yearly');
  const years = [...DATA.settings.years].sort((a, b) => a - b);
  const allTx = DATA.transactions.filter(t => !t.deleted);
  const activeCurs = currenciesWithActivity(allTx);
  const currencies = activeCurs.length ? activeCurs : DATA.settings.currencies;
  if (!compareCurrency || !currencies.includes(compareCurrency)) compareCurrency = currencies[0];
  const cur = compareCurrency;

  const yearStats = years.map(y => {
    const income = realSum('income', t => t.currency === cur && inYear(t.date, y));
    const expense = realSum('expense', t => t.currency === cur && inYear(t.date, y));
    const debtFlow = debtFlowSum(t => t.currency === cur && inYear(t.date, y));
    const invest = DATA.investments.filter(t => !t.deleted && t.currency === cur && inYear(t.date, y)).reduce((s, t) => s + t.amount, 0);
    const outflows = DATA.zakatPayments.filter(z => !z.deleted && z.currency === cur && inYear(z.date, y)).reduce((s, z) => s + z.amount, 0);
    return { y, income, expense, debtFlow, invest, outflows, net: income - expense - outflows + debtFlow };
  });

  // 2) نسبة النمو مقابل السنة السابقة
  yearStats.forEach((s, i) => { s.growth = i > 0 && yearStats[i - 1].net !== 0 ? ((s.net - yearStats[i - 1].net) / Math.abs(yearStats[i - 1].net)) * 100 : null; });

  // 3) أفضل/أسوأ سنة
  const withData = yearStats.filter(s => s.income || s.expense);
  const bestYear = withData.length ? withData.reduce((a, b) => b.net > a.net ? b : a) : null;
  const worstYear = withData.length ? withData.reduce((a, b) => b.net < a.net ? b : a) : null;

  // 4) خط زمني متصل: كل شهور كل السنين على محور واحد
  const timeline = [], timelineLabels = [];
  years.forEach(y => { for (let m = 1; m <= 12; m++) {
    const income = txByKind('income').filter(t => t.currency === cur && inMonth(t.date, y, m)).reduce((s, t) => s + t.amount, 0);
    const expense = txByKind('expense').filter(t => t.currency === cur && inMonth(t.date, y, m)).reduce((s, t) => s + t.amount, 0);
    const outflows = DATA.zakatPayments.filter(z => !z.deleted && z.currency === cur && inMonth(z.date, y, m)).reduce((s, z) => s + z.amount, 0);
    timeline.push(income - expense - outflows); timelineLabels.push(`${MONTH_NAMES[m - 1].slice(0, 3)} ${String(y).slice(2)}`);
  }});

  // 5) مقارنة العملاء عبر السنين (أفضل سنة دخل فريلانس)
  const clientsWithCurrency = DATA.clients.filter(c => !c.deleted && c.currency === cur);
  const clientYearRows = clientsWithCurrency.map(c => {
    const projectIds = DATA.projects.filter(p => p.clientId === c.id && !p.deleted).map(p => p.id);
    const perYear = years.map(y => DATA.transactions.filter(t => !t.deleted && t.mode === 'client' && projectIds.includes(t.projectId) && inYear(t.date, y)).reduce((s, t) => s + t.amount, 0));
    const bestIdx = perYear.reduce((bi, v, i) => v > perYear[bi] ? i : bi, 0);
    return { name: c.name, perYear, bestYear: perYear[bestIdx] > 0 ? years[bestIdx] : null, bestVal: perYear[bestIdx], maxVal: Math.max(1, ...perYear) };
  }).filter(r => r.perYear.some(v => v > 0));

  // 6) إجمالي حياتي شامل
  const lifetimeIncome = realSum('income', t => t.currency === cur);
  const lifetimeExpense = realSum('expense', t => t.currency === cur);
  const lifetimeDebtFlow = debtFlowSum(t => t.currency === cur);

  const byCategory = {};
  DATA.transactions.filter(t => !t.deleted && t.kind === 'expense' && t.currency === cur && t.mode !== 'debt').forEach(t => {
    const cat = DATA.categories.find(c => c.id === t.categoryId);
    const key = cat ? cat.id : 'other';
    if (!byCategory[key]) byCategory[key] = { label: cat ? cat.name : 'أخرى', value: 0, color: cat ? cat.color : '#6b7280' };
    byCategory[key].value += t.amount;
  });
  const donutData = Object.values(byCategory).sort((a, b) => b.value - a.value);

  view.innerHTML = `
    <div class="crumb-bar"><button class="btn ghost" id="backFromCompare">‹ السنوات</button><h2 class="view-title" style="margin:0;">📚 الجرد الكلي للسنوات</h2></div>
    <p class="view-sub">نظرة مقارنة شاملة عبر كل السنين المسجّلة</p>
    <div style="display:flex; justify-content:space-between; align-items:center; flex-wrap:wrap; gap:10px;">
      <div class="segmented" id="compareCurSwitch">${currencies.map(c => `<button data-cur="${c}" class="${c === cur ? 'active' : ''}" style="${c === cur ? `background:${curColor(c)}; box-shadow:0 0 14px ${curColor(c)}66;` : ''}">${c}</button>`).join('')}</div>
      <button class="btn ghost sm" id="exportCompareReportBtn">📄 تصدير المقارنة (PDF)</button>
    </div>

    <div class="stat-card glass-panel" style="margin-top:14px;"><div class="label">💰 إجمالي كل حياتك المسجّلة (${cur})</div>
      <div class="value" style="font-size:30px;">${bidi(fmt(lifetimeIncome - lifetimeExpense + lifetimeDebtFlow))}</div>
      <div class="muted" style="font-size:11px; margin-top:4px;">دخل ${bidi(fmt(lifetimeIncome))} · مصاريف ${bidi(fmt(lifetimeExpense))}${lifetimeDebtFlow ? ` · صافي حركة الديون ${bidi((lifetimeDebtFlow >= 0 ? '+' : '') + fmt(lifetimeDebtFlow))}` : ''}</div>${currentNetRow(cur)}</div>

    ${bestYear && worstYear ? `<div class="grid grid-3" style="margin-top:14px;">
      <div class="stat-card positive"><div class="label">🏆 أفضل سنة (صافي)</div><div class="value" style="font-size:20px;">${bestYear.y}</div></div>
      <div class="stat-card negative"><div class="label">📉 أسوأ سنة (صافي)</div><div class="value" style="font-size:20px;">${worstYear.y}</div></div>
      <div class="stat-card"><div class="label">عدد السنوات المسجَّلة</div><div class="value" style="font-size:20px;">${years.length}</div></div>
    </div>` : ''}

    <div class="card glass-panel" style="margin-top:14px;">
      <strong>مقارنة الصافي السنوي — ${cur}</strong>
      <div style="margin-top:12px;">${barChartCompare(yearStats)}</div>
    </div>

    <div class="card glass-panel" style="margin-top:14px;">
      <strong>📈 منحنى الصافي عبر السنين — ${cur}</strong>
      <div class="chart-wrap" style="margin-top:12px;">${richLineChart(yearStats.map(s => s.net), { color: '#4f9dff', xLabels: years.map(String), maxXLabels: years.length, axisTag: cur })}</div>
    </div>

    <div class="card glass-panel" style="margin-top:14px; overflow-x:auto;">
      <strong>📋 جدول مقارنة تفصيلي — ${cur}</strong>
      <table class="compare-table">
        <thead><tr><th>السنة</th><th>الدخل</th><th>المصاريف</th><th>حركة ديون</th><th>الصافي</th><th>أرباح الاستثمار</th><th>الإخراجات</th><th>النمو %</th></tr></thead>
        <tbody>${yearStats.map(s => `<tr>
          <td>${s.y}</td><td>${bidi(fmt(s.income))}</td><td>${bidi(fmt(s.expense))}</td>
          <td class="${s.debtFlow > 0 ? 'pos-cell' : s.debtFlow < 0 ? 'neg-cell' : ''}">${s.debtFlow ? bidi((s.debtFlow >= 0 ? '+' : '') + fmt(s.debtFlow)) : '—'}</td>
          <td class="${s.net >= 0 ? 'pos-cell' : 'neg-cell'}">${bidi(fmt(s.net))}</td>
          <td>${bidi(fmt(s.invest))}</td><td>${bidi(fmt(s.outflows))}</td>
          <td class="${s.growth === null ? '' : s.growth >= 0 ? 'pos-cell' : 'neg-cell'}">${s.growth === null ? '—' : bidi((s.growth >= 0 ? '+' : '') + s.growth.toFixed(1) + '%')}</td>
        </tr>`).join('')}</tbody>
      </table>
    </div>

    <div class="card glass-panel" style="margin-top:14px;">
      <strong>📈 الخط الزمني المتصل — كل الشهور عبر كل السنين (${cur})</strong>
      <div class="chart-wrap" style="margin-top:12px;">${richLineChart(timeline, { color: '#7c5cff', xLabels: timelineLabels, maxXLabels: 14, axisTag: cur })}</div>
    </div>

    ${clientYearRows.length ? `<div class="card glass-panel" style="margin-top:14px;">
      <strong>👥 مقارنة العملاء عبر السنين — ${cur}</strong>
      <div style="margin-top:12px; display:flex; flex-direction:column; gap:20px;">${clientYearRows.map(r => `
        <div>
          <div style="display:flex; justify-content:space-between; font-size:13px; margin-bottom:4px;">
            <span style="font-weight:700;">${r.name}</span>
            <span class="muted">${r.bestYear ? `أفضل سنة: <b style="color:var(--green);">${r.bestYear}</b> (${bidi(fmt(r.bestVal))})` : 'لا دخل بعد'}</span>
          </div>
          <div class="chart-wrap">${bar3DChartIso(years.map((y2, i) => ({ label: String(y2), value: r.perYear[i] })), { height: 190 })}</div>
        </div>`).join('')}</div>
    </div>` : ''}

    <div class="card glass-panel" style="margin-top:14px;">
      <strong>🍩 توزيع المصاريف حسب الفئة — كل السنوات مجتمعة (${cur})</strong>
      <div style="margin-top:10px; display:flex; justify-content:center;">${donutChart(donutData)}</div>
    </div>

    <div class="card glass-panel" style="margin-top:14px;">
      <div style="display:flex; justify-content:space-between; align-items:center; flex-wrap:wrap; gap:10px;">
        <strong>📊 مقارنة مصادر الدخل — كل السنوات مجتمعة (${cur})</strong>
        <div class="segmented" id="compareBarModeSwitch">
          <button data-bmode="general" class="${compareBarMode === 'general' ? 'active' : ''}">مصدر عادي</button>
          <button data-bmode="client" class="${compareBarMode === 'client' ? 'active' : ''}">عميل/مشروع</button>
          <button data-bmode="together" class="${compareBarMode === 'together' ? 'active' : ''}">معًا</button>
        </div>
      </div>
      <div class="chart-wrap" style="margin-top:14px;">${bar3DChart(incomeSourceBars(compareBarMode, cur, () => true))}</div>
    </div>`;

  $('#backFromCompare').addEventListener('click', () => { yearlyCompareMode = false; renderYearly(); });
  $('#compareCurSwitch').addEventListener('click', (e) => { const b = e.target.closest('button[data-cur]'); if (!b) return; compareCurrency = b.dataset.cur; renderYearlyCompareOverview(); });
  $('#compareBarModeSwitch').addEventListener('click', (e) => { const b = e.target.closest('button[data-bmode]'); if (!b) return; compareBarMode = b.dataset.bmode; renderYearlyCompareOverview(); });
  $('#exportCompareReportBtn').addEventListener('click', () => exportCompareReport(years, yearStats, cur));
  animateChartDraw(view);
}

function barChartCompare(yearStats) {
  const w = 900, h = 240, pad = 44, depth = 14;
  const vals = yearStats.map(s => s.net);
  const maxAbs = Math.max(1, ...vals.map(Math.abs));
  const barW = Math.min(64, (w - pad * 2) / yearStats.length - 28);
  const zeroY = h / 2;
  const id = 'cmp' + (chartIdCounter++);
  const bars = yearStats.map((s, i) => {
    const x = pad + i * ((w - pad * 2) / yearStats.length) + 14;
    const barH = (Math.abs(s.net) / maxAbs) * (h / 2 - 26);
    const isPos = s.net >= 0;
    const y = isPos ? zeroY - barH : zeroY;
    const color = isPos ? '#22d3a8' : '#ef5a6f';
    const topColor = shadeColor(color, 30), sideColor = shadeColor(color, -30);
    const gradId = `cmpg-${id}-${i}`;
    // عند الأعمدة السالبة يكون الوجه العلوي المائل عند القاعدة (أعلى العمود الفعلي) بدل القمة، حتى يبقى المنظور منطقيًا في الاتجاهين
    const faceY = isPos ? y : y + barH;
    return `<g class="bar3d-group" style="animation-delay:${i * 90}ms;">
      <defs><linearGradient id="${gradId}" x1="0" y1="0" x2="0" y2="1">
        <stop offset="0%" stop-color="${topColor}" /><stop offset="55%" stop-color="${color}" /><stop offset="100%" stop-color="${shadeColor(color, -14)}" />
      </linearGradient></defs>
      <polygon class="bar3d-side" points="${x + barW},${y} ${x + barW + depth},${y - depth / 1.6} ${x + barW + depth},${y + barH - depth / 1.6} ${x + barW},${y + barH}" fill="${sideColor}" style="animation-delay:${i * 90}ms;" />
      <polygon class="bar3d-top" points="${x},${faceY} ${x + depth},${faceY - depth / 1.6} ${x + barW + depth},${faceY - depth / 1.6} ${x + barW},${faceY}" fill="${topColor}" style="animation-delay:${i * 90}ms;" />
      <rect class="bar3d-rect" x="${x}" y="${y}" width="${barW}" height="${barH}" fill="url(#${gradId})" style="animation-delay:${i * 90}ms; color:${color};">
        <title>${s.y}: ${fmt(s.net)}</title></rect>
      <text x="${x + barW / 2 + depth / 2}" y="${(isPos ? y - depth / 1.6 : y + barH + depth / 1.6 + 14)}" text-anchor="middle" font-size="11.5" font-weight="700" fill="${color}">${bidi(fmt(s.net))}</text>
      <text x="${x + barW / 2}" y="${h - 10}" text-anchor="middle" font-size="12" fill="rgba(255,255,255,0.7)">${s.y}</text></g>`;
  }).join('');
  return `<svg width="100%" viewBox="0 0 ${w} ${h}" data-chart-anim="1">
    <line x1="${pad}" y1="${zeroY}" x2="${w - pad}" y2="${zeroY}" stroke="rgba(255,255,255,0.15)" />
    ${bars}
  </svg>`;
}

function renderYearsGrid() {
  const view = $('#view-yearly');
  view.innerHTML = `
    <h2 class="view-title">${label('nav_yearly')}</h2>
    <p class="view-sub">اختر سنة للدخول إلى تفاصيلها شهرًا بشهر</p>
    <div class="ym-grid">
      ${DATA.settings.years.map(y => `
        <div class="ym-tile ${yearHasData(y) ? 'has-data' : ''}" style="position:relative;">
          <span data-year="${y}" style="display:block;">${y}</span>
          <button class="btn ghost sm" data-delyear="${y}" style="position:absolute; top:4px; left:4px; padding:2px 7px;">×</button>
        </div>`).join('')}
      <div class="ym-tile dashed" id="addYearTile">+ إضافة سنة</div>
      <div class="ym-tile compare-tile" id="compareYearsTile"><span style="font-size:20px;">📚</span><div style="margin-top:6px;">الجرد الكلي للسنوات</div></div>
    </div>
    <div id="addYearForm" style="display:none; margin-top:12px;" class="card inline-form">
      <div class="form-grid" style="grid-template-columns: 2fr 1fr;">
        <label class="field">السنة<input type="number" id="newYearInput" placeholder="مثال: 2027"></label>
      </div>
      <div class="form-actions"><button class="btn sm" id="confirmAddYear">إضافة</button><button class="btn ghost sm" id="cancelAddYear">إلغاء</button></div>
    </div>`;
  $('#compareYearsTile').addEventListener('click', () => { yearlyCompareMode = true; renderYearly(); });
  $$('.ym-tile [data-year]', view).forEach(el => el.addEventListener('click', () => { navYear = parseInt(el.dataset.year); navMonth = null; renderYearly(); }));
  $$('[data-delyear]', view).forEach(el => el.addEventListener('click', (e) => {
    e.stopPropagation();
    const y = parseInt(el.dataset.delyear);
    if (yearHasData(y)) { toast('هذه السنة فيها بيانات — لن تُحذف بياناتها، فقط تختفي من القائمة'); }
    DATA.settings.years = DATA.settings.years.filter(x => x !== y);
    persist(true); renderYearsGrid();
  }));
  $('#addYearTile').addEventListener('click', () => { $('#addYearForm').style.display = 'block'; $('#newYearInput').focus(); });
  $('#cancelAddYear').addEventListener('click', () => { $('#addYearForm').style.display = 'none'; });
  $('#confirmAddYear').addEventListener('click', () => {
    const num = parseInt($('#newYearInput').value);
    if (num && !DATA.settings.years.includes(num)) {
      DATA.settings.years.push(num); DATA.settings.years.sort((a, b) => b - a);
      persist(true); renderYearsGrid();
    } else if (!num) toast('أدخل سنة صحيحة');
  });
}
function yearHasData(y) {
  return DATA.transactions.some(t => !t.deleted && inYear(t.date, y)) || DATA.investments.some(t => !t.deleted && inYear(t.date, y));
}

let yearOverviewCurrency = null;
function renderYearOverview() {
  const view = $('#view-yearly');
  const y = navYear;
  const yearTx = DATA.transactions.filter(t => !t.deleted && inYear(t.date, y));
  const currencies = currenciesWithActivity(yearTx.length ? yearTx : DATA.settings.currencies.map(c => ({ currency: c, amount: 0 })));
  const activeCurrencies = currencies.length ? currencies : DATA.settings.currencies;
  if (!yearOverviewCurrency || !activeCurrencies.includes(yearOverviewCurrency)) yearOverviewCurrency = activeCurrencies[0];
  const cur = yearOverviewCurrency;

  const monthly = Array.from({ length: 12 }, (_, i) => {
    const m = i + 1;
    const income = txByKind('income').filter(t => t.currency === cur && inMonth(t.date, y, m)).reduce((s, t) => s + t.amount, 0);
    const expense = txByKind('expense').filter(t => t.currency === cur && inMonth(t.date, y, m)).reduce((s, t) => s + t.amount, 0);
    const outflows = DATA.zakatPayments.filter(z => !z.deleted && z.currency === cur && inMonth(z.date, y, m)).reduce((s, z) => s + z.amount, 0);
    return { m, income, expense, outflows, net: income - expense - outflows };
  });
  const withData = monthly.filter(x => x.income || x.expense);
  const best = withData.length ? withData.reduce((a, b) => b.net > a.net ? b : a) : null;
  const worst = withData.length ? withData.reduce((a, b) => b.net < a.net ? b : a) : null;
  const totalExpense = realSum('expense', t => t.currency === cur && inYear(t.date, y));
  const totalNet = monthly.reduce((s, x) => s + x.net, 0);
  const investProfit = DATA.investments.filter(t => !t.deleted && t.currency === cur && inYear(t.date, y)).reduce((s, t) => s + t.amount, 0);

  // 🔥 أعلى يوم إنفاق · 💎 أعلى دخل (أكبر معاملة) · أعلى يوم دخل — للسنة والعملة الحاليتين
  const expenseByDay = {}, incomeByDay = {};
  yearTx.forEach(t => {
    if (t.currency !== cur || t.mode === 'debt') return;
    if (t.kind === 'expense') expenseByDay[t.date] = (expenseByDay[t.date] || 0) + t.amount;
    else if (t.kind === 'income') incomeByDay[t.date] = (incomeByDay[t.date] || 0) + t.amount;
  });
  const topSpendDay = Object.entries(expenseByDay).sort((a, b) => b[1] - a[1])[0];
  const topIncomeDay = Object.entries(incomeByDay).sort((a, b) => b[1] - a[1])[0];
  const topIncomeTx = yearTx.filter(t => t.kind === 'income' && t.currency === cur && t.mode !== 'debt').sort((a, b) => b.amount - a.amount)[0];

  const byCategory = {};
  DATA.transactions.filter(t => !t.deleted && t.kind === 'expense' && t.currency === cur && t.mode !== 'debt' && inYear(t.date, y)).forEach(t => {
    const cat = DATA.categories.find(c => c.id === t.categoryId);
    const key = cat ? cat.id : 'other';
    if (!byCategory[key]) byCategory[key] = { label: cat ? cat.name : 'أخرى', value: 0, color: cat ? cat.color : '#6b7280' };
    byCategory[key].value += t.amount;
  });
  const yearDonutData = Object.values(byCategory).sort((a, b) => b.value - a.value);

  view.innerHTML = `
    <div class="crumb-bar"><button class="btn ghost" id="backToYears">‹ السنوات</button><h2 class="view-title" style="margin:0;">جرد سنة ${y}</h2></div>
    <div class="segmented" id="yearCurSwitch">${activeCurrencies.map(c => `<button data-cur="${c}" class="${c === cur ? 'active' : ''}" style="${c === cur ? `background:${curColor(c)}; box-shadow:0 0 14px ${curColor(c)}66;` : ''}">${c}</button>`).join('')}</div>
    <div class="grid grid-4" style="margin-top:14px;">
      <div class="stat-card"><div class="label">أفضل شهر (صافي ${cur})</div><div class="value" style="font-size:18px;">${best ? MONTH_NAMES[best.m - 1] : '—'}</div></div>
      <div class="stat-card"><div class="label">أسوأ شهر (صافي ${cur})</div><div class="value" style="font-size:18px;">${worst ? MONTH_NAMES[worst.m - 1] : '—'}</div></div>
      <div class="stat-card ${investProfit >= 0 ? 'positive' : 'negative'}"><div class="label">أرباح الاستثمار (${cur})</div><div class="value">${bidi(fmt(investProfit))}</div></div>
      <div class="stat-card negative"><div class="label">إجمالي مصاريف السنة (${cur})</div><div class="value">${bidi(fmt(totalExpense))}</div></div>
      <div class="stat-card negative"><div class="label">🔥 أعلى يوم إنفاق (${cur})</div>
        <div class="value" style="font-size:17px;">${topSpendDay ? bidi(fmt(topSpendDay[1])) : '—'}</div>
        ${topSpendDay ? `<div class="muted" style="font-size:11px; margin-top:4px;">${topSpendDay[0]}</div>` : ''}</div>
      <div class="stat-card positive"><div class="label">💎 أعلى دخل (معاملة واحدة، ${cur})</div>
        <div class="value" style="font-size:17px;">${topIncomeTx ? bidi(fmt(topIncomeTx.amount)) : '—'}</div>
        ${topIncomeTx ? `<div class="muted" style="font-size:11px; margin-top:4px;">${topIncomeTx.date} · ${sourceName(topIncomeTx)}</div>` : ''}</div>
      <div class="stat-card positive"><div class="label">📅 أعلى يوم دخل (${cur})</div>
        <div class="value" style="font-size:17px;">${topIncomeDay ? bidi(fmt(topIncomeDay[1])) : '—'}</div>
        ${topIncomeDay ? `<div class="muted" style="font-size:11px; margin-top:4px;">${topIncomeDay[0]}</div>` : ''}</div>
    </div>
    <div class="card" style="margin-top:14px;">
      <strong>الصافي الشهري خلال ${y} — ${cur}</strong>
      <div class="chart-wrap" style="margin-top:10px;">${richLineChart(monthly.map(x => x.net), { color: totalNet >= 0 ? '#22d3a8' : '#ef5a6f', xLabels: MONTH_NAMES.map(n => n.slice(0, 3)), axisTag: cur })}</div>
      <p class="muted" style="font-size:12px; margin-top:6px;">إجمالي صافي السنة بـ${cur}: <span class="total-emph ${totalNet >= 0 ? 'pos' : 'neg'}">${bidi(fmt(totalNet))}</span></p>
      ${netAfterDebtsRow(totalNet, cur)}${currentNetRow(cur)}
    </div>
    <div class="ym-grid" style="margin-top:16px;">
      ${monthly.map(x => {
        const isCurrent = y === new Date().getFullYear() && x.m === new Date().getMonth() + 1;
        return `<div class="ym-tile ${x.income || x.expense ? 'has-data' : ''} ${isCurrent ? 'current-month' : ''}" data-month="${x.m}">${MONTH_NAMES[x.m - 1]}${x.income || x.expense ? `<div class="ym-value ${x.net >= 0 ? 'positive' : 'negative'}" style="color:${x.net >= 0 ? 'var(--green)' : 'var(--red)'}">${bidi(fmt(x.net))}</div>` : ''}</div>`;
      }).join('')}
    </div>

    ${yearDonutData.length ? `<div class="card glass-panel" style="margin-top:16px;">
      <strong>🍩 توزيع المصاريف حسب الفئة — سنة ${y} (${cur})</strong>
      <div style="margin-top:10px; display:flex; justify-content:center;">${donutChart(yearDonutData)}</div>
    </div>` : ''}

    <div class="card glass-panel" style="margin-top:16px;">
      <div style="display:flex; justify-content:space-between; align-items:center; flex-wrap:wrap; gap:10px;">
        <strong>📊 مقارنة مصادر الدخل — سنة ${y} (${cur})</strong>
        <div class="segmented" id="yearBarModeSwitch">
          <button data-bmode="general" class="${yearBarMode === 'general' ? 'active' : ''}">مصدر عادي</button>
          <button data-bmode="client" class="${yearBarMode === 'client' ? 'active' : ''}">عميل/مشروع</button>
          <button data-bmode="together" class="${yearBarMode === 'together' ? 'active' : ''}">معًا</button>
        </div>
      </div>
      <div class="chart-wrap" style="margin-top:14px;">${bar3DChart(incomeSourceBars(yearBarMode, cur, t => inYear(t.date, y)))}</div>
    </div>

    <div class="card" style="margin-top:16px;">
      <strong>🗺️ خريطة الحرارة السنوية — ${cur}</strong>
      <p class="muted" style="font-size:11px; margin:4px 0 10px;">كل مربع = يوم؛ أخضر = صافي موجب، أحمر = صافي سالب، الشدة حسب الحجم</p>
      ${heatmapGrid(y, cur)}
    </div>

    <div class="form-actions" style="margin-top:14px;"><button class="btn ghost sm" id="exportYearReportBtn">📄 تصدير تقرير السنة (PDF)</button></div>`;

  $('#yearCurSwitch').addEventListener('click', (e) => { const b = e.target.closest('button[data-cur]'); if (!b) return; yearOverviewCurrency = b.dataset.cur; renderYearOverview(); });
  $('#yearBarModeSwitch').addEventListener('click', (e) => { const b = e.target.closest('button[data-bmode]'); if (!b) return; yearBarMode = b.dataset.bmode; renderYearOverview(); });
  $('#backToYears').addEventListener('click', () => { navYear = null; renderYearly(); });
  $('#exportYearReportBtn').addEventListener('click', () => exportReport('year', y));
  $$('.ym-tile[data-month]', view).forEach(el => el.addEventListener('click', () => { navMonth = parseInt(el.dataset.month); monthTab = 'income'; renderYearly(); }));
  animateChartDraw(view);
}

function refreshMonthSummary() {
  const host = document.getElementById('monthSummaryHost');
  if (host && navYear !== null && navMonth !== null) { host.innerHTML = monthSummaryHtml(navYear, navMonth); animateHealthRings(host); }
}
function monthSummaryHtml(y, m) {
  const currencies = DATA.settings.currencies;
  const cards = currencies.map(cur => {
    const income = txByKind('income').filter(t => t.currency === cur && inMonth(t.date, y, m)).reduce((s, t) => s + t.amount, 0);
    const expense = txByKind('expense').filter(t => t.currency === cur && inMonth(t.date, y, m)).reduce((s, t) => s + t.amount, 0);
    const outflows = DATA.zakatPayments.filter(z => !z.deleted && z.currency === cur && inMonth(z.date, y, m)).reduce((s, z) => s + z.amount, 0);
    if (!income && !expense && !outflows) return '';
    const net = income - expense; const netAfterOutflows = net - outflows;
    const realIncome = realSum('income', t => t.currency === cur && inMonth(t.date, y, m));
    const realExpense = realSum('expense', t => t.currency === cur && inMonth(t.date, y, m));
    const debtFlow = debtFlowSum(t => t.currency === cur && inMonth(t.date, y, m));
    return `<div class="stat-card ${netAfterOutflows >= 0 ? 'positive' : 'negative'}"><div class="label">صافي <span class="cur-badge" style="color:${curColor(cur)}">${cur}</span> بعد الإخراجات</div>
      <div class="value">${bidi(fmt(netAfterOutflows) + ' ' + cur)}</div>
      <div class="muted" style="font-size:11px; margin-top:4px;">دخل ${bidi(fmt(realIncome))} · مصاريف ${bidi(fmt(realExpense))} · إخراجات ${bidi(fmt(outflows))}${debtFlow ? ` · حركة ديون ${bidi((debtFlow >= 0 ? '+' : '') + fmt(debtFlow))}` : ''}</div>${netAfterDebtsRow(netAfterOutflows, cur)}</div>`;
  }).filter(Boolean).join('');
  if (!cards) return '';

  const healthRings = currencies.map(cur => {
    const income = realSum('income', t => t.currency === cur && inMonth(t.date, y, m));
    const expense = realSum('expense', t => t.currency === cur && inMonth(t.date, y, m));
    if (!income) return '';
    return `<div><div class="cur-badge" style="color:${curColor(cur)}; font-size:12px; margin-bottom:4px;">${cur}</div>${healthScoreRing(computeHealthScore(income, expense))}</div>`;
  }).filter(Boolean).join('');
  const healthBox = healthRings ? `<div class="card glass-panel" style="margin-bottom:14px;">
      <strong>💗 مؤشر الصحة المالية لهذا الشهر (كل عملة منفردة)</strong>
      <div style="margin-top:10px; display:flex; gap:24px; flex-wrap:wrap;">${healthRings}</div>
    </div>` : '';

  return `${healthBox}<div class="grid grid-3" style="margin-bottom:14px;">${cards}</div>
    <div class="form-actions" style="margin-bottom:14px;"><button class="btn ghost sm" id="exportMonthReportBtn">📄 تصدير تقرير هذا الشهر (PDF)</button></div>`;
}

function renderMonthView() {
  const view = $('#view-yearly');
  const y = navYear, m = navMonth;
  const tabs = [['income', 'دخل'], ['expense', 'مصاريف'], ['investment', 'استثمار'], ['outflows', 'إخراجات'], ['clients', 'عملاء']]
    .filter(([k]) => !DATA.settings.disabledSections.includes(k));
  if (DATA.settings.disabledSections.includes(monthTab)) monthTab = tabs[0] ? tabs[0][0] : 'income';

  view.innerHTML = `
    <div class="crumb-bar">
      <button class="btn ghost" id="backToYear">‹ سنة ${y}</button>
      <h2 class="view-title" style="margin:0;">${MONTH_NAMES[m - 1]} ${y}</h2>
    </div>
    <div id="monthSummaryHost">${monthSummaryHtml(y, m)}</div>
    <div class="segmented" id="monthTabs">
      ${tabs.map(([k, l]) => `<button data-tab="${k}" class="${monthTab === k ? 'active' : ''}">${l}</button>`).join('')}
    </div>
    <div id="monthTabHost" style="margin-top:14px;"></div>`;

  $('#backToYear').addEventListener('click', () => { navMonth = null; renderYearly(); });
  animateHealthRings(view);
  view.addEventListener('click', (e) => { if (e.target.closest('#exportMonthReportBtn')) exportReport('month', y, m); });
  $('#monthTabs').addEventListener('click', (e) => {
    const btn = e.target.closest('button[data-tab]'); if (!btn) return;
    monthTab = btn.dataset.tab; renderYearly();
  });

  const host = $('#monthTabHost');
  if (monthTab === 'income') renderTransactionsInto(host, 'income', y, m);
  else if (monthTab === 'expense') renderTransactionsInto(host, 'expense', y, m);
  else if (monthTab === 'investment') renderInvestmentInto(host, y, m);
  else if (monthTab === 'outflows') renderOutflowsInto(host, y, m);
  else if (monthTab === 'clients') renderClientsInMonthInto(host, y, m);
}

/* ============================================================
   جدول الدخل / المصاريف (داخل شهر محدد)
   ============================================================ */
function expenseDonutHtml(list) {
  const currencies = currenciesWithActivity(list);
  if (currencies.length === 0) return '';
  const sections = currencies.map(cur => {
    const rows = list.filter(t => t.currency === cur);
    if (rows.length === 0) return ''; // حماية إضافية: لا نعرض عملة بدون بيانات فعلية حتى لو دخلت هنا بالخطأ
    const byCategory = {};
    rows.forEach(r => {
      const cat = DATA.categories.find(c => c.id === r.categoryId);
      const key = cat ? cat.id : 'other';
      if (!byCategory[key]) byCategory[key] = { label: cat ? cat.name : 'أخرى', value: 0, color: cat ? cat.color : '#6b7280' };
      byCategory[key].value += r.amount;
    });
    const data = Object.values(byCategory).sort((a, b) => b.value - a.value);
    return `<div class="donut-section"><div class="cur-badge" style="color:${curColor(cur)}; font-size:12px; margin-bottom:8px;">${cur}</div>${donutChart(data)}</div>`;
  }).filter(Boolean);
  if (sections.length === 0) return '';
  return `<div class="card" style="margin-top:14px;"><strong>🍩 توزيع المصاريف حسب الفئة</strong>
    <div class="donut-sections-grid">${sections.join('')}</div>
  </div>`;
}
function renderTransactionsInto(host, kind, y, m) {
  const list = txByKind(kind).filter(t => inMonth(t.date, y, m));
  const grouped = groupByDate(list);
  const today = todayISO();
  const addFormHtml = kind === 'income' ? incomeAddFormHtml(y, m) : expenseAddFormHtml(y, m);

  host.innerHTML = `
    <div style="display:flex; justify-content:space-between; align-items:center;">
      <p class="view-sub" style="margin:0;">${kind === 'income' ? 'يظهر اليوم فقط عند إضافة حركة إليه' : 'مصاريف الشهر مقسمة حسب اليوم والعملة والفئة'}</p>
      <button class="btn" id="toggleAddForm_${kind}">+ إضافة ${kind === 'income' ? 'دخل' : 'مصروف'}</button>
    </div>
    <div id="addFormHost_${kind}" class="card inline-form" style="display:${isPanelOpen('tx_add_' + kind) ? 'block' : 'none'};">${addFormHtml}</div>
    <div style="margin-top:16px;">
      ${grouped.length === 0 ? '<p class="muted">لا توجد حركات لهذا الشهر بعد.</p>' : grouped.map(([date, items]) => dayGroupHtml(kind, date, items, today)).join('')}
    </div>
    ${statsBlockHtml(kind, list.filter(t => t.mode !== 'debt'))}
    ${kind === 'expense' ? expenseDonutHtml(list.filter(t => t.mode !== 'debt')) : ''}
  `;

  $(`#toggleAddForm_${kind}`, host).addEventListener('click', () => {
    const h = $(`#addFormHost_${kind}`, host);
    const willOpen = h.style.display === 'none';
    h.style.display = willOpen ? 'block' : 'none';
    setPanelOpen('tx_add_' + kind, willOpen);
  });
  if (kind === 'income') bindIncomeForm(host, y, m); else bindExpenseForm(host, y, m);
  bindDayToggles(kind, host, y, m);
  bindStatsSwitch(kind, host, y, m);
  bindJumpToTransaction(kind, host, y, m);
}

function bindJumpToTransaction(kind, host, y, m) {
  $$('[data-jumptx]', host).forEach(el => el.addEventListener('click', (e) => {
    e.stopPropagation();
    const date = el.dataset.jumpdate;
    openDays.add(date + '_' + kind);
    renderTransactionsInto(host, kind, y, m);
    requestAnimationFrame(() => {
      const dayEl = host.querySelector(`.day-group[data-date="${date}"]`);
      if (dayEl) {
        dayEl.scrollIntoView({ behavior: 'smooth', block: 'center' });
        dayEl.classList.add('jump-highlight');
        setTimeout(() => dayEl.classList.remove('jump-highlight'), 1600);
      }
    });
  }));
}

function dayGroupHtml(kind, date, items, today) {
  const isNew = date === today && !DATA.meta.seenDates.includes(date);
  const currencies = Array.from(new Set(items.map(i => i.currency)));
  const isOpen = openDays.has(date + '_' + kind);
  const blocks = currencies.map(cur => {
    const rows = items.filter(i => i.currency === cur);
    const total = rows.reduce((s, r) => s + r.amount, 0);
    return `
      <div class="currency-block">
        <div class="cb-head"><span>قسم <span class="cur-badge" style="color:${curColor(cur)}">${cur}</span></span><span class="total-emph ${kind === 'expense' ? 'neg' : 'pos'}">${bidi((kind === 'expense' ? '-' : '+') + fmt(total) + ' ' + cur)}</span></div>
        ${rows.map(r => rowHtml(kind, r)).join('')}
      </div>`;
  }).join('');
  return `
    <div class="day-group ${isNew ? 'is-new' : ''}" data-date="${date}">
      <div class="day-header" data-toggle="${date}">
        <span class="day-title">${formatDateLabel(date)} ${isNew ? '✨' : ''}</span>
        <span class="details-icon" title="اضغط لعرض التفاصيل">تفاصيل ‹</span>
      </div>
      <div class="day-body ${isOpen ? 'open' : ''}">${blocks}</div>
    </div>`;
}

function rowHtml(kind, r) {
  if (editingRowId === r.id) {
    const currencies = DATA.settings.currencies;
    const cats = DATA.categories.filter(c => c.type === kind && !c.deleted);
    const isGeneral = r.mode !== 'client';
    return `
      <div class="currency-row" style="align-items:center; gap:6px; flex-wrap:wrap;">
        <input type="date" data-ef="date" value="${r.date}" style="width:130px;">
        ${isGeneral ? `<select data-ef="currency" style="width:90px;">${currencies.map(c => `<option value="${c}" ${c === r.currency ? 'selected' : ''}>${c}</option>`).join('')}</select>` : `<span class="muted" style="align-self:center;">${r.currency}</span>`}
        ${isGeneral ? `<select data-ef="categoryId" style="min-width:120px;">${cats.map(c => `<option value="${c.id}" ${c.id === r.categoryId ? 'selected' : ''}>${c.name}</option>`).join('')}</select>` : ''}
        <input type="number" data-ef="amount" value="${r.amount}" style="width:100px;">
        ${kind === 'income' ? `<input type="number" data-ef="hours" value="${r.hours || 0}" placeholder="ساعات" style="width:80px;">` : ''}
        <textarea class="autogrow" rows="1" data-ef="note" placeholder="ملاحظات" style="flex:1; min-width:120px;">${escHtml(r.note || '')}</textarea>
        <button class="btn sm" data-savetx="${r.id}" data-kind="${kind}">حفظ</button>
        <button class="btn ghost sm" data-canceltx="${r.id}">إلغاء</button>
      </div>`;
  }
  return `
    <div class="currency-row">
      <span>
        <button class="flag-btn ${r.flagged ? 'flagged' : ''}" data-flagtx="${r.id}" title="تعليم كمهم">★</button>
        ${sourceName(r)}
        <span class="tag ${r.mode === 'client' ? 'client' : 'general'}">${r.mode === 'client' ? label('source_client') : label('source_general')}</span>
        ${notePreviewHtml(r.note)}
      </span>
      <span>
        <span class="${kind === 'expense' ? 'total-emph neg' : ''}">${bidi((kind === 'expense' ? '-' : '') + fmt(r.amount) + ' ' + r.currency + (r.hours ? ` · ${fmt(r.hours)} ساعة` : ''))}</span>
        <button class="btn ghost sm" data-edittx="${r.id}" data-kind="${kind}" data-mode="${r.mode}" style="margin-inline-start:8px;">تعديل</button>
        <button class="btn ghost sm" data-del="${r.id}" data-kind="${kind}" style="margin-inline-start:4px;">حذف</button>
      </span>
    </div>`;
}

function bindDayToggles(kind, host, y, m) {
  $$('[data-toggle]', host).forEach(el => el.addEventListener('click', () => {
    const date = el.dataset.toggle, key = date + '_' + kind;
    const body = el.parentElement.querySelector('.day-body');
    const willOpen = !body.classList.contains('open');
    body.classList.toggle('open', willOpen);
    if (willOpen) {
      openDays.add(key);
      if (date === todayISO() && !DATA.meta.seenDates.includes(date)) { DATA.meta.seenDates.push(date); el.parentElement.classList.remove('is-new'); persist(); }
    } else openDays.delete(key);
  }));
  $$('[data-flagtx]', host).forEach(el => el.addEventListener('click', (e) => {
    e.stopPropagation();
    const t = DATA.transactions.find(x => x.id === el.dataset.flagtx);
    if (t) { t.flagged = !t.flagged; persist(true); renderTransactionsInto(host, kind, y, m); }
  }));
  $$('[data-del]', host).forEach(el => el.addEventListener('click', (e) => {
    e.stopPropagation();
    const t = DATA.transactions.find(x => x.id === el.dataset.del); if (!t) return;
    const linkedOps = DATA.assetOps.filter(o => !o.deleted && o.srcId === t.id);
    const linkedAmt = linkedOps.reduce((s, o) => s + Math.abs(o.amount), 0);
    const remDebt = DATA.debts.filter(d => !d.deleted && d.fromTxId === t.id);
    const cancellable = remDebt.filter(d => computeDebtPaid(d) === 0);
    const kept = remDebt.filter(d => computeDebtPaid(d) > 0);
    const doDelete = () => {
      cascadeDeleteTx(t); // يحذف عمليات الأصول المرتبطة والدَّين المتبقي غير المسدَّد منه شيء
      if (kept.length) toast('بقي دين "' + kept.map(d => d.name).join('، ') + '" لأنه سُدِّد منه جزء — احذفه من قسم الديون إن أردت');
      persist(true); renderTransactionsInto(host, kind, y, m); refreshMonthSummary();
    };
    const parts = [];
    if (linkedAmt > 0.004) parts.push(`سيُخصَم ${bidi(fmt(linkedAmt))} ${t.currency} من الأصل الذي أُضيف إليه هذا المبلغ، حتى لا يبقى مالًا بلا مصدر موثّق.`);
    if (cancellable.length) parts.push(`سيُلغى الدَّين المتبقي غير المحصَّل (${cancellable.map(d => escHtml(d.name)).join('، ')}) بقيمة ${bidi(fmt(cancellable.reduce((s, d) => s + d.amount, 0)))} ${t.currency}.`);
    if (!parts.length) return doDelete();
    confirmDialog({ title: 'حذف هذه الحركة؟', dangerous: true, confirmLabel: 'حذف مع تصحيح الحسابات', message: parts.join('<br>'), onConfirm: doDelete });
  }));
  $$('[data-edittx]', host).forEach(el => el.addEventListener('click', (e) => {
    e.stopPropagation();
    if (el.dataset.mode === 'client') { toast('لتعديل مبلغ/سعر عميل، عدّله من صفحة "العملاء"'); showView('clients'); return; }
    editingRowId = el.dataset.edittx; renderTransactionsInto(host, kind, y, m);
  }));
  $$('[data-savetx]', host).forEach(el => el.addEventListener('click', (e) => {
    e.stopPropagation();
    const t = DATA.transactions.find(x => x.id === el.dataset.savetx);
    const row = el.closest('.currency-row');
    const amount = parseFloat(row.querySelector('[data-ef="amount"]').value);
    if (isNaN(amount)) return toast('أدخل رقمًا صحيحًا (يمكن أن يكون 0)');
    const before = { amount: t.amount, currency: t.currency };
    t.date = row.querySelector('[data-ef="date"]').value || t.date;
    t.amount = amount; t.note = row.querySelector('[data-ef="note"]').value; t.updatedAt = Date.now();
    const curEl = row.querySelector('[data-ef="currency"]'); if (curEl) t.currency = curEl.value;
    const catEl = row.querySelector('[data-ef="categoryId"]'); if (catEl) t.categoryId = catEl.value;
    const hoursEl = row.querySelector('[data-ef="hours"]'); if (hoursEl) t.hours = parseFloat(hoursEl.value) || 0;
    editingRowId = null; persist(true); renderTransactionsInto(host, kind, y, m); refreshMonthSummary();
    resyncTxAssetOps(t, before);
  }));
  $$('[data-canceltx]', host).forEach(el => el.addEventListener('click', (e) => { e.stopPropagation(); editingRowId = null; renderTransactionsInto(host, kind, y, m); }));
}

function incomeAddFormHtml(y, m) {
  const currencies = DATA.settings.currencies;
  const clients = DATA.clients.filter(c => !c.deleted);
  const defaultDate = navMonth ? `${y}-${pad2(m)}-${pad2(Math.min(new Date().getDate(), new Date(y, m, 0).getDate()))}` : todayISO();
  return `
    <div class="segmented" id="incomeModeSwitch">
      <button data-mode="general" class="active">${label('source_general')}</button>
      <button data-mode="client">${label('source_client')}</button>
    </div>
    <div id="incomeGeneralFields" class="form-grid" style="margin-top:12px;">
      <label class="field">التاريخ<input type="date" id="inc_date" value="${defaultDate}"></label>
      <label class="field">العملة<select id="inc_currency">${currencies.map(c => `<option value="${c}">${c}</option>`).join('')}</select></label>
      <label class="field">المصدر<select id="inc_source"></select></label>
      <label class="field">المبلغ<input type="number" id="inc_amount" placeholder="0"></label>
      <label class="field" style="grid-column: span 2;">ملاحظات<textarea class="autogrow" rows="1" id="inc_note" placeholder="اختياري"></textarea></label>
    </div>
    <div id="incomeClientFields" class="form-grid" style="margin-top:12px; display:none;">
      <label class="field">التاريخ<input type="date" id="incc_date" value="${defaultDate}"></label>
      <label class="field">العميل<select id="incc_client"><option value="">— اختر عميل —</option>${clients.map(c => `<option value="${c.id}">${c.name} (${c.currency})</option>`).join('')}</select></label>
      <label class="field">عنوان المشروع<input type="text" id="incc_title" placeholder="مثال: مشروع 2"></label>
      <label class="field">المبلغ المتفق عليه<input type="number" id="incc_agreed" placeholder="0"></label>
      <label class="field">المدفوع حاليًا<input type="number" id="incc_paid" placeholder="0"></label>
      <label class="field">ساعات العمل<input type="number" id="incc_hours" placeholder="0"></label>
      <label class="field" style="grid-column: span 2;">ملاحظات<textarea class="autogrow" rows="1" id="incc_note" placeholder="اختياري"></textarea></label>
      <p class="muted" style="grid-column: 1/-1; font-size:12px;">لا يوجد عملاء؟ أضفهم أولاً من "مركز التحكم".</p>
    </div>
    <div class="form-actions"><button class="btn" id="saveIncomeBtn">حفظ</button></div>`;
}
function bindIncomeForm(host, y, m) {
  const modeSwitch = $('#incomeModeSwitch', host); if (!modeSwitch) return;
  modeSwitch.addEventListener('click', (e) => {
    const btn = e.target.closest('button[data-mode]'); if (!btn) return;
    $$('#incomeModeSwitch button', host).forEach(b => b.classList.toggle('active', b === btn));
    $('#incomeGeneralFields', host).style.display = btn.dataset.mode === 'general' ? 'grid' : 'none';
    $('#incomeClientFields', host).style.display = btn.dataset.mode === 'client' ? 'grid' : 'none';
  });
  refreshIncomeSourceDropdown(host);
  $('#saveIncomeBtn', host).addEventListener('click', () => {
    const mode = $('#incomeModeSwitch button.active', host).dataset.mode;
    let newTxForAlloc = null;
    if (mode === 'general') {
      const amount = parseFloat($('#inc_amount', host).value);
      if (isNaN(amount)) return toast('أدخل رقمًا صحيحًا (يمكن أن يكون 0)');
      newTxForAlloc = { id: uid(), kind: 'income', mode: 'general', categoryId: $('#inc_source', host).value,
        currency: $('#inc_currency', host).value, amount, date: $('#inc_date', host).value || todayISO(),
        note: $('#inc_note', host).value, hours: 0, flagged: false, createdAt: Date.now(), updatedAt: Date.now(), deleted: false };
      DATA.transactions.push(newTxForAlloc);
    } else {
      const clientId = $('#incc_client', host).value;
      if (!clientId) return toast('اختر عميلًا أولاً');
      const client = DATA.clients.find(c => c.id === clientId);
      const agreedRaw = $('#incc_agreed', host).value.trim();
      const paid = parseFloat($('#incc_paid', host).value) || 0, hours = parseFloat($('#incc_hours', host).value) || 0;
      let agreed = agreedRaw === '' ? NaN : parseFloat(agreedRaw);
      if (isNaN(agreed) || agreed <= 0) agreed = paid; // إذا لم يُحدَّد "المتفق عليه" يُعتبر تلقائيًا نفس المبلغ المدفوع
      const project = { id: uid(), clientId, title: $('#incc_title', host).value || 'مشروع', agreedAmount: agreed, paidAmount: paid, hours,
        notes: $('#incc_note', host).value, flagged: false, createdAt: Date.now(), updatedAt: Date.now(), deleted: false };
      DATA.projects.push(project);
      if (paid > 0) {
        newTxForAlloc = { id: uid(), kind: 'income', mode: 'client', projectId: project.id, currency: client.currency,
          amount: paid, date: $('#incc_date', host).value || todayISO(), note: $('#incc_note', host).value, hours, flagged: false,
          createdAt: Date.now(), updatedAt: Date.now(), deleted: false };
        DATA.transactions.push(newTxForAlloc);
      }
    }
    persist(true); evaluateAlerts(); renderTransactionsInto(host, 'income', y, m); refreshMonthSummary();
    if (newTxForAlloc) offerAssetAllocationForTx(newTxForAlloc, newTxForAlloc.mode === 'client' ? { createdProjectId: newTxForAlloc.projectId } : {});
  });
}
function refreshIncomeSourceDropdown(host) {
  const sel = $('#inc_source', host); if (!sel) return;
  const sources = DATA.categories.filter(c => c.type === 'income' && !c.deleted);
  sel.innerHTML = sources.map(s => `<option value="${s.id}">${s.name}</option>`).join('') || '<option value="">لا يوجد مصادر</option>';
}

function expenseAddFormHtml(y, m) {
  const currencies = DATA.settings.currencies;
  const cats = DATA.categories.filter(c => c.type === 'expense' && !c.deleted);
  const defaultDate = navMonth ? `${y}-${pad2(m)}-${pad2(Math.min(new Date().getDate(), new Date(y, m, 0).getDate()))}` : todayISO();
  return `
    <div class="form-grid">
      <label class="field">التاريخ<input type="date" id="exp_date" value="${defaultDate}"></label>
      <label class="field">العملة<select id="exp_currency">${currencies.map(c => `<option value="${c}">${c}</option>`).join('')}</select></label>
      <label class="field">الفئة<select id="exp_category">${cats.map(c => `<option value="${c.id}">${c.name}</option>`).join('')}</select></label>
      <label class="field">المبلغ<input type="number" id="exp_amount" placeholder="0"></label>
      <label class="field" style="grid-column: span 2;">ملاحظات<textarea class="autogrow" rows="1" id="exp_note" placeholder="اختياري"></textarea></label>
    </div>
    <div class="form-actions"><button class="btn" id="saveExpenseBtn">حفظ</button></div>`;
}
function bindExpenseForm(host, y, m) {
  const btn = $('#saveExpenseBtn', host); if (!btn) return;
  btn.addEventListener('click', () => {
    const amount = parseFloat($('#exp_amount', host).value);
    if (isNaN(amount)) return toast('أدخل رقمًا صحيحًا (يمكن أن يكون 0)');
    const expTx = { id: uid(), kind: 'expense', mode: 'general', categoryId: $('#exp_category', host).value,
      currency: $('#exp_currency', host).value, amount, date: $('#exp_date', host).value || todayISO(),
      note: $('#exp_note', host).value, flagged: false, createdAt: Date.now(), updatedAt: Date.now(), deleted: false };
    DATA.transactions.push(expTx);
    persist(true); evaluateAlerts(); renderTransactionsInto(host, 'expense', y, m); refreshMonthSummary();
    offerAssetAllocationForTx(expTx);
  });
}

function statsBlockHtml(kind, list) {
  const currencies = currenciesWithActivity(list);
  const mode = statsMode[kind];
  let body = '';
  if (currencies.length === 0) body = '<p class="muted">لا بيانات كافية بعد</p>';
  else if (mode === 'together') {
    body = currencies.map(cur => {
      const rows = list.filter(t => t.currency === cur);
      const total = rows.reduce((s, r) => s + r.amount, 0);
      const totalHours = rows.reduce((s, r) => s + (r.hours || 0), 0);
      const breakdown = breakdownBySource(rows);
      return `<div class="currency-block"><div class="cb-head"><span>${cur}</span><span class="total-emph ${kind === 'expense' ? 'neg' : 'pos'}">${bidi((kind === 'expense' ? '-' : '+') + fmt(total) + ' ' + cur + (kind === 'income' && totalHours ? ` · ${fmt(totalHours)} س` : ''))}</span></div>
        ${breakdown.map(b => `<div class="currency-row"><span>${b.name} <span class="muted" style="font-size:10.5px;">· ${b.lastDate}</span></span><span>${bidi((kind === 'expense' ? '-' : '') + fmt(b.amount) + ' ' + cur + (b.hours ? ` · ${fmt(b.hours)} س` : ''))} <button class="btn ghost sm" data-jumptx="${b.lastId}" data-jumpdate="${b.lastDate}" title="اذهب لهذه المعاملة" style="margin-inline-start:6px; padding:2px 8px;">↗</button></span></div>`).join('')}</div>`;
    }).join('');
  } else {
    const cur = statsCurrency[kind] && currencies.includes(statsCurrency[kind]) ? statsCurrency[kind] : currencies[0];
    const rows = list.filter(t => t.currency === cur);
    const total = rows.reduce((s, r) => s + r.amount, 0);
    const totalHours = rows.reduce((s, r) => s + (r.hours || 0), 0);
    const breakdown = breakdownBySource(rows);
    body = `<div style="margin-bottom:10px;"><select id="statsCurrencySelect-${kind}">${currencies.map(c => `<option value="${c}" ${c === cur ? 'selected' : ''}>${c}</option>`).join('')}</select></div>
      <div class="currency-block"><div class="cb-head"><span>${cur}</span><span class="total-emph ${kind === 'expense' ? 'neg' : 'pos'}">${bidi((kind === 'expense' ? '-' : '+') + fmt(total) + ' ' + cur + (kind === 'income' && totalHours ? ` · ${fmt(totalHours)} س` : ''))}</span></div>
      ${breakdown.map(b => `<div class="currency-row"><span>${b.name} <span class="muted" style="font-size:10.5px;">· ${b.lastDate}</span></span><span>${bidi((kind === 'expense' ? '-' : '') + fmt(b.amount) + ' ' + cur + (b.hours ? ` · ${fmt(b.hours)} س` : ''))} <button class="btn ghost sm" data-jumptx="${b.lastId}" data-jumpdate="${b.lastDate}" title="اذهب لهذه المعاملة" style="margin-inline-start:6px; padding:2px 8px;">↗</button></span></div>`).join('') || '<p class="muted" style="font-size:12px;">لا بيانات</p>'}</div>`;
  }
  return `<div class="card" style="margin-top:18px;">
    <div style="display:flex; justify-content:space-between; align-items:center;"><strong>الإحصائيات</strong>
      <div class="segmented" id="statsModeSwitch-${kind}"><button data-smode="together" class="${mode === 'together' ? 'active' : ''}">معًا</button><button data-smode="separate" class="${mode === 'separate' ? 'active' : ''}">منفرد</button></div>
    </div><div style="margin-top:12px;">${body}</div></div>`;
}
function breakdownBySource(rows) {
  const map = new Map();
  rows.forEach(r => {
    const name = sourceName(r);
    if (!map.has(name)) map.set(name, { name, amount: 0, hours: 0, lastDate: r.date, lastId: r.id });
    const e = map.get(name);
    e.amount += r.amount; e.hours += (r.hours || 0);
    if (r.date >= e.lastDate) { e.lastDate = r.date; e.lastId = r.id; } // نحتفظ بأحدث معاملة كممثل للفئة للانتقال إليها
  });
  return Array.from(map.values());
}
function bindStatsSwitch(kind, host, y, m) {
  const sw = $(`#statsModeSwitch-${kind}`, host);
  if (sw) sw.addEventListener('click', (e) => { const btn = e.target.closest('button[data-smode]'); if (!btn) return; statsMode[kind] = btn.dataset.smode; renderTransactionsInto(host, kind, y, m); });
  const curSel = $(`#statsCurrencySelect-${kind}`, host);
  if (curSel) curSel.addEventListener('change', () => { statsCurrency[kind] = curSel.value; renderTransactionsInto(host, kind, y, m); });
}

/* ============================================================
   العملاء (صفحة مستقلة شاملة لكل الوقت)
   ============================================================ */
function renderClients() {
  const view = $('#view-clients');
  const mode = DATA.settings.clientsPageMode;
  view.innerHTML = `
    <div style="display:flex; justify-content:space-between; align-items:center; flex-wrap:wrap; gap:10px;">
      <div><h2 class="view-title">${mode === 'debts' ? 'الديون' : 'العملاء'}</h2><p class="view-sub">${mode === 'debts' ? 'دين علي ودين لي — عبر كل الوقت' : 'حالة كل عميل ومشاريعه — عبر كل الوقت'}</p></div>
      <div style="display:flex; gap:8px; align-items:center;">
        <button class="btn ghost sm" id="exportClientsOrDebtsBtn">📄 تصدير PDF</button>
        <div class="segmented" id="clientsModeSwitch"><button data-mode="clients" class="${mode === 'clients' ? 'active' : ''}">👥 عملاء</button><button data-mode="debts" class="${mode === 'debts' ? 'active' : ''}">💳 ديون</button></div>
      </div>
    </div>
    <div id="clientsModeHost" style="margin-top:14px;"></div>`;
  $('#exportClientsOrDebtsBtn').addEventListener('click', async () => {
    const { html, filename } = mode === 'debts' ? buildDebtsReportHtml() : buildClientsReportHtml();
    toast('جارٍ إنشاء ملف PDF...');
    const res = await Platform.exportPDF(html, filename);
    if (res.ok) toast('تم حفظ التقرير: ' + res.filePath); else if (res.error) toast('تعذّر حفظ التقرير');
  });
  $('#clientsModeSwitch').addEventListener('click', (e) => {
    const b = e.target.closest('button[data-mode]'); if (!b) return;
    DATA.settings.clientsPageMode = b.dataset.mode; persist(true); renderClients();
  });
  const host = $('#clientsModeHost');
  if (mode === 'debts') renderDebtsInto(host); else renderClientsListInto(host);
}
function renderClientsListInto(host) {
  const clients = DATA.clients.filter(c => !c.deleted);
  host.innerHTML = `${clients.length === 0 ? '<p class="muted">لا يوجد عملاء بعد — أضف عميلًا من مركز التحكم.</p>' : ''}
    <div class="grid grid-3">${clients.map(clientCardHtml).join('')}</div>`;
  bindClientsEvents(host, () => renderClientsListInto(host));
  bindPanelToggles(host);
}
function renderClientsInMonthInto(host, y, m) {
  const clients = DATA.clients.filter(c => !c.deleted).filter(c => {
    const projects = DATA.projects.filter(p => p.clientId === c.id && !p.deleted);
    return projects.some(p => DATA.transactions.some(t => t.projectId === p.id && !t.deleted && inMonth(t.date, y, m)));
  });
  host.innerHTML = `<p class="view-sub" style="margin:0 0 12px;">عملاء لديهم نشاط في ${MONTH_NAMES[m - 1]} ${y}</p>
    ${clients.length === 0 ? '<p class="muted">لا يوجد نشاط عملاء لهذا الشهر.</p>' : `<div class="grid grid-3">${clients.map(clientCardHtml).join('')}</div>`}`;
  bindClientsEvents(host, () => renderClientsInMonthInto(host, y, m));
}

/* ---------------- الديون ---------------- */
let editingDebtId = null;
let payingDebtId = null;

/* ---------------- ربط الديون بالجرود والحسابات ---------------- */
// عند تسجيل دين "أنا سلفت/أخرجت من صندوقي" → يخرج المبلغ فورًا كمصروف (لأنه فعليًا خرج من صندوقك الآن).
// عند تسجيل دين "شخص سلفني/سلفت من شخص" → يدخل المبلغ فورًا كدخل (لأنه فعليًا دخل صندوقك الآن).
// عند أي تسديد (كامل أو جزئي) يُسجَّل تلقائيًا حركة عكسية بنفس المبلغ المسدَّد.
function addDebtLinkedTx(debt, kind, amount, date, note, isOrigin, extra) {
  if (!amount || amount <= 0) return;
  const tx = Object.assign({ id: uid(), kind, mode: 'debt', debtId: debt.id, debtName: debt.name, debtOrigin: !!isOrigin, currency: debt.currency,
    amount, date: date || todayISO(), note: note || '', flagged: false, createdAt: Date.now(), updatedAt: Date.now(), deleted: false }, extra || {});
  DATA.transactions.push(tx);
  offerAssetAllocationForTx(tx); // سلفة جديدة (خرج من أصل) أو اقتراض جديد (دخل لأصل) — لا تُعرض لو noAsset
  return tx;
}
// يحذف كل حركات هذا الدين (الأصلية وكل تسديداته)، ويحذف معها أي عملية أصل (assetOp) وُلدت منها —
// حتى لا يبقى مال داخل أصل بلا مصدر موثّق بعد حذف الدين (هذا كان سبب تضخّم/نقصان الحسابات سابقًا)
function removeDebtLinkedTxs(debtId) {
  const now = Date.now();
  DATA.transactions.forEach(t => {
    if (t.mode === 'debt' && t.debtId === debtId && !t.deleted) {
      t.deleted = true; t.updatedAt = now;
      DATA.assetOps.forEach(o => { if (!o.deleted && o.srcId === t.id) { o.deleted = true; o.updatedAt = now; } });
    }
  });
}
// عند حذف دَين "باقٍ" (وُلد كجزء لم يُوزَّع من حركة أخرى عبر نافذة "أين يذهب المبلغ"): نصحّح تلك الحركة الأصلية
// بدل حذف أثره بصمت — مثال: دخل 2000 وُزِّع منه 500 لأصل و1500 دينًا لشخص؛ حذف الدين يُرجع الحركة الأصلية
// إلى 500 (بدل أن تبقى 2000 متضخّمة بلا أي توثيق لوجهة الـ1500). لو كانت 1500 هي كل مبلغ الحركة، تُحذف الحركة كاملة.
function shrinkOriginForDeletedDebt(d) {
  if (!d.fromTxId) return;
  const origin = DATA.transactions.find(t => !t.deleted && t.id === d.fromTxId);
  if (!origin) return;
  const newAmt = round2(origin.amount - d.amount);
  if (newAmt <= 0.004) { cascadeDeleteTx(origin); return; }
  origin.amount = newAmt; origin.updatedAt = Date.now();
  if (origin.mode === 'client') { const p = DATA.projects.find(x => x.id === origin.projectId); if (p) { syncProjectPaidCache(p); p.updatedAt = Date.now(); } }
}
// نقطة واحدة لحذف أي حركة (دخل/مصروف/عميل) بأثر رجعي كامل وموثّق، أيًا كان مكان الحذف في التطبيق:
// 1) تُحذف كل عمليات الأصول (assetOps) التي وُلدت منها — حتى لا يبقى مال في أصل بلا مصدر موثّق.
// 2) أي دَين "باقٍ" وُلد منها كجزء غير موزَّع يُحذف معها — إلا لو سُدِّد منه جزء فيبقى حفاظًا على السجل.
function cascadeDeleteTx(t) {
  if (!t || t.deleted) return;
  const now = Date.now();
  t.deleted = true; t.updatedAt = now;
  DATA.assetOps.forEach(o => { if (!o.deleted && o.srcId === t.id) { o.deleted = true; o.updatedAt = now; } });
  DATA.debts.filter(d => !d.deleted && d.fromTxId === t.id).forEach(d => {
    if (computeDebtPaid(d) > 0) return; // بقي دين سُدِّد منه جزء: يبقى حفاظًا على السجل
    d.deleted = true; d.updatedAt = now; removeDebtLinkedTxs(d.id);
  });
  if (t.mode === 'client') { const p = DATA.projects.find(x => x.id === t.projectId); if (p) { syncProjectPaidCache(p); p.updatedAt = now; } }
}
// ============================================================
// سجل تسديد الدين: كل عملية تسديد (كاملة أو جزئية) = معاملة مستقلة بتاريخها ومبلغها الخاص —
// وليست معاملة واحدة تُستبدَل قيمتها في كل مرة (هذا كان سبب المشكلة السابقة: تسديد جديد يمحو تاريخ/مبلغ التسديد القديم).
// "المسدَّد" الآن هو دائمًا مجموع محسوب من كل معاملات التسديد الحقيقية — وليس رقمًا يُكتب يدويًا فيغيب تزامنه.
// ============================================================
function debtPaymentsOf(d) {
  return DATA.transactions.filter(t => !t.deleted && t.mode === 'debt' && t.debtId === d.id && t.debtPayment)
    .sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : b.createdAt - a.createdAt)); // الأحدث تاريخًا أولًا
}
function computeDebtPaid(d) { return debtPaymentsOf(d).reduce((s, t) => s + t.amount, 0); }
// يزامن الحقل المخزَّن d.paidAmount مع المجموع الحقيقي (للتوافق مع أي كود/تصدير قديم يقرأه مباشرة) — لا يُعتمَد عليه كمصدر وحيد للحقيقة
function syncDebtPaidCache(d) { d.paidAmount = computeDebtPaid(d); }
// يضيف عملية تسديد جديدة (منفصلة، بتاريخها ومبلغها) — تُستدعى من زر "تسديد كامل/جزئي"
function addDebtPaymentTx(d, amount, date, note) {
  if (!amount || amount <= 0) return;
  const kind = d.type === 'they_owe_me' ? 'income' : 'expense';
  const tx = { id: uid(), kind, mode: 'debt', debtId: d.id, debtName: d.name, debtPayment: true, currency: d.currency,
    amount, date: date || todayISO(), note: note || ('تسديد دين: ' + d.name), flagged: false, createdAt: Date.now(), updatedAt: Date.now(), deleted: false };
  DATA.transactions.push(tx);
  syncDebtPaidCache(d);
  offerAssetAllocationForTx(tx); // تحصيل (دخل لأصل) أو تسديد (خرج من أصل)
  return tx;
}
// ينقلك مباشرة إلى شهر أي معاملة (يُستخدم بجانب كل عملية تسديد لمعرفة أين وقعت بالضبط في جردك الشهري)
function goToTransactionMonth(t) {
  const [y, m] = t.date.split('-').map(Number);
  navYear = y; navMonth = m; monthTab = t.kind === 'income' ? 'income' : 'expense';
  showView('yearly');
}
// الفرق بين ما سيدخل صندوقك (ديون لك لم تُحصَّل بعد) وما سيخرج منه (ديون عليك لم تُسدَّد بعد) - لكل عملة
function debtAdjustment(currency) {
  const debts = DATA.debts.filter(d => !d.deleted && d.currency === currency);
  const remainingTheyOweMe = debts.filter(d => d.type === 'they_owe_me').reduce((s, d) => s + Math.max(0, d.amount - computeDebtPaid(d)), 0);
  const remainingIOwe = debts.filter(d => d.type === 'i_owe').reduce((s, d) => s + Math.max(0, d.amount - computeDebtPaid(d)), 0);
  return remainingTheyOweMe - remainingIOwe;
}
function netAfterDebtsRow(currentNet, currency) {
  const adj = debtAdjustment(currency);
  if (!adj) return '';
  const after = currentNet + adj;
  return `<div class="muted" style="font-size:11px; margin-top:6px; padding-top:6px; border-top:1px dashed rgba(255,255,255,.1);">
    الإجمالي الحالي: <b>${bidi(fmt(currentNet))}</b> · بعد تسوية كل الديون الحالية: <b style="color:${after >= currentNet ? 'var(--green)' : 'var(--red)'}">${bidi(fmt(after))}</b></div>`;
}
// 💎 الصافي الحالي: المجموع الفعلي لأصولك الآن (قسم "أموالي" فقط) — بلا ديون عند الآخرين ولا سلف/عملاء لم يسدّدوا بعد.
// الهدف: تقدر تقارنه بعين واحدة مع الأرقام المبنية على الدخل/المصاريف هنا، وتتأكد هل هي مطابقة لواقع أموالك الفعلي
function currentNetRow(currency) {
  const manualAssets = computeNetWorth(currency).manualAssets;
  if (!manualAssets) return '';
  return `<div style="margin-top:8px; padding-top:8px; border-top:1px dashed rgba(255,255,255,.1);">
    <div class="muted" style="font-size:11px;">💎 الصافي الحالي (من "أموالي" فعليًا الآن)</div>
    <div style="font-size:19px; font-weight:800; color:var(--text); margin-top:2px;">${bidi(fmt(manualAssets))}</div></div>`;
}
function debtNameKey(name) { return String(name || '').trim().toLowerCase(); }
function renderDebtsInto(host) {
  const debts = DATA.debts.filter(d => !d.deleted);
  const currencies = DATA.settings.currencies;

  // ملخص صافي الديون لكل عملة على حدة (بدون خلط عملات)
  const summaryCards = currenciesWithActivity(debts.map(d => ({ currency: d.currency, amount: d.amount }))).map(cur => {
    const theyOweMeRemaining = debts.filter(d => d.currency === cur && d.type === 'they_owe_me').reduce((s, d) => s + (d.amount - computeDebtPaid(d)), 0);
    const iOweRemaining = debts.filter(d => d.currency === cur && d.type === 'i_owe').reduce((s, d) => s + (d.amount - computeDebtPaid(d)), 0);
    const net = theyOweMeRemaining - iOweRemaining;
    return `<div class="stat-card ${net >= 0 ? 'positive' : 'negative'}"><div class="label">${cur}</div>
      <div class="value">${bidi((net >= 0 ? '+' : '') + fmt(net))}</div>
      <div class="muted" style="font-size:11px; margin-top:4px;">لي ${bidi(fmt(theyOweMeRemaining))} · عليّ ${bidi(fmt(iOweRemaining))}</div></div>`;
  }).join('');

  // تجميع الديون حسب الاسم
  const groups = {};
  // ⚠️ التجميع بالاسم المُطبَّع (بلا مسافات زائدة/فرق حالة أحرف): Br و br و "Br " نافذة واحدة، لا نوافذ منفصلة
  debts.forEach(d => { const k = debtNameKey(d.name); (groups[k] = groups[k] || { name: String(d.name || '').trim(), list: [] }).list.push(d); });

  host.innerHTML = `
    ${summaryCards ? `<div class="card glass-panel"><strong id="debtsSummaryTitle">${label('debts_summary_title')}</strong> <button class="btn ghost sm" id="editSummaryTitleBtn" style="margin-inline-start:6px;">✎</button>
      <div class="grid grid-3" style="margin-top:10px;">${summaryCards}</div></div>` : ''}

    <details class="collapse-card card inline-form" data-panel="add_debt"${panelOpenAttr('add_debt')} style="margin-top:14px;"><summary>+ إضافة دين</summary>
      <div class="form-grid" style="margin-top:10px;">
        <label class="field">الاسم<input type="text" id="debt_name" placeholder="مثال: أحمد"></label>
        <label class="field">النوع<select id="debt_type">
          <option value="i_owe">${label('debt_type_i_owe')}</option>
          <option value="they_owe_me">${label('debt_type_they_owe_me')}</option>
        </select></label>
        <label class="field">العملة<select id="debt_currency">${currencies.map(c => `<option>${c}</option>`).join('')}</select></label>
        <label class="field">المبلغ<input type="number" id="debt_amount" placeholder="0"></label>
        <label class="field">التاريخ<input type="date" id="debt_date" value="${todayISO()}"></label>
      </div>
      <div style="margin-top:10px;">
        <label class="field">التذكير<select id="debt_reminder_mode">
          <option value="none">بدون تذكير</option>
          <option value="datetime">تاريخ ووقت محدد</option>
          <option value="relative">بعد مدة من الآن</option>
        </select></label>
        <div id="debt_reminder_fields" style="margin-top:8px; display:none;"></div>
      </div>
      <div class="form-grid" style="margin-top:10px;"><label class="field" style="grid-column:1/-1;">ملاحظات<textarea class="autogrow" rows="1" id="debt_note"></textarea></label></div>
      <div class="form-actions"><button class="btn" id="addDebtBtn">إضافة</button></div>
    </details>
    <div class="grid grid-3" style="margin-top:16px; align-items:start;">${Object.keys(groups).length ? Object.values(groups).map(g => debtGroupCardHtml(g.name, g.list)).join('') : '<p class="muted">لا توجد ديون مسجّلة</p>'}</div>`;

  $('#editSummaryTitleBtn')?.addEventListener('click', () => {
    const box = document.createElement('div');
    box.className = 'form-actions';
    box.style.marginTop = '8px';
    box.innerHTML = `<input type="text" id="summaryTitleInput" value="${label('debts_summary_title')}" style="flex:1;"><button class="btn sm" id="saveSummaryTitle">حفظ</button>`;
    $('#debtsSummaryTitle').parentElement.appendChild(box);
    $('#saveSummaryTitle').addEventListener('click', () => {
      DATA.labels.debts_summary_title = $('#summaryTitleInput').value || DATA.labels.debts_summary_title;
      persist(true); renderDebtsInto(host);
    });
  });

  const reminderModeSel = $('#debt_reminder_mode');
  const renderReminderFields = () => {
    const box = $('#debt_reminder_fields');
    if (reminderModeSel.value === 'datetime') box.innerHTML = `<input type="datetime-local" id="debt_reminder_dt">`;
    else if (reminderModeSel.value === 'relative') box.innerHTML = `
      <div class="form-grid" style="grid-template-columns:1fr 1fr;">
        <input type="number" id="debt_reminder_amount" placeholder="مثال: 7" min="1">
        <select id="debt_reminder_unit"><option value="days">يوم/أيام</option><option value="weeks">أسبوع/أسابيع</option><option value="months">شهر/أشهر</option></select>
      </div>`;
    else box.innerHTML = '';
    box.style.display = reminderModeSel.value === 'none' ? 'none' : 'block';
  };
  reminderModeSel.addEventListener('change', renderReminderFields); renderReminderFields();

  $('#addDebtBtn').addEventListener('click', () => {
    let name = $('#debt_name').value.trim(); if (!name) return toast('أدخل الاسم');
    { const prev = DATA.debts.find(d => !d.deleted && debtNameKey(d.name) === debtNameKey(name)); if (prev) name = String(prev.name).trim(); } // نفس الشخص = نفس الكتابة، فيدخل تلقائيًا في نافذته الموجودة
    const amount = parseFloat($('#debt_amount').value); if (isNaN(amount) || amount <= 0) return toast('أدخل مبلغًا صحيحًا');
    let reminderAt = null;
    if (reminderModeSel.value === 'datetime') reminderAt = parseReminderInput($('#debt_reminder_dt').value);
    else if (reminderModeSel.value === 'relative') {
      const n = parseFloat($('#debt_reminder_amount').value);
      if (!isNaN(n) && n > 0) {
        const unit = $('#debt_reminder_unit').value;
        const ms = unit === 'days' ? n * 86400000 : unit === 'weeks' ? n * 7 * 86400000 : n * 30 * 86400000;
        reminderAt = Date.now() + ms;
      }
    }
    const newDebt = { id: uid(), name, type: $('#debt_type').value, currency: $('#debt_currency').value, amount, paidAmount: 0,
      date: $('#debt_date').value || todayISO(), note: $('#debt_note').value, reminderAt, notifiedAt: null, flagged: false,
      createdAt: Date.now(), updatedAt: Date.now(), deleted: false };
    DATA.debts.push(newDebt);
    addDebtLinkedTx(newDebt, newDebt.type === 'they_owe_me' ? 'expense' : 'income', amount, newDebt.date,
      (newDebt.type === 'they_owe_me' ? 'سلفة لـ' : 'سلفة من') + ' ' + name, true);
    persist(true); evaluateAlerts(); renderDebtsInto(host); refreshMonthSummary();
  });
  bindDebtsEvents(host);
  bindPanelToggles(host);
}

function debtPanelKey(name) { return 'debtgrp_' + String(name || '').trim().replace(/[^a-zA-Z0-9_\u0600-\u06FF]/g, ''); }
function debtGroupCardHtml(name, list) {
  // إجمالي عام للشخص عبر كل ديونه (بغض النظر عن الاتجاه) لعرض شريط تقدم كلي
  const totalAmount = list.reduce((s, d) => s + d.amount, 0);
  const totalPaid = list.reduce((s, d) => s + computeDebtPaid(d), 0);
  const overallPct = totalAmount > 0 ? Math.min(100, (totalPaid / totalAmount) * 100) : 0;
  const anyPositive = list.some(d => d.type === 'they_owe_me');
  // غير المسدَّدة تمامًا أولًا (الأقل تسديدًا بالنسبة)، ونزولًا حتى المسدَّدة كليًا في الآخر
  const sortedList = [...list].sort((a, b) => (computeDebtPaid(a) / (a.amount || 1)) - (computeDebtPaid(b) / (b.amount || 1)));
  const panelKey = debtPanelKey(name);
  return `<details data-focus="${panelKey}" class="collapse-card card debt-card ${list.length > 1 ? '' : (anyPositive ? 'debt-positive' : 'debt-negative')}" data-panel="${panelKey}"${panelOpenAttr(panelKey)}>
    <summary><div style="flex:1; min-width:0;">
      <div style="display:flex; justify-content:space-between; align-items:center;"><span style="font-weight:800;">${name}</span><span class="muted" style="font-size:11px;">${list.length} دين</span></div>
      ${`<div class="debt-progress-wrap" style="margin-top:8px;"><div class="debt-progress-bar ${overallPct >= 100 ? 'debt-bar-pos' : 'debt-bar-neg'}" style="width:${overallPct}%"></div><span class="debt-progress-label">${list.length > 1 ? 'إجمالي ' : ''}${Math.round(overallPct)}%</span></div>`}
    </div></summary>
    ${sortedList.map(debtCardHtml).join('')}
  </details>`;
}

function debtCardHtml(d) {
  const theyOweMe = d.type === 'they_owe_me';
  const paid = computeDebtPaid(d);
  const pct = d.amount > 0 ? Math.min(100, (paid / d.amount) * 100) : 0;
  const remaining = d.amount - paid;
  const payments = debtPaymentsOf(d);
  if (editingDebtId === d.id) {
    return `<div class="debt-entry" data-focus="debt:${d.id}"><div class="form-grid" style="grid-template-columns:1fr 1fr;">
      <label class="field">الاسم<input type="text" data-df="name" value="${d.name}"></label>
      <label class="field">المبلغ الكلي<input type="number" data-df="amount" value="${d.amount}"></label>
      <label class="field">التاريخ<input type="date" data-df="date" value="${d.date || todayISO()}"></label>
      <label class="field">وقت التذكير (اتركه فارغًا لإلغائه)<input type="datetime-local" data-df="reminder" value="${msToLocalDatetimeInput(d.reminderAt)}"></label>
      <label class="field" style="grid-column:span 2;">ملاحظات<textarea class="autogrow" rows="1" data-df="note">${escHtml(d.note || '')}</textarea></label></div>
      <p class="muted" style="font-size:11px; margin-top:6px;">💡 "المسدَّد" (${bidi(fmt(paid))} حاليًا) يُحسب تلقائيًا من مجموع عمليات التسديد أسفل — لتعديله استعمل زر "تسديد" أو عدّل/احذف عملية تسديد بعينها من القائمة تحت.</p>
      <div class="form-actions"><button class="btn sm" data-savedebt="${d.id}">حفظ</button><button class="btn ghost sm" data-canceldebt="${d.id}">إلغاء</button></div></div>`;
  }
  const payForm = payingDebtId === d.id ? `<div class="form-grid" style="grid-template-columns:1fr 1fr; margin-top:8px;">
      <input type="number" id="payAmount_${d.id}" placeholder="المبلغ المدفوع" max="${remaining}" value="${payFormPrefillFull ? remaining : ''}">
      <input type="date" id="payDate_${d.id}" value="${todayISO()}">
    </div>
    <div class="form-actions" style="margin-top:6px;">
      <button class="btn sm" data-confirmpay="${d.id}">تأكيد التسديد</button><button class="btn ghost sm" data-cancelpay="${d.id}">إلغاء</button>
    </div>` : '';
  const paymentsListHtml = payments.length ? `<div class="debt-payments-list" style="margin-top:8px;">
    ${payments.map(t => `<div class="debt-payment-row">
        <span>💵 ${bidi(fmt(t.amount))} ${t.currency} <span class="muted">· ${t.date}</span></span>
        <span><button class="btn ghost sm" data-gotodebttx="${t.id}" title="اذهب إلى مكانها في الشهر">↗</button>
          <button class="btn ghost sm" data-deldebttx="${t.id}" title="حذف هذه العملية">✕</button></span>
      </div>`).join('')}
  </div>` : '';
  return `<div class="debt-entry" data-focus="debt:${d.id}">
    <div class="prow-head"><span><button class="flag-btn ${d.flagged ? 'flagged' : ''}" data-flagdebt="${d.id}" title="تعليم كمهم">★</button>
      <span class="pill" style="background:${theyOweMe ? 'rgba(34,211,168,.15)' : 'rgba(239,90,111,.15)'}; color:${theyOweMe ? 'var(--green)' : 'var(--red)'};">${theyOweMe ? label('debt_type_they_owe_me') : label('debt_type_i_owe')}</span>
      <span class="muted" style="font-size:11px; margin-inline-start:6px;">${d.date || ''}</span></span>
      <span style="color:${theyOweMe ? 'var(--green)' : 'var(--red)'}; font-weight:700;">${bidi((theyOweMe ? '+' : '-') + fmt(remaining) + ' ' + d.currency)}</span></div>
    <div class="muted" style="font-size:11px; margin-top:2px;">مسدَّد ${bidi(fmt(paid) + '/' + fmt(d.amount))}</div>
    <div class="debt-progress-wrap" style="margin-top:8px;">
      <div class="debt-progress-bar ${theyOweMe ? 'debt-bar-pos' : 'debt-bar-neg'}" style="width:${pct}%"></div>
      <span class="debt-progress-label">${Math.round(pct)}%</span>
    </div>
    <div class="form-actions" style="margin-top:8px;">
      ${remaining > 0 ? `<button class="btn ghost sm" data-debtfull="${d.id}">تسديد كامل</button><button class="btn ghost sm" data-debtpartial="${d.id}">تسديد جزئي</button>` : ''}
      <button class="btn ghost sm" data-editdebt="${d.id}">تعديل</button>
      <button class="btn ghost sm" data-deldebt="${d.id}">حذف</button>
    </div>
    ${payForm}
    ${paymentsListHtml}
    ${d.reminderAt ? `<div class="muted" style="font-size:11px; margin-top:6px;">⏰ ${new Date(d.reminderAt).toLocaleString('ar-DZ')}</div>` : ''}
    ${d.note ? `<div class="muted" style="font-size:11px; margin-top:4px;">📝 ${d.note}</div>` : ''}
  </div>`;
}
let payFormPrefillFull = false;
function bindDebtsEvents(host) {
  $$('[data-flagdebt]', host).forEach(el => el.addEventListener('click', () => { const d = DATA.debts.find(x => x.id === el.dataset.flagdebt); if (d) { d.flagged = !d.flagged; persist(true); renderDebtsInto(host); } }));
  $$('[data-debtfull]', host).forEach(el => el.addEventListener('click', () => { payingDebtId = el.dataset.debtfull; payFormPrefillFull = true; renderDebtsInto(host); }));
  $$('[data-debtpartial]', host).forEach(el => el.addEventListener('click', () => { payingDebtId = el.dataset.debtpartial; payFormPrefillFull = false; renderDebtsInto(host); }));
  $$('[data-cancelpay]', host).forEach(el => el.addEventListener('click', () => { payingDebtId = null; renderDebtsInto(host); }));
  $$('[data-confirmpay]', host).forEach(el => el.addEventListener('click', () => {
    const d = DATA.debts.find(x => x.id === el.dataset.confirmpay); if (!d) return;
    const remaining = d.amount - computeDebtPaid(d);
    const amt = parseFloat($(`#payAmount_${d.id}`).value);
    if (isNaN(amt) || amt <= 0) return toast('أدخل مبلغًا صحيحًا');
    const date = $(`#payDate_${d.id}`).value || todayISO();
    const applied = Math.min(amt, remaining);
    addDebtPaymentTx(d, applied, date);
    payingDebtId = null; persist(true); evaluateAlerts(); renderDebtsInto(host); refreshMonthSummary();
  }));
  $$('[data-gotodebttx]', host).forEach(el => el.addEventListener('click', () => {
    const t = DATA.transactions.find(x => x.id === el.dataset.gotodebttx); if (t) goToTransactionMonth(t);
  }));
  $$('[data-deldebttx]', host).forEach(el => el.addEventListener('click', () => {
    const t = DATA.transactions.find(x => x.id === el.dataset.deldebttx); if (!t) return;
    const d = DATA.debts.find(x => x.id === t.debtId);
    const linkedOps = DATA.assetOps.filter(o => !o.deleted && o.srcId === t.id);
    const linkedAmt = linkedOps.reduce((s, o) => s + Math.abs(o.amount), 0);
    const finish = () => {
      cascadeDeleteTx(t);
      if (d) syncDebtPaidCache(d);
      persist(true); evaluateAlerts(); renderDebtsInto(host); refreshMonthSummary();
    };
    if (linkedAmt <= 0.004) return finish();
    confirmDialog({ title: 'حذف هذه العملية؟', dangerous: true, confirmLabel: 'حذف مع تصحيح الحسابات',
      message: `سيُخصَم ${bidi(fmt(linkedAmt))} ${t.currency} من الأصل الذي أُضيف إليه هذا المبلغ، حتى لا يبقى مالًا بلا مصدر موثّق.`, onConfirm: finish });
  }));
  $$('[data-editdebt]', host).forEach(el => el.addEventListener('click', () => { editingDebtId = el.dataset.editdebt; renderDebtsInto(host); }));
  $$('[data-canceldebt]', host).forEach(el => el.addEventListener('click', () => { editingDebtId = null; renderDebtsInto(host); }));
  $$('[data-deldebt]', host).forEach(el => el.addEventListener('click', () => {
    const d = DATA.debts.find(x => x.id === el.dataset.deldebt); if (!d) return;
    const doDelete = () => {
      shrinkOriginForDeletedDebt(d); // يُصحّح العملية الأصلية أولًا (إن وُجدت) قبل حذف الدين
      d.deleted = true; d.updatedAt = Date.now();
      removeDebtLinkedTxs(d.id); // يحذف حركته الأصلية وكل تسديداته، مع تنظيف أي عمليات أصول مرتبطة بها
      persist(true); evaluateAlerts(); renderDebtsInto(host); refreshMonthSummary();
    };
    const paid = computeDebtPaid(d);
    const origin = d.fromTxId ? DATA.transactions.find(t => !t.deleted && t.id === d.fromTxId) : null;
    const linkedTxs = DATA.transactions.filter(t => !t.deleted && t.mode === 'debt' && t.debtId === d.id);
    const linkedAssetAmount = linkedTxs.reduce((s, t) => s + DATA.assetOps.filter(o => !o.deleted && o.srcId === t.id).reduce((x, o) => x + Math.abs(o.amount), 0), 0);
    const parts = [];
    if (origin) parts.push(`ستُصحَّح العملية الأصلية "${escHtml(origin.note || (origin.kind === 'income' ? 'دخل' : 'مصروف'))}" من ${bidi(fmt(origin.amount))} إلى ${bidi(fmt(Math.max(0, origin.amount - d.amount)))} ${d.currency} — بدل أن تبقى متضخِّمة بمبلغ هذا الدين بلا توثيق.`);
    if (linkedAssetAmount > 0.004) parts.push(`سيُخصَم ${bidi(fmt(linkedAssetAmount))} ${d.currency} من الأصل المرتبط بهذا الدين، لأن مصدرها لن يعد موثّقًا.`);
    if (paid > 0) parts.push(`المسدَّد سابقًا من هذا الدين (${bidi(fmt(paid))} ${d.currency}) سيُحذف أثره أيضًا مع أصوله المرتبطة، حتى لا يبقى مالًا بلا سجل.`);
    if (!parts.length) return doDelete(); // لا يوجد أي أثر مالي مرتبط — حذف مباشر بلا إزعاج
    confirmDialog({ title: `حذف دين "${escHtml(d.name)}"؟`, dangerous: true, confirmLabel: 'حذف مع تصحيح الحسابات',
      message: parts.join('<br>'), onConfirm: doDelete });
  }));
  $$('[data-savedebt]', host).forEach(el => el.addEventListener('click', () => {
    const d = DATA.debts.find(x => x.id === el.dataset.savedebt);
    const entry = el.closest('.debt-entry');
    d.name = entry.querySelector('[data-df="name"]').value || d.name;
    d.amount = parseFloat(entry.querySelector('[data-df="amount"]').value) || 0;
    d.date = entry.querySelector('[data-df="date"]').value || d.date;
    d.note = entry.querySelector('[data-df="note"]').value; d.updatedAt = Date.now();
    const reminderInput = entry.querySelector('[data-df="reminder"]');
    if (reminderInput) {
      const newReminderAt = parseReminderInput(reminderInput.value);
      if (newReminderAt !== d.reminderAt) { d.reminderAt = newReminderAt; d.notifiedAt = null; }
    }
    // مزامنة حركة الجرد الأصلية المرتبطة بهذا الدين مع أي تعديل بالاسم/المبلغ/التاريخ
    const origin = DATA.transactions.find(t => t.mode === 'debt' && t.debtId === d.id && t.debtOrigin && !t.deleted);
    if (origin) { origin.amount = d.amount; origin.date = d.date; origin.updatedAt = Date.now(); }
    DATA.transactions.forEach(t => { if (t.mode === 'debt' && t.debtId === d.id) t.debtName = d.name; });
    syncDebtPaidCache(d);
    editingDebtId = null; persist(true); evaluateAlerts(); renderDebtsInto(host); refreshMonthSummary();
  }));
}

function clientCardHtml(client) {
  const projects = DATA.projects.filter(p => p.clientId === client.id && !p.deleted);
  const totalAgreed = projects.reduce((s, p) => s + p.agreedAmount, 0);
  const totalPaid = projects.reduce((s, p) => s + computeProjectPaid(p), 0);
  const totalHours = projects.reduce((s, p) => s + p.hours, 0);
  const overallPct = totalAgreed > 0 ? Math.min(100, (totalPaid / totalAgreed) * 100) : 0;
  const rate = totalHours > 0 ? (totalPaid / totalHours) : 0;
  const addForm = addingProjectForClientId === client.id ? addProjectFormHtml(client, true) : '';
  // غير المكتملة الدفع أولًا (الأقل نسبة تسديدًا)، ونزولًا حتى المكتملة بالكامل في الآخر
  const sortedProjects = [...projects].sort((a, b) => (computeProjectPaid(a) / (a.agreedAmount || 1)) - (computeProjectPaid(b) / (b.agreedAmount || 1)));
  const panelKey = 'clientcard_' + client.id;
  return `<details data-focus="client:${client.id}" class="collapse-card card client-card" data-panel="${panelKey}"${panelOpenAttr(panelKey)}>
    <summary><div style="flex:1; min-width:0;">
      <div style="display:flex; justify-content:space-between; align-items:center; flex-wrap:wrap; gap:8px;">
        <span class="name">${client.name}</span>
        <span><button class="btn ghost sm" data-addprojfor="${client.id}" title="إضافة معاملة/مشروع لهذا العميل">+ معاملة</button>
        <button class="btn ghost sm" data-markallpaid="${client.id}">✓ تحديد الكل: دفع كلي</button></span>
      </div>
      <div class="sub">${client.currency} · ${projects.length} مشروع</div>
      <div style="margin-top:10px;"><div class="progress-wrap"><div class="progress-bar ${statusClass(overallPct)}" style="width:${overallPct}%"></div></div>
      <div class="muted" style="font-size:11.5px; margin-top:4px;">إجمالي: ${fmt(totalPaid)} / ${fmt(totalAgreed)} ${client.currency} · معدل الربح: ${fmt(rate)} ${client.currency}/ساعة</div></div>
    </div></summary>
    ${addForm}
    ${sortedProjects.map(p => projectRowHtml(client, p)).join('')}</details>`;
}
// نموذج إضافة معاملة/مشروع جديد لعميل محدَّد مباشرة من قسم العملاء — بنفس حقول قسم الشهر (عميل/مشروع) بالضبط،
// مع تاريخ اختياري (يدخل تاريخ اليوم تلقائيًا إذا تُرك فارغًا)
function addProjectFormHtml(client, scoped) {
  return `<div class="project-row" style="background:var(--surface); border-radius:10px; padding:10px; margin-top:${scoped ? '10px' : '0'};">
    <div class="form-grid" style="grid-template-columns:1fr 1fr;">
      <label class="field">عنوان المشروع<input type="text" id="newProj_title_${client.id}" placeholder="مثال: مشروع 2"></label>
      <label class="field">التاريخ<input type="date" id="newProj_date_${client.id}" value="${todayISO()}"></label>
      <label class="field">المبلغ المتفق عليه<input type="number" id="newProj_agreed_${client.id}" placeholder="0"></label>
      <label class="field">المدفوع الآن<input type="number" id="newProj_paid_${client.id}" placeholder="0"></label>
      <label class="field">ساعات العمل<input type="number" id="newProj_hours_${client.id}" placeholder="0"></label>
      <label class="field" style="grid-column:span 2;">ملاحظات<textarea class="autogrow" rows="1" id="newProj_note_${client.id}" placeholder="اختياري"></textarea></label>
    </div>
    <div class="form-actions"><button class="btn sm" data-confirmaddproj="${client.id}">حفظ</button><button class="btn ghost sm" data-canceladdproj="${client.id}">إلغاء</button></div>
  </div>`;
}
function projectRowHtml(client, p) {
  const paid = computeProjectPaid(p);
  if (editingProjectId === p.id) {
    return `<div class="project-row"><div class="form-grid" style="grid-template-columns:1fr 1fr;">
      <label class="field">العنوان<input type="text" data-pf="title" value="${p.title}"></label>
      <label class="field">المتفق عليه<input type="number" data-pf="agreedAmount" value="${p.agreedAmount}"></label>
      <label class="field">الساعات<input type="number" data-pf="hours" value="${p.hours}"></label>
      <label class="field" style="grid-column:span 2;">ملاحظات<textarea class="autogrow" rows="1" data-pf="notes">${escHtml(p.notes || '')}</textarea></label></div>
      <p class="muted" style="font-size:11px; margin-top:6px;">💡 "المدفوع" (${bidi(fmt(paid))} حاليًا) يُحسب تلقائيًا من مجموع الدفعات أسفل — لتعديله استعمل زر "دفعة" أو عدّل/احذف دفعة بعينها من القائمة تحت.</p>
      <div class="form-actions"><button class="btn sm" data-saveproj="${p.id}">حفظ</button><button class="btn ghost sm" data-cancelproj="${p.id}">إلغاء</button></div></div>`;
  }
  const pct = p.agreedAmount > 0 ? Math.min(100, (paid / p.agreedAmount) * 100) : 0;
  const remaining = p.agreedAmount - paid;
  const payments = projectPaymentsOf(p);
  const payForm = payingProjectId === p.id ? `<div class="form-grid" style="grid-template-columns:1fr 1fr; margin-top:8px;">
      <input type="number" id="projPayAmount_${p.id}" placeholder="المبلغ المدفوع" value="${projPayPrefillFull ? Math.max(remaining, 0) : ''}">
      <input type="date" id="projPayDate_${p.id}" value="${todayISO()}">
    </div>
    <p class="muted" style="font-size:10.5px; margin-top:4px;">💡 المبلغ المتفق عليه (${bidi(fmt(p.agreedAmount))}) هو نقطة انطلاق لا رقم مقفول — لو زاد المشروع عن التقدير الأولي، اكتب المبلغ الحقيقي كاملًا هنا وسيُسجَّل كما هو.</p>
    <div class="form-actions" style="margin-top:6px;">
      <button class="btn sm" data-confirmprojpay="${p.id}">تأكيد الدفعة</button><button class="btn ghost sm" data-cancelprojpay="${p.id}">إلغاء</button>
    </div>` : '';
  const paymentsListHtml = payments.length ? `<div class="debt-payments-list" style="margin-top:8px;">
    ${payments.map(t => `<div class="debt-payment-row">
        <span>💵 ${bidi(fmt(t.amount))} ${client.currency} <span class="muted">· ${t.date}</span></span>
        <span><button class="btn ghost sm" data-gotoprojtx="${t.id}" title="اذهب إلى مكانها في الشهر">↗</button>
          <button class="btn ghost sm" data-delprojtx="${t.id}" title="حذف هذه الدفعة">✕</button></span>
      </div>`).join('')}
  </div>` : '';
  return `<div class="project-row"><div class="prow-head"><span><button class="flag-btn ${p.flagged ? 'flagged' : ''}" data-flagproj="${p.id}" title="تعليم كمهم">★</button> ${p.title}${notePreviewHtml(p.notes)}</span>
    <span>${bidi(fmt(paid)+'/'+fmt(p.agreedAmount)+' '+client.currency)}${paid > p.agreedAmount ? ` <span class="income" style="font-size:11px;">(+${bidi(fmt(paid - p.agreedAmount))} زيادة عن المتفق عليه)</span>` : ''}
      <button class="btn ghost sm" data-projpartial="${p.id}" style="margin-inline-start:6px;">دفعة جزئية</button>
      <button class="btn ghost sm" data-projfull="${p.id}">دفع كلي</button>
      <button class="btn ghost sm" data-editproj="${p.id}">تعديل</button>
      <button class="btn ghost sm" data-delproj="${p.id}">حذف</button></span></div>
    <div class="progress-wrap"><div class="progress-bar ${statusClass(pct)}" style="width:${pct}%"></div></div>
    ${payForm}
    ${paymentsListHtml}
  </div>`;
}
function statusClass(pct) { if (pct <= 0) return 'status-none'; if (pct >= 100) return 'status-done'; return 'status-partial'; }
let addingProjectForClientId = null, payingProjectId = null, projPayPrefillFull = false;
function bindClientsEvents(view, rerender) {
  $$('[data-flagproj]', view).forEach(el => el.addEventListener('click', () => { const p = DATA.projects.find(x => x.id === el.dataset.flagproj); if (p) { p.flagged = !p.flagged; persist(true); rerender(); } }));
  $$('[data-editproj]', view).forEach(el => el.addEventListener('click', () => { editingProjectId = el.dataset.editproj; rerender(); }));
  $$('[data-cancelproj]', view).forEach(el => el.addEventListener('click', () => { editingProjectId = null; rerender(); }));
  $$('[data-projfull]', view).forEach(el => el.addEventListener('click', () => { payingProjectId = el.dataset.projfull; projPayPrefillFull = true; rerender(); }));
  $$('[data-projpartial]', view).forEach(el => el.addEventListener('click', () => { payingProjectId = el.dataset.projpartial; projPayPrefillFull = false; rerender(); }));
  $$('[data-cancelprojpay]', view).forEach(el => el.addEventListener('click', () => { payingProjectId = null; rerender(); }));
  $$('[data-confirmprojpay]', view).forEach(el => el.addEventListener('click', () => {
    const p = DATA.projects.find(x => x.id === el.dataset.confirmprojpay); if (!p) return;
    const client = DATA.clients.find(c => c.id === p.clientId);
    const paidSoFar = computeProjectPaid(p);
    const amt = parseFloat($(`#projPayAmount_${p.id}`).value);
    if (isNaN(amt) || amt <= 0) return toast('أدخل مبلغًا صحيحًا');
    const date = $(`#projPayDate_${p.id}`).value || todayISO();
    addProjectPaymentTx(p, client, amt, date); // يُسجَّل المبلغ كما كُتب بالضبط — بلا أي سقف، لأن "المتفق عليه" نقطة انطلاق لا رقم نهائي مقفول
    if (projPayPrefillFull && (paidSoFar + amt) < p.agreedAmount) toast(`⚠️ المجموع المدفوع (${bidi(fmt(paidSoFar + amt))}) أقل من الحد الأدنى المتفق عليه لهذا المشروع (${bidi(fmt(p.agreedAmount))}) — تأكد إن كان هذا مقصودًا`);
    payingProjectId = null; persist(true); evaluateAlerts(); rerender(); refreshMonthSummary();
  }));
  $$('[data-gotoprojtx]', view).forEach(el => el.addEventListener('click', () => { const t = DATA.transactions.find(x => x.id === el.dataset.gotoprojtx); if (t) goToTransactionMonth(t); }));
  $$('[data-delprojtx]', view).forEach(el => el.addEventListener('click', () => {
    const t = DATA.transactions.find(x => x.id === el.dataset.delprojtx); if (!t) return;
    const p = DATA.projects.find(x => x.id === t.projectId);
    const linkedOps = DATA.assetOps.filter(o => !o.deleted && o.srcId === t.id);
    const linkedAmt = linkedOps.reduce((s, o) => s + Math.abs(o.amount), 0);
    const finish = () => { cascadeDeleteTx(t); if (p) syncProjectPaidCache(p); persist(true); rerender(); refreshMonthSummary(); };
    if (linkedAmt <= 0.004) return finish();
    confirmDialog({ title: 'حذف هذه الدفعة؟', dangerous: true, confirmLabel: 'حذف مع تصحيح الحسابات',
      message: `سيُخصَم ${bidi(fmt(linkedAmt))} ${t.currency} من الأصل الذي أُضيفت إليه هذه الدفعة، حتى لا يبقى مالًا بلا مصدر موثّق.`, onConfirm: finish });
  }));
  $$('[data-markallpaid]', view).forEach(el => el.addEventListener('click', (e) => {
    e.preventDefault(); e.stopPropagation();
    const client = DATA.clients.find(c => c.id === el.dataset.markallpaid);
    DATA.projects.filter(p => p.clientId === client.id && !p.deleted).forEach(p => {
      const remaining = p.agreedAmount - computeProjectPaid(p);
      if (remaining > 0) addProjectPaymentTx(p, client, remaining, todayISO());
    });
    persist(true); rerender(); refreshMonthSummary();
  }));
  $$('[data-delproj]', view).forEach(el => el.addEventListener('click', () => {
    const p = DATA.projects.find(x => x.id === el.dataset.delproj); if (!p) return;
    const linkedTxs = DATA.transactions.filter(t => !t.deleted && t.projectId === p.id && t.mode === 'client');
    const linkedAmt = linkedTxs.reduce((s, t) => s + DATA.assetOps.filter(o => !o.deleted && o.srcId === t.id).reduce((x, o) => x + Math.abs(o.amount), 0), 0);
    const finish = () => {
      p.deleted = true; p.updatedAt = Date.now();
      linkedTxs.forEach(t => cascadeDeleteTx(t));
      DATA.quotes.forEach(q => { if (q.projectId === p.id) { q.projectId = null; q.clientId = null; } }); // فكّ ربط أي عرض سعر كان محوَّلًا لهذا المشروع
      persist(true); rerender(); refreshMonthSummary();
    };
    if (linkedAmt <= 0.004) return finish();
    confirmDialog({ title: `حذف مشروع "${escHtml(p.title)}"؟`, dangerous: true, confirmLabel: 'حذف مع تصحيح الحسابات',
      message: `سيُخصَم ${bidi(fmt(linkedAmt))} من الأصول التي أُضيفت إليها دفعات هذا المشروع، حتى لا يبقى مالًا بلا مصدر موثّق.`, onConfirm: finish });
  }));
  $$('[data-saveproj]', view).forEach(el => el.addEventListener('click', () => {
    const p = DATA.projects.find(x => x.id === el.dataset.saveproj);
    const row = el.closest('.project-row');
    p.title = row.querySelector('[data-pf="title"]').value || p.title;
    p.agreedAmount = parseFloat(row.querySelector('[data-pf="agreedAmount"]').value) || 0;
    p.hours = parseFloat(row.querySelector('[data-pf="hours"]').value) || 0;
    p.notes = row.querySelector('[data-pf="notes"]').value; p.updatedAt = Date.now();
    syncProjectPaidCache(p); editingProjectId = null; persist(true); rerender(); refreshMonthSummary();
  }));
  // إضافة معاملة/مشروع جديد مباشرة من قسم العملاء (لكل عميل زر "+ معاملة")
  $$('[data-addprojfor]', view).forEach(el => el.addEventListener('click', (e) => { e.preventDefault(); e.stopPropagation(); addingProjectForClientId = el.dataset.addprojfor; rerender(); }));
  $$('[data-canceladdproj]', view).forEach(el => el.addEventListener('click', () => { addingProjectForClientId = null; rerender(); }));
  $$('[data-confirmaddproj]', view).forEach(el => el.addEventListener('click', () => {
    const clientId = el.dataset.confirmaddproj; const client = DATA.clients.find(c => c.id === clientId); if (!client) return;
    const agreedRaw = $(`#newProj_agreed_${clientId}`).value.trim();
    const paid = parseFloat($(`#newProj_paid_${clientId}`).value) || 0;
    const hours = parseFloat($(`#newProj_hours_${clientId}`).value) || 0;
    let agreed = agreedRaw === '' ? NaN : parseFloat(agreedRaw);
    if (isNaN(agreed) || agreed <= 0) agreed = paid; // إذا لم يُحدَّد "المتفق عليه" يُعتبر تلقائيًا نفس المبلغ المدفوع
    const title = $(`#newProj_title_${clientId}`).value || 'مشروع';
    const note = $(`#newProj_note_${clientId}`).value;
    const date = $(`#newProj_date_${clientId}`).value || todayISO(); // تاريخ اليوم تلقائيًا إذا تُرك فارغًا
    const project = { id: uid(), clientId, title, agreedAmount: agreed, paidAmount: 0, hours,
      notes: note, flagged: false, createdAt: Date.now(), updatedAt: Date.now(), deleted: false };
    DATA.projects.push(project);
    if (paid > 0) addProjectPaymentTx(project, client, paid, date, note, hours, { createdProject: true });
    addingProjectForClientId = null; persist(true); evaluateAlerts(); rerender(); refreshMonthSummary();
    toast('أُضيفت المعاملة');
  }));
}
// ============================================================
// سجل دفعات المشروع: كل دفعة (كاملة أو جزئية) = معاملة مستقلة بتاريخها ومبلغها الخاص —
// بنفس مبدأ سجل تسديد الديون بالضبط، لنفس السبب: دفعة جديدة يجب ألا تمحو تاريخ/مبلغ دفعة سابقة.
// ============================================================
function projectPaymentsOf(p) {
  return DATA.transactions.filter(t => !t.deleted && t.mode === 'client' && t.projectId === p.id)
    .sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : b.createdAt - a.createdAt));
}
function computeProjectPaid(p) { return projectPaymentsOf(p).reduce((s, t) => s + t.amount, 0); }
function syncProjectPaidCache(p) { p.paidAmount = computeProjectPaid(p); }
function addProjectPaymentTx(p, client, amount, date, note, hours, opts) {
  if (!amount || amount <= 0) return;
  const tx = { id: uid(), kind: 'income', mode: 'client', projectId: p.id, currency: client.currency,
    amount, date: date || todayISO(), note: note || '', hours: hours || 0, flagged: false, createdAt: Date.now(), updatedAt: Date.now(), deleted: false };
  DATA.transactions.push(tx);
  syncProjectPaidCache(p);
  offerAssetAllocationForTx(tx, opts && opts.createdProject ? { createdProjectId: p.id } : {}); // العميل دفع: أين استلمتَ المبلغ؟ (كاش/بنك/...)
  return tx;
}

/* ============================================================
   الاستثمار (داخل شهر) - شبكة أيام + ملخص أسبوعي + سوق عملات
   ============================================================ */
function renderInvestmentInto(host, y, m) {
  const currencies = DATA.settings.currencies;
  if (!investCurrency) investCurrency = currencies[0];
  const daysInMonth = new Date(y, m, 0).getDate();
  const monthKey = `${y}-${pad2(m)}`;
  const entries = DATA.investments.filter(i => i.currency === investCurrency && !i.deleted && i.date.startsWith(monthKey));
  const byDay = {}; entries.forEach(e => { byDay[e.date] = (byDay[e.date] || 0) + e.amount; });

  const initial = DATA.settings.investmentInitial[investCurrency] || 0;
  const upToMonthEnd = `${monthKey}-${pad2(daysInMonth)}`;
  const cumulative = initial + DATA.investments.filter(i => i.currency === investCurrency && !i.deleted && i.date <= upToMonthEnd).reduce((s, i) => s + i.amount, 0);
  const monthNet = entries.reduce((s, e) => s + e.amount, 0);

  const weeks = [];
  const weekCount = 4; // ثابتة دائمًا - أي أيام زائدة (29/30/31) تنضم للأسبوع الرابع بدل أسبوع خامس وهمي
  for (let w = 0; w < weekCount; w++) {
    const startDay = w * 7 + 1;
    const endDay = w === weekCount - 1 ? daysInMonth : Math.min(daysInMonth, startDay + 6);
    let sum = 0;
    for (let d = startDay; d <= endDay; d++) { const ds = `${monthKey}-${pad2(d)}`; sum += byDay[ds] || 0; }
    weeks.push({ label: `أسبوع ${w + 1}`, sum });
  }

  const balanceBeforeMonth = initial + DATA.investments.filter(i => i.currency === investCurrency && !i.deleted && i.date < `${monthKey}-01`).reduce((s, i) => s + i.amount, 0);
  let running = balanceBeforeMonth;
  const monthlyRunningBalance = Array.from({ length: daysInMonth }, (_, i) => {
    const ds = `${monthKey}-${pad2(i + 1)}`;
    running += byDay[ds] || 0;
    return running;
  });

  const dayCells = Array.from({ length: daysInMonth }, (_, i) => {
    const d = i + 1, ds = `${monthKey}-${pad2(d)}`, val = byDay[ds] || 0;
    return `<div class="invest-cell ${val > 0 ? 'pos' : val < 0 ? 'neg' : ''}" data-day="${d}">
      <div class="day-num" data-opendetail="${d}">${d}</div>
      <input type="number" class="invest-cell-input" data-quickday="${d}" value="${val || ''}" placeholder="0" style="color:${val > 0 ? 'var(--green)' : val < 0 ? 'var(--red)' : 'var(--text)'};">
    </div>`;
  }).join('');

  host.innerHTML = `
    <div class="segmented" id="investCurSwitch">${currencies.map(c => `<button data-cur="${c}" class="${c === investCurrency ? 'active' : ''}" style="${c === investCurrency ? `background:${curColor(c)}; box-shadow:0 0 14px ${curColor(c)}66;` : ''}">${c}</button>`).join('')}</div>
    <div class="grid grid-3" style="margin-top:14px;">
      <div class="stat-card"><div class="label">الاستثمار الأساسي</div><div class="value">${bidi(fmt(initial)+' '+investCurrency)}</div></div>
      <div class="stat-card ${monthNet >= 0 ? 'positive' : 'negative'}"><div class="label">صافي ربح الشهر</div><div class="value">${bidi(fmt(monthNet)+' '+investCurrency)}</div></div>
      <div class="stat-card"><div class="label">إجمالي رصيد المحفظة</div><div class="value">${bidi(fmt(cumulative)+' '+investCurrency)}</div></div>
    </div>

    <div class="card" style="margin-top:14px;">
      <strong>تطور رصيد المحفظة خلال ${MONTH_NAMES[m - 1]}</strong>
      <div class="chart-wrap" style="margin-top:10px;">${richLineChart(monthlyRunningBalance, { color: monthNet >= 0 ? '#22d3a8' : '#ef5a6f', segmented: true, xLabels: Array.from({ length: daysInMonth }, (_, i) => String(i + 1)), maxXLabels: 15, axisTag: investCurrency })}</div>
    </div>

    <div class="card" style="margin-top:14px;">
      <div style="display:flex; gap:16px; flex-wrap:wrap;">
        <div style="flex:2; min-width:280px;">
          <strong>الأيام (${daysInMonth} يوم) — اضغط على أي يوم لتسجيل ربح/خسارة</strong>
          <div class="invest-grid" style="margin-top:10px;">${dayCells}</div>
          <div id="dayEditHost" style="margin-top:12px;"></div>
        </div>
        <div style="flex:1; min-width:180px;">
          <strong>الملخص الأسبوعي</strong>
          <div style="margin-top:10px;">${weeks.map(w => `<div class="week-card"><span>${w.label}</span><span class="total-emph ${w.sum >= 0 ? 'pos' : 'neg'}">${bidi(fmt(w.sum))}</span></div>`).join('')}</div>
        </div>
      </div>
    </div>

    <div class="card inline-form" style="margin-top:14px;">
      <label class="field">رأس المال الأولي لعملة ${investCurrency}<input type="number" id="inv_initial" value="${initial}" style="max-width:220px;"></label>
      <div class="form-actions"><button class="btn ghost sm" id="inv_saveInitial">حفظ رأس المال</button></div>
    </div>

    <div class="card" style="margin-top:14px;">
      <strong>سوق العملات (تحويل يدوي)</strong>
      <div class="form-grid" style="grid-template-columns: repeat(4,1fr); margin-top:10px;">
        <label class="field">من<select id="mk_from">${currencies.map(c => `<option>${c}</option>`).join('')}</select></label>
        <label class="field">إلى<select id="mk_to">${currencies.map(c => `<option>${c}</option>`).join('')}</select></label>
        <label class="field">سعر الصرف (1 من = كم إلى)<input type="number" id="mk_rate" placeholder="مثال: 135"></label>
        <label class="field">المبلغ<input type="number" id="mk_amount" placeholder="0"></label>
      </div>
      <div id="mk_result" class="total-emph pos" style="margin-top:10px; font-size:20px;"></div>
    </div>
  `;

  $('#investCurSwitch', host).addEventListener('click', (e) => { const b = e.target.closest('button[data-cur]'); if (!b) return; investCurrency = b.dataset.cur; renderInvestmentInto(host, y, m); });
  $('#inv_saveInitial', host).addEventListener('click', () => { DATA.settings.investmentInitial[investCurrency] = parseFloat($('#inv_initial', host).value) || 0; persist(true); renderInvestmentInto(host, y, m); });
  animateChartDraw(host);

  $$('[data-opendetail]', host).forEach(el => el.addEventListener('click', () => {
    const d = el.dataset.opendetail, ds = `${monthKey}-${pad2(d)}`;
    const existing = entries.find(e => e.date === ds);
    const editHost = $('#dayEditHost', host);
    editHost.innerHTML = `<div class="card" style="padding:12px;"><strong>يوم ${d}</strong>
      <div class="form-grid" style="grid-template-columns:1fr 1fr; margin-top:8px;">
        <label class="field">الربح/الخسارة (سالب للخسارة)<input type="number" id="dayAmount" value="${existing ? existing.amount : ''}" placeholder="0"></label>
        <label class="field">ملاحظات<input type="text" id="dayNote" value="${existing ? (existing.note || '') : ''}"></label>
      </div><div class="form-actions"><button class="btn sm" id="dayAmountSave">حفظ</button></div></div>`;
    $('#dayAmountSave', editHost).addEventListener('click', () => {
      const amount = parseFloat($('#dayAmount', editHost).value);
      if (isNaN(amount)) return toast('أدخل رقمًا صحيحًا');
      if (existing) { existing.amount = amount; existing.note = $('#dayNote', editHost).value; existing.updatedAt = Date.now(); }
      else DATA.investments.push({ id: uid(), currency: investCurrency, amount, date: ds, note: $('#dayNote', editHost).value, createdAt: Date.now(), updatedAt: Date.now(), deleted: false });
      playTone(amount >= 0 ? 'positive' : 'negative');
      persist(true); renderInvestmentInto(host, y, m);
    });
  }));

  // إدخال سريع مباشر من داخل خانة اليوم نفسها، بدون فتح اللوحة السفلية
  const saveQuickDay = (d, rawVal) => {
    const amount = parseFloat(rawVal);
    if (isNaN(amount)) return;
    const ds = `${monthKey}-${pad2(d)}`;
    const existing = entries.find(e => e.date === ds);
    if (existing) { existing.amount = amount; existing.updatedAt = Date.now(); }
    else DATA.investments.push({ id: uid(), currency: investCurrency, amount, date: ds, note: '', createdAt: Date.now(), updatedAt: Date.now(), deleted: false });
    playTone(amount >= 0 ? 'positive' : 'negative');
    persist(true); renderInvestmentInto(host, y, m);
  };
  $$('[data-quickday]', host).forEach(input => {
    input.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); input.blur(); } });
    input.addEventListener('input', () => {
      const v = parseFloat(input.value);
      input.style.color = v > 0 ? 'var(--green)' : v < 0 ? 'var(--red)' : 'var(--text)';
    });
    input.addEventListener('blur', () => {
      const d = input.dataset.quickday;
      if (input.value !== '' && input.value !== String(byDay[`${monthKey}-${pad2(d)}`] || '')) saveQuickDay(d, input.value);
    });
  });

  const updateConversion = () => {
    const from = $('#mk_from', host).value, to = $('#mk_to', host).value;
    const rate = parseFloat($('#mk_rate', host).value), amount = parseFloat($('#mk_amount', host).value);
    const key = `${from}_${to}`;
    if (!isNaN(rate)) DATA.settings.exchangeRates[key] = rate;
    const useRate = !isNaN(rate) ? rate : (DATA.settings.exchangeRates[key] || 0);
    const resultEl = $('#mk_result', host);
    if (useRate && !isNaN(amount)) { resultEl.innerHTML = bidi(`${fmt(amount)} ${from} = ${fmt(amount * useRate)} ${to}`); resultEl.className = 'total-emph pos'; resultEl.style.fontSize = '20px'; }
    else { resultEl.textContent = 'أدخل سعر الصرف والمبلغ لعرض التحويل'; resultEl.className = 'muted'; resultEl.style.fontSize = '13px'; }
  };
  ['mk_from', 'mk_to', 'mk_rate', 'mk_amount'].forEach(id => $(`#${id}`, host).addEventListener('input', updateConversion));
}

/* ============================================================
   الإخراجات (داخل شهر) - إدخال يدوي كامل
   ============================================================ */
function renderOutflowsInto(host, y, m) {
  const currencies = DATA.settings.currencies;
  const payments = DATA.zakatPayments.filter(z => !z.deleted && inMonth(z.date, y, m)).sort((a, b) => b.date.localeCompare(a.date));
  const totalsByCurrency = {}; const deliveredByCurrency = {};
  payments.forEach(p => { totalsByCurrency[p.currency] = (totalsByCurrency[p.currency] || 0) + p.amount; if (p.delivered) deliveredByCurrency[p.currency] = (deliveredByCurrency[p.currency] || 0) + p.amount; });
  const activeCurs = currenciesWithActivity(payments);

  const monthIncome = c => txByKind('income').filter(t => t.currency === c && inMonth(t.date, y, m)).reduce((s, t) => s + t.amount, 0);
  const monthExpense = c => txByKind('expense').filter(t => t.currency === c && inMonth(t.date, y, m)).reduce((s, t) => s + t.amount, 0);

  host.innerHTML = `
    <p class="view-sub" style="margin:0 0 12px;">احسب تلقائيًا من صافي الشهر، أو سجّل يدويًا</p>
    <div class="grid grid-3">
      ${activeCurs.length === 0 ? '<p class="muted">لا توجد دفعات هذا الشهر بعد</p>' : activeCurs.map(c => {
        const due = totalsByCurrency[c]; const delivered = deliveredByCurrency[c] || 0; const pct = due > 0 ? Math.min(100, (delivered / due) * 100) : 0;
        return `<div class="stat-card outflow"><div class="label">إجمالي ${c}</div><div class="value">${bidi(fmt(due) + ' ' + c)}</div>
          <div class="progress-wrap" style="margin-top:8px;"><div class="progress-bar ${pct >= 100 ? 'status-done' : 'status-outflow-partial'}" style="width:${pct}%"></div></div>
          <div class="muted" style="font-size:11px; margin-top:4px;">وصل لصاحبه: ${bidi(fmt(delivered) + '/' + fmt(due))}</div></div>`;
      }).join('')}
    </div>

    <div class="card inline-form" style="margin-top:14px;">
      <strong>حاسبة تلقائية (نسبة من صافي الشهر)</strong>
      <div class="form-grid" style="margin-top:10px;">
        <label class="field">العملة<select id="auto_currency">${currencies.map(c => `<option>${c}</option>`).join('')}</select></label>
        <label class="field">النسبة %<input type="number" id="auto_percent" value="${DATA.settings.zakatPercent}"></label>
        <label class="field">الاسم<input type="text" id="auto_name" value="زكاة"></label>
      </div>
      <p class="muted" style="font-size:12px; margin-top:8px;" id="auto_preview"></p>
      <div class="form-actions"><button class="btn" id="auto_add">إضافة كدفعة مستحقة</button></div>
    </div>

    <div class="card inline-form" style="margin-top:14px;">
      <strong>إضافة يدوية</strong>
      <div class="form-grid" style="margin-top:10px;">
        <label class="field">الاسم<input type="text" id="zk_name" placeholder="زكاة / صدقة / إحسان"></label>
        <label class="field">النسبة % (اختياري)<input type="number" id="zk_percent" placeholder="مثال: 2.5"></label>
        <label class="field">العملة<select id="zk_currency">${currencies.map(c => `<option>${c}</option>`).join('')}</select></label>
        <label class="field">المبلغ<input type="number" id="zk_amount"></label>
        <label class="field">التاريخ<input type="date" id="zk_date" value="${y}-${pad2(m)}-${pad2(new Date().getDate())}"></label>
      </div>
      <div class="form-actions"><button class="btn ghost" id="zk_save">تسجيل عملية</button></div>
    </div>

    <div class="card" style="margin-top:14px;"><strong>سجل هذا الشهر</strong>
      <div style="margin-top:8px;">${payments.length === 0 ? '<p class="muted">لا توجد دفعات مسجّلة بعد</p>' : payments.map(z => zakatRowHtml(z)).join('')}</div>
    </div>`;

  const updatePreview = () => {
    const c = $('#auto_currency', host).value; const pct = parseFloat($('#auto_percent', host).value) || 0;
    const net = monthIncome(c) - monthExpense(c);
    const due = Math.max(0, net) * (pct / 100);
    $('#auto_preview', host).innerHTML = `صافي الشهر بـ${c}: ${bidi(fmt(net))} · المستحق (${pct}%): <span class="total-emph pos">${bidi(fmt(due) + ' ' + c)}</span>`;
  };
  ['auto_currency', 'auto_percent'].forEach(id => $(`#${id}`, host).addEventListener('input', updatePreview));
  updatePreview();

  $('#auto_add', host).addEventListener('click', () => {
    const c = $('#auto_currency', host).value; const pct = parseFloat($('#auto_percent', host).value) || 0;
    const net = monthIncome(c) - monthExpense(c);
    const due = Math.max(0, net) * (pct / 100);
    if (due <= 0) return toast('لا يوجد مستحق (الصافي صفر أو سالب)');
    DATA.zakatPayments.push({ id: uid(), name: $('#auto_name', host).value || 'زكاة', percent: pct, amount: due, currency: c,
      date: `${y}-${pad2(m)}-${pad2(new Date().getDate())}`, delivered: false, deleted: false });
    persist(true); renderOutflowsInto(host, y, m); refreshMonthSummary();
  });

  $('#zk_save', host).addEventListener('click', () => {
    const amount = parseFloat($('#zk_amount', host).value);
    if (isNaN(amount)) return toast('أدخل رقمًا صحيحًا');
    DATA.zakatPayments.push({ id: uid(), name: $('#zk_name', host).value || 'زكاة', percent: parseFloat($('#zk_percent', host).value) || null,
      amount, currency: $('#zk_currency', host).value, date: $('#zk_date', host).value || todayISO(), delivered: false, deleted: false });
    persist(true); renderOutflowsInto(host, y, m); refreshMonthSummary();
  });
  bindZakatEvents(host, () => { renderOutflowsInto(host, y, m); refreshMonthSummary(); });
}
function zakatRowHtml(z) {
  if (editingZakatId === z.id) {
    return `<div class="list-row" style="gap:8px; flex-wrap:wrap;">
      <input type="text" data-zf="name" value="${(z.name || '').replace(/"/g, '&quot;')}" style="width:120px;" placeholder="الاسم">
      <select data-zf="currency" style="width:90px;">${DATA.settings.currencies.map(c => `<option ${c === z.currency ? 'selected' : ''}>${c}</option>`).join('')}</select>
      <input type="number" data-zf="percent" value="${z.percent || ''}" style="width:80px;" placeholder="النسبة %">
      <input type="date" data-zf="date" value="${z.date}" style="width:130px;">
      <input type="number" data-zf="amount" value="${z.amount}" style="width:100px;">
      <button class="btn sm" data-savezk="${z.id}">حفظ</button><button class="btn ghost sm" data-cancelzk="${z.id}">إلغاء</button></div>`;
  }
  return `<div class="list-row"><span>${z.name || 'زكاة'} ${z.percent ? `(${z.percent}%)` : ''} <span class="muted">· ${z.date}</span></span>
    <span>${bidi(fmt(z.amount) + ' ' + z.currency)}
      <button class="btn ghost sm" data-deliverzk="${z.id}" style="margin-inline-start:8px; ${z.delivered ? 'color:var(--green);' : ''}">${z.delivered ? '✓ وصل لصاحبه' : 'لم يصل بعد'}</button>
      <button class="btn ghost sm" data-editzk="${z.id}" style="margin-inline-start:8px;">تعديل</button>
      <button class="btn ghost sm" data-delzk="${z.id}">حذف</button></span></div>`;
}
function bindZakatEvents(host, rerender) {
  $$('[data-editzk]', host).forEach(el => el.addEventListener('click', () => { editingZakatId = el.dataset.editzk; rerender(); }));
  $$('[data-cancelzk]', host).forEach(el => el.addEventListener('click', () => { editingZakatId = null; rerender(); }));
  $$('[data-delzk]', host).forEach(el => el.addEventListener('click', () => { const z = DATA.zakatPayments.find(x => x.id === el.dataset.delzk); if (z) { z.deleted = true; z.updatedAt = Date.now(); persist(true); renderMonthView(); } }));
  $$('[data-deliverzk]', host).forEach(el => el.addEventListener('click', () => { const z = DATA.zakatPayments.find(x => x.id === el.dataset.deliverzk); if (z) {
    z.delivered = !z.delivered; z.updatedAt = Date.now(); persist(true); rerender();
    // عند التسليم فعليًا يخرج المال من أصل — نسأل من أين (وعند إلغاء التسليم يتراجع أثره تلقائيًا)
    if (z.delivered) offerAssetAllocation({ srcType: 'zakat', srcId: z.id, src: 'zakat', direction: 'out', amount: z.amount, currency: z.currency, date: z.date, who: z.name, note: '',
      title: `من أين خرج ${fmt(z.amount)} ${z.currency}؟`, subtitle: `${ASSET_SRC_LABEL.zakat} · ${z.name}`, replaceOld: true, reduceLabel: 'المُسلَّم فقط — يُعدَّل مبلغ الإخراج' });
  } }));
  $$('[data-savezk]', host).forEach(el => el.addEventListener('click', () => {
    const z = DATA.zakatPayments.find(x => x.id === el.dataset.savezk); const row = el.closest('.list-row');
    const amount = parseFloat(row.querySelector('[data-zf="amount"]').value); if (isNaN(amount)) return toast('أدخل رقمًا صحيحًا');
    z.name = row.querySelector('[data-zf="name"]').value || z.name; z.date = row.querySelector('[data-zf="date"]').value || z.date; z.amount = amount;
    const curEl = row.querySelector('[data-zf="currency"]'); if (curEl) z.currency = curEl.value;
    const pctEl = row.querySelector('[data-zf="percent"]'); if (pctEl) z.percent = pctEl.value ? parseFloat(pctEl.value) : null;
    editingZakatId = null; persist(true); rerender();
  }));
}

/* ============================================================
   مقارنة مصادر الدخل: مصدر عادي (أنواعه) / عميل-مشروع / معًا
   ============================================================ */
function incomeSourceBars(mode, cur, filterFn) {
  if (mode === 'client') {
    const clients = DATA.clients.filter(c => !c.deleted && c.currency === cur);
    return clients.map(c => {
      const projectIds = DATA.projects.filter(p => p.clientId === c.id && !p.deleted).map(p => p.id);
      const value = DATA.transactions.filter(t => !t.deleted && t.mode === 'client' && projectIds.includes(t.projectId) && t.currency === cur && filterFn(t)).reduce((s, t) => s + t.amount, 0);
      return { label: c.name, value };
    }).filter(r => r.value > 0);
  }
  if (mode === 'general') {
    const byCat = {};
    DATA.transactions.filter(t => !t.deleted && t.kind === 'income' && t.mode === 'general' && t.currency === cur && filterFn(t)).forEach(t => {
      const cat = DATA.categories.find(c => c.id === t.categoryId);
      const key = cat ? cat.id : 'other';
      if (!byCat[key]) byCat[key] = { label: cat ? cat.name : 'أخرى', value: 0 };
      byCat[key].value += t.amount;
    });
    return Object.values(byCat).filter(r => r.value > 0);
  }
  return [...incomeSourceBars('general', cur, filterFn), ...incomeSourceBars('client', cur, filterFn)];
}

// يفتّح/يغمّق لونًا مع الحفاظ على تشبّعه (يعمل عبر HSL بدل الجمع المباشر في RGB)، حتى لا يتحوّل أي لون فاتح لبهتان باهت (وردي شاحب) عند التفتيح كما كان يحدث سابقًا
function hexToHsl(hex) {
  hex = (hex || '#7c5cff').replace('#', '');
  if (hex.length === 3) hex = hex.split('').map(c => c + c).join('');
  const num = parseInt(hex, 16) || 0x7c5cff;
  const r = (num >> 16) / 255, g = ((num >> 8) & 0xff) / 255, b = (num & 0xff) / 255;
  const max = Math.max(r, g, b), min = Math.min(r, g, b);
  let h, s; const l = (max + min) / 2;
  if (max === min) { h = s = 0; }
  else {
    const d = max - min;
    s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
    switch (max) {
      case r: h = (g - b) / d + (g < b ? 6 : 0); break;
      case g: h = (b - r) / d + 2; break;
      default: h = (r - g) / d + 4;
    }
    h /= 6;
  }
  return [h * 360, s * 100, l * 100];
}
function hslToHex(h, s, l) {
  h = ((h % 360) + 360) % 360 / 360; s = Math.max(0, Math.min(100, s)) / 100; l = Math.max(0, Math.min(100, l)) / 100;
  let r, g, b;
  if (s === 0) { r = g = b = l; }
  else {
    const hue2rgb = (p, q, t) => { if (t < 0) t += 1; if (t > 1) t -= 1; if (t < 1 / 6) return p + (q - p) * 6 * t; if (t < 1 / 2) return q; if (t < 2 / 3) return p + (q - p) * (2 / 3 - t) * 6; return p; };
    const q = l < 0.5 ? l * (1 + s) : l + s - l * s;
    const p = 2 * l - q;
    r = hue2rgb(p, q, h + 1 / 3); g = hue2rgb(p, q, h); b = hue2rgb(p, q, h - 1 / 3);
  }
  const toHex = x => Math.round(x * 255).toString(16).padStart(2, '0');
  return `#${toHex(r)}${toHex(g)}${toHex(b)}`;
}
function shadeColor(hex, percent) {
  const [h, s, l] = hexToHsl(hex);
  // نحرّك الإضاءة نسبيًا نحو الأبيض أو الأسود حسب الإشارة، بدل جمع ثابت في RGB يُبهت اللون
  const newL = percent >= 0 ? l + (100 - l) * (percent / 100) * 0.62 : l + l * (percent / 100) * 0.62;
  const newS = Math.min(100, s + (percent >= 0 ? 6 : 10)); // تعزيز بسيط للتشبّع بدل فقدانه، ليبقى اللون حيويًا لا باهتًا
  return hslToHex(h, newS, Math.max(4, Math.min(96, newL)));
}

const BAR3D_PALETTE = ['#8bc34a', '#c6d833', '#ffb300', '#ff7043', '#ef5a6f', '#ec407a', '#7c5cff', '#42a5f5', '#26c6da', '#22d3a8'];

// عمود ثلاثي الأبعاد لامع (زجاجي) بأسلوب لوحات القيادة الاحترافية: تدرّج لوني + بريق جانبي + نمو متحرك تصاعدي
// نسخة مسطّحة (بدون منظور ثلاثي الأبعاد) — تُستعمل في "مقارنة مصادر الدخل" كما كانت دائمًا
function bar3DChart(items, opts = {}) {
  if (!items || !items.length) return '<p class="muted" style="font-size:13px; padding:10px 0;">لا توجد بيانات بعد</p>';
  const w = opts.width || 900, h = opts.height || 260, pad = 40, gap = 16;
  const sorted = [...items].sort((a, b) => a.value - b.value); // تصاعدي (سلّم) كالصور المرجعية
  const maxVal = Math.max(1, ...sorted.map(d => d.value));
  const n = sorted.length;
  const plotW = w - pad * 2;
  const barW = Math.min(90, Math.max(28, (plotW - gap * (n - 1)) / n));
  const usedW = barW * n + gap * (n - 1);
  const startX = pad + Math.max(0, (plotW - usedW) / 2);
  const baseY = h - pad;
  const maxBarH = h - pad * 2 - 34;
  const id = 'bar3d' + (chartIdCounter++);

  const bars = sorted.map((d, i) => {
    const bh = Math.max(8, (d.value / maxVal) * maxBarH);
    const x = startX + i * (barW + gap);
    const y = baseY - bh;
    const color = BAR3D_PALETTE[i % BAR3D_PALETTE.length];
    const topColor = shadeColor(color, 26);
    const gradId = `bg3d-${id}-${i}`;
    const lbl = d.label.length > 11 ? d.label.slice(0, 10) + '…' : d.label;
    return `<g>
      <defs>
        <linearGradient id="${gradId}" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stop-color="${topColor}" />
          <stop offset="55%" stop-color="${color}" />
          <stop offset="100%" stop-color="${shadeColor(color, -20)}" />
        </linearGradient>
      </defs>
      <rect class="bar3d-rect" x="${x}" y="${y}" width="${barW}" height="${bh}" rx="10" fill="url(#${gradId})" style="animation-delay:${i * 90}ms; color:${color};" filter="url(#bar3d-glow-${id})"><title>${d.label}: ${fmt(d.value)}</title></rect>
      <rect class="bar3d-shine" x="${x + barW * 0.14}" y="${y + 5}" width="${Math.max(3, barW * 0.16)}" height="${Math.max(0, bh - 12)}" rx="4" style="animation-delay:${i * 90}ms;" />
      <text class="bar3d-value" x="${x + barW / 2}" y="${y - 10}" text-anchor="middle" font-size="12" font-weight="800" fill="#fff" style="animation-delay:${i * 90 + 260}ms;">${fmt(d.value)}</text>
      <text x="${x + barW / 2}" y="${baseY + 20}" text-anchor="middle" font-size="10.5" fill="rgba(255,255,255,0.65)">${lbl}</text>
    </g>`;
  }).join('');

  return `<svg width="100%" viewBox="0 0 ${w} ${h}" preserveAspectRatio="xMidYMid meet" data-chart-anim="1">
    <defs><filter id="bar3d-glow-${id}" x="-60%" y="-60%" width="220%" height="220%"><feGaussianBlur stdDeviation="3" result="blur" /><feMerge><feMergeNode in="blur"/><feMergeNode in="SourceGraphic"/></feMerge></filter></defs>
    <line x1="${pad}" y1="${baseY}" x2="${w - pad}" y2="${baseY}" stroke="rgba(255,255,255,0.12)" />
    ${bars}
  </svg>`;
}
// نسخة بمنظور Isometric حقيقي (وجه علوي + جانبي + منصّة قاعدة) — تُستعمل فقط في "مقارنة العملاء عبر السنين" كما طُلب سابقًا
// عمود أسطواني برأس مدبب لامع (بالضبط أسلوب الصورة المرجعية) — يُستعمل في "مقارنة الأصول والديون"
// كل عنصر عموده الكامل الخاص (غير مقسوم داخليًا)، واللون يُحدَّد حسب الفئة (أخضر=أصول/أحمر=ديون) إذا مُرِّر، وإلا يُستعمل تدرّج قوس قزح تلقائي
function cylinderBarChart(items, opts = {}) {
  if (!items || !items.length) return '<p class="muted" style="font-size:13px; padding:10px 0;">لا توجد بيانات بعد</p>';
  const w = opts.width || 900, h = opts.height || 280, pad = 40, gap = 20;
  const sorted = [...items].sort((a, b) => a.value - b.value);
  const maxVal = Math.max(1, ...sorted.map(d => d.value));
  const n = sorted.length;
  const plotW = w - pad * 2;
  const barW = Math.min(76, Math.max(26, (plotW - gap * (n - 1)) / n));
  const usedW = barW * n + gap * (n - 1);
  const startX = pad + Math.max(0, (plotW - usedW) / 2);
  const baseY = h - pad;
  const capH = barW * 0.55; // ارتفاع الرأس المدبب
  const maxBarH = h - pad * 2 - capH - 34;
  const id = 'cyl' + (chartIdCounter++);

  const bars = sorted.map((d, i) => {
    const bh = Math.max(10, (d.value / maxVal) * maxBarH);
    const x = startX + i * (barW + gap);
    const capBaseY = baseY - bh, peakY = capBaseY - capH;
    const color = d.color || BAR3D_PALETTE[i % BAR3D_PALETTE.length];
    const topColor = shadeColor(color, 34), gradId = `cylg-${id}-${i}`;
    const lbl = d.label.length > 11 ? d.label.slice(0, 10) + '…' : d.label;
    return `<g class="bar3d-group" style="animation-delay:${i * 90}ms;">
      <defs><linearGradient id="${gradId}" x1="0" y1="0" x2="1" y2="0">
        <stop offset="0%" stop-color="${shadeColor(color, -18)}" /><stop offset="35%" stop-color="${topColor}" /><stop offset="60%" stop-color="${color}" /><stop offset="100%" stop-color="${shadeColor(color, -10)}" />
      </linearGradient></defs>
      <path class="bar3d-rect" d="M ${x},${baseY} L ${x},${capBaseY} L ${x + barW / 2},${peakY} L ${x + barW},${capBaseY} L ${x + barW},${baseY} Z"
        fill="url(#${gradId})" style="animation-delay:${i * 90}ms; color:${color};" filter="url(#bar3d-glow-${id})"><title>${d.label}: ${fmt(d.value)}</title></path>
      <rect class="bar3d-shine" x="${x + barW * 0.16}" y="${capBaseY + 6}" width="${Math.max(3, barW * 0.14)}" height="${Math.max(0, bh - 14)}" rx="4" style="animation-delay:${i * 90}ms;" />
      <text class="bar3d-value" x="${x + barW / 2}" y="${peakY - 10}" text-anchor="middle" font-size="12" font-weight="800" fill="#fff" style="animation-delay:${i * 90 + 260}ms;">${fmt(d.value)}</text>
      <text x="${x + barW / 2}" y="${baseY + 20}" text-anchor="middle" font-size="10.5" fill="rgba(255,255,255,0.65)">${lbl}</text>
    </g>`;
  }).join('');

  return `<svg width="100%" viewBox="0 0 ${w} ${h}" preserveAspectRatio="xMidYMid meet" data-chart-anim="1">
    <defs><filter id="bar3d-glow-${id}" x="-60%" y="-60%" width="220%" height="220%"><feGaussianBlur stdDeviation="3" result="blur" /><feMerge><feMergeNode in="blur"/><feMergeNode in="SourceGraphic"/></feMerge></filter></defs>
    <line x1="${pad}" y1="${baseY}" x2="${w - pad}" y2="${baseY}" stroke="rgba(255,255,255,0.12)" />
    ${bars}
  </svg>`;
}
function bar3DChartIso(items, opts = {}) {
  if (!items || !items.length) return '<p class="muted" style="font-size:13px; padding:10px 0;">لا توجد بيانات بعد</p>';
  const w = opts.width || 900, h = opts.height || 260, pad = 40, gap = 22;
  const sorted = [...items].sort((a, b) => a.value - b.value); // تصاعدي (سلّم) كالصور المرجعية
  const maxVal = Math.max(1, ...sorted.map(d => d.value));
  const n = sorted.length;
  const plotW = w - pad * 2;
  const depth = 14; // عمق المنظور الوهمي (isometric) — يعطي الإحساس بالبعد الثالث الحقيقي بدل تدرّج مسطّح
  const barW = Math.min(78, Math.max(24, (plotW - gap * (n - 1)) / n - depth));
  const usedW = (barW + depth) * n + gap * (n - 1);
  const startX = pad + Math.max(0, (plotW - usedW) / 2);
  const baseY = h - pad;
  const maxBarH = h - pad * 2 - 34;
  const id = 'bar3d' + (chartIdCounter++);

  const bars = sorted.map((d, i) => {
    const bh = Math.max(8, (d.value / maxVal) * maxBarH);
    const x = startX + i * (barW + depth + gap);
    const y = baseY - bh;
    const color = BAR3D_PALETTE[i % BAR3D_PALETTE.length];
    const topColor = shadeColor(color, 30);
    const sideColor = shadeColor(color, -32);
    const gradId = `bg3d-${id}-${i}`;
    const lbl = d.label.length > 11 ? d.label.slice(0, 10) + '…' : d.label;
    return `<g class="bar3d-group" style="animation-delay:${i * 90}ms;">
      <defs>
        <linearGradient id="${gradId}" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stop-color="${topColor}" />
          <stop offset="55%" stop-color="${color}" />
          <stop offset="100%" stop-color="${shadeColor(color, -14)}" />
        </linearGradient>
      </defs>
      <!-- الوجه الجانبي (يمين) — يعطي عمق المنظور -->
      <polygon class="bar3d-side" points="${x + barW},${y} ${x + barW + depth},${y - depth / 1.6} ${x + barW + depth},${baseY - depth / 1.6} ${x + barW},${baseY}" fill="${sideColor}" style="animation-delay:${i * 90}ms;" />
      <!-- الوجه العلوي (معيّن مائل) -->
      <polygon class="bar3d-top" points="${x},${y} ${x + depth},${y - depth / 1.6} ${x + barW + depth},${y - depth / 1.6} ${x + barW},${y}" fill="${topColor}" style="animation-delay:${i * 90}ms;" />
      <!-- الوجه الأمامي -->
      <rect class="bar3d-rect" x="${x}" y="${y}" width="${barW}" height="${bh}" fill="url(#${gradId})" style="animation-delay:${i * 90}ms; color:${color};" filter="url(#bar3d-glow-${id})"><title>${d.label}: ${fmt(d.value)}</title></rect>
      <rect class="bar3d-shine" x="${x + barW * 0.14}" y="${y + 5}" width="${Math.max(3, barW * 0.14)}" height="${Math.max(0, bh - 12)}" rx="3" style="animation-delay:${i * 90}ms;" />
      <text class="bar3d-value" x="${x + barW / 2 + depth / 2}" y="${y - depth / 1.6 - 10}" text-anchor="middle" font-size="12" font-weight="800" fill="#fff" style="animation-delay:${i * 90 + 260}ms;">${fmt(d.value)}</text>
      <text x="${x + barW / 2}" y="${baseY + depth / 1.6 + 20}" text-anchor="middle" font-size="10.5" fill="rgba(255,255,255,0.65)">${lbl}</text>
    </g>`;
  }).join('');
  const plankX1 = startX - 16, plankX2 = startX + usedW - depth - gap + barW + 16;

  return `<svg width="100%" viewBox="0 0 ${w} ${h}" preserveAspectRatio="xMidYMid meet" data-chart-anim="1">
    <defs>
      <filter id="bar3d-glow-${id}" x="-60%" y="-60%" width="220%" height="220%"><feGaussianBlur stdDeviation="3" result="blur" /><feMerge><feMergeNode in="blur"/><feMergeNode in="SourceGraphic"/></feMerge></filter>
      <linearGradient id="plank-${id}" x1="0" y1="0" x2="0" y2="1"><stop offset="0%" stop-color="rgba(255,255,255,0.14)" /><stop offset="100%" stop-color="rgba(255,255,255,0.03)" /></linearGradient>
    </defs>
    <!-- منصّة القاعدة (isometric) تحت كل الأعمدة، بنفس روح الصورة المرجعية -->
    <polygon class="bar3d-plank" points="${plankX1},${baseY} ${plankX1 + depth},${baseY - depth / 1.6} ${plankX2 + depth},${baseY - depth / 1.6} ${plankX2},${baseY} ${plankX2},${baseY + 10} ${plankX1},${baseY + 10}" fill="url(#plank-${id})" stroke="rgba(255,255,255,0.1)" />
    ${bars}
  </svg>`;
}

let chartIdCounter = 0;
function richLineChart(values, opts = {}) {
  const w = opts.width || 900, h = opts.height || 240, pad = 44;
  const color = opts.color || '#7c5cff';
  const id = 'chart' + (chartIdCounter++);
  let vals = values.length < 2 ? [values[0] || 0, values[0] || 0] : values;
  const min = Math.min(...vals, 0), max = Math.max(...vals, 0), range = (max - min) || 1;
  const stepX = (w - pad * 2) / (vals.length - 1);
  const pts = vals.map((v, i) => [pad + i * stepX, h - pad - ((v - min) / range) * (h - pad * 2)]);

  // مماسّات هرميت مع تسطيح تلقائي عند القمم/القيعان (نقطة تتغيّر فيها الاتجاه): بدل خط بيزييه يمر بقوة عبر القمة فيعطي رأسًا حادًا،
  // نجعل ميل المماس صفرًا عند أي قمة أو قاع محلي فينتج "قبّة" مدوّرة ناعمة بدل الرأس الحاد - وهذا هو المطلوب لمظهر فخم احترافي
  const nPts = pts.length;
  const secantSlopes = [];
  for (let i = 0; i < nPts - 1; i++) {
    const dx = pts[i + 1][0] - pts[i][0];
    secantSlopes.push(dx === 0 ? 0 : (pts[i + 1][1] - pts[i][1]) / dx);
  }
  const tangents = pts.map((p, i) => {
    if (nPts < 2) return 0;
    if (i === 0) return secantSlopes[0];
    if (i === nPts - 1) return secantSlopes[nPts - 2];
    const s0 = secantSlopes[i - 1], s1 = secantSlopes[i];
    if (s0 === 0 || s1 === 0 || (s0 > 0) !== (s1 > 0)) return 0; // قمة أو قاع محلي => مماس أفقي (انحناء مدوّر)
    return (s0 + s1) / 2; // منطقة صاعدة/هابطة متصلة => ميل متوسط ناعم بلا فرط انحناء (overshoot)
  });
  const segs = [];
  for (let i = 0; i < pts.length - 1; i++) {
    const p1 = pts[i], p2 = pts[i + 1];
    const dxThird = (p2[0] - p1[0]) / 3;
    const cp1 = [p1[0] + dxThird, p1[1] + tangents[i] * dxThird];
    const cp2 = [p2[0] - dxThird, p2[1] - tangents[i + 1] * dxThird];
    segs.push({ p1, p2, cp1, cp2 });
  }
  const fullSmoothPath = pts.length < 2 ? '' :
    `M ${pts[0][0]},${pts[0][1]} ` + segs.map(s => `C ${s.cp1[0]},${s.cp1[1]} ${s.cp2[0]},${s.cp2[1]} ${s.p2[0]},${s.p2[1]}`).join(' ');
  const zeroY = h - pad - ((0 - min) / range) * (h - pad * 2);

  // خط واحد متصل دائمًا (يمنع أي فجوة بين الأجزاء) - التلوين حسب الاتجاه يُنفَّذ عبر تدرج بحواف صلبة على نفس الخط
  let strokeRef = color;
  let segGradDefs = '';
  if (opts.segmented && vals.length > 1) {
    const stops = [];
    for (let i = 0; i < vals.length - 1; i++) {
      const segColor = vals[i + 1] >= vals[i] ? '#22d3a8' : '#ef5a6f';
      const o0 = (i / (vals.length - 1) * 100).toFixed(2), o1 = ((i + 1) / (vals.length - 1) * 100).toFixed(2);
      stops.push(`<stop offset="${o0}%" stop-color="${segColor}" /><stop offset="${o1}%" stop-color="${segColor}" />`);
    }
    segGradDefs = `<linearGradient id="seg-${id}" x1="0" y1="0" x2="1" y2="0">${stops.join('')}</linearGradient>`;
    strokeRef = `url(#seg-${id})`;
  }
  const linesSvg = `<path class="chart-draw-path" d="${fullSmoothPath}" fill="none" stroke="${strokeRef}" stroke-width="3" stroke-linecap="round" stroke-linejoin="round" filter="url(#glow-${id})" />`;
  const areaPath = `${fullSmoothPath} L ${pts[pts.length - 1][0]},${zeroY} L ${pts[0][0]},${zeroY} Z`;

  const fmtLabel = opts.labelFmt || fmt;
  const yTicks = 4;
  // إزالة الخطوط الأفقية العرضية وسط المنحنى (لا فائدة منها بصريًا) - يبقى فقط رقم القيمة على الحافة اليسرى
  const yGrid = Array.from({ length: yTicks + 1 }, (_, i) => {
    const v = min + (range * i) / yTicks;
    const y = h - pad - (i / yTicks) * (h - pad * 2);
    return `<text x="${pad - 8}" y="${y + 3}" text-anchor="end" font-size="10.5" fill="rgba(255,255,255,0.5)">${fmtLabel(v)}</text>`;
  }).join('');

  // كل نقطة تحصل على تسمية سينية، لكن الظاهرة دائمًا فقط كل عدة نقاط - الباقي يظهر عند مرور الماوس فقط
  let xLabelsSvg = '';
  if (opts.xLabels && opts.xLabels.length === vals.length) {
    const everyN = Math.max(1, Math.ceil(vals.length / (opts.maxXLabels || 12)));
    xLabelsSvg = pts.map(([x], i) => {
      const alwaysShown = i % everyN === 0 || i === pts.length - 1;
      return `<text id="xlabel-${id}-${i}" class="chart-xlabel${alwaysShown ? ' always-on' : ''}" x="${x}" y="${h - pad + 18}" text-anchor="middle" font-size="10" fill="rgba(255,255,255,0.5)">${opts.xLabels[i]}</text>`;
    }).join('');
  }

  const lastPt = pts[pts.length - 1];

  return `<svg width="100%" viewBox="0 0 ${w} ${h}" preserveAspectRatio="xMidYMid meet" data-chart="${id}" data-chart-anim="1">
    <defs>
      <linearGradient id="grad-${id}" x1="0" y1="0" x2="0" y2="1">
        <stop offset="0%" stop-color="${color}" stop-opacity="0.45" />
        <stop offset="100%" stop-color="${color}" stop-opacity="0" />
      </linearGradient>
      ${segGradDefs}
      <filter id="glow-${id}" x="-50%" y="-50%" width="200%" height="200%">
        <feGaussianBlur stdDeviation="4" result="blur" />
        <feMerge><feMergeNode in="blur"/><feMergeNode in="SourceGraphic"/></feMerge>
      </filter>
    </defs>
    ${yGrid}
    ${xLabelsSvg}
    <line x1="${pad}" y1="${pad - 14}" x2="${pad}" y2="${h - pad + 4}" stroke="rgba(255,255,255,0.1)" />
    ${opts.axisTag ? `<text x="${pad}" y="${pad - 20}" text-anchor="start" font-size="11" font-weight="700" fill="${color}">${opts.axisTag}</text>` : ''}
    <path d="${areaPath}" fill="url(#grad-${id})" />
    ${linesSvg}
    <circle class="chart-ripple" cx="${lastPt[0]}" cy="${lastPt[1]}" r="6" fill="none" stroke="${opts.segmented ? (vals[vals.length - 1] >= vals[vals.length - 2] ? '#22d3a8' : '#ef5a6f') : color}" stroke-width="2" />
    <circle class="chart-ripple chart-ripple-2" cx="${lastPt[0]}" cy="${lastPt[1]}" r="6" fill="none" stroke="${opts.segmented ? (vals[vals.length - 1] >= vals[vals.length - 2] ? '#22d3a8' : '#ef5a6f') : color}" stroke-width="2" />
    ${pts.map(([x, y], i) => {
      const isLast = i === pts.length - 1;
      const dotColor = opts.segmented ? (i === 0 ? color : (vals[i] >= vals[i - 1] ? '#22d3a8' : '#ef5a6f')) : color;
      // فقط النقطة الأخيرة تبقى ظاهرة دائمًا (بحجم أصغر) - بقية نقاط الشهور/السنوات مخفية افتراضيًا (لا تُظهر شكلًا مبهتًا على طول الخط)
      // وتُستعمل فقط كمنطقة تفاعل خفية: تظهر وتنبض بحركة تكبير/تصغير/توهج فقط عند تمرير الماوس عليها
      const r = isLast ? 4.5 : 9;
      return `<circle cx="${x}" cy="${y}" r="${r}" fill="${dotColor}" filter="url(#glow-${id})" class="chart-dot ${isLast ? 'chart-dot-last' : ''}" data-val="${fmtLabel(vals[i]).replace(/"/g, '&quot;')}" data-xlabel-id="xlabel-${id}-${i}" style="animation-delay:${i * 40}ms; color:${dotColor};"/>`;
    }).join('')}
  </svg>`;
}
// أُبقيت هذه الدالة لتوافق الاستدعاءات القديمة، لكنها الآن تُسلّم الرسوم لنظام "حركة الدخول عند الوصول فعليًا للشاشة" بدل تشغيلها فورًا بلا انتظار السكرول
function animateChartDraw(root) {
  observeChartsForEntrance(root);
}

function bindChartTooltips(root) {
  const tip = $('#chartTooltip');
  if (!tip) return;
  $$('.chart-dot', root).forEach(dot => {
    dot.addEventListener('mouseenter', (e) => {
      tip.textContent = dot.dataset.val;
      tip.classList.add('show');
      moveTooltip(e);
      const xlab = document.getElementById(dot.dataset.xlabelId);
      if (xlab) xlab.classList.add('show');
    });
    dot.addEventListener('mousemove', moveTooltip);
    dot.addEventListener('mouseleave', () => {
      tip.classList.remove('show');
      const xlab = document.getElementById(dot.dataset.xlabelId);
      if (xlab) xlab.classList.remove('show');
    });
  });
  function moveTooltip(e) {
    tip.style.left = (e.clientX + 14) + 'px';
    tip.style.top = (e.clientY - 10) + 'px';
  }
}

/* ---------------- صوت خفيف عند تسجيل ربح/خسارة ---------------- */
let sharedAudioCtx = null;
function playTone(kind) {
  try {
    sharedAudioCtx = sharedAudioCtx || new (window.AudioContext || window.webkitAudioContext)();
    const ctx = sharedAudioCtx;
    const osc = ctx.createOscillator(); const gain = ctx.createGain();
    osc.type = 'sine';
    osc.frequency.value = kind === 'positive' ? 820 : 220;
    gain.gain.setValueAtTime(0.001, ctx.currentTime);
    gain.gain.exponentialRampToValueAtTime(0.12, ctx.currentTime + 0.01);
    gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.22);
    osc.connect(gain); gain.connect(ctx.destination);
    osc.start(); osc.stop(ctx.currentTime + 0.24);
  } catch (e) { /* الصوت غير متاح - تجاهل */ }
}
function lineChartSvg(values) {
  const w = 900, h = 220, pad = 30;
  if (values.length < 2) values = [values[0] || 0, values[0] || 0];
  const min = Math.min(...values), max = Math.max(...values), range = (max - min) || 1;
  const stepX = (w - pad * 2) / (values.length - 1);
  const points = values.map((v, i) => `${pad + i * stepX},${h - pad - ((v - min) / range) * (h - pad * 2)}`).join(' ');
  return `<svg width="${w}" height="${h}" viewBox="0 0 ${w} ${h}" data-chart-anim="1"><polyline points="${points}" fill="none" stroke="#7c5cff" stroke-width="2.5" class="glow-line" style="color:#7c5cff" /></svg>`;
}

/* ============================================================
   الرزنامة (منفصلة عن المذكرة)
   ============================================================ */
function renderCalendar() {
  const view = $('#view-calendar');
  const items = DATA.calendarItems.filter(i => !i.deleted && i.kind === 'event').sort((a, b) => (a.date || '').localeCompare(b.date || ''));
  view.innerHTML = `<h2 class="view-title">${label('nav_calendar')}</h2><p class="view-sub">أحداث ومواعيد، مع تذكير يُشعرك على هذا الجهاز فورًا
      <button class="btn ghost sm" id="exportCalBtn" style="margin-inline-start:8px;">📄 تصدير PDF</button></p>
    <details class="collapse-card card inline-form" data-panel="add_calendar_event"${panelOpenAttr('add_calendar_event')}><summary>+ إضافة موعد</summary><div class="form-grid" style="margin-top:10px;">
      <label class="field">العنوان<input type="text" id="cal_title"></label>
      <label class="field">التاريخ<input type="date" id="cal_date" value="${todayISO()}"></label>
      <label class="field">وقت التذكير (اختياري)<input type="datetime-local" id="cal_reminder"></label>
      <label class="field" style="grid-column: span 2;">تفاصيل<textarea class="autogrow" rows="1" id="cal_note"></textarea></label></div>
      <div class="form-actions"><button class="btn" id="cal_save">إضافة</button></div></details>
    <div class="card" style="margin-top:14px;">${items.length === 0 ? '<p class="muted">لا توجد مواعيد بعد</p>' : items.map(i => calRowHtml(i)).join('')}</div>`;
  $('#exportCalBtn').addEventListener('click', async () => {
    const { html, filename } = buildCalendarReportHtml(); toast('جارٍ إنشاء ملف PDF...');
    const res = await Platform.exportPDF(html, filename);
    if (res.ok) toast('تم حفظ التقرير: ' + res.filePath); else if (res.error) toast('تعذّر حفظ التقرير');
  });
  $('#cal_save').addEventListener('click', () => {
    const title = $('#cal_title').value.trim(); if (!title) return toast('أدخل عنوانًا');
    const reminderAt = parseReminderInput($('#cal_reminder').value);
    DATA.calendarItems.push({ id: uid(), kind: 'event', title, date: $('#cal_date').value, note: $('#cal_note').value,
      reminderAt, notifiedAt: null, deleted: false });
    persist(true); renderCalendar();
    if (reminderAt) toast('⏰ التذكير مضبوط على: ' + new Date(reminderAt).toLocaleString('ar-DZ'));
  });
  bindCalendarEvents(view, () => renderCalendar(), 'event');
  bindPanelToggles(view);
}
function renderNotes() {
  const view = $('#view-notes');
  const items = DATA.calendarItems.filter(i => !i.deleted && i.kind === 'note').sort((a, b) => (b.date || '').localeCompare(a.date || ''));
  view.innerHTML = `<h2 class="view-title">${label('nav_notes')}</h2><p class="view-sub">ملاحظاتك، مع إمكانية ربط تذكير أيضًا
      <button class="btn ghost sm" id="exportNotesBtn" style="margin-inline-start:8px;">📄 تصدير PDF</button></p>
    <details class="collapse-card card inline-form" data-panel="add_note"${panelOpenAttr('add_note')}><summary>+ إضافة ملاحظة</summary><div class="form-grid" style="margin-top:10px;">
      <label class="field">العنوان<input type="text" id="note_title"></label>
      <label class="field">التاريخ<input type="date" id="note_date" value="${todayISO()}"></label>
      <label class="field">وقت التذكير (اختياري)<input type="datetime-local" id="note_reminder"></label>
      <label class="field" style="grid-column: span 2;">التفاصيل<textarea class="autogrow" rows="1" id="note_note"></textarea></label></div>
      <div class="form-actions"><button class="btn" id="note_save">إضافة</button></div></details>
    <div class="card" style="margin-top:14px;">${items.length === 0 ? '<p class="muted">لا توجد ملاحظات بعد</p>' : items.map(i => calRowHtml(i)).join('')}</div>`;
  $('#exportNotesBtn').addEventListener('click', async () => {
    const { html, filename } = buildNotesReportHtml(); toast('جارٍ إنشاء ملف PDF...');
    const res = await Platform.exportPDF(html, filename);
    if (res.ok) toast('تم حفظ التقرير: ' + res.filePath); else if (res.error) toast('تعذّر حفظ التقرير');
  });
  $('#note_save').addEventListener('click', () => {
    const title = $('#note_title').value.trim(); if (!title) return toast('أدخل عنوانًا');
    const reminderAt = parseReminderInput($('#note_reminder').value);
    DATA.calendarItems.push({ id: uid(), kind: 'note', title, date: $('#note_date').value, note: $('#note_note').value,
      reminderAt, notifiedAt: null, deleted: false });
    persist(true); renderNotes();
    if (reminderAt) toast('⏰ التذكير مضبوط على: ' + new Date(reminderAt).toLocaleString('ar-DZ'));
  });
  bindCalendarEvents(view, () => renderNotes(), 'note');
  bindPanelToggles(view);
}
function parseReminderInput(val) {
  if (!val) return null;
  const [datePart, timePart] = val.split('T');
  const [Y, Mo, D] = datePart.split('-').map(Number);
  const [H, Mi] = timePart.split(':').map(Number);
  return new Date(Y, Mo - 1, D, H, Mi, 0, 0).getTime(); // يبني الوقت بالتوقيت المحلي صراحة، يمنع أي لبس UTC
}
function msToLocalDatetimeInput(ms) {
  if (!ms) return '';
  const d = new Date(ms);
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}T${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
}
// يحسب موعد التذكير الدوري التالي انطلاقًا من الموعد السابق نفسه (فيحافظ على نفس يوم الأسبوع/الشهر والساعة التي اختارها المستخدم أول مرة)
const RECURRENCE_LABELS = { daily: 'يوميًا', weekly: 'أسبوعيًا', monthly: 'شهريًا', quarterly: 'كل فصل (3 أشهر)', yearly: 'سنويًا', once: 'مرة واحدة' };
function computeNextOccurrence(fromMs, recurrence) {
  const d = new Date(fromMs);
  switch (recurrence) {
    case 'daily': d.setDate(d.getDate() + 1); return d.getTime();
    case 'weekly': d.setDate(d.getDate() + 7); return d.getTime();
    case 'monthly': d.setMonth(d.getMonth() + 1); return d.getTime();
    case 'quarterly': d.setMonth(d.getMonth() + 3); return d.getTime();
    case 'yearly': d.setFullYear(d.getFullYear() + 1); return d.getTime();
    default: return null; // 'once' - لا يتكرر
  }
}
function calRowHtml(i) {
  if (editingCalId === i.id) {
    if (i.apptId) {
      return `<div class="list-row" data-focus="cal:${i.id}" style="gap:8px; flex-wrap:wrap;">
        <span class="muted" style="font-size:11.5px;">🔗 مرتبط بموعد — العنوان والتاريخ يُعدَّلان من "المواعيد" (داخل التخطيط والتسعير). التذكير قابل للتعديل هنا مباشرة.</span>
        <input type="datetime-local" data-cf="reminder" value="${msToLocalDatetimeInput(i.reminderAt)}" style="width:190px;" title="وقت التذكير">
        <textarea class="autogrow" rows="1" data-cf="note" placeholder="تفاصيل" style="flex:1; min-width:120px;">${escHtml(i.note || '')}</textarea>
        <button class="btn sm" data-savecal="${i.id}">حفظ</button><button class="btn ghost sm" data-cancelcal="${i.id}">إلغاء</button></div>`;
    }
    return `<div class="list-row" data-focus="cal:${i.id}" style="gap:8px; flex-wrap:wrap;">
      <input type="text" data-cf="title" value="${(i.title || '').replace(/"/g, '&quot;')}" style="flex:1; min-width:120px;">
      <input type="date" data-cf="date" value="${i.date}" style="width:130px;">
      <input type="datetime-local" data-cf="reminder" value="${msToLocalDatetimeInput(i.reminderAt)}" style="width:190px;" title="وقت التذكير">
      <textarea class="autogrow" rows="1" data-cf="note" placeholder="تفاصيل" style="flex:1; min-width:120px;">${escHtml(i.note || '')}</textarea>
      <button class="btn sm" data-savecal="${i.id}">حفظ</button><button class="btn ghost sm" data-cancelcal="${i.id}">إلغاء</button></div>`;
  }
  return `<div class="list-row" data-focus="cal:${i.id}"><span>${i.kind === 'event' ? '📅' : '📝'} ${i.title} <span class="muted">· ${i.date}</span>${i.apptId ? ' <span class="muted" style="font-size:10px;">🔗 موعد</span>' : ''}${notePreviewHtml(i.note, '🗒️')}</span>
    <span>${i.reminderAt ? '⏰ ' + new Date(i.reminderAt).toLocaleString('ar-DZ') : ''}
      <button class="btn ghost sm" data-editcal="${i.id}" style="margin-inline-start:8px;">تعديل</button>
      <button class="btn ghost sm" data-caldel="${i.id}">حذف</button></span></div>`;
}
function bindCalendarEvents(view, rerender) {
  $$('[data-editcal]', view).forEach(el => el.addEventListener('click', () => { editingCalId = el.dataset.editcal; rerender(); }));
  $$('[data-cancelcal]', view).forEach(el => el.addEventListener('click', () => { editingCalId = null; rerender(); }));
  $$('[data-caldel]', view).forEach(el => el.addEventListener('click', () => {
    const item = DATA.calendarItems.find(i => i.id === el.dataset.caldel); if (!item) return;
    item.deleted = true; item.updatedAt = Date.now();
    if (item.apptId) { const a = DATA.appointments.find(x => x.id === item.apptId); if (a) { a.deleted = true; a.updatedAt = Date.now(); } } // حذف الموعد المرتبط تلقائيًا
    persist(true); rerender();
  }));
  $$('[data-savecal]', view).forEach(el => el.addEventListener('click', () => {
    const i = DATA.calendarItems.find(x => x.id === el.dataset.savecal); const row = el.closest('.list-row');
    if (!i.apptId) { i.title = row.querySelector('[data-cf="title"]').value || i.title; i.date = row.querySelector('[data-cf="date"]').value || i.date; }
    i.note = row.querySelector('[data-cf="note"]').value;
    const reminderVal = row.querySelector('[data-cf="reminder"]').value;
    const newReminderAt = parseReminderInput(reminderVal);
    if (newReminderAt !== i.reminderAt) { i.reminderAt = newReminderAt; i.notifiedAt = null; } // تغيير الوقت يعيد تفعيل التذكير
    editingCalId = null; persist(true); rerender();
  }));
}

/* ==================== التخطيط والتسعير (v2) ==================== */
let editingPlanId = null, loggingPlanId = null, editingPriceItemId = null, editingAddonId = null, editingPresetId = null;
let planningTab = 'plans';

function renderPlanning() {
  const view = $('#view-planning');
  view.innerHTML = `<h2 class="view-title">${label('nav_planning')}</h2>
    <p class="view-sub">خططك وأهدافك الدورية، جدولك المتكرر (يومي/أسبوعي/فصلي/سنوي)، مواعيدك، وحاسبة تسعير مشاريعك
      <button class="btn ghost sm" id="exportPlanningBtn" style="margin-inline-start:8px;">📄 تصدير PDF</button></p>
    <div class="segmented" id="planningTabSwitch">
      <button data-tab="plans" class="${planningTab === 'plans' ? 'active' : ''}">🗓️ تخطيط وأهداف</button>
      <button data-tab="schedule" class="${planningTab === 'schedule' ? 'active' : ''}">📅 جدولي</button>
      <button data-tab="appointments" class="${planningTab === 'appointments' ? 'active' : ''}">🕐 المواعيد</button>
      <button data-tab="pricing" class="${planningTab === 'pricing' ? 'active' : ''}">💵 تسعير</button>
    </div>
    <div id="planningTabHost" style="margin-top:14px;"></div>`;
  $('#exportPlanningBtn').addEventListener('click', async () => {
    const { html, filename } = planningTab === 'pricing' ? buildPricingReportHtml() : planningTab === 'schedule' ? buildScheduleReportHtml() : planningTab === 'appointments' ? buildAppointmentsReportHtml() : buildPlansReportHtml();
    toast('جارٍ إنشاء ملف PDF...');
    const res = await Platform.exportPDF(html, filename);
    if (res.ok) toast('تم حفظ التقرير: ' + res.filePath); else if (res.error) toast('تعذّر حفظ التقرير');
  });
  $('#planningTabSwitch').addEventListener('click', (e) => {
    const b = e.target.closest('button[data-tab]'); if (!b) return;
    planningTab = b.dataset.tab; renderPlanning();
  });
  const host = $('#planningTabHost');
  if (planningTab === 'plans') renderPlansInto(host);
  else if (planningTab === 'schedule') renderScheduleInto(host);
  else if (planningTab === 'appointments') renderAppointmentsInto(host);
  else renderPricingInto(host);
}

/* ---------- تبويب: تخطيط وأهداف ---------- */
function renderPlansInto(host) {
  const plans = DATA.plans.filter(p => !p.deleted).sort((a, b) => (a.nextReminderAt || 0) - (b.nextReminderAt || 0));
  host.innerHTML = `<details class="collapse-card card inline-form" data-panel="add_plan"${panelOpenAttr('add_plan')}><summary>+ إضافة خطة/هدف</summary>
      <div class="form-grid" style="margin-top:10px;">
        <label class="field">العنوان<input type="text" id="plan_title" placeholder="مثال: مراجعة أهداف الشهر"></label>
        <label class="field">النوع<select id="plan_kind"><option value="routine">خطة/برنامج متكرر</option><option value="goal">هدف بمتابعة دورية</option></select></label>
        <label class="field">التكرار<select id="plan_recurrence">
          <option value="daily">يوميًا</option><option value="weekly">أسبوعيًا</option><option value="monthly" selected>شهريًا</option>
          <option value="quarterly">كل فصل (3 أشهر)</option><option value="yearly">سنويًا</option><option value="once">مرة واحدة بلا تكرار</option></select></label>
        <label class="field">أول موعد تذكير<input type="datetime-local" id="plan_start"></label>
        <label class="field" style="grid-column:span 2;">تفاصيل / وصف الخطة أو الهدف<textarea class="autogrow" rows="1" id="plan_notes"></textarea></label>
      </div>
      <div class="form-actions"><button class="btn" id="addPlanBtn">إضافة</button></div>
    </details>
    <div class="card" style="margin-top:14px;">${plans.length === 0 ? '<p class="muted">لا توجد خطط أو أهداف بعد</p>' : plans.map(p => planRowHtml(p)).join('')}</div>`;
  bindPlansEvents(host);
  bindPanelToggles(host);
}
function planRowHtml(p) {
  if (editingPlanId === p.id) {
    return `<div class="list-row" data-focus="plan:${p.id}" style="flex-direction:column; align-items:stretch; gap:8px;">
      <div class="form-grid">
        <input type="text" data-pf="title" value="${(p.title || '').replace(/"/g, '&quot;')}">
        <select data-pf="kind"><option value="routine" ${p.kind === 'routine' ? 'selected' : ''}>خطة/برنامج متكرر</option><option value="goal" ${p.kind === 'goal' ? 'selected' : ''}>هدف بمتابعة دورية</option></select>
        <select data-pf="recurrence">${Object.entries(RECURRENCE_LABELS).map(([k, v]) => `<option value="${k}" ${p.recurrence === k ? 'selected' : ''}>${v}</option>`).join('')}</select>
        <input type="datetime-local" data-pf="nextReminderAt" value="${msToLocalDatetimeInput(p.nextReminderAt)}">
        <textarea class="autogrow" rows="1" data-pf="notes" style="grid-column:span 2;">${escHtml(p.notes || '')}</textarea>
      </div>
      <div class="form-actions"><button class="btn sm" data-saveplan="${p.id}">حفظ</button><button class="btn ghost sm" data-cancelplan>إلغاء</button></div>
    </div>`;
  }
  const logForm = loggingPlanId === p.id ? `<div class="form-actions" style="margin-top:8px;">
      <input type="text" id="planLogNote_${p.id}" placeholder="أين وصلت؟ ماذا تحقق أو تعثّر؟" style="flex:1;">
      <button class="btn sm" data-confirmlog="${p.id}">حفظ التقدّم</button><button class="btn ghost sm" data-cancellog="${p.id}">إلغاء</button></div>` : '';
  const lastLog = p.progressLog && p.progressLog.length ? p.progressLog[p.progressLog.length - 1] : null;
  return `<div class="debt-entry" data-focus="plan:${p.id}">
    <div class="prow-head"><span><button class="flag-btn ${p.flagged ? 'flagged' : ''}" data-flagplan="${p.id}" title="تعليم كمهم">★</button>
      <span class="pill" style="background:${p.kind === 'goal' ? 'rgba(197,125,255,.15)' : 'rgba(79,124,255,.15)'}; color:${p.kind === 'goal' ? '#c77dff' : 'var(--accent, #4f7cff)'};">${p.kind === 'goal' ? '🎯 هدف' : '🔁 خطة متكررة'} · ${RECURRENCE_LABELS[p.recurrence] || p.recurrence}</span>
      ${p.status === 'archived' ? '<span class="muted" style="font-size:11px; margin-inline-start:6px;">(مؤرشفة)</span>' : ''}</span></div>
    <div style="font-weight:600; margin-top:4px;">${p.title}</div>
    ${p.notes ? `<div class="muted" style="font-size:12px; margin-top:2px;">${p.notes}</div>` : ''}
    <div class="muted" style="font-size:11px; margin-top:6px;">⏰ الموعد القادم: ${p.nextReminderAt ? new Date(p.nextReminderAt).toLocaleString('ar-DZ') : '—'}</div>
    ${lastLog ? `<div class="muted" style="font-size:11px; margin-top:4px;">📝 آخر تحديث (${new Date(lastLog.date).toLocaleDateString('ar-DZ')}): ${lastLog.note}</div>` : ''}
    <div class="form-actions" style="margin-top:8px;">
      <button class="btn ghost sm" data-logplan="${p.id}">تسجيل تقدّم</button>
      <button class="btn ghost sm" data-editplan="${p.id}">تعديل</button>
      <button class="btn ghost sm" data-archiveplan="${p.id}">${p.status === 'archived' ? 'إعادة تفعيل' : 'أرشفة'}</button>
      <button class="btn ghost sm" data-delplan="${p.id}">حذف</button>
    </div>
    ${logForm}
  </div>`;
}
function bindPlansEvents(host) {
  $('#addPlanBtn', host).addEventListener('click', () => {
    const title = $('#plan_title', host).value.trim(); if (!title) return toast('أدخل عنوانًا');
    const kind = $('#plan_kind', host).value, recurrence = $('#plan_recurrence', host).value;
    const startVal = $('#plan_start', host).value;
    const nextReminderAt = startVal ? parseReminderInput(startVal) : Date.now();
    DATA.plans.push({ id: uid(), kind, title, recurrence, notes: $('#plan_notes', host).value, progressLog: [],
      nextReminderAt, notifiedAt: null, status: 'active', flagged: false, createdAt: Date.now(), updatedAt: Date.now(), deleted: false });
    persist(true); renderPlansInto(host);
  });
  $$('[data-flagplan]', host).forEach(el => el.addEventListener('click', () => { const p = DATA.plans.find(x => x.id === el.dataset.flagplan); if (p) { p.flagged = !p.flagged; persist(true); renderPlansInto(host); } }));
  $$('[data-editplan]', host).forEach(el => el.addEventListener('click', () => { editingPlanId = el.dataset.editplan; renderPlansInto(host); }));
  $$('[data-cancelplan]', host).forEach(el => el.addEventListener('click', () => { editingPlanId = null; renderPlansInto(host); }));
  $$('[data-delplan]', host).forEach(el => el.addEventListener('click', () => { const p = DATA.plans.find(x => x.id === el.dataset.delplan); if (p) { p.deleted = true; p.updatedAt = Date.now(); persist(true); renderPlansInto(host); } }));
  $$('[data-archiveplan]', host).forEach(el => el.addEventListener('click', () => { const p = DATA.plans.find(x => x.id === el.dataset.archiveplan); if (p) { p.status = p.status === 'archived' ? 'active' : 'archived'; persist(true); renderPlansInto(host); } }));
  $$('[data-logplan]', host).forEach(el => el.addEventListener('click', () => { loggingPlanId = el.dataset.logplan; renderPlansInto(host); }));
  $$('[data-cancellog]', host).forEach(el => el.addEventListener('click', () => { loggingPlanId = null; renderPlansInto(host); }));
  $$('[data-confirmlog]', host).forEach(el => el.addEventListener('click', () => {
    const p = DATA.plans.find(x => x.id === el.dataset.confirmlog); if (!p) return;
    const noteEl = $(`#planLogNote_${p.id}`); const note = noteEl ? noteEl.value.trim() : '';
    if (!note) return toast('اكتب تحديثًا ولو قصيرًا');
    p.progressLog = p.progressLog || []; p.progressLog.push({ date: Date.now(), note });
    const next = computeNextOccurrence(p.nextReminderAt || Date.now(), p.recurrence);
    p.nextReminderAt = next; p.notifiedAt = null; p.updatedAt = Date.now();
    if (!next) p.status = 'archived'; // "مرة واحدة" تُؤرشَف تلقائيًا بعد تسجيل تقدّمها لأنها انتهت
    loggingPlanId = null; persist(true); renderPlansInto(host);
  }));
  $$('[data-saveplan]', host).forEach(el => el.addEventListener('click', () => {
    const p = DATA.plans.find(x => x.id === el.dataset.saveplan); const row = el.closest('.list-row');
    const title = row.querySelector('[data-pf="title"]').value.trim(); if (title) p.title = title;
    p.kind = row.querySelector('[data-pf="kind"]').value;
    p.recurrence = row.querySelector('[data-pf="recurrence"]').value;
    const newAt = parseReminderInput(row.querySelector('[data-pf="nextReminderAt"]').value);
    if (newAt !== p.nextReminderAt) { p.nextReminderAt = newAt; p.notifiedAt = null; }
    p.notes = row.querySelector('[data-pf="notes"]').value; p.updatedAt = Date.now();
    editingPlanId = null; persist(true); renderPlansInto(host);
  }));
}

/* ---------- تبويب: جدولي المتكرر (يومي / أسبوعي / فصلي / سنوي) ---------- */
const SCHEDULE_DAY_NAMES = ['الأحد', 'الاثنين', 'الثلاثاء', 'الأربعاء', 'الخميس', 'الجمعة', 'السبت'];
const SCHEDULE_MODES_CFG = {
  daily:     { label: 'يومي',  icon: '☀️', flat: true,  hasTime: true, store: () => DATA.dailySchedule },
  weekly:    { label: 'أسبوعي', icon: '📅', flat: false, hasTime: true,
               buckets: () => [0, 1, 2, 3, 4, 5, 6], bucketLabel: i => SCHEDULE_DAY_NAMES[i] + (i === new Date().getDay() ? ' (اليوم)' : ''),
               store: () => DATA.weeklySchedule },
  quarterly: { label: 'فصلي',  icon: '📆', flat: false, hasTime: false,
               buckets: () => [1, 2, 3, 4], bucketLabel: i => `الفصل ${i}`, store: () => DATA.quarterlySchedule },
  yearly:    { label: 'سنوي',  icon: '🗓️', flat: false, hasTime: false,
               buckets: () => [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12], bucketLabel: i => MONTH_NAMES[i - 1], store: () => DATA.yearlySchedule },
};
function enabledScheduleModes() {
  const en = DATA.settings.scheduleModesEnabled || {};
  return Object.keys(SCHEDULE_MODES_CFG).filter(k => en[k] !== false);
}
let scheduleActiveMode = 'weekly';
let scheduleActiveBucket = { daily: 0, weekly: new Date().getDay(), quarterly: Math.floor(new Date().getMonth() / 3) + 1, yearly: new Date().getMonth() + 1 };
let editingScheduleBlockId = null;
function renderScheduleInto(host) {
  const modes = enabledScheduleModes();
  if (!modes.includes(scheduleActiveMode)) scheduleActiveMode = modes[0] || 'weekly';
  const cfg = SCHEDULE_MODES_CFG[scheduleActiveMode];
  host.innerHTML = `<div class="card">
      <div style="display:flex; justify-content:space-between; align-items:center; flex-wrap:wrap; gap:10px;">
        <strong>📅 جدولك المتكرر</strong>
        ${modes.length > 1 ? `<div class="segmented" id="scheduleModeSwitch">${modes.map(k => `<button data-mode="${k}" class="${scheduleActiveMode === k ? 'active' : ''}">${SCHEDULE_MODES_CFG[k].icon} ${SCHEDULE_MODES_CFG[k].label}</button>`).join('')}</div>` : ''}
      </div>
      <p class="muted" style="font-size:12px; margin-top:4px;">اضبطه مرة واحدة، ويتكرر تلقائيًا بلا حاجة لإعادة الإدخال. عدّل أي عنصر وقتما تحب — التعديل يسري من الآن فصاعدًا.
        ${modes.length < Object.keys(SCHEDULE_MODES_CFG).length ? ' يمكنك إظهار/إخفاء أنواع الجدول الأخرى من الإعدادات.' : ''}</p>
      ${cfg.flat ? '' : `<div class="segmented" id="scheduleBucketSwitch" style="margin-top:10px; flex-wrap:wrap;">
        ${cfg.buckets().map(i => `<button data-bucket="${i}" class="${scheduleActiveBucket[scheduleActiveMode] === i ? 'active' : ''}">${cfg.bucketLabel(i)}</button>`).join('')}
      </div>`}
      <div id="scheduleDayHost" style="margin-top:14px;"></div>
    </div>
    <div class="card" data-focus="sched-notify" style="margin-top:14px;">
      <strong>🔔 تذكير جدول اليوم</strong>
      <p class="muted" style="font-size:12px; margin-top:4px;">
        هذا إعداد واحد مشترك (تفعيل + توقيت) يُطبَّق على كل أنواع الجدول الأربعة معًا — وليس لكل نوع توقيته الخاص.
        كل نوع يُنبّهك حسب دورته الطبيعية بعد هذا التوقيت: <b>اليومي</b> و<b>الأسبوعي</b> كل يوم، <b>الفصلي</b> فقط عند دخول فصل جديد (كل 3 أشهر)،
        و<b>السنوي</b> فقط عند دخول شهره من كل عام. اضغط على أي تذكير في جرس الإشعارات ليأخذك مباشرة إلى نفس ذلك القسم.
      </p>
      <div class="form-grid" style="margin-top:8px;">
        <label class="field">مفعّل؟<select id="sched_notify_enabled"><option value="1" ${DATA.settings.scheduleReminderEnabled ? 'selected' : ''}>نعم</option><option value="0" ${!DATA.settings.scheduleReminderEnabled ? 'selected' : ''}>لا</option></select></label>
        <label class="field">وقت التنبيه اليومي<input type="time" id="sched_notify_time" value="${DATA.settings.scheduleReminderTime}"></label>
      </div>
      <div class="form-actions"><button class="btn sm" id="saveScheduleSettingsBtn">حفظ</button></div>
    </div>`;
  renderScheduleBucket(host);
  $('#scheduleModeSwitch', host)?.addEventListener('click', (e) => { const b = e.target.closest('button[data-mode]'); if (!b) return; scheduleActiveMode = b.dataset.mode; editingScheduleBlockId = null; renderScheduleInto(host); });
  $('#scheduleBucketSwitch', host)?.addEventListener('click', (e) => { const b = e.target.closest('button[data-bucket]'); if (!b) return; scheduleActiveBucket[scheduleActiveMode] = parseInt(b.dataset.bucket); editingScheduleBlockId = null; renderScheduleInto(host); });
  $('#saveScheduleSettingsBtn', host).addEventListener('click', () => {
    DATA.settings.scheduleReminderEnabled = $('#sched_notify_enabled', host).value === '1';
    DATA.settings.scheduleReminderTime = $('#sched_notify_time', host).value || '08:00';
    persist(true); toast('تم الحفظ');
  });
}
function currentScheduleBucketArray() {
  const cfg = SCHEDULE_MODES_CFG[scheduleActiveMode];
  const store = cfg.store();
  if (cfg.flat) return store;
  const key = scheduleActiveBucket[scheduleActiveMode];
  if (!store[key]) store[key] = [];
  return store[key];
}
function renderScheduleBucket(host) {
  const dayHost = $('#scheduleDayHost', host);
  const cfg = SCHEDULE_MODES_CFG[scheduleActiveMode];
  const blocks = currentScheduleBucketArray().filter(b => !b.deleted).slice().sort((a, b) => cfg.hasTime ? (a.from || '').localeCompare(b.from || '') : 0);
  dayHost.innerHTML = `
    ${blocks.length === 0 ? '<p class="muted" style="font-size:12px;">لا توجد عناصر بعد</p>' : blocks.map(b => scheduleBlockRowHtml(b, cfg.hasTime)).join('')}
    <details class="collapse-card" data-panel="add_schedule_block_${scheduleActiveMode}"${panelOpenAttr('add_schedule_block_' + scheduleActiveMode)} style="margin-top:10px;"><summary>+ إضافة ${cfg.hasTime ? 'مهمة' : 'عنصر'}</summary>
    <div class="form-grid" style="margin-top:10px;">
      ${cfg.hasTime ? `<input type="time" id="blk_from"><input type="time" id="blk_to">` : ''}
      <input type="text" id="blk_title" placeholder="${cfg.hasTime ? 'المهمة (مثال: مونتاج، استراحة، فيلم...)' : 'العنصر (مثال: مراجعة الأهداف الفصلية)'}" style="grid-column:span 2;">
      <label class="field" style="grid-column:span 2; flex-direction:row; align-items:center; gap:8px;"><input type="checkbox" id="blk_movable" checked style="width:auto;"> قابل للتحريك (عدّل الحالة لو هذا وقت ثابت لا يتغيّر أبدًا، مثل الصلاة أو النوم)</label>
    </div>
    <div class="form-actions"><button class="btn sm" id="addScheduleBlockBtn">إضافة</button></div></details>`;
  bindPanelToggles(dayHost);
  $('#addScheduleBlockBtn', dayHost).addEventListener('click', () => {
    const title = $('#blk_title', dayHost).value.trim();
    const from = cfg.hasTime ? $('#blk_from', dayHost).value : '';
    const to = cfg.hasTime ? $('#blk_to', dayHost).value : '';
    const movable = $('#blk_movable', dayHost).checked;
    if (cfg.hasTime && !from) return toast('أدخل الوقت والمهمة على الأقل');
    if (!title) return toast('أدخل عنوانًا على الأقل');
    currentScheduleBucketArray().push({ id: uid(), from, to: to || from, title, movable, createdAt: Date.now(), updatedAt: Date.now(), deleted: false });
    persist(true); renderScheduleBucket(host);
    if (scheduleActiveMode === 'weekly' && from) checkScheduleAppointmentConflict(scheduleActiveBucket.weekly, from, to || from, title);
  });
  $$('[data-delblock]', dayHost).forEach(el => el.addEventListener('click', () => {
    const arr = currentScheduleBucketArray();
    const b = arr.find(x => x.id === el.dataset.delblock);
    if (b) { b.deleted = true; b.updatedAt = Date.now(); } // حذف ناعم (علامة) بدل إزالة فعلية، عشان يتزامن الحذف صح مع الجهاز الثاني
    persist(true); renderScheduleBucket(host);
  }));
  $$('[data-editblock]', dayHost).forEach(el => el.addEventListener('click', () => { editingScheduleBlockId = el.dataset.editblock; renderScheduleBucket(host); }));
  $$('[data-cancelblock]', dayHost).forEach(el => el.addEventListener('click', () => { editingScheduleBlockId = null; renderScheduleBucket(host); }));
  $$('[data-saveblock]', dayHost).forEach(el => el.addEventListener('click', () => {
    const b = currentScheduleBucketArray().find(x => x.id === el.dataset.saveblock); if (!b) return;
    const row = el.closest('.list-row');
    const title = row.querySelector('[data-bf="title"]').value.trim();
    if (!title) return toast('أدخل عنوانًا');
    b.title = title;
    if (cfg.hasTime) { b.from = row.querySelector('[data-bf="from"]').value || b.from; b.to = row.querySelector('[data-bf="to"]').value || b.from; }
    b.movable = row.querySelector('[data-bf="movable"]').checked;
    b.updatedAt = Date.now();
    editingScheduleBlockId = null; persist(true); renderScheduleBucket(host);
    if (scheduleActiveMode === 'weekly' && b.from) checkScheduleAppointmentConflict(scheduleActiveBucket.weekly, b.from, b.to, b.title);
  }));
}
// عند إضافة/تعديل عنصر بالجدول الأسبوعي، ننبّه لو فيه موعد محجوز مستقبلًا بنفس اليوم/الوقت — بدون منع الحفظ، فقط تنبيه لحل التعارض يدويًا
function checkScheduleAppointmentConflict(weekday, from, to, blockTitle) {
  const today = todayISO();
  const conflict = DATA.appointments.find(a => !a.deleted && a.date >= today && new Date(a.date + 'T00:00:00').getDay() === weekday && timeRangesOverlap(from, to, a.startTime, a.endTime));
  if (conflict) toast(`⚠️ تعارض: لديك موعد "${apptTitle(conflict)}" يوم ${conflict.date} بين ${conflict.startTime}–${conflict.endTime} — راجعه`);
}
function scheduleBlockRowHtml(b, hasTime) {
  if (editingScheduleBlockId === b.id) {
    return `<div class="list-row" style="flex-wrap:wrap; gap:8px;">
      <div class="form-grid" style="grid-template-columns:${hasTime ? '1fr 1fr 2fr' : '1fr'}; flex:1;">
        ${hasTime ? `<input type="time" data-bf="from" value="${b.from || ''}"><input type="time" data-bf="to" value="${b.to || ''}">` : ''}
        <input type="text" data-bf="title" value="${escHtml(b.title)}">
        <label class="field" style="grid-column:span ${hasTime ? 3 : 1}; flex-direction:row; align-items:center; gap:8px;"><input type="checkbox" data-bf="movable" ${b.movable === false ? '' : 'checked'} style="width:auto;"> قابل للتحريك</label>
      </div>
      <span style="white-space:nowrap;"><button class="btn sm" data-saveblock="${b.id}">حفظ</button><button class="btn ghost sm" data-cancelblock="${b.id}">إلغاء</button></span>
    </div>`;
  }
  return `<div class="list-row"><span>${hasTime ? `⏰ ${b.from}${b.to && b.to !== b.from ? '–' + b.to : ''} — ` : '• '}<b>${escHtml(b.title)}</b> ${b.movable === false ? '<span class="badge-fixed" title="وقت ثابت — لا يُقترح تحريكه تلقائيًا">🔒 ثابت</span>' : ''}</span>
    <span><button class="btn ghost sm" data-editblock="${b.id}">تعديل</button><button class="btn ghost sm" data-delblock="${b.id}">حذف</button></span></div>`;
}
function buildScheduleReportHtml() {
  const body = enabledScheduleModes().map(modeKey => {
    const cfg = SCHEDULE_MODES_CFG[modeKey];
    if (cfg.flat) {
      const blocks = (cfg.store() || []).filter(b => !b.deleted).slice().sort((a, b) => (a.from || '').localeCompare(b.from || ''));
      const rows = blocks.map(b => `<tr><td>${b.from || ''}${b.to && b.to !== b.from ? '–' + b.to : ''}</td><td>${b.title}</td></tr>`).join('');
      return `<h2>${cfg.icon} ${cfg.label}</h2>${blocks.length ? `<table><tr><th>الوقت</th><th>المهمة</th></tr>${rows}</table>` : '<p style="color:#888;">لا توجد عناصر</p>'}`;
    }
    const sections = cfg.buckets().map(i => {
      const blocks = (cfg.store()[i] || []).filter(b => !b.deleted).slice().sort((a, b) => cfg.hasTime ? (a.from || '').localeCompare(b.from || '') : 0);
      const rows = cfg.hasTime
        ? blocks.map(b => `<tr><td>${b.from}${b.to && b.to !== b.from ? '–' + b.to : ''}</td><td>${b.title}</td></tr>`).join('')
        : blocks.map(b => `<tr><td>${b.title}</td></tr>`).join('');
      return `<h3>${cfg.bucketLabel(i)}</h3>${blocks.length ? `<table>${cfg.hasTime ? '<tr><th>الوقت</th><th>المهمة</th></tr>' : ''}${rows}</table>` : '<p style="color:#888;">لا توجد عناصر</p>'}`;
    }).join('');
    return `<h2>${cfg.icon} ${cfg.label}</h2>${sections}`;
  }).join('');
  return { html: reportPageHtml('جدولي — RD Flow', body), filename: 'جدولي.pdf' };
}

/* ==================== قسم: المواعيد (ضمن التخطيط والتسعير) — حجز مواعيد لأي نوع خدمة/مهنة يضيفها المستخدم بحرية ====================
   المصدر الوحيد للحقيقة لـ"مشغول/فاضي" هو نفس "جدولي" (اليومي + الأسبوعي) — أي عنصر فيه يُحسب مشغولاً عند اقتراح الأوقات،
   والمواعيد طبقة فوقه فقط. كل عنصر بجدولي له علامة "قابل للتحريك" أو "ثابت" تُستخدم عند اكتشاف أي تعارض.
   كل موعد يُربط تلقائيًا بعنصر في "الرزنامة" (نفس مبدأ الربط أحادي المصدر المستعمل بقية التطبيق): حذف/تعديل التاريخ أو التذكير
   من أي من الجهتين ينعكس في الأخرى فورًا. */
const WEEKDAY_NAMES_FULL = ['الأحد', 'الاثنين', 'الثلاثاء', 'الأربعاء', 'الخميس', 'الجمعة', 'السبت'];
function timeToMin(t) { if (!t) return null; const [h, m] = t.split(':').map(Number); return h * 60 + m; }
function minToTime(min) { min = ((min % 1440) + 1440) % 1440; return `${pad2(Math.floor(min / 60))}:${pad2(min % 60)}`; }
function timeRangesOverlap(s1, e1, s2, e2) { const a1 = timeToMin(s1), b1 = timeToMin(e1), a2 = timeToMin(s2), b2 = timeToMin(e2); if (a1 == null || b1 == null || a2 == null || b2 == null) return false; return a1 < b2 && a2 < b1; }
function apptServiceName(a) { if (a.customTitle) return a.customTitle; const st = DATA.serviceTypes.find(s => s.id === a.serviceTypeId); return st ? st.name : 'موعد'; }
function apptTitle(a) { return `${apptServiceName(a)}${a.clientName ? ' — ' + a.clientName : ''}`; }
function apptLinkedCalItem(a) { return a.calendarItemId ? DATA.calendarItems.find(c => c.id === a.calendarItemId && !c.deleted) : null; }
// يُنشئ/يُحدّث عنصر رزنامة مرتبط بهذا الموعد (العنوان/التاريخ/الملاحظة) — مصدر الحقيقة لوقت التذكير نفسه هو هذا العنصر، فلا يوجد تكرار أو تعارض بين نسختين
function syncApptCalendarItem(appt) {
  let cal = apptLinkedCalItem(appt);
  const title = apptTitle(appt);
  const note = `موعد: ${apptServiceName(appt)}${appt.clientName ? ' — ' + appt.clientName : ''} (${appt.startTime}–${appt.endTime})`;
  if (cal) { cal.title = title; cal.date = appt.date; cal.note = note; cal.updatedAt = Date.now(); }
  else {
    cal = { id: uid(), kind: 'event', title, date: appt.date, note, reminderAt: null, notifiedAt: null, apptId: appt.id, createdAt: Date.now(), deleted: false };
    DATA.calendarItems.push(cal);
    appt.calendarItemId = cal.id;
  }
}
// يحسب فراغات يوم واحد (بلا سقف صارم — حتى 8 خيارات) بناءً على: ساعات الدوام، المواعيد المحجوزة (+فاصل راحة)، وكل عناصر جدولي اليومي/الأسبوعي المتكرر
function computeFreeSlotsForDay(dateISO, durationMin) {
  if (!dateISO || !durationMin) return [];
  const weekday = new Date(dateISO + 'T00:00:00').getDay();
  const wh = DATA.settings.workHours[weekday];
  if (!wh || !wh.enabled) return [];
  const dayStart = timeToMin(wh.start), dayEnd = timeToMin(wh.end);
  if (dayStart == null || dayEnd == null || dayEnd <= dayStart) return [];
  const buffer = DATA.settings.appointmentBufferMin || 0;
  const busy = [];
  DATA.appointments.filter(a => !a.deleted && a.date === dateISO).forEach(a => busy.push([Math.max(0, timeToMin(a.startTime) - buffer), timeToMin(a.endTime) + buffer]));
  (DATA.weeklySchedule[weekday] || []).filter(b => !b.deleted).forEach(b => { if (b.from && b.to) busy.push([timeToMin(b.from), timeToMin(b.to)]); });
  (DATA.dailySchedule || []).filter(b => !b.deleted).forEach(b => { if (b.from && b.to) busy.push([timeToMin(b.from), timeToMin(b.to)]); });
  busy.sort((a, b) => a[0] - b[0]);
  const merged = [];
  busy.forEach(([s, e]) => {
    if (merged.length && s <= merged[merged.length - 1][1]) merged[merged.length - 1][1] = Math.max(merged[merged.length - 1][1], e);
    else merged.push([s, e]);
  });
  const gaps = []; let cursor = dayStart;
  merged.forEach(([s, e]) => { if (s > cursor) gaps.push([cursor, Math.min(s, dayEnd)]); cursor = Math.max(cursor, e); });
  if (cursor < dayEnd) gaps.push([cursor, dayEnd]);
  const slots = [];
  gaps.forEach(([s, e]) => { let t = s; while (t + durationMin <= e && slots.length < 8) { slots.push({ start: minToTime(t), end: minToTime(t + durationMin) }); t += durationMin; } });
  return slots;
}
// يفحص عدّة أيام متتالية بدءًا من تاريخ معيّن، ويرجع فقط الأيام التي فيها فراغ فعلي (لعرضها كخيارات على الزبون مباشرة، مع إمكانية "تحميل المزيد" لاحقًا)
function computeFreeSlotsRange(startDateISO, durationMin, offsetDays, countDays) {
  const results = [];
  const d = new Date(startDateISO + 'T00:00:00'); d.setDate(d.getDate() + offsetDays);
  for (let i = 0; i < countDays; i++) {
    const iso = d.toISOString().slice(0, 10);
    const slots = computeFreeSlotsForDay(iso, durationMin);
    if (slots.length) results.push({ date: iso, dayLabel: WEEKDAY_NAMES_FULL[d.getDay()], slots });
    d.setDate(d.getDate() + 1);
  }
  return results;
}
// عند حفظ موعد: تعارض مع عنصر "ثابت" بجدولي = تنبيه واضح بلا اقتراح حل (لأنه لا يُقترح تحريك شيء مقدّس كالصلاة)؛ تعارض مع عنصر "قابل للتحريك" = اقتراح بنقله من جدولي
function checkAppointmentScheduleConflict(dateISO, start, end) {
  const weekday = new Date(dateISO + 'T00:00:00').getDay();
  const all = [...(DATA.weeklySchedule[weekday] || []), ...(DATA.dailySchedule || [])].filter(b => !b.deleted);
  const hit = all.find(b => b.from && b.to && timeRangesOverlap(start, end, b.from, b.to));
  if (!hit) return null;
  return hit.movable === false
    ? `⚠️ تعارض حقيقي مع "${hit.title}" (ثابت في جدولك) — راجعه يدويًا، هذا وقت لا يُقترح تغييره تلقائيًا.`
    : `⚠️ تعارض مع "${hit.title}" (قابل للتحريك) — تقدر تنقله من قسم "جدولي" لوقت آخر لتفريغ هذا الموعد.`;
}
// تذكير تلقائي (منفصل عن تذكير الموعد نفسه) بأن موعد زبون متكرر قد "حان وقته" بناءً على آخر زيارة + دورة التكرار
function checkAppointmentDueReminders() {
  const today = todayISO();
  let changed = false;
  DATA.appointments.filter(a => !a.deleted && a.recurEveryDays && !a.recurNotifiedAt).forEach(a => {
    const due = new Date(a.date + 'T00:00:00'); due.setDate(due.getDate() + a.recurEveryDays);
    if (due.toISOString().slice(0, 10) <= today) {
      logNotify('المواعيد', `🔁 حان وقت اقتراح موعد جديد لـ ${a.clientName || apptServiceName(a)}`, `آخر زيارة كانت ${a.date} — يتكرر كل ${a.recurEveryDays} يوم`, 'planning-appointments', { v: 'planning', tab: 'appointments', focus: 'appt:' + a.id });
      a.recurNotifiedAt = today; changed = true;
    }
  });
  if (changed) persist();
}
let editingServiceTypeId = null, editingAppointmentId = null, apptScan = { date: null, duration: null, offset: 0 };
function renderAppointmentsInto(host) {
  host.innerHTML = `<p class="muted" style="font-size:12px; margin-bottom:10px;">احجز مواعيد لأي نوع خدمة تقدّمها، ودع التطبيق يقترح عليك أوقاتًا فارغة فعلية بناءً على جدولك الحقيقي — وتظهر مرتبطة تلقائيًا في الرزنامة.</p>
    <div id="apptWorkHoursHost"></div>
    <div id="apptServiceTypesHost" style="margin-top:14px;"></div>
    <div id="apptAddHost" style="margin-top:14px;"></div>
    <div id="apptListHost" style="margin-top:14px;"></div>`;
  renderWorkHoursBox($('#apptWorkHoursHost', host));
  renderServiceTypesBox($('#apptServiceTypesHost', host));
  renderApptAddBox($('#apptAddHost', host));
  renderApptList($('#apptListHost', host));
}
function renderWorkHoursBox(host) {
  const wh = DATA.settings.workHours;
  host.innerHTML = `<details class="collapse-card card" data-panel="appt_workhours"${panelOpenAttr('appt_workhours')}><summary>⏰ ساعات الدوام والفاصل بين المواعيد</summary>
    <p class="muted" style="font-size:12px; margin-top:4px;">تحدَّد مرة واحدة، وتُستعمل تلقائيًا عند اقتراح أي وقت فارغ. عدّلها وقتما تحب.</p>
    <div style="margin-top:8px;">
      ${WEEKDAY_NAMES_FULL.map((name, i) => `<div class="list-row" style="flex-wrap:wrap; gap:8px;">
        <label style="display:flex; align-items:center; gap:6px; min-width:110px;"><input type="checkbox" data-wh="${i}" data-whf="enabled" ${wh[i].enabled ? 'checked' : ''} style="width:auto;"> ${name}</label>
        <input type="time" data-wh="${i}" data-whf="start" value="${wh[i].start}" ${wh[i].enabled ? '' : 'disabled'}>
        <span class="muted">إلى</span>
        <input type="time" data-wh="${i}" data-whf="end" value="${wh[i].end}" ${wh[i].enabled ? '' : 'disabled'}>
      </div>`).join('')}
      <label class="field" style="margin-top:10px; max-width:260px;">فاصل راحة بين موعد وآخر (دقائق)<input type="number" id="appt_buffer" value="${DATA.settings.appointmentBufferMin}" min="0"></label>
    </div>
    <div class="form-actions"><button class="btn sm" id="saveWorkHoursBtn">حفظ ساعات الدوام</button></div>
  </details>`;
  bindPanelToggles(host);
  // ⚠️ بق محلي حقيقي (بلا علاقة بالمزامنة): الضغط على أي خانة كان يعيد رسم
  // الصندوق فورًا (عشان يفعّل/يعطّل حقلي الوقت)، بس الرسم الجديد كان يقرأ
  // الحالة القديمة من DATA (اللي ما تحدّثت إلا بعد الضغط على "حفظ") — فيرجّع
  // الخانة لوضعها الأصلي قبل ما توصل تضغط حفظ أصلًا. الحل: نحدّث DATA فورًا
  // عند كل ضغطة، قبل إعادة الرسم
  $$('[data-whf="enabled"]', host).forEach(el => el.addEventListener('change', () => {
    wh[el.dataset.wh].enabled = el.checked;
    renderWorkHoursBox(host);
  }));
  $('#saveWorkHoursBtn', host).addEventListener('click', () => {
    WEEKDAY_NAMES_FULL.forEach((_, i) => {
      wh[i].enabled = $(`[data-wh="${i}"][data-whf="enabled"]`, host).checked;
      wh[i].start = $(`[data-wh="${i}"][data-whf="start"]`, host).value || wh[i].start;
      wh[i].end = $(`[data-wh="${i}"][data-whf="end"]`, host).value || wh[i].end;
    });
    DATA.settings.appointmentBufferMin = parseFloat($('#appt_buffer', host).value) || 0;
    persist(true); toast('تم حفظ ساعات الدوام'); renderWorkHoursBox(host);
  });
}
function renderServiceTypesBox(host) {
  const types = DATA.serviceTypes.filter(s => !s.deleted);
  host.innerHTML = `<details class="collapse-card card" data-panel="appt_servicetypes"${panelOpenAttr('appt_servicetypes')}><summary>🧰 أنواع الخدمات (حرّة بالكامل — أضف أي مهنة أو خدمة تقدّمها)</summary>
    <p class="muted" style="font-size:12px; margin-top:4px;">مو مقتصرة على مهنة معيّنة — أضف أي خدمة بمدتها الخاصة (قص شعر، استشارة، جلسة تصوير...).</p>
    ${types.length === 0 ? '<p class="muted" style="font-size:12px; margin-top:8px;">لا توجد خدمات مضافة بعد</p>' : types.map(s => serviceTypeRowHtml(s)).join('')}
    <div class="form-grid" style="margin-top:10px;">
      <input type="text" id="st_name" placeholder="اسم الخدمة (مثال: قص شعر)">
      <input type="number" id="st_duration" placeholder="المدة بالدقائق (مثال: 30)">
    </div>
    <div class="form-actions"><button class="btn sm" id="addServiceTypeBtn">إضافة خدمة</button></div>
  </details>`;
  bindPanelToggles(host);
  $('#addServiceTypeBtn', host).addEventListener('click', () => {
    const name = $('#st_name', host).value.trim(); const duration = parseFloat($('#st_duration', host).value);
    if (!name || isNaN(duration) || duration <= 0) return toast('أدخل اسم الخدمة ومدتها بالدقائق');
    DATA.serviceTypes.push({ id: uid(), name, durationMin: duration, deleted: false });
    persist(true); renderServiceTypesBox(host);
  });
  $$('[data-editst]', host).forEach(el => el.addEventListener('click', () => { editingServiceTypeId = el.dataset.editst; renderServiceTypesBox(host); }));
  $$('[data-cancelst]', host).forEach(el => el.addEventListener('click', () => { editingServiceTypeId = null; renderServiceTypesBox(host); }));
  $$('[data-delst]', host).forEach(el => el.addEventListener('click', () => { const s = DATA.serviceTypes.find(x => x.id === el.dataset.delst); if (s) { s.deleted = true; s.updatedAt = Date.now(); persist(true); renderServiceTypesBox(host); } }));
  $$('[data-savest]', host).forEach(el => el.addEventListener('click', () => {
    const s = DATA.serviceTypes.find(x => x.id === el.dataset.savest); const row = el.closest('.list-row');
    s.name = row.querySelector('[data-stf="name"]').value.trim() || s.name;
    s.durationMin = parseFloat(row.querySelector('[data-stf="duration"]').value) || s.durationMin;
    editingServiceTypeId = null; persist(true); renderServiceTypesBox(host);
  }));
}
function serviceTypeRowHtml(s) {
  if (editingServiceTypeId === s.id) {
    return `<div class="list-row" style="gap:6px;">
      <input type="text" data-stf="name" value="${escHtml(s.name)}" style="flex:1;">
      <input type="number" data-stf="duration" value="${s.durationMin}" style="width:100px;">
      <button class="btn sm" data-savest="${s.id}">حفظ</button><button class="btn ghost sm" data-cancelst>إلغاء</button></div>`;
  }
  return `<div class="list-row"><span>🧰 ${escHtml(s.name)} <span class="muted">(${s.durationMin} د)</span></span>
    <span><button class="btn ghost sm" data-editst="${s.id}">تعديل</button><button class="btn ghost sm" data-delst="${s.id}">حذف</button></span></div>`;
}
function renderApptAddBox(host) {
  const types = DATA.serviceTypes.filter(s => !s.deleted);
  host.innerHTML = `<details class="collapse-card card" data-panel="appt_add"${panelOpenAttr('appt_add')}><summary>+ إضافة موعد</summary>
    <div class="form-grid" style="margin-top:10px;">
      <label class="field">نوع الخدمة${types.length ? '<select id="appt_type"><option value="">— خدمة مخصّصة (اكتبها) —</option>' + types.map(t => `<option value="${t.id}">${t.name} (${t.durationMin} د)</option>`).join('') + '</select>' : '<input type="text" id="appt_customtitle" placeholder="اكتب اسم الخدمة (لم تُضِف أنواعًا بعد)">'}</label>
      ${types.length ? `<label class="field" id="appt_customtitle_wrap" style="display:none;">اسم الخدمة المخصّصة<input type="text" id="appt_customtitle"></label>` : ''}
      <label class="field">اسم الزبون (اختياري)<input type="text" id="appt_client" placeholder="اسم الزبون"></label>
      <label class="field">التاريخ (بداية البحث عن فراغ)<input type="date" id="appt_date" value="${todayISO()}"></label>
      <label class="field">مدة الخدمة (دقيقة)<input type="number" id="appt_duration" value="30"></label>
      <label class="field">يتكرر كل (أيام) — اختياري<input type="number" id="appt_recur" placeholder="مثال: 14 لعميل كل أسبوعين"></label>
      <label class="field">تذكير قبل الموعد (اختياري)<input type="datetime-local" id="appt_reminder"></label>
    </div>
    <div class="form-actions"><button class="btn ghost" id="suggestSlotsBtn" type="button">🔎 اقترح أوقاتًا فارغة</button></div>
    <div id="apptSuggestBox" style="margin-top:10px;"></div>
    <div class="form-grid" style="margin-top:10px;">
      <label class="field">وقت البداية<input type="time" id="appt_start"></label>
      <label class="field">وقت النهاية<input type="time" id="appt_end"></label>
    </div>
    <div id="apptConflictBox"></div>
    <div class="form-actions"><button class="btn" id="saveApptBtn">حفظ الموعد</button></div>
  </details>`;
  bindPanelToggles(host);
  const typeSel = $('#appt_type', host);
  if (typeSel) {
    const customWrap = $('#appt_customtitle_wrap', host);
    typeSel.addEventListener('change', () => {
      const t = types.find(x => x.id === typeSel.value);
      if (t) { $('#appt_duration', host).value = t.durationMin; customWrap.style.display = 'none'; }
      else customWrap.style.display = 'flex';
    });
  }
  function renderSuggestions(range, append) {
    const box = $('#apptSuggestBox', host);
    if (!append) box.innerHTML = '<div class="muted" style="font-size:11.5px; margin-bottom:6px;">اختر وقتًا مقترحًا (أو اكتب وقتك يدويًا تحت):</div><div id="apptSuggestDays"></div>';
    const daysHost = $('#apptSuggestDays', host);
    $('#apptSuggestMore', host)?.remove();
    if (!range.length && !append && !daysHost.children.length) { daysHost.innerHTML = '<p class="muted" style="font-size:12px;">لا يوجد وقت فارغ كافٍ بهذه الفترة — جرّب مدة أقصر أو تابع "تحميل المزيد".</p>'; }
    range.forEach(day => {
      const dayEl = document.createElement('div');
      dayEl.style.marginBottom = '8px';
      dayEl.innerHTML = `<div class="muted" style="font-size:11px; margin-bottom:4px;">${day.dayLabel} ${day.date}</div>
        <div style="display:flex; flex-wrap:wrap; gap:8px;">${day.slots.map(s => `<button type="button" class="btn ghost sm" data-pickslot="${day.date}|${s.start}|${s.end}">${s.start} – ${s.end}</button>`).join('')}</div>`;
      daysHost.appendChild(dayEl);
    });
    $$('[data-pickslot]', daysHost).forEach(el => el.addEventListener('click', () => {
      const [date, start, end] = el.dataset.pickslot.split('|');
      $('#appt_date', host).value = date; $('#appt_start', host).value = start; $('#appt_end', host).value = end;
      checkConflictLive();
    }));
    if (apptScan.offset < 30) {
      const moreBtn = document.createElement('button');
      moreBtn.type = 'button'; moreBtn.className = 'btn ghost sm'; moreBtn.id = 'apptSuggestMore';
      moreBtn.style.marginTop = '8px';
      moreBtn.textContent = '⏬ تحميل المزيد (أسبوع آخر)';
      moreBtn.addEventListener('click', () => {
        apptScan.offset += 7;
        const more = computeFreeSlotsRange(apptScan.date, apptScan.duration, apptScan.offset, 7);
        renderSuggestions(more, true);
      });
      box.appendChild(moreBtn);
    }
  }
  $('#suggestSlotsBtn', host).addEventListener('click', () => {
    const date = $('#appt_date', host).value; const duration = parseFloat($('#appt_duration', host).value) || 30;
    if (!date) return toast('اختر تاريخًا أولًا');
    apptScan = { date, duration, offset: 0 };
    const range = computeFreeSlotsRange(date, duration, 0, 7);
    renderSuggestions(range, false);
  });
  function checkConflictLive() {
    const date = $('#appt_date', host).value, start = $('#appt_start', host).value, end = $('#appt_end', host).value;
    const conflictBox = $('#apptConflictBox', host);
    if (!date || !start || !end) { conflictBox.innerHTML = ''; return; }
    const msg = checkAppointmentScheduleConflict(date, start, end);
    conflictBox.innerHTML = msg ? `<div class="card" style="background:rgba(255,90,90,0.12); border:1px solid rgba(255,90,90,0.4); margin-top:8px; font-size:12px;">${msg}</div>` : '';
  }
  $('#appt_start', host).addEventListener('change', checkConflictLive);
  $('#appt_end', host).addEventListener('change', checkConflictLive);
  $('#appt_date', host).addEventListener('change', checkConflictLive);
  $('#saveApptBtn', host).addEventListener('click', () => {
    const date = $('#appt_date', host).value, start = $('#appt_start', host).value, end = $('#appt_end', host).value;
    if (!date || !start || !end) return toast('أكمل التاريخ ووقت البداية والنهاية');
    const serviceTypeId = typeSel ? typeSel.value : '';
    const customTitle = $('#appt_customtitle', host)?.value.trim() || '';
    if (!serviceTypeId && !customTitle) return toast('اختر نوع خدمة أو اكتب اسمها');
    const recurRaw = $('#appt_recur', host).value;
    const appt = { id: uid(), serviceTypeId: serviceTypeId || null, customTitle: serviceTypeId ? '' : customTitle,
      clientName: $('#appt_client', host).value.trim(), date, startTime: start, endTime: end,
      recurEveryDays: recurRaw ? parseFloat(recurRaw) : null, recurNotifiedAt: null, calendarItemId: null,
      notes: '', createdAt: Date.now(), updatedAt: Date.now(), deleted: false };
    DATA.appointments.push(appt);
    syncApptCalendarItem(appt);
    const reminderVal = $('#appt_reminder', host).value;
    if (reminderVal) { const cal = apptLinkedCalItem(appt); const r = parseReminderInput(reminderVal); if (cal && r) { cal.reminderAt = r; cal.notifiedAt = null; } }
    persist(true); toast('تم حفظ الموعد وربطه بالرزنامة'); renderApptAddBox(host); renderApptList($('#apptListHost'));
  });
}
function renderApptList(host) {
  const today = todayISO();
  const upcoming = DATA.appointments.filter(a => !a.deleted && a.date >= today).sort((a, b) => (a.date + a.startTime).localeCompare(b.date + b.startTime));
  const past = DATA.appointments.filter(a => !a.deleted && a.date < today).sort((a, b) => (b.date + b.startTime).localeCompare(a.date + a.startTime));
  host.innerHTML = `<div class="card">
    <strong>📋 المواعيد القادمة</strong>
    ${upcoming.length === 0 ? '<p class="muted" style="font-size:12px; margin-top:8px;">لا توجد مواعيد قادمة</p>' : upcoming.map(a => apptRowHtml(a)).join('')}
    ${past.length ? `<details style="margin-top:12px;"><summary class="muted" style="font-size:12px; cursor:pointer;">مواعيد سابقة (${past.length})</summary>${past.map(a => apptRowHtml(a)).join('')}</details>` : ''}
  </div>`;
  $$('[data-delappt]', host).forEach(el => el.addEventListener('click', () => {
    const a = DATA.appointments.find(x => x.id === el.dataset.delappt); if (!a) return;
    a.deleted = true; a.updatedAt = Date.now(); const cal = apptLinkedCalItem(a); if (cal) { cal.deleted = true; cal.updatedAt = Date.now(); }
    persist(true); renderApptList(host);
  }));
  $$('[data-editappt]', host).forEach(el => el.addEventListener('click', () => { editingAppointmentId = el.dataset.editappt; renderApptList(host); }));
  $$('[data-cancelappt]', host).forEach(el => el.addEventListener('click', () => { editingAppointmentId = null; renderApptList(host); }));
  $$('[data-saveappt]', host).forEach(el => el.addEventListener('click', () => {
    const a = DATA.appointments.find(x => x.id === el.dataset.saveappt); const row = el.closest('.list-row');
    a.date = row.querySelector('[data-af="date"]').value || a.date;
    a.startTime = row.querySelector('[data-af="start"]').value || a.startTime;
    a.endTime = row.querySelector('[data-af="end"]').value || a.endTime;
    a.clientName = row.querySelector('[data-af="client"]').value.trim();
    a.updatedAt = Date.now();
    syncApptCalendarItem(a);
    const reminderVal = row.querySelector('[data-af="reminder"]').value;
    const cal = apptLinkedCalItem(a);
    if (cal) { const newReminderAt = parseReminderInput(reminderVal); if (newReminderAt !== cal.reminderAt) { cal.reminderAt = newReminderAt; cal.notifiedAt = null; } }
    editingAppointmentId = null; persist(true); renderApptList(host);
    const msg = checkAppointmentScheduleConflict(a.date, a.startTime, a.endTime);
    if (msg) toast(msg);
  }));
  $$('[data-suggestnext]', host).forEach(el => el.addEventListener('click', () => {
    const a = DATA.appointments.find(x => x.id === el.dataset.suggestnext); if (!a) return;
    const nextDate = new Date(a.date + 'T00:00:00'); nextDate.setDate(nextDate.getDate() + (a.recurEveryDays || 7));
    const dateInput = $('#appt_date'); if (dateInput) { dateInput.value = nextDate.toISOString().slice(0, 10); dateInput.dispatchEvent(new Event('change')); }
    const typeSel = $('#appt_type'); if (typeSel && a.serviceTypeId) typeSel.value = a.serviceTypeId;
    if ($('#appt_client')) $('#appt_client').value = a.clientName || '';
    toast('جهّزنا موعدًا مقترحًا لنفس الزبون بالأسفل — اضغط "اقترح أوقاتًا فارغة"');
    $('#apptAddHost')?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }));
}
function apptRowHtml(a) {
  const cal = apptLinkedCalItem(a);
  if (editingAppointmentId === a.id) {
    return `<div class="list-row" data-focus="appt:${a.id}" style="flex-wrap:wrap; gap:8px;">
      <input type="date" data-af="date" value="${a.date}">
      <input type="time" data-af="start" value="${a.startTime}">
      <input type="time" data-af="end" value="${a.endTime}">
      <input type="text" data-af="client" value="${escHtml(a.clientName || '')}" placeholder="اسم الزبون">
      <input type="datetime-local" data-af="reminder" value="${msToLocalDatetimeInput(cal ? cal.reminderAt : null)}" title="وقت التذكير (اتركه فارغًا لإلغائه)">
      <span><button class="btn sm" data-saveappt="${a.id}">حفظ</button><button class="btn ghost sm" data-cancelappt>إلغاء</button></span>
    </div>`;
  }
  const nextDue = a.recurEveryDays ? (() => { const d = new Date(a.date + 'T00:00:00'); d.setDate(d.getDate() + a.recurEveryDays); return d.toISOString().slice(0, 10); })() : null;
  return `<div class="list-row" data-focus="appt:${a.id}" style="flex-direction:column; align-items:stretch;">
    <div style="display:flex; justify-content:space-between; flex-wrap:wrap;">
      <span>🗓️ ${a.date} · ⏰ ${a.startTime}–${a.endTime} — <b>${escHtml(apptTitle(a))}</b> <span class="muted" style="font-size:10.5px;">🔗 مرتبط بالرزنامة</span></span>
      <span>${cal && cal.reminderAt ? '⏰ ' + new Date(cal.reminderAt).toLocaleString('ar-DZ') + ' ' : ''}
        <button class="btn ghost sm" data-editappt="${a.id}">تعديل</button><button class="btn ghost sm" data-delappt="${a.id}">حذف</button></span>
    </div>
    ${a.recurEveryDays ? `<div class="muted" style="font-size:11px; margin-top:4px;">🔁 يتكرر كل ${a.recurEveryDays} يوم — القادم تقريبًا: ${nextDue} <button type="button" class="btn ghost sm" data-suggestnext="${a.id}" style="margin-inline-start:6px;">اقترح الآن</button></div>` : ''}
  </div>`;
}
function buildAppointmentsReportHtml() {
  const appts = DATA.appointments.filter(a => !a.deleted).sort((a, b) => (a.date + a.startTime).localeCompare(b.date + b.startTime));
  const rows = appts.map(a => `<tr><td>${a.date}</td><td>${a.startTime}–${a.endTime}</td><td>${apptServiceName(a)}</td><td>${a.clientName || '—'}</td><td>${a.recurEveryDays ? 'كل ' + a.recurEveryDays + ' يوم' : '—'}</td></tr>`).join('');
  const body = `<table><tr><th>التاريخ</th><th>الوقت</th><th>الخدمة</th><th>الزبون</th><th>التكرار</th></tr>${rows}</table>`;
  return { html: reportPageHtml('تقرير المواعيد — RD Flow', appts.length ? body : ''), filename: 'تقرير-المواعيد.pdf' };
}
const QUOTE_COMPLEXITY = { simple: { label: 'بسيط', mult: 1 }, medium: { label: 'متوسط', mult: 1.3 }, complex: { label: 'معقّد', mult: 1.6 } };
function renderPricingInto(host) {
  const items = DATA.priceItems.filter(x => !x.deleted);
  const addons = DATA.priceAddons.filter(x => !x.deleted);
  const markets = [...new Set(items.map(x => x.market))];
  const presets = DATA.pricingPresets.filter(x => !x.deleted);
  // إصلاح ذاتي: أي عرض سعر يشاور على مشروع أو عميل تم حذفه فعليًا يعود "غير مرتبط" تلقائيًا (بدل بقاء رابط لسجل شبح)
  let selfHealed = false;
  DATA.quotes.forEach(q => {
    if (q.projectId && !DATA.projects.find(p => p.id === q.projectId && !p.deleted)) { q.projectId = null; q.clientId = null; selfHealed = true; }
    else if (q.clientId && !DATA.clients.find(c => c.id === q.clientId && !c.deleted)) { q.clientId = null; q.projectId = null; selfHealed = true; }
  });
  if (selfHealed) persist();
  const quotes = DATA.quotes.filter(x => !x.deleted).sort((a, b) => b.createdAt - a.createdAt);
  host.innerHTML = `
    <details class="collapse-card card" data-panel="pricing_items"${panelOpenAttr('pricing_items')}><summary>💰 قائمة أسعارك (حسب السوق ونوع الفيديو)</summary>
      <p class="muted" style="font-size:12px; margin-top:4px;">هذه أسعارك التقريبية أنت — تحدّدها وتعدّلها وقتما تحب، والحاسبة أسفل تستعملها كنقطة انطلاق قابلة للتعديل لكل مشروع على حدة.</p>
      ${items.length === 0 ? '<p class="muted" style="font-size:12px;">لا توجد أسعار مضافة بعد</p>' : items.map(i => priceItemRowHtml(i)).join('')}
      <div class="form-grid" style="margin-top:10px;">
        <input type="text" id="pi_market" placeholder="السوق (مثال: محلي / دولي / منصة X)">
        <input type="text" id="pi_type" placeholder="نوع الفيديو/المونتاج">
        <select id="pi_unit"><option value="بالمشروع">بالمشروع</option><option value="بالدقيقة">بالدقيقة</option><option value="بالفيديو">بالفيديو</option></select>
        <input type="number" id="pi_price" placeholder="السعر الأساسي">
        <select id="pi_currency">${DATA.settings.currencies.map(c => `<option>${c}</option>`).join('')}</select>
        <input type="number" id="pi_minprice" placeholder="الحد الأدنى المقبول (اختياري)">
        <textarea class="autogrow" rows="1" id="pi_notes" placeholder="ملاحظات (اختياري)" style="grid-column:span 2;"></textarea>
      </div>
      <div class="form-actions"><button class="btn sm" id="addPriceItemBtn">إضافة سعر</button></div>
    </details>

    <details class="collapse-card card" data-panel="pricing_addons"${panelOpenAttr('pricing_addons')} style="margin-top:14px;"><summary>⚙️ إضافات وعوامل تسعير حرة (اختياري لكل مشروع)</summary>
      <p class="muted" style="font-size:12px; margin-top:4px;">هنا تضيف أي "خيار" حر بسعره الخاص — مثلاً: سوند إفكت، موشن جرافيك، ترجمة، تعديلات إضافية... بمجرد إضافته هنا، يظهر تلقائيًا كخيار تقدر "تفعّله" عند حساب أي عرض سعر تحت، وسعره يُضاف منطقيًا للمجموع النهائي.</p>
      ${addons.length === 0 ? '<p class="muted" style="font-size:12px;">لا توجد إضافات مسجّلة بعد</p>' : addons.map(a => addonRowHtml(a)).join('')}
      <div class="form-grid" style="margin-top:10px;">
        <input type="text" id="ad_name" placeholder="اسم الخيار (مثال: سوند إفكت)">
        <select id="ad_unit"><option value="fixed">سعر ثابت للمشروع كاملًا</option><option value="perUnit">يتكرر مع كل وحدة/كمية</option></select>
        <input type="number" id="ad_price" placeholder="السعر">
        <select id="ad_currency">${DATA.settings.currencies.map(c => `<option>${c}</option>`).join('')}</select>
        <textarea class="autogrow" rows="1" id="ad_notes" placeholder="ملاحظة (اختياري)" style="grid-column:span 2;"></textarea>
      </div>
      <div class="form-actions"><button class="btn sm" id="addAddonBtn">إضافة خيار</button></div>
    </details>

    <details class="collapse-card card" data-panel="pricing_quote"${panelOpenAttr('pricing_quote')} style="margin-top:14px;"><summary>🧮 احسب عرض سعر لمشروع</summary>
      ${presets.length ? `<div class="form-grid" style="margin-top:8px;">
        <label class="field" style="grid-column:span 2;">قالب جاهز (اختياري)<select id="q_preset"><option value="">— بدون قالب —</option>${presets.map(p => `<option value="${p.id}">${p.name}</option>`).join('')}</select></label>
      </div>` : ''}
      <div class="form-grid" style="margin-top:8px;">
        <label class="field">السوق<select id="q_market"><option value="">اختر السوق</option>${markets.map(m => `<option>${m}</option>`).join('')}</select></label>
        <label class="field">نوع الفيديو<select id="q_type"><option value="">اختر السوق أولًا</option></select></label>
        <label class="field">السعر المستخدم لهذا المشروع<input type="number" id="q_priceOverride" placeholder="يتعبّى تلقائيًا — عدّله إن أردت"></label>
        <label class="field">الكمية/المدة (بوحدة السعر)<input type="number" id="q_qty" value="1" min="0" step="0.5"></label>
        <label class="field">مستوى التعقيد<select id="q_complexity">${Object.entries(QUOTE_COMPLEXITY).map(([k, v]) => `<option value="${k}">${v.label} (×${v.mult})</option>`).join('')}</select></label>
        <label class="field">استعجال (%)<input type="number" id="q_rush" value="0" min="0"></label>
        <label class="field">خصم (%)<input type="number" id="q_discount" value="0" min="0"></label>
        <label class="field" style="grid-column:span 2;">وصف المشروع (توثيقي فقط)<textarea class="autogrow" rows="1" id="q_desc" placeholder="مثال: فيديو ريلز 60 ثانية لعلامة تجارية محلية، مونتاج سريع مع موشن جرافيك بسيط"></textarea></label>
      </div>
      <p class="muted" style="font-size:11px; margin-top:6px;">💡 "السعر المستخدم لهذا المشروع" يتعبّى تلقائيًا من قائمة أسعارك، لكنه مجرد نقطة انطلاق — عدّله كما تحب لهذا المشروع فقط دون أن يتغيّر سعرك الافتراضي المحفوظ بالقائمة أعلاه.</p>
      <div id="q_addonsBox" style="margin-top:10px;"></div>
      <p class="muted" style="font-size:11px; margin-top:6px;">💡 كيف تُحسب التسعيرة بالضبط: <b>السعر المستخدم × الكمية × مضاعِف التعقيد × (1 + نسبة الاستعجال)</b>، ثم تُضاف فوقه أسعار أي إضافات فعّلتها (فوق)، وأخيرًا يُطرح الخصم من المجموع الكامل. حقل "وصف المشروع" توثيقي بحت لتتذكر تفاصيل الطلب لاحقًا — <b>هو وحده لا يغيّر أي رقم في السعر</b>؛ أي تأثير على السعر يجب أن يمرّ عبر الحقول الرقمية (الكمية/التعقيد/الاستعجال/الخصم) أو عبر "الإضافات" فوق. لو تحب لاحقًا نخلي الوصف نفسه يُقترح منه تعقيد أو إضافات تلقائيًا (تحليل نص ذكي)، قوللي ونفعّلها.</p>
      <p class="muted" style="font-size:11px; margin-top:4px;">📎 ملاحظة: إرفاق صور المشروع وتحليلها تلقائيًا لاقتراح السعر يحتاج وضع الذكاء الاصطناعي الكامل (لاحقًا باختيارك عبر مفتاح API) — حاليًا الحساب يعتمد على أسعارك المحفوظة + المضاعِفات والإضافات اللي تحددها هنا يدويًا.</p>
      <div id="quoteResultBox" style="margin-top:10px;"></div>
      <div class="form-actions" style="margin-top:8px; flex-wrap:wrap;">
        <button class="btn" id="computeQuoteBtn">احسب السعر</button>
        <input type="text" id="q_presetName" placeholder="اسم القالب (لحفظه كقالب)" style="width:180px;">
        <button class="btn ghost" id="savePresetBtn">💾 احفظ كقالب</button>
        <button class="btn ghost" id="saveQuoteBtn" style="display:none;">💾 حفظ كعرض سعر</button>
      </div>
      ${presets.length ? `<div style="margin-top:12px;"><div class="muted" style="font-size:11.5px; margin-bottom:6px;">القوالب المحفوظة:</div>${presets.map(p => presetRowHtml(p)).join('')}</div>` : ''}
    </details>

    <div class="card" style="margin-top:14px;"><h3 style="margin:0 0 10px;">عروض الأسعار المحفوظة</h3>
      ${quotes.length === 0 ? '<p class="muted" style="font-size:12px;">لا توجد عروض محفوظة بعد</p>' : quotes.map(q => quoteRowHtml(q)).join('')}
    </div>`;
  bindPricingEvents(host, items, addons, markets, presets);
}
function priceItemRowHtml(i) {
  if (editingPriceItemId === i.id) {
    return `<div class="list-row" style="gap:6px; flex-wrap:wrap;">
      <input type="text" data-pif="market" value="${i.market}" style="width:120px;">
      <input type="text" data-pif="videoType" value="${i.videoType}" style="flex:1; min-width:120px;">
      <select data-pif="unit"><option ${i.unit === 'بالمشروع' ? 'selected' : ''}>بالمشروع</option><option ${i.unit === 'بالدقيقة' ? 'selected' : ''}>بالدقيقة</option><option ${i.unit === 'بالفيديو' ? 'selected' : ''}>بالفيديو</option></select>
      <input type="number" data-pif="basePrice" value="${i.basePrice}" style="width:100px;">
      <select data-pif="currency">${DATA.settings.currencies.map(c => `<option ${c === i.currency ? 'selected' : ''}>${c}</option>`).join('')}</select>
      <input type="number" data-pif="minPrice" value="${i.minPrice ?? ''}" placeholder="الحد الأدنى (اختياري)" style="width:140px;">
      <button class="btn sm" data-savepi="${i.id}">حفظ</button><button class="btn ghost sm" data-cancelpi>إلغاء</button></div>`;
  }
  return `<div class="list-row"><span><b>${i.market}</b> · ${i.videoType} — ${bidi(fmt(i.basePrice))} ${i.currency} / ${i.unit}${i.minPrice ? ` <span class="muted">(حد أدنى: ${bidi(fmt(i.minPrice))})</span>` : ''}${i.notes ? ` <span class="muted">(${i.notes})</span>` : ''}</span>
    <span><button class="btn ghost sm" data-editpi="${i.id}">تعديل</button><button class="btn ghost sm" data-delpi="${i.id}">حذف</button></span></div>`;
}
function presetRowHtml(p) {
  if (editingPresetId === p.id) {
    return `<div class="list-row" style="gap:6px;">
      <input type="text" data-prf="name" value="${escHtml(p.name)}" style="flex:1;">
      <button class="btn sm" data-savepreset="${p.id}">حفظ</button><button class="btn ghost sm" data-cancelpreset>إلغاء</button></div>`;
  }
  return `<div class="list-row"><span>📋 ${escHtml(p.name)}</span>
    <span><button class="btn ghost sm" data-editpreset="${p.id}">تعديل الاسم</button><button class="btn ghost sm" data-delpreset="${p.id}">حذف</button></span></div>`;
}
function addonRowHtml(a) {
  if (editingAddonId === a.id) {
    return `<div class="list-row" style="gap:6px; flex-wrap:wrap;">
      <input type="text" data-adf="name" value="${a.name}" style="flex:1; min-width:120px;">
      <select data-adf="unit"><option value="fixed" ${a.unit === 'fixed' ? 'selected' : ''}>ثابت للمشروع</option><option value="perUnit" ${a.unit === 'perUnit' ? 'selected' : ''}>لكل وحدة</option></select>
      <input type="number" data-adf="price" value="${a.price}" style="width:100px;">
      <select data-adf="currency">${DATA.settings.currencies.map(c => `<option ${c === a.currency ? 'selected' : ''}>${c}</option>`).join('')}</select>
      <button class="btn sm" data-saveaddon="${a.id}">حفظ</button><button class="btn ghost sm" data-canceladdon>إلغاء</button></div>`;
  }
  return `<div class="list-row"><span><b>${a.name}</b> — ${bidi(fmt(a.price))} ${a.currency} ${a.unit === 'perUnit' ? '/ وحدة' : '(ثابت)'}${a.notes ? ` <span class="muted">(${a.notes})</span>` : ''}</span>
    <span><button class="btn ghost sm" data-editaddon="${a.id}">تعديل</button><button class="btn ghost sm" data-deladdon="${a.id}">حذف</button></span></div>`;
}
function quoteRowHtml(q) {
  const client = q.clientId ? DATA.clients.find(c => c.id === q.clientId && !c.deleted) : null;
  const project = q.projectId ? DATA.projects.find(p => p.id === q.projectId && !p.deleted) : null;
  return `<div class="list-row" style="flex-direction:column; align-items:stretch;">
    <div style="display:flex; justify-content:space-between;"><span><b>${q.market}</b> · ${q.videoType} <span class="muted" style="font-size:11px;">${new Date(q.createdAt).toLocaleDateString('ar-DZ')}</span></span>
    <span style="font-weight:700; color:var(--green);">${bidi(fmt(project ? project.agreedAmount : q.total))} ${q.currency}</span></div>
    ${q.description ? `<div class="muted" style="font-size:12px; margin-top:4px;">${q.description}</div>` : ''}
    ${q.addons && q.addons.length ? `<div class="muted" style="font-size:11px; margin-top:4px;">➕ ${q.addons.map(a => `${a.name} (${bidi(fmt(a.amount))})`).join(' · ')}</div>` : ''}
    ${client ? `<div class="muted" style="font-size:11.5px; margin-top:6px;">👤 مرتبط بالعميل: <b>${escHtml(client.name)}</b>${project ? ` — ${project.paidAmount >= project.agreedAmount && project.agreedAmount > 0 ? '✅ مدفوع بالكامل' : project.paidAmount > 0 ? `مدفوع جزئيًا (${bidi(fmt(project.paidAmount))}/${bidi(fmt(project.agreedAmount))})` : 'لم يُدفع بعد'}` : ''}</div>` : '<div class="muted" style="font-size:11.5px; margin-top:6px;">غير مرتبط بعميل</div>'}
    <div class="form-actions" style="margin-top:6px;">
      ${client && !project ? `<button class="btn sm" data-convertquote="${q.id}">✅ حوّل لعملية دخل</button>` : ''}
      ${project ? `<button class="btn ghost sm" data-gotoclient="${q.clientId}">فتح صفحة العميل</button>` : ''}
      <button class="btn ghost sm" data-delquote="${q.id}">حذف عرض السعر</button>
    </div>
  </div>`;
}
function bindPricingEvents(host, items, addons, markets, presets) {
  bindPanelToggles(host);
  $('#addPriceItemBtn', host).addEventListener('click', () => {
    const market = $('#pi_market', host).value.trim(), videoType = $('#pi_type', host).value.trim();
    const basePrice = parseFloat($('#pi_price', host).value);
    const minPriceRaw = $('#pi_minprice', host).value;
    if (!market || !videoType || isNaN(basePrice)) return toast('أكمل السوق ونوع الفيديو والسعر');
    DATA.priceItems.push({ id: uid(), market, videoType, unit: $('#pi_unit', host).value, basePrice,
      currency: $('#pi_currency', host).value, minPrice: minPriceRaw === '' ? null : parseFloat(minPriceRaw), notes: $('#pi_notes', host).value, deleted: false });
    persist(true); renderPricingInto(host);
  });
  $$('[data-editpi]', host).forEach(el => el.addEventListener('click', () => { editingPriceItemId = el.dataset.editpi; renderPricingInto(host); }));
  $('[data-cancelpi]', host)?.addEventListener('click', () => { editingPriceItemId = null; renderPricingInto(host); });
  $$('[data-delpi]', host).forEach(el => el.addEventListener('click', () => { const i = DATA.priceItems.find(x => x.id === el.dataset.delpi); if (i) { i.deleted = true; i.updatedAt = Date.now(); persist(true); renderPricingInto(host); } }));
  $$('[data-savepi]', host).forEach(el => el.addEventListener('click', () => {
    const i = DATA.priceItems.find(x => x.id === el.dataset.savepi); const row = el.closest('.list-row');
    i.market = row.querySelector('[data-pif="market"]').value || i.market;
    i.videoType = row.querySelector('[data-pif="videoType"]').value || i.videoType;
    i.unit = row.querySelector('[data-pif="unit"]').value;
    i.basePrice = parseFloat(row.querySelector('[data-pif="basePrice"]').value) || 0;
    i.currency = row.querySelector('[data-pif="currency"]').value;
    const minRaw = row.querySelector('[data-pif="minPrice"]').value;
    i.minPrice = minRaw === '' ? null : parseFloat(minRaw);
    editingPriceItemId = null; persist(true); renderPricingInto(host);
  }));
  $$('[data-delquote]', host).forEach(el => el.addEventListener('click', () => { const q = DATA.quotes.find(x => x.id === el.dataset.delquote); if (q) { q.deleted = true; q.updatedAt = Date.now(); persist(true); renderPricingInto(host); } }));
  $$('[data-gotoclient]', host).forEach(el => el.addEventListener('click', () => showView('clients')));
  $$('[data-convertquote]', host).forEach(el => el.addEventListener('click', () => {
    const q = DATA.quotes.find(x => x.id === el.dataset.convertquote); if (!q || !q.clientId) return;
    const client = DATA.clients.find(c => c.id === q.clientId && !c.deleted); if (!client) return toast('العميل المرتبط لم يعد موجودًا');
    const project = { id: uid(), clientId: client.id, title: q.videoType + (q.description ? ' — ' + q.description : ''),
      agreedAmount: q.total, paidAmount: 0, hours: 0, notes: q.description || '', flagged: false, createdAt: Date.now(), updatedAt: Date.now(), deleted: false };
    DATA.projects.push(project);
    q.projectId = project.id;
    persist(true); toast('تم تحويله لعملية دخل عند العميل — سجّل الدفع من صفحة العميل عند التحصيل'); renderPricingInto(host);
  }));

  // إضافات/عوامل التسعير الحرة (CRUD)
  $('#addAddonBtn', host).addEventListener('click', () => {
    const name = $('#ad_name', host).value.trim();
    const price = parseFloat($('#ad_price', host).value);
    if (!name || isNaN(price)) return toast('أكمل اسم الخيار وسعره');
    DATA.priceAddons.push({ id: uid(), name, price, unit: $('#ad_unit', host).value,
      currency: $('#ad_currency', host).value, notes: $('#ad_notes', host).value.trim(), deleted: false });
    persist(true); renderPricingInto(host);
  });
  $$('[data-editaddon]', host).forEach(el => el.addEventListener('click', () => { editingAddonId = el.dataset.editaddon; renderPricingInto(host); }));
  $('[data-canceladdon]', host)?.addEventListener('click', () => { editingAddonId = null; renderPricingInto(host); });
  $$('[data-deladdon]', host).forEach(el => el.addEventListener('click', () => { const a = DATA.priceAddons.find(x => x.id === el.dataset.deladdon); if (a) { a.deleted = true; a.updatedAt = Date.now(); persist(true); renderPricingInto(host); } }));
  $$('[data-saveaddon]', host).forEach(el => el.addEventListener('click', () => {
    const a = DATA.priceAddons.find(x => x.id === el.dataset.saveaddon); const row = el.closest('.list-row');
    a.name = row.querySelector('[data-adf="name"]').value || a.name;
    a.unit = row.querySelector('[data-adf="unit"]').value;
    a.price = parseFloat(row.querySelector('[data-adf="price"]').value) || 0;
    a.currency = row.querySelector('[data-adf="currency"]').value;
    editingAddonId = null; persist(true); renderPricingInto(host);
  }));

  // القوالب الجاهزة (Presets) — CRUD
  $$('[data-editpreset]', host).forEach(el => el.addEventListener('click', () => { editingPresetId = el.dataset.editpreset; renderPricingInto(host); }));
  $('[data-cancelpreset]', host)?.addEventListener('click', () => { editingPresetId = null; renderPricingInto(host); });
  $$('[data-delpreset]', host).forEach(el => el.addEventListener('click', () => { const p = DATA.pricingPresets.find(x => x.id === el.dataset.delpreset); if (p) { p.deleted = true; p.updatedAt = Date.now(); persist(true); renderPricingInto(host); } }));
  $$('[data-savepreset]', host).forEach(el => el.addEventListener('click', () => {
    const p = DATA.pricingPresets.find(x => x.id === el.dataset.savepreset); const row = el.closest('.list-row');
    p.name = row.querySelector('[data-prf="name"]').value.trim() || p.name;
    editingPresetId = null; persist(true); renderPricingInto(host);
  }));

  function renderAddonsBox(currency, presetAddons) {
    const box = $('#q_addonsBox', host);
    const matching = addons.filter(a => a.currency === currency);
    if (!matching.length) { box.innerHTML = ''; return; }
    const presetMap = new Map((presetAddons || []).map(a => [a.id, a.price]));
    box.innerHTML = `<div class="muted" style="font-size:11.5px; margin-bottom:6px;">➕ إضافات لهذا المشروع (اختياري) — يمكنك تعديل سعر أي إضافة لهذا المشروع فقط:</div>
      <div style="display:flex; flex-wrap:wrap; gap:10px;">
        ${matching.map(a => `<label class="chip-check">
          <input type="checkbox" data-addonchk="${a.id}" ${presetMap.has(a.id) ? 'checked' : ''}> ${a.name}
          <input type="number" data-addonprice="${a.id}" value="${presetMap.has(a.id) ? presetMap.get(a.id) : a.price}" style="width:80px; margin-inline-start:6px;">
          <span class="muted" style="font-size:10.5px;">${a.currency}${a.unit === 'perUnit' ? '/وحدة' : ''}</span>
        </label>`).join('')}
      </div>`;
  }

  $('#q_market', host).addEventListener('change', () => {
    const m = $('#q_market', host).value;
    const typeSel = $('#q_type', host);
    const matching = items.filter(i => i.market === m);
    typeSel.innerHTML = matching.length ? matching.map(i => `<option value="${i.id}">${i.videoType} (${bidi(fmt(i.basePrice))} ${i.currency}/${i.unit})</option>`).join('') : '<option value="">لا توجد أسعار لهذا السوق</option>';
    const first = matching[0];
    $('#q_priceOverride', host).value = first ? first.basePrice : '';
    renderAddonsBox(first ? first.currency : null);
  });
  $('#q_type', host).addEventListener('change', () => {
    const priceItem = items.find(i => i.id === $('#q_type', host).value);
    $('#q_priceOverride', host).value = priceItem ? priceItem.basePrice : '';
    renderAddonsBox(priceItem ? priceItem.currency : null);
  });

  // تحميل قالب جاهز يعبّي كل الحقول تلقائيًا (تبقى قابلة للتعديل بعدها)
  $('#q_preset', host)?.addEventListener('change', () => {
    const p = presets.find(x => x.id === $('#q_preset', host).value); if (!p) return;
    const priceItem = items.find(i => i.id === p.itemId);
    if (priceItem) {
      $('#q_market', host).value = priceItem.market;
      $('#q_market', host).dispatchEvent(new Event('change'));
      $('#q_type', host).value = priceItem.id;
    }
    $('#q_priceOverride', host).value = p.priceOverride ?? (priceItem ? priceItem.basePrice : '');
    $('#q_qty', host).value = p.qty; $('#q_complexity', host).value = p.complexity;
    $('#q_rush', host).value = p.rush; $('#q_discount', host).value = p.discount;
    $('#q_desc', host).value = p.description || '';
    renderAddonsBox(priceItem ? priceItem.currency : null, p.addons);
  });

  let lastComputed = null, linkedClientId = null;
  $('#computeQuoteBtn', host).addEventListener('click', () => {
    const itemId = $('#q_type', host).value; const priceItem = items.find(i => i.id === itemId);
    if (!priceItem) return toast('اختر السوق ونوع الفيديو أولًا');
    const usedPrice = parseFloat($('#q_priceOverride', host).value);
    const priceToUse = isNaN(usedPrice) ? priceItem.basePrice : usedPrice;
    const qty = parseFloat($('#q_qty', host).value) || 1;
    const complexity = QUOTE_COMPLEXITY[$('#q_complexity', host).value];
    const rush = parseFloat($('#q_rush', host).value) || 0, discount = parseFloat($('#q_discount', host).value) || 0;

    const baseAfterQty = priceToUse * qty;
    const afterComplexity = baseAfterQty * complexity.mult;
    const afterRush = afterComplexity * (1 + rush / 100);

    const checkedAddonEls = $$('[data-addonchk]', host).filter(c => c.checked);
    const addonBreakdown = checkedAddonEls.map(c => {
      const a = addons.find(x => x.id === c.dataset.addonchk); if (!a) return null;
      const priceInput = $(`[data-addonprice="${a.id}"]`, host);
      const usedAddonPrice = parseFloat(priceInput?.value); const addonPrice = isNaN(usedAddonPrice) ? a.price : usedAddonPrice;
      return { id: a.id, name: a.name, price: addonPrice, unit: a.unit, amount: a.unit === 'perUnit' ? addonPrice * qty : addonPrice };
    }).filter(Boolean);
    const addonsTotal = addonBreakdown.reduce((s, a) => s + a.amount, 0);

    const subtotal = afterRush + addonsTotal;
    const discountAmount = subtotal * (discount / 100);
    const total = subtotal - discountAmount;

    lastComputed = { market: priceItem.market, videoType: priceItem.videoType, currency: priceItem.currency, total,
      addons: addonBreakdown.map(a => ({ name: a.name, amount: a.amount })), description: $('#q_desc', host).value,
      itemId: priceItem.id, qty, complexityKey: $('#q_complexity', host).value, rush, discount, priceOverride: priceToUse,
      addonSelections: addonBreakdown.map(a => ({ id: a.id, price: a.price })) };
    linkedClientId = null;

    const belowFloor = priceItem.minPrice && total < priceItem.minPrice;
    const existingClients = DATA.clients.filter(c => !c.deleted);
    $('#quoteResultBox', host).innerHTML = `
      ${belowFloor ? `<div class="card" style="background:rgba(255,90,90,0.12); border:1px solid rgba(255,90,90,0.4); margin-bottom:10px;">⚠️ هذا السعر أقل من حدّك الأدنى المحفوظ لهذا النوع (${bidi(fmt(priceItem.minPrice))} ${priceItem.currency}) — تأكد أن الخصم أو الرقم صحيح.</div>` : ''}
      <div class="stat-card positive"><div class="label">السعر التقديري</div><div class="value">${bidi(fmt(total))} ${priceItem.currency}</div></div>
      <div class="card" style="margin-top:10px; background:var(--surface);">
        <strong style="font-size:12.5px;">🧾 كيف وصلنا لهذا الرقم:</strong>
        <div class="muted" style="font-size:12px; margin-top:8px; line-height:1.9;">
          1) السعر المستخدم لهذا المشروع: <b>${bidi(fmt(priceToUse))}</b>${priceToUse !== priceItem.basePrice ? ` <span class="muted">(بدل الافتراضي ${bidi(fmt(priceItem.basePrice))})</span>` : ''} (${priceItem.market} · ${priceItem.videoType} / ${priceItem.unit})<br>
          2) × الكمية/المدة (${qty}) = <b>${bidi(fmt(baseAfterQty))}</b><br>
          3) × مضاعِف التعقيد "${complexity.label}" (×${complexity.mult}) = <b>${bidi(fmt(afterComplexity))}</b><br>
          4) + نسبة الاستعجال (${rush}%) = <b>${bidi(fmt(afterRush))}</b><br>
          ${addonBreakdown.length ? `5) + الإضافات المفعّلة: ${addonBreakdown.map(a => `${a.name} (${bidi(fmt(a.amount))})`).join(' + ')} = <b>${bidi(fmt(subtotal))}</b><br>` : '5) لا إضافات مفعّلة في هذا المشروع<br>'}
          ${discount > 0 ? `6) − خصم ${discount}% (${bidi(fmt(discountAmount))}) عن المجموع<br>` : '6) بلا خصم<br>'}
          <b style="color:var(--green);">= الإجمالي النهائي: ${bidi(fmt(total))} ${priceItem.currency}</b>
        </div>
        <p class="muted" style="font-size:10.5px; margin-top:8px;">ملخص القاعدة: السعر المستخدم × كمية × تعقيد × (1+استعجال%) + إضافات، ثم يُطرح الخصم من المجموع الكامل. "وصف المشروع" لا يدخل في هذا الحساب إطلاقًا — فقط للتوثيق.</p>
      </div>
      <div class="card" style="margin-top:10px;">
        <strong style="font-size:12.5px;">🔗 اربطه بعميل (اختياري)</strong>
        <div class="form-grid" style="margin-top:8px;">
          <label class="field">عميل موجود<select id="q_clientSel"><option value="">— بدون —</option>${existingClients.map(c => `<option value="${c.id}">${escHtml(c.name)}</option>`).join('')}</select></label>
        </div>
        <details style="margin-top:8px;"><summary class="muted" style="font-size:11.5px; cursor:pointer;">+ عميل جديد (لو غير موجود بالقائمة)</summary>
          <div class="form-grid" style="margin-top:8px;">
            <input type="text" id="q_newClientName" placeholder="اسم العميل الجديد">
            <select id="q_newClientCurrency">${DATA.settings.currencies.map(c => `<option ${c === priceItem.currency ? 'selected' : ''}>${c}</option>`).join('')}</select>
          </div>
          <div class="form-actions" style="margin-top:6px;"><button class="btn ghost sm" id="q_addNewClientBtn" type="button">+ إضافة العميل</button></div>
        </details>
      </div>`;
    $('#q_clientSel', host).addEventListener('change', () => { linkedClientId = $('#q_clientSel', host).value || null; });
    $('#q_addNewClientBtn', host).addEventListener('click', () => {
      const name = $('#q_newClientName', host).value.trim(); if (!name) return toast('أدخل اسم العميل');
      const newClient = { id: uid(), name, currency: $('#q_newClientCurrency', host).value, createdAt: Date.now(), deleted: false };
      DATA.clients.push(newClient); persist(true);
      linkedClientId = newClient.id;
      const sel = $('#q_clientSel', host);
      sel.innerHTML += `<option value="${newClient.id}" selected>${escHtml(newClient.name)}</option>`;
      sel.value = newClient.id;
      toast('تمت إضافة العميل وربطه بهذا العرض');
    });
    $('#saveQuoteBtn', host).style.display = 'inline-flex';
  });
  $('#savePresetBtn', host).addEventListener('click', () => {
    const itemId = $('#q_type', host).value; const priceItem = items.find(i => i.id === itemId);
    if (!priceItem) return toast('اختر السوق ونوع الفيديو أولًا قبل الحفظ كقالب');
    const name = $('#q_presetName', host).value.trim(); if (!name) return toast('أدخل اسمًا للقالب');
    const checkedAddonEls = $$('[data-addonchk]', host).filter(c => c.checked);
    const addonSelections = checkedAddonEls.map(c => { const priceInput = $(`[data-addonprice="${c.dataset.addonchk}"]`, host); return { id: c.dataset.addonchk, price: parseFloat(priceInput?.value) || 0 }; });
    const priceOverrideRaw = parseFloat($('#q_priceOverride', host).value);
    DATA.pricingPresets.push({ id: uid(), name, itemId, qty: parseFloat($('#q_qty', host).value) || 1,
      complexity: $('#q_complexity', host).value, rush: parseFloat($('#q_rush', host).value) || 0, discount: parseFloat($('#q_discount', host).value) || 0,
      priceOverride: isNaN(priceOverrideRaw) ? null : priceOverrideRaw, addons: addonSelections, description: $('#q_desc', host).value, createdAt: Date.now(), deleted: false });
    persist(true); toast('تم حفظ القالب'); renderPricingInto(host);
  });
  $('#saveQuoteBtn', host).addEventListener('click', () => {
    if (!lastComputed) return;
    const { itemId, qty, complexityKey, rush, discount, priceOverride, addonSelections, ...toSave } = lastComputed;
    DATA.quotes.push({ id: uid(), ...toSave, clientId: linkedClientId, projectId: null, createdAt: Date.now(), deleted: false });
    persist(true); toast('تم حفظ عرض السعر'); renderPricingInto(host);
  });
}
function checkReminders() {
  if (!DATA) return;
  const now = Date.now(); let changed = false;
  DATA.calendarItems.filter(i => !i.deleted && i.reminderAt && !i.notifiedAt).forEach(i => {
    if (i.reminderAt <= now) {
      logNotify(i.apptId ? 'المواعيد' : i.kind === 'event' ? 'الرزنامة' : 'المذكرة', (i.kind === 'event' ? 'تذكير: ' : 'ملاحظة: ') + i.title, i.note || '', null,
        i.apptId ? { v: 'planning', tab: 'appointments', focus: 'appt:' + i.apptId } : { v: i.kind === 'event' ? 'calendar' : 'notes', focus: 'cal:' + i.id });
      i.notifiedAt = now; changed = true;
    }
  });
  (DATA.debts || []).filter(d => !d.deleted && d.reminderAt && !d.notifiedAt).forEach(d => {
    if (d.reminderAt <= now) { logNotify('الديون', 'تذكير دين: ' + d.name, d.note || '', null, { v: 'clients', mode: 'debts', panels: [debtPanelKey(d.name)], focus: 'debt:' + d.id }); d.notifiedAt = now; changed = true; }
  });
  (DATA.plans || []).filter(p => !p.deleted && p.status !== 'archived' && p.nextReminderAt && !p.notifiedAt).forEach(p => {
    if (p.nextReminderAt <= now) {
      logNotify('التخطيط', (p.kind === 'goal' ? '🎯 متابعة هدف: ' : '🔁 تذكير خطة: ') + p.title, 'أين وصلت؟ سجّل تقدّمك من قسم التخطيط والتسعير.', null, { v: 'planning', tab: 'plans', focus: 'plan:' + p.id });
      p.notifiedAt = now; changed = true;
    }
  });
  if (changed) persist();
  checkMonthComparisonAlert();
  checkScheduleReminders();
  checkAppointmentDueReminders();
  // التنبيهات الذكية كانت تُفحص فقط عند إضافة حركة — نفحصها الآن مرة كل يوم أيضًا (كما يُشرح في مركز التحكم) حتى لا يفوتك تنبيه "عميل لم يدفع منذ مدة"
  if (DATA.meta.lastAlertEvalDate !== todayISO()) { DATA.meta.lastAlertEvalDate = todayISO(); evaluateAlerts(); }
  if (Date.now() - _lastBadgeTick > 60000) { _lastBadgeTick = Date.now(); updateNotifBadge(); } // يحدّث الشارة كل دقيقة (تذكير صار وقته...)
}
let _lastBadgeTick = 0;
// تذكير تلقائي بكل نوع جدول مفعّل (يومي/أسبوعي/فصلي/سنوي) عند وصول دورته — يومي وأسبوعي كل يوم، فصلي عند دخول فصل جديد، سنوي عند دخول شهره كل عام
// (فيه حارس مضاعف: العلامة المخزَّنة + فحص مباشر في سجل الإشعارات نفسه، حتى لا يتكرر نفس التذكير أبدًا مهما حدث أثناء الحفظ/إعادة التشغيل)
function scheduleAlreadyNotified(navTarget, sinceMs) {
  return liveNotifs().some(n => n.navigateTo === navTarget && n.createdAt >= sinceMs);
}
function checkScheduleReminders() {
  if (!DATA.settings.scheduleReminderEnabled) return;
  const now = new Date();
  const [H, Mi] = (DATA.settings.scheduleReminderTime || '08:00').split(':').map(Number);
  const triggerAt = new Date(now.getFullYear(), now.getMonth(), now.getDate(), H, Mi, 0, 0).getTime();
  if (Date.now() < triggerAt) return;
  const today = todayISO();
  const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 0, 0, 0, 0).getTime();
  const startOfQuarter = new Date(now.getFullYear(), Math.floor(now.getMonth() / 3) * 3, 1, 0, 0, 0, 0).getTime();
  const startOfMonth = new Date(now.getFullYear(), now.getMonth(), 1, 0, 0, 0, 0).getTime();
  const markers = DATA.meta.scheduleNotifyMarkers = DATA.meta.scheduleNotifyMarkers || { daily: null, weekly: null, quarterly: null, yearly: null };
  const modes = enabledScheduleModes();
  let changed = false;

  if (modes.includes('daily') && markers.daily !== today && !scheduleAlreadyNotified('schedule-today:daily', startOfToday)) {
    const count = (DATA.dailySchedule || []).filter(b => !b.deleted).length;
    markers.daily = today; changed = true;
    logNotify('الجدول', '☀️ جدولك اليومي', count ? `${count} مهمة مجدولة اليوم — اضغط لعرضها` : 'لا توجد مهام مجدولة بعد في جدولك اليومي', 'schedule-today:daily');
  }
  if (modes.includes('weekly') && markers.weekly !== today && !scheduleAlreadyNotified('schedule-today:weekly', startOfToday)) {
    const dayIdx = now.getDay();
    const count = (DATA.weeklySchedule[dayIdx] || []).filter(b => !b.deleted).length;
    markers.weekly = today; changed = true;
    logNotify('الجدول', '📅 هذا جدولك اليوم: ' + SCHEDULE_DAY_NAMES[dayIdx], count ? `${count} مهمة مجدولة — اضغط لعرضها` : 'لا توجد مهام مجدولة بعد لهذا اليوم', 'schedule-today:weekly');
  }
  if (modes.includes('quarterly')) {
    const q = Math.floor(now.getMonth() / 3) + 1;
    const qKey = `${now.getFullYear()}-Q${q}`;
    if (markers.quarterly !== qKey && !scheduleAlreadyNotified('schedule-today:quarterly', startOfQuarter)) {
      const count = (DATA.quarterlySchedule[q] || []).filter(b => !b.deleted).length;
      markers.quarterly = qKey; changed = true;
      if (count) logNotify('الجدول', `📆 وصل الفصل ${q} — جدولك الفصلي`, `${count} عنصر مجدول لهذا الفصل — اضغط لعرضه`, 'schedule-today:quarterly');
    }
  }
  if (modes.includes('yearly')) {
    const mIdx = now.getMonth() + 1;
    const mKey = `${now.getFullYear()}-${pad2(mIdx)}`;
    if (markers.yearly !== mKey && !scheduleAlreadyNotified('schedule-today:yearly', startOfMonth)) {
      const count = (DATA.yearlySchedule[mIdx] || []).filter(b => !b.deleted).length;
      markers.yearly = mKey; changed = true;
      if (count) logNotify('الجدول', `🗓️ وصل شهر ${MONTH_NAMES[mIdx - 1]} — جدولك السنوي`, `${count} عنصر مجدول لهذا الشهر — اضغط لعرضه`, 'schedule-today:yearly');
    }
  }
  if (changed) persist();
}

/* ---------------- تنبيه مقارنة الشهر بالشهر السابق (بعد 15 يومًا، ثم بعد أسبوع إضافي) ---------------- */
function checkMonthComparisonAlert() {
  if (!DATA.settings.monthComparisonAlertsEnabled) return;
  const today = new Date();
  const day = today.getDate();
  if (day < 15) return;
  const trigger = day >= 22 ? 'day22' : 'day15';
  const y = today.getFullYear(), m = today.getMonth() + 1;
  const logKey = `${y}-${pad2(m)}_${trigger}`;
  if (isSyncFlagOn('mc', logKey)) return; // العلامة تتزامن: لا يصل التنبيه مرة ثانية من جهاز آخر

  const prevM = m === 1 ? 12 : m - 1, prevY = m === 1 ? y - 1 : y;
  let anyCompared = false;
  DATA.settings.currencies.forEach(cur => {
    const thisNet = txByKind('income').filter(t => t.currency === cur && inMonth(t.date, y, m)).reduce((s, t) => s + t.amount, 0)
      - txByKind('expense').filter(t => t.currency === cur && inMonth(t.date, y, m)).reduce((s, t) => s + t.amount, 0);
    const prevNet = txByKind('income').filter(t => t.currency === cur && inMonth(t.date, prevY, prevM)).reduce((s, t) => s + t.amount, 0)
      - txByKind('expense').filter(t => t.currency === cur && inMonth(t.date, prevY, prevM)).reduce((s, t) => s + t.amount, 0);
    if (thisNet === 0 && prevNet === 0) return;
    anyCompared = true;
    const diff = thisNet - prevNet;
    const verdict = diff > 0 ? `أفضل بـ${fmt(Math.abs(diff))} ${cur} من` : diff < 0 ? `أسوأ بـ${fmt(Math.abs(diff))} ${cur} من` : `مساوٍ لـ`;
    logNotify('إحصائيات', `مقارنة الشهر (${cur})`, `${MONTH_NAMES[m - 1]} حتى الآن ${verdict} ${MONTH_NAMES[prevM - 1]}`, null, { v: 'dashboard', focus: 'insights:' + cur }, { id: `mc_${logKey}_${cur}` });
  });
  if (anyCompared) { setSyncFlag('mc', logKey, true); persist(); }
}

/* ============================================================
   مركز التحكم (مع تعديل الآن، مو فقط حذف)
   ============================================================ */
/* ============================================================
   🏦 أموالي: الحسابات والأصول + الاقتطاعات المتكررة التلقائية
   ============================================================ */
let wealthTab = 'assets';
let editingAssetId = null, editingAssetTypeId = null;
// أنواع الأصول الافتراضية عند أول تشغيل — بعدها تصبح قابلة للتعديل بالكامل (إضافة/تعديل/حذف) من مركز التحكم
const DEFAULT_ASSET_TYPES = [
  { id: 'cash', icon: '💵', name: 'نقدًا' },
  { id: 'bank', icon: '🏦', name: 'حساب بنكي' },
  { id: 'card', icon: '💳', name: 'بطاقة' },
  { id: 'ewallet', icon: '📱', name: 'محفظة إلكترونية' },
  { id: 'project', icon: '📦', name: 'مشروع/استثمار' },
  { id: 'other', icon: '💎', name: 'أصل آخر' },
];
function assetTypeLabel(typeId) { const t = DATA.assetTypes.find(x => x.id === typeId); return t ? `${t.icon} ${t.name}` : (typeId || '—'); }

function assetTypeName(typeId) { const t = DATA.assetTypes.find(x => x.id === typeId); return t ? t.name : ''; }
function assetTypeIcon(typeId) { const t = DATA.assetTypes.find(x => x.id === typeId); return t ? t.icon : '💠'; }
// العملية المرتبطة بحركة مالية (دخل/مصروف/دين/دفعة عميل/إخراج) تبقى "حيّة" فقط ما دامت حركتها الأصلية حيّة —
// فلو حُذفت الحركة (أو أُلغي تسليم الإخراج) يتراجع أثرها على الأصل تلقائيًا بدون أي كود حذف إضافي بكل مكان
function liveOps() {
  const linked = DATA.assetOps.some(o => !o.deleted && o.srcId);
  let aliveTx = null, aliveZk = null;
  if (linked) {
    aliveTx = new Set(); DATA.transactions.forEach(t => { if (!t.deleted) aliveTx.add(t.id); });
    aliveZk = new Set(); DATA.zakatPayments.forEach(z => { if (!z.deleted && z.delivered) aliveZk.add(z.id); });
  }
  return DATA.assetOps.filter(o => {
    if (o.deleted) return false;
    if (!o.srcId) return true;
    return o.srcType === 'zakat' ? aliveZk.has(o.srcId) : aliveTx.has(o.srcId);
  });
}
// القيمة الحالية للأصل = الرصيد الافتتاحي القديم (a.value، للأصول المُدخَلة قبل نظام النوافذ) + مجموع كل عملياته الحيّة (assetOps).
// ⚠️ لا نخزّن الناتج بل نحسبه دائمًا — حتى لو أضاف جهازان عمليتين مختلفتين لنفس الأصل أثناء انقطاع النت، تندمج العمليتان
// بالمزامنة (اتحاد بالـid) ويطلع الرصيد صحيحًا بدل أن تطغى قيمة جهاز على الآخر.
function assetValue(a, _ops) {
  let v = Number(a.value) || 0;
  (_ops || liveOps()).forEach(o => { if (o.assetId === a.id) v += Number(o.amount) || 0; });
  return Math.round(v * 100) / 100;
}
function assetOpsOf(assetId) {
  return liveOps().filter(o => o.assetId === assetId)
    .sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : (b.createdAt || 0) - (a.createdAt || 0)));
}
// الأصل الذي تُضاف إليه العملية الجديدة: نفس النوع + نفس العملة (النوع هو اسم الأصل: rip / بنك / كاش...).
// لو وُجد أكثر من أصل قديم بنفس النوع والعملة نفضّل الذي اسمه = اسم النوع، وإلا الأقدم
function findAssetForType(typeId, currency) {
  const list = DATA.assets.filter(a => !a.deleted && a.type === typeId && a.currency === currency);
  if (!list.length) return null;
  const tn = assetTypeName(typeId).trim().toLowerCase();
  return list.find(a => String(a.name || '').trim().toLowerCase() === tn) || [...list].sort((a, b) => (a.createdAt || 0) - (b.createdAt || 0))[0];
}
function addAssetOp(asset, { id, amount, who, date, note, kind, transferId, counterAssetId, srcType, srcId, src }) {
  const now = Date.now();
  const op = { id: id || uid(), assetId: asset.id, kind: kind || (amount >= 0 ? 'in' : 'out'), amount, who: who || '', date: date || todayISO(), note: note || '',
    createdAt: now, updatedAt: now, deleted: false };
  if (transferId) op.transferId = transferId;
  if (counterAssetId) op.counterAssetId = counterAssetId;
  if (srcId) { op.srcType = srcType || 'tx'; op.srcId = srcId; op.src = src || ''; } // ربط بالحركة المالية الأصلية
  DATA.assetOps.push(op);
  asset.lastUpdatedAt = now; asset.updatedAt = now;
  return op;
}
// الرجوع إلى مكان العملية في الشهر: يفتح شهر التاريخ ويضيء اليوم لو فيه حركة دخل/مصروف مسجّلة بنفس اليوم
function goToAssetOpDay(date, kindHint) {
  if (!date) return;
  const [y, m] = date.split('-').map(Number);
  const has = (kind) => DATA.transactions.some(t => !t.deleted && t.date === date && t.kind === kind);
  const kind = kindHint || (has('income') ? 'income' : has('expense') ? 'expense' : 'income');
  navYear = y; navMonth = m; monthTab = kind;
  if (kind !== 'outflows' && has(kind)) openDays.add(date + '_' + kind);
  showView('yearly');
  requestAnimationFrame(() => {
    const dayEl = document.querySelector(`#view-yearly .day-group[data-date="${date}"]`);
    if (dayEl) { dayEl.scrollIntoView({ behavior: 'smooth', block: 'center' }); dayEl.classList.add('jump-highlight'); setTimeout(() => dayEl.classList.remove('jump-highlight'), 1600); }
    else toast('لا توجد حركات دخل/مصروف مسجّلة في هذا اليوم — فُتح الشهر');
  });
}
// التراجع عن تحويل: التحويلات الجديدة لها عمليتان مرتبطتان (نحذفهما ناعمًا)، والتحويلات القديمة (قبل نظام النوافذ) كانت تعدّل a.value مباشرة فنعكس أثرها عليه
function undoAssetTransfer(t) {
  const now = Date.now();
  const linked = DATA.assetOps.filter(o => !o.deleted && o.transferId === t.id);
  if (linked.length) linked.forEach(o => { o.deleted = true; o.updatedAt = now; });
  else {
    const from = DATA.assets.find(a => a.id === t.fromAssetId), to = DATA.assets.find(a => a.id === t.toAssetId);
    if (from) { from.value = (Number(from.value) || 0) + t.amount; from.updatedAt = now; }
    if (to) { to.value = (Number(to.value) || 0) - t.amount; to.updatedAt = now; }
  }
  t.deleted = true; t.updatedAt = now;
}

/* ============================================================
   🔗 ربط العمليات المالية بقسم "أموالي"
   كل حركة مال حقيقية (دخل / مصروف / دفعة عميل / دين وتسديده / إخراج مُسلَّم) تفتح نافذة تسأل: أين أُضيف هذا المبلغ (أو من أين خرج)؟
   يمكن توزيعه على عدة أصول (كاش 5000 + بنك 2000)، وما تبقّى يُسجَّل دينًا (لم يُحصَّل / لم يُدفَع بعد) أو يُترك.
   ============================================================ */
const ASSET_SRC_LABEL = { income: '💰 دخل', expense: '🧾 مصروف', client: '👤 عميل', debt: '🤝 دين', zakat: '🕌 إخراج' };
let allocQueue = [], allocDialogOpen = false;
function assetPromptEnabled() { return true; } // إلزامي: كل حركة مال تدخل أو تخرج لازم تُؤكَّد وتُوزَّع بشكل صحيح
function txAllocSrc(t) { return t.mode === 'client' ? 'client' : t.mode === 'debt' ? 'debt' : t.kind === 'income' ? 'income' : 'expense'; }
const round2 = (n) => Math.round(n * 100) / 100;

/* ---------- مصدر العملية (الحركة الأصلية): قراءة/تعديل/حذف — كل تغيير هنا يبقي الأقسام كلها متوافقة مع الأصول ---------- */
function sourceAmountOf(srcType, srcId) {
  if (srcType === 'zakat') { const z = DATA.zakatPayments.find(x => x.id === srcId); return z ? z.amount : 0; }
  const t = DATA.transactions.find(x => x.id === srcId); return t ? t.amount : 0;
}
// تعديل مبلغ الحركة الأصلية (تخفيض أو تعديل) مع تحديث كل ما يعتمد عليها (دفعات المشروع، مسدَّد الدين، مبلغ الدين الأصلي)
function setSourceAmount(srcType, srcId, newAmount) {
  const now = Date.now(); newAmount = round2(newAmount);
  if (srcType === 'zakat') { const z = DATA.zakatPayments.find(x => x.id === srcId); if (z) { z.amount = newAmount; z.updatedAt = now; } return; }
  const t = DATA.transactions.find(x => x.id === srcId); if (!t) return;
  t.amount = newAmount; t.updatedAt = now;
  if (t.mode === 'client') { const p = DATA.projects.find(x => x.id === t.projectId); if (p) { syncProjectPaidCache(p); p.updatedAt = now; } }
  if (t.mode === 'debt') { const d = DATA.debts.find(x => x.id === t.debtId); if (d) { if (t.debtOrigin) d.amount = newAmount; syncDebtPaidCache(d); d.updatedAt = now; } }
}
function setSourceDate(srcType, srcId, date) {
  const now = Date.now();
  if (srcType === 'zakat') { const z = DATA.zakatPayments.find(x => x.id === srcId); if (z) { z.date = date; z.updatedAt = now; } }
  else {
    const t = DATA.transactions.find(x => x.id === srcId); if (!t) return;
    t.date = date; t.updatedAt = now;
    if (t.mode === 'debt' && t.debtOrigin) { const d = DATA.debts.find(x => x.id === t.debtId); if (d) { d.date = date; d.updatedAt = now; } }
  }
  DATA.assetOps.forEach(o => { if (!o.deleted && o.srcId === srcId && o.date !== date) { o.date = date; o.updatedAt = now; } });
}
// حذف الحركة الأصلية كليًا مع كل ما ولد منها (دين متبقٍّ لم يُسدَّد منه شيء، دين أصلي بتسديداته، أثر الدفعة على المشروع/الدين)
function deleteSourceEntirely(srcType, srcId) {
  const now = Date.now();
  if (srcType === 'zakat') { const z = DATA.zakatPayments.find(x => x.id === srcId); if (z) { z.deleted = true; z.updatedAt = now; } return; }
  const t = DATA.transactions.find(x => x.id === srcId); if (!t) return;
  t.deleted = true; t.updatedAt = now;
  DATA.debts.filter(d => !d.deleted && d.fromTxId === t.id).forEach(d => {
    if (computeDebtPaid(d) > 0) return; // سُدِّد منه جزء: يبقى حفاظًا على السجل
    d.deleted = true; d.updatedAt = now; removeDebtLinkedTxs(d.id);
  });
  if (t.mode === 'client') { const p = DATA.projects.find(x => x.id === t.projectId); if (p) { syncProjectPaidCache(p); p.updatedAt = now; } }
  if (t.mode === 'debt') {
    const d = DATA.debts.find(x => x.id === t.debtId);
    if (d) {
      if (t.debtOrigin && !d.deleted) { d.deleted = true; d.updatedAt = now; removeDebtLinkedTxs(d.id); }
      else { syncDebtPaidCache(d); d.updatedAt = now; }
    }
  }
}
function opSourceHasRemainderDebt(srcId) { return DATA.debts.some(d => !d.deleted && d.fromTxId === srcId); }
// ماذا يحدث للحركة الأصلية عند حذف/إزالة هذه العملية من الأصل؟ → 'delete' أو 'reduce' (مع المبلغ الجديد)
function planOpCascade(o) {
  const srcAmt = sourceAmountOf(o.srcType, o.srcId);
  const siblings = liveOps().filter(x => x.srcId === o.srcId && x.id !== o.id);
  const newAmt = round2(srcAmt - Math.abs(o.amount));
  if (newAmt <= 0.004 || (!siblings.length && !opSourceHasRemainderDebt(o.srcId))) return { action: 'delete', from: srcAmt };
  return { action: 'reduce', from: srcAmt, to: newAmt };
}
function cascadeDeleteAssetOp(o) {
  const plan = o.srcId ? planOpCascade(o) : null; // قبل أي تعديل
  o.deleted = true; o.updatedAt = Date.now();
  if (!plan) return;
  if (plan.action === 'delete') deleteSourceEntirely(o.srcType, o.srcId); else setSourceAmount(o.srcType, o.srcId, plan.to);
}
function describeOpCascade(o) {
  const plan = planOpCascade(o);
  const where = { income: 'قسم الدخل', expense: 'قسم المصاريف', client: 'قسم العملاء', debt: 'قسم الديون', zakat: 'قسم الإخراجات' }[o.src] || 'القسم المرتبط';
  const cur = (DATA.assets.find(a => a.id === o.assetId) || {}).currency || '';
  if (plan.action === 'delete') {
    let extra = '';
    if (o.src === 'debt') { const t = DATA.transactions.find(x => x.id === o.srcId); if (t && t.debtOrigin) extra = ' (وهي أصل الدين، فيُحذف الدين كاملًا مع كل تسديداته)'; }
    return `هذه العملية مرتبطة بـ${where}${o.who ? ' (' + escHtml(o.who) + ')' : ''} — ستُحذف من هناك أيضًا${extra} حتى لا يحدث خلل في الحسابات.`;
  }
  return `هذه العملية جزء من حركة في ${where}${o.who ? ' (' + escHtml(o.who) + ')' : ''} — سيُخفَّض مبلغ الحركة هناك من ${bidi(fmt(plan.from))} إلى ${bidi(fmt(plan.to))} ${cur} حتى تبقى الحسابات متطابقة.`;
}

// يُستدعى بعد إنشاء أي حركة مال: يضع نافذة التوزيع في الطابور (لا تتداخل نافذتان)
function offerAssetAllocation(spec) {
  if (!spec || !(spec.amount > 0)) return;
  if (!DATA.assetTypes.some(t => !t.deleted)) return;
  allocQueue.push(spec);
  if (!allocDialogOpen) nextAllocDialog();
}
// للحركة المالية العادية (t): يبني المواصفات تلقائيًا
function offerAssetAllocationForTx(t, extra) {
  if (!t || t.noAsset || t.deleted) return;
  const who = t.mode === 'client' ? sourceName(t).split(' — ')[0] : t.mode === 'debt' ? (t.debtName || '') : sourceName(t);
  const isIn = t.kind === 'income';
  let reduceLabel = isIn ? 'غير مقبوض — أسجّل المبلغ الموزَّع فقط' : 'غير مدفوع — أسجّل المبلغ الموزَّع فقط';
  if (t.mode === 'client') reduceLabel = 'غير مسدَّد من العميل — يبقى مستحقًا عليه، وتُسجَّل الدفعة الموزَّعة فقط';
  else if (t.mode === 'debt' && t.debtPayment) reduceLabel = 'الباقي لم يُسدَّد بعد — تُسجَّل الدفعة الموزَّعة فقط';
  else if (t.mode === 'debt') reduceLabel = 'أسجّل المبلغ الموزَّع فقط (يُخفَّض مبلغ الدين)';
  offerAssetAllocation(Object.assign({ srcType: 'tx', srcId: t.id, src: txAllocSrc(t), direction: isIn ? 'in' : 'out',
    amount: t.amount, currency: t.currency, date: t.date, who, note: t.note || '', allowDebt: t.mode === 'general' || t.mode === 'client', reduceLabel,
    title: `${isIn ? 'أين تضيف' : 'من أين خرج'} ${fmt(t.amount)} ${t.currency}؟`, subtitle: `${ASSET_SRC_LABEL[txAllocSrc(t)]} · ${who}` }, extra || {}));
}
function nextAllocDialog() {
  const spec = allocQueue.shift();
  if (!spec) { allocDialogOpen = false; return; }
  allocDialogOpen = true;
  renderAllocDialog(spec);
}
// نافذة إلزامية: لا تُغلق إلا بتوزيع صحيح كامل، أو بإلغاء العملية نفسها (لا يوجد "تخطي" — كل مال يدخل/يخرج لازم يُحسب صح)
function renderAllocDialog(spec) {
  let panel = document.getElementById('assetAllocPanel');
  if (!panel) { panel = document.createElement('div'); panel.id = 'assetAllocPanel'; document.body.appendChild(panel); }
  panel.classList.remove('hidden');
  const dir = spec.direction === 'out' ? 'out' : 'in';
  const types = DATA.assetTypes.filter(t => !t.deleted);
  const last = (DATA.settings.lastAllocType || {})[dir];
  const defType = types.some(t => t.id === last) ? last : types[0].id;
  let rows = spec.prefill && spec.prefill.length ? spec.prefill.map(r => ({ ...r })) : [{ typeId: defType, amount: spec.amount }];
  let cancelArmed = false, resolveMode = '', debtRows = [{ name: spec.debtDefaultName || '', amount: 0 }];
  const closeAndNext = () => { panel.classList.add('hidden'); panel.innerHTML = ''; render(activeView); refreshMonthSummary(); nextAllocDialog(); };
  const typeOpts = (sel) => types.map(t => `<option value="${t.id}" ${t.id === sel ? 'selected' : ''}>${t.icon} ${t.name}</option>`).join('');
  const readRows = () => $$('#assetAllocPanel [data-arow]').map(r => ({ typeId: r.querySelector('select').value, amount: parseFloat(r.querySelector('input').value) || 0 }));
  const uniqueDebtorNames = () => [...new Set(DATA.debts.filter(d => !d.deleted).map(d => String(d.name || '').trim()).filter(Boolean))];
  const readDebtRows = () => $$('#assetAllocPanel [data-drow]').map(r => ({ name: r.querySelector('input[type=text]').value.trim(), amount: parseFloat(r.querySelector('input[type=number]').value) || 0 }));
  const resolveOpts = [];
  if (spec.allowDebt) resolveOpts.push({ v: 'debt', l: dir === 'in' ? 'دين لي عند شخص (يُضاف لقسم الديون)' : 'دين عليّ لشخص (يُضاف لقسم الديون)' });
  resolveOpts.push({ v: 'reduce', l: spec.reduceLabel || 'أسجّل المبلغ الموزَّع فقط' });
  const draw = () => {
    panel.innerHTML = `<div id="assetAllocBox">
      <div style="font-size:16px; font-weight:800;">${dir === 'in' ? '📥' : '📤'} ${spec.title}</div>
      ${spec.subtitle ? `<div class="muted" style="font-size:12px; margin-top:4px;">${escHtml(spec.subtitle)}</div>` : ''}
      <div id="allocRows" style="margin-top:14px; display:flex; flex-direction:column; gap:8px;">
        ${rows.map((r, i) => `<div data-arow style="display:flex; gap:8px; align-items:center;">
          <select style="flex:1.2;">${typeOpts(r.typeId)}</select>
          <input type="number" style="flex:1;" min="0" value="${r.amount != null ? r.amount : ''}" placeholder="المبلغ">
          ${rows.length > 1 ? `<button class="btn ghost sm" data-arowdel="${i}" title="حذف هذا السطر">✕</button>` : ''}</div>`).join('')}
      </div>
      <div class="form-actions" style="margin-top:8px;"><button class="btn ghost sm" id="allocAddRow">+ توزيع على أصل آخر</button></div>
      <div id="allocRemainder" style="margin-top:10px; font-size:12.5px;"></div>
      <div id="allocResolveBox" style="display:none; margin-top:8px; padding:10px; border:1px dashed var(--border); border-radius:12px;">
        <label class="field" style="margin:0;">ماذا نفعل بالباقي؟
          <select id="allocResolveMode"><option value="">— اختر —</option>${resolveOpts.map(o => `<option value="${o.v}" ${resolveMode === o.v ? 'selected' : ''}>${o.l}</option>`).join('')}</select></label>
      </div>
      <div id="allocDebtRows" style="margin-top:8px; display:none; flex-direction:column; gap:8px;">
        ${debtRows.map((r, i) => `<div data-drow style="display:flex; gap:8px; align-items:center;">
          <input type="text" list="existingDebtorsDatalist" style="flex:1.3; min-width:0;" placeholder="اسم الشخص (اختر موجود أو اكتب جديد)" value="${escHtml(r.name || '')}">
          <input type="number" style="flex:1; min-width:0;" min="0" value="${r.amount != null ? r.amount : ''}" placeholder="المبلغ">
          ${debtRows.length > 1 ? `<button class="btn ghost sm" data-drowdel="${i}" title="حذف">✕</button>` : ''}</div>`).join('')}
        <button class="btn ghost sm" id="allocDebtAddRow" type="button" style="align-self:flex-start;">+ أضف شخصًا آخر (توزيع الباقي على أكثر من شخص)</button>
        <div id="allocDebtRemainder" class="muted" style="font-size:11px;"></div>
      </div>
      <datalist id="existingDebtorsDatalist">${uniqueDebtorNames().map(n => `<option value="${escHtml(n)}"></option>`).join('')}</datalist>
      <div class="muted" style="font-size:11px; margin-top:10px;">لا تُغلق هذه النافذة إلا بعد أن تُحسَب العملية بشكل صحيح: وزّع المبلغ كاملًا، أو اختر ما يُفعل بالباقي.</div>
      <div class="form-actions" style="justify-content:center; margin-top:14px;">
        <button class="btn" id="allocConfirm">تأكيد</button>
        <button class="btn ghost" id="allocCancel" style="${cancelArmed ? 'color:var(--red); border-color:var(--red);' : ''}">${spec.keepPending ? 'لاحقًا' : cancelArmed ? '⚠️ نعم، ألغِ العملية' : (spec.revert ? 'تراجع عن التعديل' : 'إلغاء العملية')}</button>
      </div></div>`;
    const update = () => {
      const cur = readRows(); const total = cur.reduce((x, r) => x + r.amount, 0); const rem = round2(spec.amount - total);
      const box = $('#allocRemainder', panel);
      box.innerHTML = rem > 0.004 ? `<span style="color:var(--amber);">المتبقي بدون توزيع: <b>${bidi(fmt(rem) + ' ' + spec.currency)}</b></span>`
        : rem < -0.004 ? `<span style="color:var(--red);">المجموع أكبر من المبلغ بـ <b>${bidi(fmt(-rem) + ' ' + spec.currency)}</b></span>`
        : `<span style="color:var(--green);">✓ تم توزيع المبلغ كاملًا</span>`;
      $('#allocResolveBox', panel).style.display = rem > 0.004 ? 'block' : 'none';
      const showDebtRows = rem > 0.004 && resolveMode === 'debt';
      const debtRowsBox = $('#allocDebtRows', panel);
      debtRowsBox.style.display = showDebtRows ? 'flex' : 'none';
      if (showDebtRows) {
        const debtTotal = round2(readDebtRows().reduce((x, r) => x + r.amount, 0));
        const debtRem = round2(rem - debtTotal);
        $('#allocDebtRemainder', panel).innerHTML = Math.abs(debtRem) < 0.004 ? `<span style="color:var(--green);">✓ وُزِّع الباقي كاملًا على الأشخاص</span>`
          : debtRem > 0 ? `متبقٍّ بلا شخص محدَّد: <b>${bidi(fmt(debtRem) + ' ' + spec.currency)}</b>`
          : `<span style="color:var(--red);">المجموع أكبر من الباقي بـ ${bidi(fmt(-debtRem) + ' ' + spec.currency)}</span>`;
      }
    };
    panel.oninput = () => update();
    $('#allocResolveMode', panel).addEventListener('change', (e) => { resolveMode = e.target.value; update(); });
    update();
    $('#allocDebtAddRow', panel)?.addEventListener('click', () => {
      rows = readRows(); debtRows = readDebtRows();
      const rem = round2(spec.amount - rows.reduce((x, r) => x + r.amount, 0));
      const debtRem = round2(rem - debtRows.reduce((x, r) => x + r.amount, 0));
      debtRows.push({ name: '', amount: debtRem > 0 ? debtRem : 0 }); draw();
    });
    $$('[data-drowdel]', panel).forEach(b => b.addEventListener('click', () => { rows = readRows(); debtRows = readDebtRows(); debtRows.splice(parseInt(b.dataset.drowdel), 1); draw(); }));
    $('#allocAddRow', panel).addEventListener('click', () => {
      rows = readRows(); debtRows = readDebtRows(); const rem = round2(spec.amount - rows.reduce((x, r) => x + r.amount, 0));
      rows.push({ typeId: defType, amount: rem > 0 ? rem : 0 }); draw();
    });
    $$('[data-arowdel]', panel).forEach(b => b.addEventListener('click', () => { rows = readRows(); debtRows = readDebtRows(); rows.splice(parseInt(b.dataset.arowdel), 1); draw(); }));
    $('#allocCancel', panel).addEventListener('click', () => {
      if (spec.keepPending) { toast('بقي بانتظار الأصل — تجده في الأموال ← الاقتطاعات المتكررة'); closeAndNext(); return; } // اقتطاع متكرر: لا نحذفه، فقط نؤجّل الاختيار
      if (!cancelArmed) { rows = readRows(); debtRows = readDebtRows(); cancelArmed = true; draw(); return; }
      const now = Date.now();
      if (spec.revert && spec.srcType === 'tx') { const t = DATA.transactions.find(x => x.id === spec.srcId); if (t) { t.amount = spec.revert.amount; t.currency = spec.revert.currency; t.updatedAt = now; } }
      else if (spec.srcType === 'zakat') { const z = DATA.zakatPayments.find(x => x.id === spec.srcId); if (z) { z.delivered = false; z.updatedAt = now; } }
      else {
        deleteSourceEntirely(spec.srcType, spec.srcId);
        if (spec.createdProjectId) { const pr = DATA.projects.find(x => x.id === spec.createdProjectId); if (pr && !projectPaymentsOf(pr).length) { pr.deleted = true; pr.updatedAt = now; } }
      }
      persist(true); evaluateAlerts(); toast(spec.revert ? 'تم التراجع عن التعديل' : 'أُلغيت العملية');
      closeAndNext();
    });
    $('#allocConfirm', panel).addEventListener('click', () => {
      const cur = readRows().filter(r => r.amount > 0);
      const total = round2(cur.reduce((x, r) => x + r.amount, 0)); const rem = round2(spec.amount - total);
      if (rem < -0.004) return toast('مجموع التوزيع أكبر من المبلغ');
      let mode = '';
      if (rem > 0.004) {
        mode = resolveMode; if (!mode) return toast('اختر ما يُفعل بالباقي ' + fmt(rem) + ' ' + spec.currency);
      }
      // يجوز ترك كل الأصول بلا توزيع (0) طالما اختير ماذا يُفعل بكامل المبلغ كباقٍ (دين مثلًا) — لا يُشترط توزيع جزء على أصل حتمًا
      if (!cur.length && !mode) return toast('وزّع مبلغًا على أصل واحد على الأقل، أو اختر ماذا نفعل بالباقي، أو اضغط إلغاء العملية');
      let debtEntries = [];
      if (mode === 'debt') {
        debtEntries = readDebtRows().filter(r => r.amount > 0);
        if (!debtEntries.length) return toast('أضف شخصًا واحدًا على الأقل لتسجيل الدَّين');
        if (debtEntries.some(r => !r.name)) return toast('اكتب اسم كل شخص بقائمة الدَّين');
        const debtTotal = round2(debtEntries.reduce((x, r) => x + r.amount, 0));
        if (Math.abs(debtTotal - rem) > 0.004) return toast(`مجموع توزيع الدَّين (${fmt(debtTotal)}) لازم يساوي الباقي (${fmt(rem)} ${spec.currency})`);
      }
      const now = Date.now();
      // إعادة التوزيع: نلغي التوزيع القديم لنفس الحركة أولًا
      if (spec.replaceOld) {
        DATA.assetOps.forEach(o => { if (!o.deleted && o.srcId === spec.srcId) { o.deleted = true; o.updatedAt = now; } });
        DATA.debts.filter(d => !d.deleted && d.fromTxId === spec.srcId && computeDebtPaid(d) === 0).forEach(d => { d.deleted = true; d.updatedAt = now; removeDebtLinkedTxs(d.id); });
      }
      if (mode === 'reduce') setSourceAmount(spec.srcType, spec.srcId, total); // تُسجَّل الحركة بالمبلغ الموزَّع فقط
      cur.forEach(r => {
        let asset = findAssetForType(r.typeId, spec.currency);
        if (!asset) { asset = { id: uid(), type: r.typeId, name: assetTypeName(r.typeId) || 'أصل', value: 0, currency: spec.currency, notes: '', lastUpdatedAt: now, createdAt: now, updatedAt: now, deleted: false }; DATA.assets.push(asset); }
        addAssetOp(asset, { amount: dir === 'in' ? r.amount : -r.amount, who: spec.who || '', date: spec.date, note: spec.note || '', kind: dir, srcType: spec.srcType, srcId: spec.srcId, src: spec.src });
        setPanelOpen('assetwin_' + asset.id, true);
      });
      if (spec.srcType === 'tx') { const st = DATA.transactions.find(x => x.id === spec.srcId); if (st && st.assetPending) { st.assetPending = false; st.updatedAt = now; } } // اقتطاع متكرر كان بانتظار الأصل
      if (cur.length) DATA.settings.lastAllocType = Object.assign({}, DATA.settings.lastAllocType, { [dir]: cur[0].typeId }); // لو كل المبلغ راح لدَين بلا أي أصل، ما فيه نوع أصل نحفظه كـ"آخر مستخدَم"
      if (mode === 'debt') {
        // الباقي دَين: لك عند الشخص (لو دخل) أو عليك له (لو مصروف)، وقد يتوزّع على أكثر من شخص. حركة الدين
        // المقابلة تعادل الجزء غير المقبوض/غير المدفوع في صافي التدفق النقدي (نفس منطق السلفة) — ولا تُربَط
        // بأي أصل لأن المال ما تحرّك فعلًا
        debtEntries.forEach(entry => {
          let debtName = entry.name;
          const prev = DATA.debts.find(d => !d.deleted && debtNameKey(d.name) === debtNameKey(debtName)); if (prev) debtName = String(prev.name).trim();
          const debt = { id: uid(), name: debtName, type: dir === 'in' ? 'they_owe_me' : 'i_owe', currency: spec.currency, amount: entry.amount, paidAmount: 0,
            date: spec.date, note: (dir === 'in' ? 'متبقٍّ غير محصَّل من: ' : 'متبقٍّ غير مدفوع من: ') + (spec.subtitle || ''), reminderAt: null, notifiedAt: null, flagged: false, fromTxId: spec.srcType === 'tx' ? spec.srcId : null,
            createdAt: now, updatedAt: now, deleted: false };
          DATA.debts.push(debt);
          addDebtLinkedTx(debt, dir === 'in' ? 'expense' : 'income', entry.amount, spec.date, debt.note, true, { noAsset: true });
        });
        toast(debtEntries.length > 1 ? `سُجِّل الدَّين موزَّعًا على ${debtEntries.length} أشخاص في قسم الديون`
          : `سُجِّل دين ${fmt(debtEntries[0].amount)} ${spec.currency} ${dir === 'in' ? 'لك عند' : 'عليك لـ'} ${debtEntries[0].name} في قسم الديون`);
      }
      persist(true); evaluateAlerts();
      closeAndNext();
    });
  };
  draw();
}
// عند تعديل حركة مرتبطة بأصول: نزامن التاريخ مباشرة، ولو تغيّر المبلغ/العملة نفتح نافذة التوزيع (إلزامية) بالتوزيع القديم كنقطة بداية
function resyncTxAssetOps(t, before) {
  const linked = DATA.assetOps.filter(o => !o.deleted && o.srcId === t.id);
  if (!linked.length) return;
  linked.forEach(o => { if (o.date !== t.date) { o.date = t.date; o.updatedAt = Date.now(); } });
  const sum = linked.reduce((x, o) => x + Math.abs(o.amount), 0);
  const assetOf = (o) => DATA.assets.find(a => a.id === o.assetId);
  const curChanged = linked.some(o => { const a = assetOf(o); return a && a.currency !== t.currency; });
  const remDebt = DATA.debts.filter(d => !d.deleted && d.fromTxId === t.id).reduce((x, d) => x + d.amount, 0);
  if (curChanged || Math.abs(sum + remDebt - t.amount) > 0.004) {
    toast('تغيّر المبلغ — أعد توزيعه على الأصول');
    offerAssetAllocationForTx(t, { replaceOld: true, revert: before || null, prefill: linked.map(o => { const a = assetOf(o); return { typeId: a ? a.type : DATA.assetTypes[0].id, amount: Math.abs(o.amount) }; }) });
  }
}

// صافي الثروة = (أصولك المُدخَلة يدويًا + أموالك عند الآخرين) − (ما عليك من ديون) — الديون تُسحب تلقائيًا من قسم الديون، لا تُدخَل هنا يدويًا مرة ثانية
function computeNetWorth(cur) {
  const manualAssets = DATA.assets.filter(a => !a.deleted && a.currency === cur).reduce((s, a) => s + assetValue(a), 0);
  const theyOweMe = DATA.debts.filter(d => !d.deleted && d.type === 'they_owe_me' && d.currency === cur).reduce((s, d) => s + Math.max(0, d.amount - computeDebtPaid(d)), 0);
  const iOwe = DATA.debts.filter(d => !d.deleted && d.type === 'i_owe' && d.currency === cur).reduce((s, d) => s + Math.max(0, d.amount - computeDebtPaid(d)), 0);
  return { manualAssets, theyOweMe, iOwe, totalAssets: manualAssets + theyOweMe, totalLiabilities: iOwe, netWorth: manualAssets + theyOweMe - iOwe };
}
// يأخذ لقطة يومية واحدة (أول مرة تُفتح فيها الصفحة أو يُشغَّل التطبيق ذلك اليوم) حتى يتكوّن منحنى صافي الثروة عبر الوقت تلقائيًا بلا أي جهد يدوي
function ensureTodaySnapshot() {
  const today = todayISO(), id = 'snap_' + today;
  const ex = (DATA.assetSnapshots || []).find(x => x.id === id);
  if (ex && !ex.deleted) return;
  const netWorth = {}; DATA.settings.currencies.forEach(cur => { netWorth[cur] = computeNetWorth(cur).netWorth; });
  const now = Date.now();
  if (ex) { ex.netWorth = netWorth; ex.deleted = false; ex.updatedAt = now; }
  else DATA.assetSnapshots.push({ id, date: today, netWorth, createdAt: now, updatedAt: now, deleted: false }); // معرّف ثابت لليوم → يتزامن بين الأجهزة
  const live = liveSnapshots();
  if (live.length > 730) { const cut = live.slice(0, live.length - 730); cut.forEach(x => { x.deleted = true; x.updatedAt = now; }); } // كابح: سنتان كحد أقصى (حذف ناعم حتى لا تعود بالمزامنة)
  persist(true);
}

function renderWealth() {
  ensureTodaySnapshot();
  const view = $('#view-wealth');
  view.innerHTML = `<h2 class="view-title">${label('nav_wealth')}</h2>
    <p class="view-sub">أصولك والتزاماتك الحقيقية، وصافي ثروتك عبر الوقت
      <button class="btn ghost sm" id="exportWealthBtn" style="margin-inline-start:8px;">📄 تصدير PDF</button></p>
    <div class="segmented" id="wealthTabSwitch">
      <button data-tab="assets" class="${wealthTab === 'assets' ? 'active' : ''}">🏦 الحسابات والأصول</button>
      <button data-tab="recurring" class="${wealthTab === 'recurring' ? 'active' : ''}">🔁 الاقتطاعات المتكررة</button>
    </div>
    <div id="wealthTabHost" style="margin-top:14px;"></div>`;
  $('#exportWealthBtn').addEventListener('click', async () => {
    const { html, filename } = buildWealthReportHtml(); toast('جارٍ إنشاء ملف PDF...');
    const res = await Platform.exportPDF(html, filename);
    if (res.ok) toast('تم حفظ التقرير: ' + res.filePath); else if (res.error) toast('تعذّر حفظ التقرير');
  });
  $('#wealthTabSwitch').addEventListener('click', (e) => { const b = e.target.closest('button[data-tab]'); if (!b) return; wealthTab = b.dataset.tab; renderWealth(); });
  const host = $('#wealthTabHost');
  if (wealthTab === 'assets') renderAssetsInto(host); else renderRecurringInto(host);
}

let wealthChartCurrency = null, wealthChartMode = 'together';
// دمج الأعمدة المتشابهة بالاسم: كل اسم (بغض النظر عن حالة الأحرف/المسافات) يظهر عمودًا واحدًا بمجموع قيمه —
// بدل ما كل دين/عملية جديدة لنفس الشخص (مثل Br) تضيف عمودًا جديدًا بنفس الاسم في "مقارنة الأصول والديون"
function mergeChartItemsByName(items) {
  const map = new Map();
  items.forEach(it => {
    const label = String(it.label == null ? '' : it.label).trim() || '—';
    const key = label.toLowerCase();
    const cur = map.get(key);
    if (cur) cur.value += it.value; else map.set(key, { ...it, label });
  });
  return Array.from(map.values());
}
function wealthCompareData(mode, cur) {
  const assetItems = mergeChartItemsByName(DATA.assets.filter(a => !a.deleted && a.currency === cur).map(a => ({ label: a.name || assetTypeName(a.type), value: assetValue(a), color: '#22d3a8' })));
  const theyOweItems = mergeChartItemsByName(DATA.debts.filter(d => !d.deleted && d.type === 'they_owe_me' && d.currency === cur).map(d => ({ label: d.name, value: Math.max(0, d.amount - computeDebtPaid(d)), color: '#42d8b8' })));
  const iOweItems = mergeChartItemsByName(DATA.debts.filter(d => !d.deleted && d.type === 'i_owe' && d.currency === cur).map(d => ({ label: d.name, value: Math.max(0, d.amount - computeDebtPaid(d)), color: '#ef5a6f' })));
  if (mode === 'assets') return [...assetItems, ...theyOweItems].filter(x => x.value > 0);
  if (mode === 'debts') return iOweItems.filter(x => x.value > 0);
  return [...assetItems, ...theyOweItems, ...iOweItems].filter(x => x.value > 0);
}
function renderAssetsInto(host) {
  const currencies = DATA.settings.currencies;
  const assets = DATA.assets.filter(a => !a.deleted);
  if (!wealthChartCurrency || !currencies.includes(wealthChartCurrency)) wealthChartCurrency = currencies[0];
  const transfers = DATA.assetTransfers.filter(t => !t.deleted).sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : b.createdAt - a.createdAt));
  const sections = currencies.map(cur => {
    const nw = computeNetWorth(cur);
    if (!nw.manualAssets && !nw.theyOweMe && !nw.iOwe) return '';
    const history = liveSnapshots().filter(s => s.netWorth && s.netWorth[cur] !== undefined).slice(-90);
    const chart = history.length >= 2
      ? richLineChart(history.map(s => s.netWorth[cur]), { color: nw.netWorth >= 0 ? '#22d3a8' : '#ef5a6f', xLabels: history.map(s => s.date.slice(5)), maxXLabels: 8, axisTag: 'صافي الثروة', height: 180 })
      : '<p class="muted" style="font-size:12px;">سيظهر منحنى صافي ثروتك هنا تلقائيًا مع مرور أيام الاستخدام (لقطة واحدة كل يوم).</p>';
    return `<div class="card" style="margin-top:14px;">
      <div class="cur-badge" style="color:${curColor(cur)}; font-size:13px; margin-bottom:8px;">${cur}</div>
      <div class="grid grid-3">
        <div class="stat-card"><div class="label">💰 إجمالي الأصول</div><div class="value">${bidi(fmt(nw.totalAssets))}</div>
          <div style="font-size:16px; font-weight:800; color:var(--text); margin-top:6px;">يدوي: ${bidi(fmt(nw.manualAssets))}</div>
          <div class="muted" style="font-size:11px; margin-top:2px;">+ عند الآخرين ${bidi(fmt(nw.theyOweMe))}</div></div>
        <div class="stat-card negative"><div class="label">🔴 إجمالي الالتزامات</div><div class="value">${bidi(fmt(nw.totalLiabilities))}</div>
          <div class="muted" style="font-size:11px; margin-top:4px;">مسحوبة تلقائيًا من قسم الديون</div></div>
        <div class="stat-card ${nw.netWorth >= 0 ? 'positive' : 'negative'}"><div class="label">💎 صافي الثروة</div><div class="value">${bidi(fmt(nw.netWorth))}</div></div>
      </div>
      <div style="margin-top:14px;">${chart}</div>
    </div>`;
  }).join('');

  const compareItems = wealthCompareData(wealthChartMode, wealthChartCurrency);
  host.innerHTML = `    ${sections || '<p class="muted">أضف أصلًا واحدًا على الأقل بالأسفل لتبدأ حساب ثروتك</p>'}

    <div class="card glass-panel" style="margin-top:14px;">
      <div style="display:flex; justify-content:space-between; align-items:center; flex-wrap:wrap; gap:10px;">
        <strong>📊 مقارنة الأصول والديون</strong>
        <div style="display:flex; gap:8px; flex-wrap:wrap;">
          <select id="wealthChartCur" style="width:auto;">${currencies.map(c => `<option ${c === wealthChartCurrency ? 'selected' : ''}>${c}</option>`).join('')}</select>
          <div class="segmented" id="wealthChartModeSwitch">
            <button data-wmode="assets" class="${wealthChartMode === 'assets' ? 'active' : ''}">الأصول</button>
            <button data-wmode="debts" class="${wealthChartMode === 'debts' ? 'active' : ''}">الديون</button>
            <button data-wmode="together" class="${wealthChartMode === 'together' ? 'active' : ''}">معًا</button>
          </div>
        </div>
      </div>
      <p class="muted" style="font-size:11px; margin-top:6px;">بعملة واحدة في كل مرة (بدون خلط عملات مختلفة برقم واحد). في وضع "معًا": الأخضر = أصول ولك عند الآخرين، الأحمر = عليك من ديون.</p>
      <div class="chart-wrap" style="margin-top:12px;">${cylinderBarChart(compareItems)}</div>
    </div>

    <div class="card glass-panel" style="margin-top:14px;">
      <strong>🔁 تحويل بين أصولك</strong>
      <p class="muted" style="font-size:11px; margin-top:4px;">مثال: حوّلت 10,000 من الكاش إلى حسابك البريدي — يسجَّل كتحويل واحد بتاريخه، وينقص من الأصل الأول ويزيد في الثاني تلقائيًا (لا يُحتسب دخلًا أو مصروفًا).</p>
      <div class="form-grid" style="margin-top:10px;">
        <select id="transfer_from">${assets.map(a => `<option value="${a.id}">${assetTypeIcon(a.type)} ${a.name} (${a.currency}) — ${bidi(fmt(assetValue(a)))}</option>`).join('')}</select>
        <select id="transfer_to">${assets.map(a => `<option value="${a.id}">${assetTypeIcon(a.type)} ${a.name} (${a.currency}) — ${bidi(fmt(assetValue(a)))}</option>`).join('')}</select>
        <input type="number" id="transfer_amount" placeholder="المبلغ">
        <input type="date" id="transfer_date" value="${todayISO()}">
        <textarea class="autogrow" rows="1" id="transfer_note" placeholder="ملاحظة (اختياري)" style="grid-column:span 2;"></textarea>
      </div>
      <div class="form-actions"><button class="btn sm" id="addTransferBtn">تنفيذ التحويل</button></div>
      ${transfers.length ? `<div class="debt-payments-list" style="margin-top:12px;">${transfers.map(t => {
        const from = DATA.assets.find(a => a.id === t.fromAssetId), to = DATA.assets.find(a => a.id === t.toAssetId);
        return `<div class="debt-payment-row"><span>🔁 ${from ? from.name : 'أصل محذوف'} ← ${to ? to.name : 'أصل محذوف'}: ${bidi(fmt(t.amount))} ${t.currency} <span class="muted">· ${t.date}</span>${notePreviewHtml(t.note)}</span>
          <span><button class="btn ghost sm" data-deltransfer="${t.id}" title="حذف والتراجع عن التحويل">✕</button></span></div>`;
      }).join('')}</div>` : ''}
    </div>

    <div style="margin-top:14px;"><strong>أصولك المُدخَلة يدويًا</strong>
      <p class="muted" style="font-size:11px; margin-top:4px;">كل أصل نافذة: اضغط عليه لتظهر كل عملياته بالتفصيل (كل عملية بتاريخها وصاحبها وملاحظتها وسهم يأخذك إلى يومها). "الأموال عند الآخرين" و"ما عليك من ديون" تُحسب تلقائيًا من قسم الديون فوق — لا تُدخلها هنا مرة ثانية حتى لا يتكرر الرقم.</p>
    </div>
    <div class="grid grid-3" style="margin-top:10px; align-items:start;">${assets.length === 0 ? '<p class="muted" style="font-size:12px;">لا توجد أصول مضافة بعد</p>' : assets.map(a => assetWindowHtml(a)).join('')}</div>
    <div class="card" style="margin-top:14px;">
      <details class="collapse-card" data-panel="add_asset"${panelOpenAttr('add_asset')}><summary>+ إضافة أصل / عملية على أصل</summary>
      <p class="muted" style="font-size:11px; margin-top:2px;">اختر الأصل من القائمة (مثل rip أو بنك أو كاش) — هذا هو اسمه، وإن كان موجودًا مسبقًا تُضاف العملية داخل نافذته ولا يُنشأ عمود جديد. خانة الاسم الثانية اختيارية: اكتب فيها اسم الشخص/المصدر (مثل: قاسم) لتُحفظ باسمه داخل نافذة الأصل.</p>
      <div class="form-grid" style="margin-top:10px;">
        <select id="asset_type" title="الأصل (نوعه هو اسمه)">${DATA.assetTypes.filter(t => !t.deleted).map(t => `<option value="${t.id}">${t.icon} ${t.name}</option>`).join('')}</select>
        <input type="text" id="asset_name" placeholder="اسم الشخص / المصدر (اختياري — مثال: قاسم)">
        <input type="number" id="asset_value" placeholder="المبلغ (سالب = خروج)">
        <select id="asset_currency">${currencies.map(c => `<option>${c}</option>`).join('')}</select>
        <input type="date" id="asset_date" value="${todayISO()}">
        <textarea class="autogrow" rows="1" id="asset_notes" placeholder="ملاحظات (اختياري)"></textarea>
      </div>
      <div class="form-actions"><button class="btn sm" id="addAssetBtn">إضافة</button></div>
    </details></div>`;
  bindAssetsEvents(host);
  bindPanelToggles(host);
}
let addingOpAssetId = null, editingAssetOpId = null;
const ASSET_OP_KIND_LABEL = { in: 'دخل', out: 'خرج', adjust: 'تعديل القيمة', transfer_in: 'تحويل وارد', transfer_out: 'تحويل صادر' };
function assetOpRowHtml(a, o) {
  const positive = o.amount >= 0;
  const isTransfer = o.kind === 'transfer_in' || o.kind === 'transfer_out';
  if (editingAssetOpId === o.id) {
    return `<div class="debt-entry"><div class="form-grid" style="grid-template-columns:1fr 1fr;">
      <label class="field">المبلغ (موجب)<input type="number" data-of="amount" value="${Math.abs(o.amount)}"></label>
      <label class="field">التاريخ<input type="date" data-of="date" value="${o.date || todayISO()}"></label>
      <label class="field" style="grid-column:span 2;">الاسم (اختياري)<input type="text" data-of="who" value="${escHtml(o.who || '')}"></label>
      <label class="field" style="grid-column:span 2;">ملاحظات<textarea class="autogrow" rows="1" data-of="note">${escHtml(o.note || '')}</textarea></label></div>
      <div class="form-actions"><button class="btn sm" data-saveassetop="${o.id}">حفظ</button><button class="btn ghost sm" data-cancelassetop>إلغاء</button></div></div>`;
  }
  const counter = isTransfer ? DATA.assets.find(x => x.id === o.counterAssetId) : null;
  const title = isTransfer
    ? `🔁 ${o.kind === 'transfer_out' ? 'تحويل إلى' : 'تحويل من'} ${escHtml(counter ? counter.name : 'أصل محذوف')}`
    : ((o.src ? `<span class="pill">${ASSET_SRC_LABEL[o.src] || ''}</span> ` : '') + (o.who ? `${o.src ? '' : '👤 '}${escHtml(o.who)}` : ''));
  // السهم ↗: للعملية المرتبطة بحركة مالية يذهب إلى تبويبها الصحيح (دخل/مصروف/إخراجات) وليس فقط إلى التاريخ
  let gotoKind = '';
  if (o.srcType === 'zakat') gotoKind = 'outflows';
  else if (o.srcId) { const tx = DATA.transactions.find(t => t.id === o.srcId); if (tx) gotoKind = tx.kind; }
  return `<div class="debt-entry">
    <div class="prow-head"><span><span class="pill" style="background:${positive ? 'rgba(34,211,168,.15)' : 'rgba(239,90,111,.15)'}; color:${positive ? 'var(--green)' : 'var(--red)'};">${ASSET_OP_KIND_LABEL[o.kind] || (positive ? 'دخل' : 'خرج')}</span>
      <span class="muted" style="font-size:11px; margin-inline-start:6px;">${o.date || ''}</span></span>
      <span style="color:${positive ? 'var(--green)' : 'var(--red)'}; font-weight:700;">${bidi((positive ? '+' : '-') + fmt(Math.abs(o.amount)) + ' ' + a.currency)}</span></div>
    ${title ? `<div style="font-size:12px; margin-top:4px;">${title}</div>` : ''}
    ${o.note ? `<div class="muted" style="font-size:11px; margin-top:4px;">📝 ${escHtml(o.note)}</div>` : ''}
    <div class="form-actions" style="margin-top:8px;">
      <button class="btn ghost sm" data-gotoassetop="${o.date || ''}" data-gotokind="${gotoKind}" title="اذهب إلى يوم هذه العملية">↗</button>
      ${isTransfer ? `<button class="btn ghost sm" data-delassetop="${o.id}" title="حذف التحويل والتراجع عن أثره على الأصلين">✕</button>`
        : `<button class="btn ghost sm" data-editassetop="${o.id}">تعديل</button><button class="btn ghost sm" data-delassetop="${o.id}">حذف</button>`}
    </div></div>`;
}
// نافذة أصل واحد (بنفس نظام نوافذ الديون): الرأس = اسم الأصل وقيمته الحالية، والداخل = كل عملياته بالتفصيل
function assetWindowHtml(a) {
  const stale = a.lastUpdatedAt && (Date.now() - a.lastUpdatedAt) > 120 * 24 * 3600 * 1000; // لم تُراجَع قيمته منذ أكثر من ~4 أشهر
  const value = assetValue(a);
  const ops = assetOpsOf(a.id);
  const opening = Math.round((Number(a.value) || 0) * 100) / 100;
  const panelKey = 'assetwin_' + a.id;
  const typeName = assetTypeName(a.type);
  const showTypeHint = typeName && String(a.name || '').trim().toLowerCase() !== typeName.trim().toLowerCase();
  const head = `<summary><div style="flex:1; min-width:0;">
      <div style="display:flex; justify-content:space-between; align-items:center; gap:8px;"><span style="font-weight:800;">${assetTypeIcon(a.type)} ${escHtml(a.name || typeName)}${showTypeHint ? ` <span class="muted" style="font-size:10.5px; font-weight:400;">· ${escHtml(typeName)}</span>` : ''}</span>
        <span style="color:${value >= 0 ? 'var(--green)' : 'var(--red)'}; font-weight:800;">${bidi(fmt(value) + ' ' + a.currency)}</span></div>
      <div class="muted" style="font-size:11px; margin-top:4px;">${ops.length} عملية${stale ? ' · <span style="color:var(--amber);">لم تُراجَع قيمته منذ فترة</span>' : ''}</div>
    </div></summary>`;
  const cls = `collapse-card card debt-card ${value >= 0 ? 'debt-positive' : 'debt-negative'}`;
  if (editingAssetId === a.id) {
    return `<details class="${cls}" data-focus="asset:${a.id}" data-panel="${panelKey}" open>${head}
      <div class="debt-entry"><div class="form-grid" style="grid-template-columns:1fr 1fr;">
        <label class="field">النوع<select data-af="type">${DATA.assetTypes.filter(t => !t.deleted || t.id === a.type).map(t => `<option value="${t.id}" ${a.type === t.id ? 'selected' : ''}>${t.icon} ${t.name}</option>`).join('')}</select></label>
        <label class="field">الاسم<input type="text" data-af="name" value="${escHtml(a.name)}"></label>
        <label class="field">القيمة الحالية<input type="number" data-af="value" value="${value}"></label>
        <label class="field">العملة<select data-af="currency">${DATA.settings.currencies.map(c => `<option ${c === a.currency ? 'selected' : ''}>${c}</option>`).join('')}</select></label></div>
        <p class="muted" style="font-size:11px; margin-top:6px;">💡 لو غيّرت القيمة يُسجَّل الفرق كعملية "تعديل القيمة" داخل النافذة (لا تضيع أي عملية سابقة).</p>
        <div class="form-actions"><button class="btn sm" data-saveasset="${a.id}">حفظ</button><button class="btn ghost sm" data-cancelasset>إلغاء</button></div></div></details>`;
  }
  const openingRow = opening !== 0 ? `<div class="debt-entry"><div class="prow-head"><span><span class="pill">رصيد سابق</span></span>
      <span style="color:${opening >= 0 ? 'var(--green)' : 'var(--red)'}; font-weight:700;">${bidi((opening >= 0 ? '+' : '-') + fmt(Math.abs(opening)) + ' ' + a.currency)}</span></div>
      <div class="muted" style="font-size:11px; margin-top:4px;">القيمة المُدخَلة قبل تفعيل نظام العمليات</div></div>` : '';
  const addForm = addingAssetOpFormOpen(a.id) ? `<div class="debt-entry"><div class="form-grid" style="grid-template-columns:1fr 1fr;">
      <select id="aop_kind_${a.id}"><option value="in">دخل (+)</option><option value="out">خرج (−)</option></select>
      <input type="number" id="aop_amount_${a.id}" placeholder="المبلغ">
      <input type="text" id="aop_who_${a.id}" placeholder="الاسم (اختياري — مثال: قاسم)">
      <input type="date" id="aop_date_${a.id}" value="${todayISO()}">
      <label class="aop-link-row" style="grid-column:span 2; display:flex; align-items:center; gap:8px; font-size:12.5px; cursor:pointer;"><input type="checkbox" id="aop_link_${a.id}" checked style="width:auto; flex:0 0 auto;"><span>سجّلها أيضًا كـ<b id="aop_linklbl_${a.id}">دخل</b> في قسمه (يظهر في الدخل/المصاريف والإحصائيات)</span></label>
      <div class="segmented" id="aop_srcmode_${a.id}" style="grid-column:span 2;">
        <button type="button" data-srcmode="general" class="active">مصدر عادي</button>
        <button type="button" data-srcmode="client">عميل</button>
      </div>
      <select id="aop_cat_${a.id}" style="grid-column:span 2;">${aopCategoryOptionsHtml('in')}</select>
      <div id="aop_clientfields_${a.id}" class="form-grid" style="grid-column:span 2; grid-template-columns:1fr 1fr; display:none;">
        <select id="aop_client_${a.id}" style="grid-column:span 2;"><option value="">— اختر عميل —</option>${DATA.clients.filter(c => !c.deleted).map(c => `<option value="${c.id}">${escHtml(c.name)} (${c.currency})</option>`).join('')}</select>
        <input type="text" id="aop_ptitle_${a.id}" placeholder="عنوان المشروع (اختياري)">
        <input type="number" id="aop_pagreed_${a.id}" placeholder="المتفق عليه (اختياري)">
        <p class="muted" style="grid-column:span 2; font-size:11px;">لا يوجد عملاء؟ أضفهم أولاً من "مركز التحكم".</p>
      </div>
      <textarea class="autogrow" rows="1" id="aop_note_${a.id}" placeholder="ملاحظات (اختياري)" style="grid-column:span 2;"></textarea></div>
      <div class="form-actions"><button class="btn sm" data-confirmop="${a.id}">حفظ العملية</button><button class="btn ghost sm" data-cancelop>إلغاء</button></div></div>` : '';
  return `<details class="${cls}" data-focus="asset:${a.id}" data-panel="${panelKey}"${panelOpenAttr(panelKey)}>${head}
    ${a.notes ? `<div class="muted" style="font-size:11px; margin-top:2px;">📝 ${escHtml(a.notes)}</div>` : ''}
    ${ops.length ? ops.map(o => assetOpRowHtml(a, o)).join('') : ''}
    ${openingRow}
    ${!ops.length && !openingRow ? '<p class="muted" style="font-size:12px; margin-top:6px;">لا توجد عمليات بعد</p>' : ''}
    ${addForm}
    <div class="form-actions" style="margin-top:12px;">
      <button class="btn ghost sm" data-addop="${a.id}">+ عملية</button>
      <button class="btn ghost sm" data-editasset="${a.id}">تعديل/تحديث القيمة</button>
      <button class="btn ghost sm" data-delasset="${a.id}">حذف الأصل</button></div>
    <div class="muted" style="font-size:10.5px; margin-top:6px;">آخر تحديث: ${a.lastUpdatedAt ? new Date(a.lastUpdatedAt).toLocaleDateString('ar-DZ') : '—'}</div>
  </details>`;
}
function addingAssetOpFormOpen(id) { return addingOpAssetId === id; }
function aopCategoryOptionsHtml(kind) {
  const cs = DATA.categories.filter(c => !c.deleted && c.type === (kind === 'out' ? 'expense' : 'income'));
  return cs.length ? cs.map(c => `<option value="${c.id}">${escHtml(c.name)}</option>`).join('') : '<option value="">أضف فئة أولًا من مركز التحكم</option>';
}
function bindAssetsEvents(host) {
  $('#wealthChartCur', host)?.addEventListener('change', () => { wealthChartCurrency = $('#wealthChartCur', host).value; renderAssetsInto(host); });
  $('#wealthChartModeSwitch', host)?.addEventListener('click', (e) => { const b = e.target.closest('button[data-wmode]'); if (!b) return; wealthChartMode = b.dataset.wmode; renderAssetsInto(host); });
  $('#addTransferBtn', host)?.addEventListener('click', () => {
    const fromId = $('#transfer_from', host).value, toId = $('#transfer_to', host).value;
    const from = DATA.assets.find(a => a.id === fromId), to = DATA.assets.find(a => a.id === toId);
    if (!from || !to) return toast('اختر الأصلين');
    if (from.id === to.id) return toast('اختر أصلين مختلفين');
    if (from.currency !== to.currency) return toast('التحويل بين نفس العملة فقط (لا يوجد سعر صرف في التطبيق)');
    const amount = parseFloat($('#transfer_amount', host).value);
    if (isNaN(amount) || amount <= 0) return toast('أدخل مبلغًا صحيحًا');
    const date = $('#transfer_date', host).value || todayISO();
    const note = $('#transfer_note', host).value.trim();
    const transferId = uid();
    DATA.assetTransfers.push({ id: transferId, fromAssetId: from.id, toAssetId: to.id, amount, currency: from.currency, date, note, createdAt: Date.now(), updatedAt: Date.now(), deleted: false });
    // كل تحويل يُسجَّل كعمليتين داخل نافذتي الأصلين (صادر من الأول، وارد للثاني)
    addAssetOp(from, { amount: -amount, date, note, kind: 'transfer_out', transferId, counterAssetId: to.id });
    addAssetOp(to, { amount, date, note, kind: 'transfer_in', transferId, counterAssetId: from.id });
    persist(true); toast('تم التحويل'); renderAssetsInto(host);
  });
  $$('[data-deltransfer]', host).forEach(el => el.addEventListener('click', () => {
    const t = DATA.assetTransfers.find(x => x.id === el.dataset.deltransfer); if (!t) return;
    undoAssetTransfer(t);
    persist(true); toast('تم حذف التحويل والتراجع عن أثره'); renderAssetsInto(host);
  }));
  $('#addAssetBtn', host).addEventListener('click', () => {
    const typeId = $('#asset_type', host).value;
    const amount = parseFloat($('#asset_value', host).value);
    if (!typeId) return toast('اختر الأصل');
    if (isNaN(amount) || amount === 0) return toast('أدخل المبلغ');
    const who = $('#asset_name', host).value.trim(); // اختياري: اسم شخص/مصدر العملية (مثل قاسم) — يُحفظ داخل نافذة الأصل ولا يصير اسمًا للأصل
    const currency = $('#asset_currency', host).value;
    const note = $('#asset_notes', host).value.trim();
    const date = $('#asset_date', host).value || todayISO();
    // اسم الأصل = اسم نوعه (rip / بنك / كاش...). لو موجود أصل بنفس النوع والعملة تُضاف العملية داخل نافذته بدل إنشاء عمود/بطاقة جديدة بنفس الاسم
    let asset = findAssetForType(typeId, currency);
    const isNew = !asset;
    const now = Date.now();
    if (!asset) {
      asset = { id: uid(), type: typeId, name: assetTypeName(typeId) || 'أصل', value: 0, currency, notes: '', lastUpdatedAt: now, createdAt: now, updatedAt: now, deleted: false };
      DATA.assets.push(asset);
    }
    addAssetOp(asset, { amount, who, date, note });
    setPanelOpen('assetwin_' + asset.id, true);
    persist(true);
    toast(isNew ? `تمت إضافة الأصل "${asset.name}"` : `أُضيفت العملية داخل نافذة "${asset.name}"`);
    renderAssetsInto(host);
  });
  $$('[data-editasset]', host).forEach(el => el.addEventListener('click', () => { editingAssetId = el.dataset.editasset; renderAssetsInto(host); }));
  $('[data-cancelasset]', host)?.addEventListener('click', () => { editingAssetId = null; renderAssetsInto(host); });
  $$('[data-delasset]', host).forEach(el => el.addEventListener('click', () => {
    const a = DATA.assets.find(x => x.id === el.dataset.delasset); if (!a) return;
    const doDelete = () => {
      const now = Date.now();
      // عمليات الأصل المرتبطة بالدخل/المصاريف/العملاء/الديون: يُحذف أثرها هناك أيضًا حتى لا يبقى تضخيم في الحسابات
      assetOpsOf(a.id).filter(o => o.srcId).forEach(o => cascadeDeleteAssetOp(o));
      a.deleted = true; a.updatedAt = now;
      DATA.assetOps.forEach(o => { if (o.assetId === a.id && !o.deleted) { o.deleted = true; o.updatedAt = now; } });
      persist(true); evaluateAlerts(); renderAssetsInto(host); refreshMonthSummary();
    };
    const linked = assetOpsOf(a.id).filter(o => o.srcId).length;
    if (!linked) return doDelete();
    confirmDialog({ title: `حذف الأصل "${escHtml(a.name)}"؟`, dangerous: true, confirmLabel: 'حذف الأصل وأثره',
      message: `يحوي هذا الأصل ${linked} عملية مرتبطة بأقسام أخرى (دخل/مصاريف/عملاء/ديون/إخراجات). سيُحذف أثرها من تلك الأقسام أيضًا (أو يُخفَّض مبلغ الحركة المشتركة) حتى تبقى الحسابات متطابقة.`, onConfirm: doDelete });
  }));
  $$('[data-saveasset]', host).forEach(el => el.addEventListener('click', () => {
    const a = DATA.assets.find(x => x.id === el.dataset.saveasset); const box = el.closest('.debt-entry');
    const newValue = parseFloat(box.querySelector('[data-af="value"]').value);
    const oldValue = assetValue(a);
    a.type = box.querySelector('[data-af="type"]').value;
    a.name = box.querySelector('[data-af="name"]').value.trim() || a.name;
    a.currency = box.querySelector('[data-af="currency"]').value;
    a.updatedAt = Date.now();
    // تاريخ "آخر تحديث" يتغيّر فقط لو القيمة فعليًا تغيّرت — والفرق يُسجَّل كعملية تعديل داخل النافذة (لا نمسح عمليات سابقة)
    if (!isNaN(newValue) && Math.abs(newValue - oldValue) > 0.004) {
      addAssetOp(a, { amount: Math.round((newValue - oldValue) * 100) / 100, date: todayISO(), note: 'تعديل يدوي للقيمة', kind: 'adjust' });
    }
    editingAssetId = null; persist(true); renderAssetsInto(host);
  }));
  // ---- عمليات داخل نافذة الأصل ----
  $$('[data-addop]', host).forEach(el => el.addEventListener('click', () => { addingOpAssetId = addingOpAssetId === el.dataset.addop ? null : el.dataset.addop; setPanelOpen('assetwin_' + el.dataset.addop, true); renderAssetsInto(host); }));
  $('[data-cancelop]', host)?.addEventListener('click', () => { addingOpAssetId = null; renderAssetsInto(host); });
  // نوع العملية يحدّد فئات الدخل أو المصاريف المعروضة، ويحدّد أيضًا هل يظهر خيار «عميل» (للدخل فقط)
  $$('[id^="aop_kind_"]', host).forEach(sel => sel.addEventListener('change', () => {
    const aid = sel.id.slice('aop_kind_'.length);
    const cat = $(`#aop_cat_${aid}`, host), lbl = $(`#aop_linklbl_${aid}`, host);
    if (cat) cat.innerHTML = aopCategoryOptionsHtml(sel.value); if (lbl) lbl.textContent = sel.value === 'out' ? 'مصروف' : 'دخل';
    const srcmode = $(`#aop_srcmode_${aid}`, host), clientfields = $(`#aop_clientfields_${aid}`, host);
    if (srcmode) {
      srcmode.style.display = sel.value === 'in' ? 'flex' : 'none';
      if (sel.value === 'out') { // المصروف لا يكون «عميل» — نُرجعه لمصدر عادي دائمًا
        $$('button', srcmode).forEach(b => b.classList.toggle('active', b.dataset.srcmode === 'general'));
        if (clientfields) clientfields.style.display = 'none';
        if (cat) cat.style.display = '';
      }
    }
  }));
  // تبديل «مصدر عادي / عميل» داخل نافذة الأصل
  $$('[id^="aop_srcmode_"]', host).forEach(sw => sw.addEventListener('click', (e) => {
    const btn = e.target.closest('button[data-srcmode]'); if (!btn) return;
    const aid = sw.id.slice('aop_srcmode_'.length);
    $$('button', sw).forEach(b => b.classList.toggle('active', b === btn));
    const cat = $(`#aop_cat_${aid}`, host), clientfields = $(`#aop_clientfields_${aid}`, host);
    if (cat) cat.style.display = btn.dataset.srcmode === 'general' ? '' : 'none';
    if (clientfields) clientfields.style.display = btn.dataset.srcmode === 'client' ? 'grid' : 'none';
  }));
  $$('[data-confirmop]', host).forEach(el => el.addEventListener('click', () => {
    const a = DATA.assets.find(x => x.id === el.dataset.confirmop); if (!a) return;
    const amt = parseFloat($(`#aop_amount_${a.id}`, host).value);
    if (isNaN(amt) || amt <= 0) return toast('أدخل مبلغًا صحيحًا');
    const kind = $(`#aop_kind_${a.id}`, host).value;
    const who = $(`#aop_who_${a.id}`, host).value.trim(), date = $(`#aop_date_${a.id}`, host).value || todayISO(), note = $(`#aop_note_${a.id}`, host).value.trim();
    const srcModeBtn = $(`#aop_srcmode_${a.id} button.active`, host);
    const srcMode = (kind === 'in' && srcModeBtn) ? srcModeBtn.dataset.srcmode : 'general';
    // «سجّلها أيضًا كدخل/مصروف»: تُنشأ حركة حقيقية في قسمها (مصدر عادي أو عميل) وتُربط بالعملية — فيبقى الحذف والتعديل متطابقين من الطرفين
    let tx = null;
    if ($(`#aop_link_${a.id}`, host)?.checked) {
      const nowT = Date.now();
      if (srcMode === 'client') {
        const clientId = $(`#aop_client_${a.id}`, host)?.value;
        if (!clientId) return toast('اختر عميلًا، أو بدّل إلى «مصدر عادي»');
        const client = DATA.clients.find(c => c.id === clientId); if (!client) return toast('العميل غير موجود، اختر عميلًا آخر');
        const agreedRaw = ($(`#aop_pagreed_${a.id}`, host)?.value || '').trim();
        let agreed = agreedRaw === '' ? NaN : parseFloat(agreedRaw);
        if (isNaN(agreed) || agreed <= 0) agreed = amt;
        const project = { id: uid(), clientId, title: ($(`#aop_ptitle_${a.id}`, host)?.value || '').trim() || 'مشروع', agreedAmount: agreed, paidAmount: amt, hours: 0,
          notes: note, flagged: false, createdAt: nowT, updatedAt: nowT, deleted: false };
        DATA.projects.push(project);
        tx = { id: uid(), kind: 'income', mode: 'client', projectId: project.id, currency: a.currency, amount: amt, date, note: [who, note].filter(Boolean).join(' — '), hours: 0, flagged: false, createdAt: nowT, updatedAt: nowT, deleted: false };
      } else {
        const catId = $(`#aop_cat_${a.id}`, host)?.value;
        if (!catId) return toast('اختر الفئة، أو أضف فئة من مركز التحكم، أو ألغِ خيار «سجّلها أيضًا»');
        tx = { id: uid(), kind: kind === 'out' ? 'expense' : 'income', mode: 'general', categoryId: catId, currency: a.currency, amount: amt, date, note: [who, note].filter(Boolean).join(' — '), flagged: false, createdAt: nowT, updatedAt: nowT, deleted: false };
      }
      DATA.transactions.push(tx);
    }
    addAssetOp(a, { amount: kind === 'out' ? -amt : amt, who, date, note, kind, srcType: tx ? 'tx' : undefined, srcId: tx ? tx.id : undefined, src: tx ? tx.kind : undefined });
    addingOpAssetId = null; persist(true); if (tx) { evaluateAlerts(); refreshMonthSummary(); } renderAssetsInto(host);
  }));
  $$('[data-gotoassetop]', host).forEach(el => el.addEventListener('click', (e) => { e.stopPropagation(); goToAssetOpDay(el.dataset.gotoassetop, el.dataset.gotokind || ''); }));
  $$('[data-editassetop]', host).forEach(el => el.addEventListener('click', () => { editingAssetOpId = el.dataset.editassetop; renderAssetsInto(host); }));
  $('[data-cancelassetop]', host)?.addEventListener('click', () => { editingAssetOpId = null; renderAssetsInto(host); });
  $$('[data-saveassetop]', host).forEach(el => el.addEventListener('click', () => {
    const o = DATA.assetOps.find(x => x.id === el.dataset.saveassetop); const box = el.closest('.debt-entry'); if (!o) return;
    const amt = parseFloat(box.querySelector('[data-of="amount"]').value);
    if (isNaN(amt) || amt <= 0) return toast('أدخل مبلغًا صحيحًا');
    const oldAbs = Math.abs(o.amount);
    const newDate = box.querySelector('[data-of="date"]').value || o.date;
    // عملية مرتبطة بحركة في قسم آخر: أي تعديل بالمبلغ/التاريخ ينعكس على الحركة الأصلية حتى تبقى الأقسام متطابقة
    if (o.srcId) {
      if (Math.abs(amt - oldAbs) > 0.004) setSourceAmount(o.srcType, o.srcId, sourceAmountOf(o.srcType, o.srcId) + (amt - oldAbs));
      if (newDate !== o.date) setSourceDate(o.srcType, o.srcId, newDate);
    }
    o.amount = o.amount < 0 ? -amt : amt;
    o.date = newDate;
    o.who = box.querySelector('[data-of="who"]').value.trim();
    o.note = box.querySelector('[data-of="note"]').value.trim();
    o.updatedAt = Date.now();
    const a = DATA.assets.find(x => x.id === o.assetId); if (a) { a.lastUpdatedAt = Date.now(); a.updatedAt = Date.now(); }
    editingAssetOpId = null; persist(true); renderAssetsInto(host);
  }));
  $$('[data-delassetop]', host).forEach(el => el.addEventListener('click', () => {
    const o = DATA.assetOps.find(x => x.id === el.dataset.delassetop); if (!o) return;
    if (o.transferId) {
      const t = DATA.assetTransfers.find(x => x.id === o.transferId);
      if (t) { undoAssetTransfer(t); persist(true); toast('تم حذف التحويل والتراجع عن أثره'); renderAssetsInto(host); return; }
    }
    const finish = () => {
      if (o.srcId) cascadeDeleteAssetOp(o); else { o.deleted = true; o.updatedAt = Date.now(); }
      const a = DATA.assets.find(x => x.id === o.assetId); if (a) { a.lastUpdatedAt = Date.now(); a.updatedAt = Date.now(); }
      persist(true); evaluateAlerts(); renderAssetsInto(host); refreshMonthSummary();
    };
    if (!o.srcId) return finish();
    // عملية مرتبطة بحركة في قسم آخر: تأكيد أولًا، ثم تُحذف/تُخفَّض هناك أيضًا
    confirmDialog({ title: 'حذف العملية من الأصل ومن القسم المرتبط', dangerous: true, confirmLabel: 'حذف', message: describeOpCascade(o), onConfirm: finish });
  }));
}

/* ---------- الاقتطاعات/العمليات المتكررة التلقائية ---------- */
const RECURRING_ICON = { income: '💰', expense: '🧾' };
// تاريخ آخر معاملة تولّدت فعليًا لهذه القاعدة (null لو ما تولّدت أي واحدة بعد)
function lastRecurringDate(r) {
  if (!r.lastGeneratedYM) return null;
  const [y, m] = r.lastGeneratedYM.split('-').map(Number);
  const daysInMonth = new Date(y, m, 0).getDate();
  return `${y}-${pad2(m)}-${pad2(Math.min(r.dayOfMonth, daysInMonth))}`;
}
// تاريخ أقرب معاملة قادمة ستتولّد تلقائيًا (الشهر التالي لآخر توليد، أو شهر الإنشاء لو ما تولّدت أي واحدة بعد)
function nextRecurringDate(r) {
  let y, m;
  if (r.lastGeneratedYM) { [y, m] = r.lastGeneratedYM.split('-').map(Number); m++; if (m > 12) { m = 1; y++; } }
  else { const c = new Date(r.createdAt); y = c.getFullYear(); m = c.getMonth() + 1; }
  const daysInMonth = new Date(y, m, 0).getDate();
  return `${y}-${pad2(m)}-${pad2(Math.min(r.dayOfMonth, daysInMonth))}`;
}
function renderRecurringInto(host) {
  const items = DATA.recurringTx.filter(r => !r.deleted);
  const catsOf = kind => DATA.categories.filter(c => !c.deleted && c.type === kind);
  host.innerHTML = `<div class="card"><strong>🔁 الاقتطاعات/العمليات المتكررة <button class="btn ghost sm" id="recurringHelpBtn" type="button" style="margin-inline-start:8px;" title="اشرح لي">؟</button></strong>
    <p class="muted" style="font-size:12px; margin-top:4px;">أضفها مرة واحدة فقط وستُضاف تلقائيًا كل شهر بنفس القيمة (مثال: اقتطاع بريدي، اشتراك، تأمين) — بلا أي إدخال يدوي بعدها، حتى لو ما فتحت التطبيق أشهرًا، تُعوَّض تلقائيًا عند فتحه. كل معاملة تتولّد تدخل مباشرة في جدول معاملاتك العادي (دخل/مصاريف) بنفس تاريخها. <b>الأصل الافتراضي:</b> إن حدّدت أصلًا (مثل بنك) يُخصم منه المصروف أو يُضاف إليه الدخل تلقائيًا؛ وإن لم تحدّد (أو لم يكفِ رصيد المصروف) تبقى المعاملة «بانتظار الأصل» لتختاره بنفسك.</p>
    <div id="recurringHelpBox" class="muted" style="display:none; margin-top:10px; font-size:12.5px; line-height:2;"></div>
    ${pendingRecurringHtml()}
    <div style="margin-top:10px;">${items.length === 0 ? '<p class="muted" style="font-size:12px;">لا توجد عمليات متكررة بعد</p>' : items.map(r => recurringRowHtml(r)).join('')}</div>
    <details class="collapse-card" data-panel="add_recurring"${panelOpenAttr('add_recurring')} style="margin-top:10px;"><summary>+ إضافة عملية متكررة</summary>
    <div class="form-grid" style="margin-top:10px;">
      <select id="rec_kind"><option value="expense">مصروف</option><option value="income">دخل</option></select>
      <select id="rec_category"></select>
      <input type="number" id="rec_amount" placeholder="القيمة الثابتة">
      <select id="rec_currency">${DATA.settings.currencies.map(c => `<option>${c}</option>`).join('')}</select>
      <input type="number" id="rec_day" placeholder="يوم الشهر (1-28)" min="1" max="28" value="1">
      <select id="rec_asset" title="الأصل الافتراضي">${recAssetOptionsHtml('')}</select>
      <textarea class="autogrow" rows="1" id="rec_note" placeholder="ملاحظة (اختياري)" style="grid-column:span 2;"></textarea>
    </div>
    <div class="form-actions"><button class="btn sm" id="addRecurringBtn">إضافة</button></div></details></div>`;
  const catSelect = $('#rec_category', host);
  function refreshCats() { const k = $('#rec_kind', host).value; const cs = catsOf(k); catSelect.innerHTML = cs.length ? cs.map(c => `<option value="${c.id}">${c.name}</option>`).join('') : '<option value="">أضف فئة أولًا من مركز التحكم</option>'; }
  refreshCats();
  $('#rec_kind', host).addEventListener('change', refreshCats);
  $('#recurringHelpBtn', host).addEventListener('click', () => {
    const box = $('#recurringHelpBox', host);
    if (box.style.display === 'none') {
      box.style.display = 'block';
      box.innerHTML = `<b>🔁 كيف تعمل هذه القاعدة بالضبط؟</b><br>
        تضيف القاعدة هنا <b>مرة واحدة فقط</b> (النوع، الفئة، القيمة الثابتة، ويوم من الشهر بين 1 و28). من تلك اللحظة، التطبيق ينشئ لك تلقائيًا — دون أي تدخل منك بعدها — معاملة حقيقية تظهر في قائمة معاملاتك العادية (دخل أو مصاريف) بنفس القيمة، في نفس اليوم من كل شهر.<br><br>
        <b>مثال:</b> أضفت اليوم اقتطاع "اشتراك انترنت" — مصروف — 2000 (بالعملة التي اخترتها) — يوم 5 من كل شهر:<br>
        • إذا كان يوم 5 من هذا الشهر قد مرّ بالفعل، ينشئ فورًا معاملة مصروف بتاريخ (5 من هذا الشهر) بقيمة 2000.<br>
        • في الشهر القادم، بمجرد ما تفتح التطبيق بعد يوم 5، ينشئ معاملة أخرى تلقائيًا بتاريخ (5 من ذلك الشهر) — وهكذا كل شهر، للأبد، بلا أي إدخال يدوي منك مرة ثانية.<br>
        • حتى لو ما فتحت التطبيق لعدة أشهر متتالية، عند فتحه يعوّض كل الأشهر الفائتة دفعة واحدة (كل شهر بمعاملة منفصلة بتاريخه الصحيح)، ما يضيع ولا شهر.<br><br>
        <b>عن "التاريخ" تحت كل قاعدة:</b> "آخر عملية" = تاريخ آخر معاملة تولّدت فعليًا لهذه القاعدة، و"القادمة" = التاريخ المتوقّع للمعاملة التالية.<br><br>
        <b>عن "الوقت":</b> كل المعاملات في هذا التطبيق (وليس فقط المتكررة) تُسجَّل بيوم/شهر/سنة فقط بدون ساعة محدّدة، لأنها سجل مالي وليست موعدًا — فلا فائدة حقيقية من ساعة دقيقة هنا. إذا تحب تذكيرًا بساعة معيّنة (مثلاً "نبّهني الساعة 8 صباحًا يوم الدفع")، هذا موجود في قسم "الرزنامة" وليس هنا؛ قوللي إذا حبيت نربطهم ببعض تلقائيًا.`;
    } else box.style.display = 'none';
  });
  bindRecurringEvents(host);
  bindPanelToggles(host);
}
function recAssetOptionsHtml(sel) {
  return `<option value="">🕓 بدون أصل افتراضي — اسألني لاحقًا</option>` + DATA.assetTypes.filter(t => !t.deleted || t.id === sel).map(t => `<option value="${t.id}" ${t.id === sel ? 'selected' : ''}>${t.icon} ${t.name}</option>`).join('');
}
function pendingRecurringTxs() { return DATA.transactions.filter(t => !t.deleted && t.assetPending).sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : 0)); }
function pendingRecurringHtml() {
  const list = pendingRecurringTxs(); if (!list.length) return '';
  const open = panelState['rec_pending'] !== false;
  return `<details class="collapse-card card" data-panel="rec_pending" ${open ? 'open' : ''} style="margin-top:10px; border-color:rgba(255,170,60,.5);"><summary>⏳ بانتظار الأصل (${list.length})</summary>
    <p class="muted" style="font-size:12px; margin-top:6px;">اقتطاعات ولّدها التطبيق تلقائيًا ولم يُسجَّل أثرها على أصولك بعد. اختر الأصل لكل واحد، أو «لا يمسّ الأصول» إن كنت حدّثت رصيدك يدويًا.</p>
    ${list.map(t => { const cat = DATA.categories.find(c => c.id === t.categoryId);
      return `<div class="list-row" data-focus="recpend:${t.id}" style="flex-direction:column; align-items:stretch; gap:6px;">
        <div style="display:flex; justify-content:space-between; gap:8px;"><span>${RECURRING_ICON[t.kind]} ${escHtml(cat ? cat.name : '—')}</span><span style="font-weight:700;">${bidi(fmt(t.amount))} ${t.currency}</span></div>
        <div class="muted" style="font-size:11px;">${t.date}</div>
        <div class="form-actions" style="margin:0;"><button class="btn sm" data-pendpick="${t.id}">اختر الأصل</button><button class="btn ghost sm" data-pendskip="${t.id}">لا يمسّ الأصول</button></div></div>`; }).join('')}
  </details>`;
}
function recurringRowHtml(r) {
  const cat = DATA.categories.find(c => c.id === r.categoryId);
  const last = lastRecurringDate(r), next = nextRecurringDate(r);
  return `<div class="list-row" data-focus="rec:${r.id}" style="flex-direction:column; align-items:stretch; gap:2px;">
    <div style="display:flex; justify-content:space-between; align-items:center;">
      <span>${RECURRING_ICON[r.kind]} ${cat ? cat.name : '—'} — ${bidi(fmt(r.amount))} ${r.currency}
        ${!r.active ? '<span class="muted" style="font-size:11px;"> (معطّل)</span>' : ''}${notePreviewHtml(r.note)}</span>
      <span><button class="btn ghost sm" data-togglerec="${r.id}">${r.active ? 'إيقاف' : 'تفعيل'}</button><button class="btn ghost sm" data-delrec="${r.id}">حذف</button></span>
    </div>
    <div class="muted" style="font-size:11px;">يوم ${r.dayOfMonth} من كل شهر · آخر عملية: ${last || '—'} ${r.active ? `· القادمة: ${next}` : ''}</div>
    <div style="display:flex; align-items:center; gap:8px; margin-top:4px;"><span class="muted" style="font-size:11px; flex:0 0 auto;">الأصل الافتراضي:</span><select data-recasset="${r.id}" style="flex:1; min-width:0; font-size:12px;">${recAssetOptionsHtml(r.assetTypeId || '')}</select></div>
  </div>`;
}
function bindRecurringEvents(host) {
  $('#addRecurringBtn', host).addEventListener('click', () => {
    const categoryId = $('#rec_category', host).value; const amount = parseFloat($('#rec_amount', host).value);
    if (!categoryId || isNaN(amount) || amount <= 0) return toast('أكمل الفئة والقيمة');
    const day = Math.min(28, Math.max(1, parseInt($('#rec_day', host).value) || 1));
    DATA.recurringTx.push({ id: uid(), kind: $('#rec_kind', host).value, categoryId, amount, currency: $('#rec_currency', host).value,
      dayOfMonth: day, note: $('#rec_note', host).value, assetTypeId: $('#rec_asset', host).value || null, active: true, lastGeneratedYM: null, createdAt: Date.now(), updatedAt: Date.now(), deleted: false });
    persist(true); generateDueRecurringTx(); renderRecurringInto(host);
    toast('أُضيفت، وستتكرر تلقائيًا كل شهر من الآن');
  });
  $$('[data-togglerec]', host).forEach(el => el.addEventListener('click', () => { const r = DATA.recurringTx.find(x => x.id === el.dataset.togglerec); if (r) { r.active = !r.active; persist(true); renderRecurringInto(host); } }));
  $$('[data-delrec]', host).forEach(el => el.addEventListener('click', () => { const r = DATA.recurringTx.find(x => x.id === el.dataset.delrec); if (r) { r.deleted = true; r.updatedAt = Date.now(); persist(true); renderRecurringInto(host); } }));
  // الأصل الافتراضي لكل اقتطاع: يُطبَّق على ما يُولَّد من الآن فصاعدًا (ما ولّده سابقًا لا يتغيّر)
  $$('[data-recasset]', host).forEach(el => el.addEventListener('change', () => { const r = DATA.recurringTx.find(x => x.id === el.dataset.recasset); if (!r) return; r.assetTypeId = el.value || null; r.updatedAt = Date.now(); persist(true); renderRecurringInto(host); toast(r.assetTypeId ? 'سيُسجَّل من هذا الأصل تلقائيًا من الاقتطاع القادم' : 'سيبقى كل اقتطاع بانتظار اختيارك للأصل'); }));
  // اقتطاعات ولّدها التطبيق ولم يُحدَّد لها أصل بعد
  $$('[data-pendpick]', host).forEach(el => el.addEventListener('click', () => { const t = DATA.transactions.find(x => x.id === el.dataset.pendpick); if (t && !t.deleted) offerAssetAllocationForTx(t, { keepPending: true }); }));
  $$('[data-pendskip]', host).forEach(el => el.addEventListener('click', () => { const t = DATA.transactions.find(x => x.id === el.dataset.pendskip); if (!t) return; t.assetPending = false; t.noAsset = true; t.updatedAt = Date.now(); persist(true); renderRecurringInto(host); toast('لن يمسّ أصولك'); }));
}
// يُسجّل أثر الاقتطاع المتكرر على الأصول: لو للاقتطاع أصل افتراضي (ورصيده يكفي للمصروف) يُخصم/يُضاف تلقائيًا بعملية مرتبطة بالمعاملة،
// وإلا تبقى المعاملة «بانتظار الأصل» (assetPending) لتختار الأصل لاحقًا من الأموال ← الاقتطاعات المتكررة — لا نوافذ تقاطعك عند فتح التطبيق
function applyRecurringAsset(r, tx, ym, autoDone, pendingNew) {
  const type = r.assetTypeId ? DATA.assetTypes.find(t => t.id === r.assetTypeId && !t.deleted) : null;
  const isOut = tx.kind === 'expense';
  let asset = type ? findAssetForType(type.id, tx.currency) : null;
  if (!type) { tx.assetPending = true; pendingNew.push({ tx, reason: 'none' }); return; }
  if (isOut && (!asset || assetValue(asset) + 0.004 < tx.amount)) { tx.assetPending = true; pendingNew.push({ tx, reason: 'low', assetName: asset ? asset.name : assetTypeName(type.id) }); return; }
  const now = Date.now();
  if (!asset) { // دخل لأصل لا يوجد بعد: نُنشئه بمعرّف ثابت (حتى لا يتكرر لو أنشأه جهازان معًا)
    const aid = `autoasset_${type.id}_${tx.currency}`;
    const ex = DATA.assets.find(a => a.id === aid);
    if (ex) { ex.deleted = false; ex.updatedAt = now; asset = ex; }
    else { asset = { id: aid, type: type.id, name: assetTypeName(type.id) || 'أصل', value: 0, currency: tx.currency, notes: '', lastUpdatedAt: now, createdAt: now, updatedAt: now, deleted: false }; DATA.assets.push(asset); }
  }
  addAssetOp(asset, { id: `recop_${r.id}_${ym}`, amount: isOut ? -tx.amount : tx.amount, who: sourceName(tx), date: tx.date, note: tx.note || '', kind: isOut ? 'out' : 'in',
    srcType: 'tx', srcId: tx.id, src: isOut ? 'expense' : 'income' });
  autoDone.push({ tx, asset });
}
function notifyRecurringResults(autoDone, pendingNew) {
  const money = (t) => `${fmt(t.amount)} ${t.currency}`;
  const h = (arr) => _fh(arr.map(x => x.tx.id).sort().join('|'), 31);
  if (autoDone.length) {
    const body = autoDone.slice(0, 4).map(x => `${x.tx.kind === 'income' ? '+' : '−'}${money(x.tx)} ${x.tx.kind === 'income' ? 'إلى' : 'من'} ${x.asset.name}`).join(' · ') + (autoDone.length > 4 ? ` · +${autoDone.length - 4} أخرى` : '');
    logNotify('أموالي', `🔁 اقتطاعات متكررة سُجّلت في أصولك (${autoDone.length})`, body, null, { v: 'wealth', tab: 'recurring' }, { id: 'recdone_' + h(autoDone) });
  }
  if (pendingNew.length) {
    const low = pendingNew.filter(x => x.reason === 'low').length;
    const body = (low ? `رصيد الأصل الافتراضي لا يكفي لـ ${low} منها. ` : '') + 'افتح «الاقتطاعات المتكررة» واختر الأصل لكل واحد، أو حدّد أصلًا افتراضيًا للاقتطاع ليُسجَّل تلقائيًا.';
    logNotify('أموالي', `⏳ ${pendingNew.length} اقتطاع بانتظار اختيار الأصل`, body, null, { v: 'wealth', tab: 'recurring', focus: 'panel:rec_pending' }, { id: 'recpend_' + h(pendingNew) });
  }
}
// يولّد تلقائيًا كل الشهور المستحقة منذ آخر توليد (أو منذ شهر الإنشاء لأول مرة) وحتى الشهر الحالي — يعوّض حتى لو التطبيق ما اشتغل لعدة أشهر
function generateDueRecurringTx() {
  const now = new Date(); const curYM = `${now.getFullYear()}-${pad2(now.getMonth() + 1)}`;
  let changed = false; const autoDone = [], pendingNew = [];
  DATA.recurringTx.filter(r => !r.deleted && r.active).forEach(r => {
    let y, m, startFresh = !r.lastGeneratedYM;
    if (r.lastGeneratedYM) { [y, m] = r.lastGeneratedYM.split('-').map(Number); }
    else { const created = new Date(r.createdAt); y = created.getFullYear(); m = created.getMonth() + 1; }
    let guard = 0;
    while (guard++ < 240) { // كابح أمان يمنع أي حلقة لا نهائية
      if (!startFresh) { m++; if (m > 12) { m = 1; y++; } }
      startFresh = false;
      const ym = `${y}-${pad2(m)}`;
      if (ym > curYM) break;
      const daysInMonth = new Date(y, m, 0).getDate();
      const day = Math.min(r.dayOfMonth, daysInMonth);
      const date = `${y}-${pad2(m)}-${pad2(day)}`;
      // معرّف ثابت (قاعدة + شهر): لو ولّد جهازان نفس الشهر قبل أن يلتقيا بالمزامنة يندمجان في معاملة واحدة بدل أن تتكرر،
      // ولو كانت المعاملة موجودة أو حُذفت عمدًا لا نعيد إنشاءها
      const txId = `rec_${r.id}_${ym}`;
      if (!DATA.transactions.some(t => t.id === txId)) {
        const tx = { id: txId, kind: r.kind, mode: 'general', categoryId: r.categoryId, currency: r.currency,
          amount: r.amount, date, note: (r.note ? r.note + ' ' : '') + '(اقتطاع متكرر تلقائي)', flagged: false, createdAt: Date.now(), updatedAt: Date.now(), deleted: false };
        DATA.transactions.push(tx);
        applyRecurringAsset(r, tx, ym, autoDone, pendingNew);
      }
      r.lastGeneratedYM = ym; r.updatedAt = Date.now(); changed = true;
      if (ym === curYM) break;
    }
  });
  if (changed) { persist(true); refreshMonthSummary(); notifyRecurringResults(autoDone, pendingNew); }
}

function renderControl() {
  const view = $('#view-control');
  view.innerHTML = `<h2 class="view-title">${label('nav_control')}</h2>
    <div class="grid grid-3" style="align-items:start;">${controlCurrenciesHtml()}${controlSourcesHtml()}${controlClientsHtml()}</div>
    <div class="grid grid-3" style="align-items:start; margin-top:14px;">${controlAlertsHtml()}${controlLabelsHtml()}${controlExportCenterHtml()}</div>
    <div class="grid grid-3" style="align-items:start; margin-top:14px;">${controlAssetTypesHtml()}</div>`;
  bindControlEvents();
  bindPanelToggles(view);
}
let editingCurrency = null, editingCategoryId = null, editingClientId = null, editingAlertId = null;

function controlCurrenciesHtml() {
  return `<details class="collapse-card card" data-panel="ctrl_currencies"${panelOpenAttr('ctrl_currencies')}><summary>${label('control_currencies')}</summary><div style="margin-top:10px;">
    ${DATA.settings.currencies.map(c => editingCurrency === c
      ? `<div class="list-row" style="gap:6px;"><input type="text" id="editCurInput" value="${c}" style="width:90px;"><button class="btn sm" data-savecur="${c}">حفظ</button><button class="btn ghost sm" data-cancelcur>إلغاء</button></div>`
      : `<div class="list-row"><span>${c}</span><span><button class="btn ghost sm" data-editcur="${c}">تعديل</button><button class="btn ghost sm" data-delcur="${c}">حذف</button></span></div>`).join('')}
    </div><div class="form-actions"><input type="text" id="newCurrency" placeholder="مثال: GBP" style="flex:1;"><button class="btn sm" id="addCurrencyBtn">إضافة</button></div></details>`;
}
function controlSourcesHtml() {
  const income = DATA.categories.filter(c => c.type === 'income' && !c.deleted);
  const expense = DATA.categories.filter(c => c.type === 'expense' && !c.deleted);
  const catRow = c => editingCategoryId === c.id
    ? `<div class="list-row" style="gap:6px;"><input type="color" id="editCatColor_${c.id}" value="${c.color || '#4f7cff'}" style="width:32px; height:32px; padding:0; border:none; background:none; cursor:pointer;"><input type="text" id="editCatInput_${c.id}" value="${c.name}" style="flex:1;"><button class="btn sm" data-savecat="${c.id}">حفظ</button><button class="btn ghost sm" data-cancelcat>إلغاء</button></div>`
    : `<div class="list-row"><span><span style="display:inline-block; width:10px; height:10px; border-radius:50%; background:${c.color || '#4f7cff'}; margin-inline-end:8px;"></span>${c.name}</span><span><button class="btn ghost sm" data-editcat="${c.id}">تعديل</button><button class="btn ghost sm" data-delcat="${c.id}">حذف</button></span></div>`;
  return `<details class="collapse-card card" data-panel="ctrl_sources"${panelOpenAttr('ctrl_sources')}><summary>${label('control_sources')}</summary>
    <p class="muted" style="font-size:12px; margin:6px 0;">مصادر الدخل العادية</p>${income.map(catRow).join('')}
    <div class="form-actions"><input type="text" id="newIncomeSource" placeholder="مصدر دخل جديد" style="flex:1;"><button class="btn sm" data-addcat="income">إضافة</button></div>
    <p class="muted" style="font-size:12px; margin:12px 0 6px;">فئات المصاريف</p>${expense.map(catRow).join('')}
    <div class="form-actions"><input type="text" id="newExpenseCat" placeholder="فئة مصروف جديدة" style="flex:1;"><button class="btn sm" data-addcat="expense">إضافة</button></div></details>`;
}
function controlClientsHtml() {
  const clients = DATA.clients.filter(c => !c.deleted);
  const row = c => editingClientId === c.id
    ? `<div class="list-row" style="gap:6px; flex-wrap:wrap;"><input type="text" id="editClientName_${c.id}" value="${c.name}" style="flex:1; min-width:100px;">
        <select id="editClientCur_${c.id}">${DATA.settings.currencies.map(cur => `<option ${cur === c.currency ? 'selected' : ''}>${cur}</option>`).join('')}</select>
        <button class="btn sm" data-saveclient="${c.id}">حفظ</button><button class="btn ghost sm" data-cancelclient>إلغاء</button></div>`
    : `<div class="list-row"><span>${c.name} (${c.currency})</span><span><button class="btn ghost sm" data-editclient="${c.id}">تعديل</button><button class="btn ghost sm" data-delclient="${c.id}">حذف</button></span></div>`;
  return `<details class="collapse-card card" data-panel="ctrl_clients"${panelOpenAttr('ctrl_clients')}><summary>${label('control_clients')}</summary>${clients.map(row).join('') || '<p class="muted" style="font-size:12px;">لا يوجد عملاء بعد</p>'}
    <div class="form-actions" style="flex-wrap:wrap;"><input type="text" id="newClientName" placeholder="اسم العميل" style="flex:1;">
      <select id="newClientCurrency">${DATA.settings.currencies.map(c => `<option>${c}</option>`).join('')}</select>
      <button class="btn sm" id="addClientBtn">إضافة عميل</button></div></details>`;
}
function controlExportCenterHtml() {
  const now = new Date();
  const items = [
    { id: 'exp_month', label: `تقرير الشهر الحالي (${MONTH_NAMES[now.getMonth()]} ${now.getFullYear()})` },
    { id: 'exp_year', label: `تقرير السنة الحالية (${now.getFullYear()})` },
    { id: 'exp_yearcompare', label: 'تقرير مقارنة السنوات' },
    { id: 'exp_calendar', label: 'تقرير الرزنامة' },
    { id: 'exp_notes', label: 'تقرير المذكرة' },
    { id: 'exp_clients', label: 'تقرير العملاء' },
    { id: 'exp_debts', label: 'تقرير الديون' },
    { id: 'exp_plans', label: 'تقرير التخطيط والأهداف' },
    { id: 'exp_pricing', label: 'تقرير التسعير' },
    { id: 'exp_schedule', label: 'تقرير جدولي (يومي/أسبوعي/فصلي/سنوي)' },
    { id: 'exp_appointments', label: 'تقرير المواعيد' },
    { id: 'exp_wealth', label: 'تقرير أموالي (الأصول والثروة)' },
  ];
  return `<details class="collapse-card card" data-panel="ctrl_export"${panelOpenAttr('ctrl_export')}><summary>${label('control_export')}</summary>
    <p class="muted" style="font-size:12px; margin-top:4px;">اختر أي تقارير تريدها، ثم اختر مجلّد حفظ واحد — تُحفَظ كلها فيه دفعة واحدة كملفات PDF منفصلة.</p>
    <div style="margin-top:10px;">
      <label class="list-row" style="cursor:pointer;"><input type="checkbox" id="exportSelectAll"> <b>تحديد الكل</b></label>
      ${items.map(it => `<label class="list-row" style="cursor:pointer;"><input type="checkbox" class="exportCenterItem" id="${it.id}"> ${it.label}</label>`).join('')}
    </div>
    <button class="btn sm" id="exportCenterBtn" style="margin-top:10px;">⬇️ تصدير المحدَّد</button>
  </details>`;
}
function controlAlertsHtml() {
  const rowHtml = a => {
    if (editingAlertId === a.id) return alertEditFormHtml(a);
    return `<div class="list-row" data-focus="alert:${a.id}"><span>${alertDesc(a)} ${a.active ? '' : '<span class="muted">(موقوف)</span>'}</span>
      <span><button class="btn ghost sm" data-togglealert="${a.id}">${a.active ? '⏸ إيقاف' : '▶ تفعيل'}</button>
      <button class="btn ghost sm" data-editalert="${a.id}">تعديل</button>
      <button class="btn ghost sm" data-delalert="${a.id}">حذف</button></span></div>`;
  };
  return `<details class="collapse-card card" data-panel="ctrl_alerts"${panelOpenAttr('ctrl_alerts')}><summary>${label('control_alerts')} <button class="btn ghost sm" id="alertHelpBtn" type="button" style="margin-inline-start:8px;" title="اشرح لي">؟</button></summary>
    ${DATA.alerts.filter(a => !a.deleted).map(rowHtml).join('') || '<p class="muted" style="font-size:12px;">لا توجد تنبيهات بعد</p>'}
    <div style="margin-top:10px;"><label class="field">نوع التنبيه<select id="alertType">
      <option value="investment_threshold">وصول رصيد إلى مبلغ معيّن</option>
      <option value="expense_ratio">نسبة مصاريف من الدخل</option>
      <option value="category_threshold">تجاوز فئة مصروف مبلغًا معيّنًا</option>
      <option value="client_unpaid">عميل لم يكتمل دفعه منذ مدة</option></select></label>
      <div id="alertParamsHost" style="margin-top:8px;"></div><button class="btn sm" id="addAlertBtn" style="margin-top:10px;">إضافة تنبيه</button></div>
    <div id="alertHelpBox" class="muted" style="display:none; margin-top:10px; font-size:12px; line-height:1.9;"></div></details>`;
}
function alertEditFormHtml(a) {
  const curOpts = c => DATA.settings.currencies.map(x => `<option ${x === c ? 'selected' : ''}>${x}</option>`).join('');
  const expenseCats = DATA.categories.filter(c => c.type === 'expense' && !c.deleted);
  let fields = '';
  if (a.kind === 'investment_threshold') fields = `<div class="form-grid" style="grid-template-columns:1fr 1fr;"><select data-af="currency">${curOpts(a.params.currency)}</select><input type="number" data-af="amount" value="${a.params.amount}"></div>`;
  else if (a.kind === 'expense_ratio') fields = `<div class="form-grid" style="grid-template-columns:1fr 1fr;"><select data-af="currency">${curOpts(a.params.currency)}</select><input type="number" data-af="percent" value="${a.params.percent}"></div>`;
  else if (a.kind === 'category_threshold') fields = `<div class="form-grid" style="grid-template-columns:1fr 1fr 1fr;"><select data-af="categoryId">${expenseCats.map(c => `<option value="${c.id}" ${c.id === a.params.categoryId ? 'selected' : ''}>${c.name}</option>`).join('')}</select><select data-af="currency">${curOpts(a.params.currency)}</select><input type="number" data-af="amount" value="${a.params.amount}"></div>`;
  else if (a.kind === 'client_unpaid') fields = `<div class="form-grid" style="grid-template-columns:1fr 1fr;"><select data-af="clientId">${DATA.clients.filter(c => !c.deleted).map(c => `<option value="${c.id}" ${c.id === a.params.clientId ? 'selected' : ''}>${c.name}</option>`).join('')}</select><input type="number" data-af="days" value="${a.params.days}"></div>`;
  return `<div class="list-row" style="flex-direction:column; align-items:stretch; gap:6px;">${fields}
    <div class="form-actions"><button class="btn sm" data-savealert="${a.id}">حفظ</button><button class="btn ghost sm" data-cancelalert>إلغاء</button></div></div>`;
}
function alertDesc(a) {
  if (a.kind === 'investment_threshold') return `نبّهني عند وصول ${a.params.currency} إلى ${a.params.amount}`;
  if (a.kind === 'expense_ratio') return `نبّهني إذا تجاوزت مصاريف ${a.params.currency} ${a.params.percent}% من الدخل`;
  if (a.kind === 'category_threshold') { const c = DATA.categories.find(c => c.id === a.params.categoryId); return `نبّهني إذا تجاوزت فئة "${c ? c.name : ''}" ${a.params.amount} ${a.params.currency}`; }
  if (a.kind === 'client_unpaid') { const c = DATA.clients.find(c => c.id === a.params.clientId); return `نبّهني إذا لم يدفع "${c ? c.name : ''}" خلال ${a.params.days} يوم`; }
  return 'تنبيه';
}
function controlLabelsHtml() {
  const grouped = new Set(LABEL_GROUPS.flatMap(g => g.keys));
  const ungrouped = Object.keys(DATA.labels).filter(k => !grouped.has(k)); // أي مفتاح مستقبلي لم يُصنَّف بعد يظهر هنا تلقائيًا بدل أن يضيع
  const groups = ungrouped.length ? [...LABEL_GROUPS, { title: 'أخرى', keys: ungrouped }] : LABEL_GROUPS;
  return `<details class="collapse-card card" data-panel="ctrl_labels"${panelOpenAttr('ctrl_labels')}><summary>${label('control_labels')}</summary>
    <p class="muted" style="font-size:12px; margin:6px 0;">غيّر أي عنوان في التطبيق كما يناسبك — مقسّمة حسب القسم. أي قسم جديد يُضاف للتطبيق مستقبلًا تظهر عناوينه هنا تلقائيًا.</p>
    ${groups.map((g, gi) => `<details class="collapse-card" data-panel="ctrl_labels_grp_${gi}"${panelOpenAttr('ctrl_labels_grp_' + gi)} style="margin-top:8px;"><summary>${g.title}</summary>
      <div style="margin-top:8px;">${g.keys.filter(k => DATA.labels[k] !== undefined).map(k => `<label class="field" style="margin-top:8px;">${k}<input type="text" data-labelkey="${k}" value="${escHtml(DATA.labels[k])}"></label>`).join('')}</div>
    </details>`).join('')}
    <div class="form-actions" style="margin-top:10px;"><button class="btn sm" id="saveLabelsBtn">حفظ العناوين</button></div></details>`;
}
function controlAssetTypesHtml() {
  const rowHtml = t => editingAssetTypeId === t.id
    ? `<div class="list-row" style="gap:6px;"><input type="text" id="editAssetTypeIcon" value="${t.icon}" style="width:44px; text-align:center;"><input type="text" id="editAssetTypeName" value="${t.name}" style="flex:1;"><button class="btn sm" data-saveassettype="${t.id}">حفظ</button><button class="btn ghost sm" data-cancelassettype>إلغاء</button></div>`
    : `<div class="list-row"><span>${t.icon} ${t.name}</span><span><button class="btn ghost sm" data-editassettype="${t.id}">تعديل</button><button class="btn ghost sm" data-delassettype="${t.id}">حذف</button></span></div>`;
  return `<details class="collapse-card card" data-panel="ctrl_assettypes"${panelOpenAttr('ctrl_assettypes')}><summary>${label('control_assettypes')}</summary>
    <p class="muted" style="font-size:12px; margin:6px 0;">هذه الأنواع تظهر عند إضافة أصل جديد في "أموالي" — عدّلها لتطابق حسابتك الحقيقية (مثلًا غيّر "حساب بنكي" إلى "بريدي" إذا كان هذا حسابك).</p>
    ${DATA.assetTypes.filter(t => !t.deleted).map(rowHtml).join('') || '<p class="muted" style="font-size:12px;">لا توجد أنواع بعد</p>'}
    <div class="form-actions" style="margin-top:8px;">
      <input type="text" id="newAssetTypeIcon" placeholder="🏦" style="width:44px; text-align:center;">
      <input type="text" id="newAssetTypeName" placeholder="اسم النوع (مثال: بريدي)" style="flex:1;">
      <button class="btn sm" id="addAssetTypeBtn">إضافة</button>
    </div></details>`;
}
function bindControlEvents() {
  $('#exportSelectAll')?.addEventListener('change', (e) => { $$('.exportCenterItem').forEach(cb => cb.checked = e.target.checked); });
  $('#exportCenterBtn')?.addEventListener('click', async () => {
    const now = new Date();
    const picks = [];
    if ($('#exp_month')?.checked) picks.push(buildMonthReportHtml(now.getFullYear(), now.getMonth() + 1));
    if ($('#exp_year')?.checked) picks.push(buildYearReportHtml(now.getFullYear()));
    if ($('#exp_yearcompare')?.checked) picks.push(buildYearsCompareReportHtml());
    if ($('#exp_calendar')?.checked) picks.push(buildCalendarReportHtml());
    if ($('#exp_notes')?.checked) picks.push(buildNotesReportHtml());
    if ($('#exp_clients')?.checked) picks.push(buildClientsReportHtml());
    if ($('#exp_debts')?.checked) picks.push(buildDebtsReportHtml());
    if ($('#exp_plans')?.checked) picks.push(buildPlansReportHtml());
    if ($('#exp_pricing')?.checked) picks.push(buildPricingReportHtml());
    if ($('#exp_schedule')?.checked) picks.push(buildScheduleReportHtml());
    if ($('#exp_appointments')?.checked) picks.push(buildAppointmentsReportHtml());
    if ($('#exp_wealth')?.checked) picks.push(buildWealthReportHtml());
    if (!picks.length) return toast('اختر تقريرًا واحدًا على الأقل');
    toast('اختر مجلّد الحفظ...');
    const res = await Platform.exportPDFBatch(picks);
    if (res.ok) toast(`تم حفظ ${res.saved.length} تقرير(ات) في: ${res.dir}`);
    else toast('لم يتم الحفظ');
  });
  $('#addCurrencyBtn')?.addEventListener('click', () => { const v = $('#newCurrency').value.trim().toUpperCase(); if (!v) return; if (!DATA.settings.currencies.includes(v)) DATA.settings.currencies.push(v); persist(true); renderControl(); });
  $$('[data-delcur]').forEach(el => el.addEventListener('click', () => { DATA.settings.currencies = DATA.settings.currencies.filter(c => c !== el.dataset.delcur); persist(true); renderControl(); }));
  $$('[data-editcur]').forEach(el => el.addEventListener('click', () => { editingCurrency = el.dataset.editcur; renderControl(); }));
  $('[data-cancelcur]')?.addEventListener('click', () => { editingCurrency = null; renderControl(); });
  $$('[data-savecur]').forEach(el => el.addEventListener('click', () => {
    const oldC = el.dataset.savecur, newC = $('#editCurInput').value.trim().toUpperCase();
    if (newC && newC !== oldC) {
      DATA.settings.currencies = DATA.settings.currencies.map(c => c === oldC ? newC : c);
      DATA.transactions.forEach(t => { if (t.currency === oldC) t.currency = newC; });
      DATA.investments.forEach(t => { if (t.currency === oldC) t.currency = newC; });
      DATA.zakatPayments.forEach(t => { if (t.currency === oldC) t.currency = newC; });
      DATA.clients.forEach(c => { if (c.currency === oldC) c.currency = newC; });
      if (DATA.settings.investmentInitial[oldC] !== undefined) { DATA.settings.investmentInitial[newC] = DATA.settings.investmentInitial[oldC]; delete DATA.settings.investmentInitial[oldC]; }
    }
    editingCurrency = null; persist(true); renderControl();
  }));

  $$('[data-addcat]').forEach(el => el.addEventListener('click', () => {
    const type = el.dataset.addcat; const input = type === 'income' ? $('#newIncomeSource') : $('#newExpenseCat');
    const name = input.value.trim(); if (!name) return;
    DATA.categories.push({ id: uid(), type, name, color: nextCategoryColor(), deleted: false }); persist(true); renderControl();
  }));
  $$('[data-delcat]').forEach(el => el.addEventListener('click', () => { const c = DATA.categories.find(c => c.id === el.dataset.delcat); if (c) { c.deleted = true; c.updatedAt = Date.now(); persist(true); renderControl(); } }));
  $$('[data-editcat]').forEach(el => el.addEventListener('click', () => { editingCategoryId = el.dataset.editcat; renderControl(); }));
  $('[data-cancelcat]')?.addEventListener('click', () => { editingCategoryId = null; renderControl(); });
  $$('[data-savecat]').forEach(el => el.addEventListener('click', () => {
    const c = DATA.categories.find(c => c.id === el.dataset.savecat);
    const v = $(`#editCatInput_${c.id}`).value.trim(); if (v) c.name = v;
    const colorInput = $(`#editCatColor_${c.id}`); if (colorInput) c.color = colorInput.value;
    editingCategoryId = null; persist(true); renderControl();
  }));

  $('#addClientBtn')?.addEventListener('click', () => {
    const name = $('#newClientName').value.trim(); if (!name) return toast('أدخل اسم العميل');
    DATA.clients.push({ id: uid(), name, currency: $('#newClientCurrency').value, createdAt: Date.now(), deleted: false }); persist(true); renderControl();
  });
  $$('[data-delclient]').forEach(el => el.addEventListener('click', () => { const c = DATA.clients.find(c => c.id === el.dataset.delclient); if (c) { c.deleted = true; c.updatedAt = Date.now(); persist(true); renderControl(); } }));
  $$('[data-editclient]').forEach(el => el.addEventListener('click', () => { editingClientId = el.dataset.editclient; renderControl(); }));
  $('[data-cancelclient]')?.addEventListener('click', () => { editingClientId = null; renderControl(); });
  $$('[data-saveclient]').forEach(el => el.addEventListener('click', () => {
    const c = DATA.clients.find(c => c.id === el.dataset.saveclient);
    c.name = $(`#editClientName_${c.id}`).value.trim() || c.name; c.currency = $(`#editClientCur_${c.id}`).value;
    editingClientId = null; persist(true); renderControl();
  }));

  // أنواع الأصول (قسم "أموالي") — إضافة/تعديل/حذف حرّ
  // ⚠️ الحذف هنا لازم يكون "ناعم" (deleted:true) لا حذف فعلي من المصفوفة — لأن أنواع الأصول تدخل
  // بالمزامنة بين الأجهزة (Sync.MERGE_ARRAYS)، ولو حذفنا العنصر فعليًا محليًا، أول سحب لاحق من جهاز
  // ثاني أو من السحابة يرجّعه من جديد لأنه ما زال موجودًا هناك بلا علامة حذف — وهذا بالضبط سبب
  // إحساس "الحذف ما يشتغل". نفس المبدأ المتّبع بكل قسم آخر بالتطبيق (تصنيف، عميل، دين...)
  $('#addAssetTypeBtn')?.addEventListener('click', () => {
    const name = $('#newAssetTypeName').value.trim(); if (!name) return toast('أدخل اسم النوع');
    const icon = $('#newAssetTypeIcon').value.trim() || '💠';
    DATA.assetTypes.push({ id: uid(), icon, name, deleted: false, createdAt: Date.now(), updatedAt: Date.now() }); persist(true); renderControl();
  });
  $$('[data-editassettype]').forEach(el => el.addEventListener('click', () => { editingAssetTypeId = el.dataset.editassettype; renderControl(); }));
  $('[data-cancelassettype]')?.addEventListener('click', () => { editingAssetTypeId = null; renderControl(); });
  $$('[data-saveassettype]').forEach(el => el.addEventListener('click', () => {
    const t = DATA.assetTypes.find(x => x.id === el.dataset.saveassettype);
    t.name = $('#editAssetTypeName').value.trim() || t.name;
    t.icon = $('#editAssetTypeIcon').value.trim() || t.icon;
    t.updatedAt = Date.now();
    editingAssetTypeId = null; persist(true); renderControl();
  }));
  $$('[data-delassettype]').forEach(el => el.addEventListener('click', () => {
    const id = el.dataset.delassettype;
    if (DATA.assetTypes.filter(x => !x.deleted).length <= 1) return toast('لازم يبقى نوع واحد على الأقل');
    const inUse = DATA.assets.some(a => !a.deleted && a.type === id);
    if (inUse) return toast('هذا النوع مستعمل في أصل موجود — عدّل نوع ذلك الأصل أولًا ثم احذف');
    const t = DATA.assetTypes.find(x => x.id === id);
    if (t) { t.deleted = true; t.updatedAt = Date.now(); }
    persist(true); renderControl();
  }));


  const alertTypeSel = $('#alertType');
  const expenseCats = DATA.categories.filter(c => c.type === 'expense' && !c.deleted);
  const renderAlertParams = () => {
    const host = $('#alertParamsHost');
    const curOpts = DATA.settings.currencies.map(c => `<option>${c}</option>`).join('');
    if (alertTypeSel.value === 'investment_threshold') host.innerHTML = `<div class="form-grid" style="grid-template-columns:1fr 1fr;"><select id="ap_currency">${curOpts}</select><input type="number" id="ap_amount" placeholder="المبلغ"></div>`;
    else if (alertTypeSel.value === 'expense_ratio') host.innerHTML = `<div class="form-grid" style="grid-template-columns:1fr 1fr;"><select id="ap_currency">${curOpts}</select><input type="number" id="ap_percent" placeholder="النسبة %"></div>`;
    else if (alertTypeSel.value === 'category_threshold') host.innerHTML = `<div class="form-grid" style="grid-template-columns:1fr 1fr 1fr;"><select id="ap_category">${expenseCats.map(c => `<option value="${c.id}">${c.name}</option>`).join('')}</select><select id="ap_currency">${curOpts}</select><input type="number" id="ap_amount" placeholder="المبلغ"></div>`;
    else if (alertTypeSel.value === 'client_unpaid') host.innerHTML = `<div class="form-grid" style="grid-template-columns:1fr 1fr;"><select id="ap_client">${DATA.clients.filter(c => !c.deleted).map(c => `<option value="${c.id}">${c.name}</option>`).join('')}</select><input type="number" id="ap_days" placeholder="عدد الأيام" value="14"></div>`;
  };
  alertTypeSel?.addEventListener('change', renderAlertParams); if (alertTypeSel) renderAlertParams();
  $('#alertHelpBtn')?.addEventListener('click', () => {
    const box = $('#alertHelpBox');
    if (box.style.display === 'none') {
      box.innerHTML = `
        <strong>وصول رصيد إلى مبلغ معيّن:</strong> يراقب صافي (دخل − مصاريف) عملة معيّنة عبر كل الوقت، وينبّهك بإشعار فور وصوله للمبلغ الذي تحدده، مرة واحدة فقط.<br><br>
        <strong>نسبة مصاريف من الدخل:</strong> يحسب نسبة (مصاريف ÷ دخل × 100) لعملة معيّنة عبر كل الوقت، وينبّهك إذا تجاوزت النسبة اللي حددتها.<br><br>
        <strong>تجاوز فئة مصروف مبلغًا معيّنًا:</strong> يجمع كل المصاريف المسجّلة في فئة واحدة (مثل "فواتير") لعملة معيّنة عبر كل الوقت، وينبّهك عند تجاوزها المبلغ.<br><br>
        <strong>عميل لم يكتمل دفعه منذ مدة:</strong> يتحقق يوميًا هل عند عميل معيّن مشروع لم يُدفع بالكامل، وكم يوم مضى منذ إنشاء ذلك المشروع - إذا تجاوز عدد الأيام اللي حددتها، تصلك رسالة تذكير.<br><br>
        <span class="muted">كل تنبيه يُطلق مرة واحدة فقط لكل حالة، ويظهر أيضًا في نافذة "الإشعارات" 🔔 حتى لو فاتك الإشعار الفوري.</span>`;
      box.style.display = 'block';
    } else box.style.display = 'none';
  });
  $('#addAlertBtn')?.addEventListener('click', () => {
    const kind = alertTypeSel.value;
    let params;
    if (kind === 'investment_threshold') params = { currency: $('#ap_currency').value, amount: parseFloat($('#ap_amount').value) || 0 };
    else if (kind === 'expense_ratio') params = { currency: $('#ap_currency').value, percent: parseFloat($('#ap_percent').value) || 0 };
    else if (kind === 'category_threshold') params = { categoryId: $('#ap_category').value, currency: $('#ap_currency').value, amount: parseFloat($('#ap_amount').value) || 0 };
    else if (kind === 'client_unpaid') params = { clientId: $('#ap_client').value, days: parseFloat($('#ap_days').value) || 14 };
    DATA.alerts.push({ id: uid(), kind, params, active: true, lastTriggeredAt: null, deleted: false }); persist(true); renderControl();
  });
  $$('[data-delalert]').forEach(el => el.addEventListener('click', () => { const a = DATA.alerts.find(a => a.id === el.dataset.delalert); if (a) { a.deleted = true; a.updatedAt = Date.now(); persist(true); renderControl(); } }));
  $$('[data-togglealert]').forEach(el => el.addEventListener('click', () => { const a = DATA.alerts.find(a => a.id === el.dataset.togglealert); if (a) { a.active = !a.active; a.lastTriggeredAt = null; a.lastTriggeredYM = null; a.updatedAt = Date.now(); persist(true); renderControl(); } }));
  $$('[data-editalert]').forEach(el => el.addEventListener('click', () => { editingAlertId = el.dataset.editalert; renderControl(); }));
  $('[data-cancelalert]')?.addEventListener('click', () => { editingAlertId = null; renderControl(); });
  $$('[data-savealert]').forEach(el => el.addEventListener('click', () => {
    const a = DATA.alerts.find(a => a.id === el.dataset.savealert); if (!a) return;
    const row = el.closest('.list-row');
    $$('[data-af]', row).forEach(input => {
      const key = input.dataset.af;
      a.params[key] = (key === 'amount' || key === 'percent' || key === 'days') ? (parseFloat(input.value) || 0) : input.value;
    });
    a.lastTriggeredAt = null; a.lastTriggeredYM = null; a.updatedAt = Date.now(); editingAlertId = null; persist(true); renderControl(); toast('تم تحديث التنبيه');
  }));

  $('#saveLabelsBtn')?.addEventListener('click', () => { $$('[data-labelkey]').forEach(input => { DATA.labels[input.dataset.labelkey] = input.value; }); persist(true); buildNav(); renderControl(); toast('تم تحديث العناوين'); });
  bindBackupEvents();
}

function bindBackupEvents() {
  $('#backupNowBtn')?.addEventListener('click', async () => { await Platform.backupNow(DATA); toast('تم إنشاء نسخة احتياطية'); });
  $('#exportBtn')?.addEventListener('click', async () => { const res = await Platform.exportToFile(DATA); if (res.ok) toast('تم التصدير: ' + res.filePath); });
  $('#importBtn')?.addEventListener('click', async () => {
    const res = await Platform.importFromFile();
    if (res.ok && res.data) {
      DATA = res.data; DATA.meta = DATA.meta || {}; DATA.meta.seenDates = DATA.meta.seenDates || [];
      DATA.investments = DATA.investments || []; DATA.settings.investmentInitial = DATA.settings.investmentInitial || {};
      DATA.settings.exchangeRates = DATA.settings.exchangeRates || {}; DATA.zakatPayments = DATA.zakatPayments || [];
      DATA.settings.years = DATA.settings.years || [new Date().getFullYear()];
      DATA.notifications = DATA.notifications || [];
      DATA.settings.autoSaveEnabled = DATA.settings.autoSaveEnabled !== false;
      DATA.settings.autoSaveUnit = DATA.settings.autoSaveUnit || 'minutes';
      DATA.settings.disabledSections = DATA.settings.disabledSections || [];
      DATA.debts = DATA.debts || [];
      DATA.plans = DATA.plans || []; DATA.priceItems = DATA.priceItems || []; DATA.priceAddons = DATA.priceAddons || []; DATA.quotes = DATA.quotes || []; DATA.pricingPresets = DATA.pricingPresets || [];
      DATA.settings.aiProviders = DATA.settings.aiProviders || [];
      DATA.assets = DATA.assets || []; DATA.assetSnapshots = DATA.assetSnapshots || []; DATA.recurringTx = DATA.recurringTx || [];
      DATA.assetTransfers = DATA.assetTransfers || []; DATA.assetOps = DATA.assetOps || [];
      DATA.assetTypes = DATA.assetTypes || DEFAULT_ASSET_TYPES.map(t => ({ ...t }));
      DATA.weeklySchedule = DATA.weeklySchedule || { 0: [], 1: [], 2: [], 3: [], 4: [], 5: [], 6: [] };
      DATA.dailySchedule = DATA.dailySchedule || [];
      DATA.quarterlySchedule = DATA.quarterlySchedule || { 1: [], 2: [], 3: [], 4: [] };
      DATA.yearlySchedule = DATA.yearlySchedule || { 1: [], 2: [], 3: [], 4: [], 5: [], 6: [], 7: [], 8: [], 9: [], 10: [], 11: [], 12: [] };
      DATA.settings.scheduleModesEnabled = DATA.settings.scheduleModesEnabled || { daily: true, weekly: true, quarterly: true, yearly: true };
      if (DATA.settings.scheduleReminderEnabled === undefined) DATA.settings.scheduleReminderEnabled = true;
      DATA.settings.scheduleReminderTime = DATA.settings.scheduleReminderTime || '08:00';
      DATA.meta.lastScheduleNotifyDate = DATA.meta.lastScheduleNotifyDate || null;
      DATA.serviceTypes = DATA.serviceTypes || [];
      DATA.appointments = DATA.appointments || [];
      DATA.settings.workHours = DATA.settings.workHours || { 0: { enabled: true, start: '09:00', end: '20:00' }, 1: { enabled: true, start: '09:00', end: '20:00' }, 2: { enabled: true, start: '09:00', end: '20:00' }, 3: { enabled: true, start: '09:00', end: '20:00' }, 4: { enabled: true, start: '09:00', end: '20:00' }, 5: { enabled: false, start: '09:00', end: '20:00' }, 6: { enabled: true, start: '09:00', end: '20:00' } };
      DATA.settings.appointmentBufferMin = DATA.settings.appointmentBufferMin ?? 10;
      DATA.meta.scheduleNotifyMarkers = DATA.meta.scheduleNotifyMarkers || { daily: null, weekly: null, quarterly: null, yearly: null };
      if (DATA.settings.aiSmartModeEnabled === undefined) DATA.settings.aiSmartModeEnabled = false;
      if (!DATA.settings.debtTypesMigrated) {
        DATA.debts.forEach(d => { d.type = d.type === 'owed_to_me' ? 'i_owe' : d.type === 'i_owe' ? 'they_owe_me' : d.type; });
        DATA.settings.debtTypesMigrated = true;
      }
      if (!DATA.settings.categoryColorsMigrated) {
        const colorCount = {};
        DATA.categories.filter(c => !c.deleted).forEach(c => { const col = c.color || '#4f7cff'; colorCount[col] = (colorCount[col] || 0) + 1; });
        const seenSoFar = {};
        DATA.categories.filter(c => !c.deleted).forEach(c => {
          const col = c.color || '#4f7cff';
          seenSoFar[col] = (seenSoFar[col] || 0) + 1;
          if (!c.color || (colorCount[col] > 1 && seenSoFar[col] > 1)) c.color = nextCategoryColor();
        });
        DATA.settings.categoryColorsMigrated = true;
      }
      DATA.settings.clientsPageMode = DATA.settings.clientsPageMode || 'clients';
      DATA.settings.monthComparisonAlertsEnabled = DATA.settings.monthComparisonAlertsEnabled !== false;
      DATA.monthComparisonLog = DATA.monthComparisonLog || [];
      ensureSyncExtras();
      await persist(true); if (window.Sync) Sync.pushNow(DATA); applyTheme(); applyPerfMode(); buildNav(); updateNotifBadge(); navYear = null; navMonth = null; showView('dashboard');
      toast('تم الاستيراد بنجاح');
    } else if (res.error) toast(res.error);
  });

  // ---------------- النسخ الاحتياطي التلقائي المحلي ----------------
  $('#toggleAutoBackup')?.addEventListener('click', async () => {
    DATA.settings.autoBackupEnabled = !DATA.settings.autoBackupEnabled;
    await persist(true);
    if (window.Sync) Sync.pushNow(DATA); // رفع فوري بدل انتظار المزامنة المؤجّلة، عشان الإعداد يتزامن حتى لو أُغلق التطبيق بعد التبديل مباشرة
    renderSettings();
  });

  const statusEl = $('#autoBackupStatus');
  if (statusEl && window.Platform && Platform.listBackups) {
    Platform.listBackups().then(res => {
      if (!statusEl.isConnected) return; // المستخدم غيّر الشاشة قبل ما يوصل الجواب
      if (res && res.needsMainUpdate) {
        statusEl.innerHTML = `<span class="muted">هالميزة تحتاج تحديث صغير لملف main.js (نسخة ويندوز) — راسلني وأعطيك الكود الجاهز تضيفه.</span>`;
        return;
      }
      const fmt = (t) => t ? new Date(t).toLocaleString('ar-DZ') : 'لا توجد بعد';
      statusEl.innerHTML = `🟢 النسخة الحالية: ${fmt(res.current)}<br>📦 النسخة السابقة: ${fmt(res.previous)}`;
    }).catch(() => { if (statusEl.isConnected) statusEl.textContent = 'تعذّر التحقق من النسخ المحفوظة.'; });
  }

  async function doRestore(which) {
    if (!confirm(`استعادة "${which === 'current' ? 'النسخة الحالية' : 'النسخة السابقة'}" بتستبدل كل بياناتك الحالية بمحتوى هالنسخة. متأكد؟`)) return;
    const res = await Platform.restoreBackup(which);
    if (!res.ok) { toast(res.error || 'تعذّرت الاستعادة'); return; }
    DATA = res.data;
    await persist(true);
    if (window.Sync) Sync.pushNow(DATA);
    applyTheme(); applyPerfMode(); buildNav(); updateNotifBadge();
    showView('dashboard');
    toast('تمت الاستعادة بنجاح');
  }
  $('#restoreCurrentBackupBtn')?.addEventListener('click', () => doRestore('current'));
  $('#restorePreviousBackupBtn')?.addEventListener('click', () => doRestore('previous'));

  $('#pickBackupFolderBtn')?.addEventListener('click', async () => {
    const res = await Platform.pickBackupFolder();
    if (res && res.needsMainUpdate) { toast('هالميزة تحتاج تحديث صغير لملف main.js — راسلني وأعطيك الكود الجاهز'); return; }
    if (res && res.ok) toast('تم تحديد مجلد النسخ الاحتياطي');
    else toast('ما تم اختيار مجلد');
  });
}

/* ============================================================
   الإعدادات
   ============================================================ */
const AI_PROVIDER_LABELS = { anthropic: 'Anthropic (Claude)', openai: 'OpenAI (ChatGPT)', google: 'Google (Gemini)', custom: 'مخصّص (متوافق مع OpenAI)' };
function maskKey(k) { if (!k) return '—'; return k.length > 8 ? k.slice(0, 4) + '••••••' + k.slice(-4) : '••••••'; }
let editingAiProviderId = null, addingAiProvider = false;
function aiProvidersCardHtml() {
  const providers = DATA.settings.aiProviders;
  const rows = providers.map((p, idx) => {
    if (editingAiProviderId === p.id) return aiProviderEditFormHtml(p);
    const cooling = p.failedUntil && p.failedUntil > Date.now();
    return `<div class="list-row" style="flex-wrap:wrap;">
      <span><b>${idx + 1}.</b> ${AI_PROVIDER_LABELS[p.provider] || p.provider} <span class="muted" style="font-size:11px;">${p.model || 'الافتراضي'} · ${maskKey(p.apiKey)}</span>
        ${!p.enabled ? '<span class="muted" style="font-size:11px;"> (معطّل)</span>' : ''}${cooling ? `<span style="color:var(--amber); font-size:11px;"> · بانتظار (فشل: ${p.lastError || 'غير معروف'})</span>` : ''}</span>
      <span style="display:flex; gap:4px; flex-wrap:wrap;">
        <button class="btn ghost sm" data-aitest="${p.id}">اختبار</button>
        <button class="btn ghost sm" data-aimoveup="${p.id}" ${idx === 0 ? 'disabled' : ''}>↑</button>
        <button class="btn ghost sm" data-aimovedown="${p.id}" ${idx === providers.length - 1 ? 'disabled' : ''}>↓</button>
        <button class="btn ghost sm" data-aitoggle="${p.id}">${p.enabled ? 'تعطيل' : 'تفعيل'}</button>
        <button class="btn ghost sm" data-aiedit="${p.id}">تعديل</button>
        <button class="btn ghost sm" data-aidel="${p.id}">حذف</button>
      </span>
      <div class="ai-test-result" id="aitest_${p.id}"></div></div>`;
  }).join('');
  return `<strong>🧠 الوضع الذكي الكامل (اختياري)</strong>
    <p class="muted" style="font-size:12px; margin-top:6px;">أضف مفتاح API واحدًا أو أكثر ورتّبهم من الأقوى للأضعف. أي سؤال ما يقدر خبير التطبيق المحلي يجاوبه، يُرسل تلقائيًا للأول بالترتيب، ولو فشل (انتهى رصيده أو تجاوز الحد) ينتقل تلقائيًا للي بعده. هذا يحتاج إنترنت وقد يكلّفك مبلغًا صغيرًا لكل سؤال حسب مزوّدك.</p>
    <div class="segmented" id="aiSmartModeToggle" style="margin-top:10px;">
      <button data-on="1" class="${DATA.settings.aiSmartModeEnabled ? 'active' : ''}">مفعّل</button>
      <button data-on="0" class="${!DATA.settings.aiSmartModeEnabled ? 'active' : ''}">معطّل</button>
    </div>
    <div style="margin-top:10px;">${rows || '<p class="muted" style="font-size:12px;">لا توجد نماذج مضافة بعد</p>'}</div>
    ${addingAiProvider ? aiProviderEditFormHtml(null) : `<div class="form-actions" style="margin-top:10px;"><button class="btn sm" id="addAiProviderBtn">+ إضافة نموذج</button></div>`}`;
}
function aiProviderEditFormHtml(p) {
  return `<div class="list-row" style="flex-direction:column; align-items:stretch; gap:8px; background:var(--surface); padding:10px; border-radius:var(--radius-sm);">
    <div class="form-grid">
      <select id="aip_provider">${Object.entries(AI_PROVIDER_LABELS).map(([k, v]) => `<option value="${k}" ${p && p.provider === k ? 'selected' : ''}>${v}</option>`).join('')}</select>
      <input type="text" id="aip_model" placeholder="اسم الموديل (اختياري، افتراضي جيد)" value="${p ? (p.model || '') : ''}">
      <input type="password" id="aip_key" placeholder="${p ? 'اترك فارغًا للإبقاء على المفتاح الحالي' : 'الصق مفتاح API هنا'}">
      <input type="text" id="aip_endpoint" placeholder="رابط API (فقط للمخصّص)" value="${p ? (p.endpoint || '') : ''}">
    </div>
    <div class="form-actions"><button class="btn sm" id="aip_save" data-id="${p ? p.id : ''}">حفظ</button><button class="btn ghost sm" id="aip_cancel">إلغاء</button></div>
  </div>`;
}
function bindAiProviderEvents(view) {
  $('#aiSmartModeToggle', view)?.addEventListener('click', (e) => {
    const b = e.target.closest('button[data-on]'); if (!b) return;
    if (b.dataset.on === '1' && !DATA.settings.aiProviders.some(p => p.enabled)) return toast('أضف نموذجًا واحدًا على الأقل قبل التفعيل');
    DATA.settings.aiSmartModeEnabled = b.dataset.on === '1'; persist(true); renderSettings();
  });
  $$('[data-aitest]', view).forEach(el => el.addEventListener('click', async () => {
    const p = DATA.settings.aiProviders.find(x => x.id === el.dataset.aitest); if (!p) return;
    const box = $(`#aitest_${p.id}`, view); box.textContent = '🔄 جارٍ الاختبار...'; box.style.color = 'var(--text-muted)';
    const res = await Platform.aiChat([{ ...p, failedUntil: null }], 'قل "تم الاتصال بنجاح" فقط بدون أي إضافة.');
    if (res.ok) { p.failedUntil = null; p.lastError = null; box.textContent = '✅ نجح: ' + res.text; box.style.color = 'var(--green)'; }
    else { const err = (res.failed && res.failed[0] && res.failed[0].error) || 'فشل غير معروف'; p.lastError = err; box.textContent = '❌ فشل: ' + err; box.style.color = 'var(--red)'; }
    persist(true);
  }));
  $('#addAiProviderBtn', view)?.addEventListener('click', () => { addingAiProvider = true; editingAiProviderId = null; renderSettings(); });
  $$('[data-aiedit]', view).forEach(el => el.addEventListener('click', () => { editingAiProviderId = el.dataset.aiedit; addingAiProvider = false; renderSettings(); }));
  $('#aip_cancel', view)?.addEventListener('click', () => { editingAiProviderId = null; addingAiProvider = false; renderSettings(); });
  $('#aip_save', view)?.addEventListener('click', () => {
    const id = $('#aip_save', view).dataset.id;
    const provider = $('#aip_provider', view).value, model = $('#aip_model', view).value.trim();
    const keyInput = $('#aip_key', view).value.trim(), endpoint = $('#aip_endpoint', view).value.trim();
    if (id) {
      const p = DATA.settings.aiProviders.find(x => x.id === id);
      p.provider = provider; p.model = model; p.endpoint = endpoint;
      if (keyInput) p.apiKey = keyInput;
      p.failedUntil = null;
    } else {
      if (!keyInput) return toast('أدخل مفتاح API');
      DATA.settings.aiProviders.push({ id: uid(), provider, label: AI_PROVIDER_LABELS[provider], model, apiKey: keyInput, endpoint, enabled: true, failedUntil: null });
    }
    editingAiProviderId = null; addingAiProvider = false; persist(true); renderSettings();
  });
  $$('[data-aidel]', view).forEach(el => el.addEventListener('click', () => { DATA.settings.aiProviders = DATA.settings.aiProviders.filter(x => x.id !== el.dataset.aidel); persist(true); renderSettings(); }));
  $$('[data-aitoggle]', view).forEach(el => el.addEventListener('click', () => { const p = DATA.settings.aiProviders.find(x => x.id === el.dataset.aitoggle); if (p) { p.enabled = !p.enabled; persist(true); renderSettings(); } }));
  $$('[data-aimoveup]', view).forEach(el => el.addEventListener('click', () => {
    const arr = DATA.settings.aiProviders; const i = arr.findIndex(x => x.id === el.dataset.aimoveup);
    if (i > 0) { [arr[i - 1], arr[i]] = [arr[i], arr[i - 1]]; persist(true); renderSettings(); }
  }));
  $$('[data-aimovedown]', view).forEach(el => el.addEventListener('click', () => {
    const arr = DATA.settings.aiProviders; const i = arr.findIndex(x => x.id === el.dataset.aimovedown);
    if (i >= 0 && i < arr.length - 1) { [arr[i + 1], arr[i]] = [arr[i], arr[i + 1]]; persist(true); renderSettings(); }
  }));
}
function renderSettings() {
  const view = $('#view-settings');
  const themes = [['dark', 'أزرق داكن'], ['black', 'أسود داكن'], ['light', 'فاتح'], ['sunset', 'غروب'], ['emerald', 'زمردي'], ['midnight', 'منتصف الليل']];
  // كل قسم رئيسي في التطبيق (ما عدا الإعدادات نفسها، حتى لا يُغلَق الباب على نفسه) قابل للتعطيل هنا — بلا استثناء
  const NAV_TOGGLEABLE = NAV_ITEMS.filter(([k]) => k !== 'settings');
  const navOrder = orderedNavItems();
  view.innerHTML = `<h2 class="view-title">${label('nav_settings')}</h2>
    <details class="collapse-card card account-card" data-panel="set_account"${panelOpenAttr('set_account')}><summary>👤 الحساب</summary>
      ${(() => {
        const s = window.Auth && Auth.getSession();
        if (!s) return `<p class="muted" style="font-size:12px; margin-top:6px;">غير مسجّل الدخول</p>`;
        const initial = (s.user.username || s.user.email || '؟').trim().charAt(0).toUpperCase();
        return `
        <div class="account-header">
          <div class="account-avatar-wrap">
            <div class="account-avatar lg">
              ${s.user.avatar_url ? `<img src="${s.user.avatar_url}" alt="صورة الحساب">` : `<span>${initial}</span>`}
            </div>
            <button class="account-avatar-edit" id="accountAvatarBtn" title="تغيير الصورة" type="button">📷</button>
            <input type="file" id="accountAvatarInput" accept="image/*" hidden>
          </div>
          <div class="account-name-row">
            <input type="text" id="accountUsernameInput" value="${s.user.username || ''}" maxlength="24" class="account-name-input">
            <button class="btn ghost sm" id="saveUsernameBtn">حفظ</button>
          </div>
          <p class="muted account-email">${s.user.email}</p>
        </div>
        <div class="form-actions" style="justify-content:center; margin-top:6px;">
          <button class="btn ghost sm" id="signOutBtn">تسجيل الخروج</button>
        </div>
        <p class="muted" style="font-size:11px; margin-top:14px; line-height:1.6; text-align:center;">حذف الحساب نهائيًا يحتاج صلاحية خاصة ما ينفع تُحفظ داخل التطبيق نفسه لأسباب أمنية (أي شخص يقدر يستخرجها من الكود ويحذف حساب أي فرد). لحد ما نجهّز سيرفر المزامنة، أرسل لي مين تبي تحذفه وأسويها من طرفي بلوحة Supabase.</p>`;
      })()}
    </details>

    <details class="collapse-card card" data-panel="set_updates" style="margin-top:14px;"${panelOpenAttr('set_updates')}><summary>🔄 التحديثات</summary>
      <div id="updateStatusPanel" style="margin-top:8px;">جارٍ التحقق...</div>
    </details>

    <details class="collapse-card card" data-panel="set_theme" style="margin-top:14px;"${panelOpenAttr('set_theme')}><summary>${label('settings_theme')}</summary><div class="grid grid-4" style="margin-top:10px;">
      ${themes.map(([k, l]) => `<div class="ym-tile ${DATA.settings.theme === k ? 'has-data' : ''}" data-theme="${k}">${l}</div>`).join('')}
    </div></details>

    <details class="collapse-card card" data-panel="set_perf" style="margin-top:14px;"${panelOpenAttr('set_perf')}><summary>${label('settings_perf')}</summary>
      <p class="view-sub" style="margin:8px 0 12px;">يخفف التأثيرات البصرية الثقيلة (الزجاج، التوهج، الحركة) لو جهازك بطيء أو حسّيت بتهنّج بالواجهة.</p>
      <div class="grid" style="grid-template-columns:1fr; gap:8px;">
        <div class="ym-tile ${(DATA.settings.performanceMode || 'auto') === 'auto' ? 'has-data' : ''}" data-perfmode="auto">تلقائي (يكتشف قوة جهازك — موصى به)</div>
        <div class="ym-tile ${DATA.settings.performanceMode === 'high' ? 'has-data' : ''}" data-perfmode="high">أداء كامل (كل التأثيرات مفعّلة دايمًا)</div>
        <div class="ym-tile ${DATA.settings.performanceMode === 'low' ? 'has-data' : ''}" data-perfmode="low">توفير الأداء (تخفيف دائم، للأجهزة الضعيفة)</div>
      </div>
    </details>

    <details class="collapse-card card" data-panel="set_nav_order" style="margin-top:14px;"${panelOpenAttr('set_nav_order')}><summary>${label('settings_nav_order')}</summary>
      <p class="muted" style="font-size:12px; margin-top:6px;">رتّب أقسام التطبيق كما يناسبك — مثلًا اجعل "أموالي" أول تبويب. التغيير يظهر فورًا في القائمة العلوية.</p>
      <div style="margin-top:10px;">
        ${navOrder.filter(([k]) => k !== 'settings').map(([k, lk], i, arr) => `
          <div class="list-row"><span>${label(lk)}</span>
            <span><button class="btn ghost sm" data-navmove="${k}:up" ${i === 0 ? 'disabled' : ''}>▲</button>
            <button class="btn ghost sm" data-navmove="${k}:down" ${i === arr.length - 1 ? 'disabled' : ''}>▼</button></span>
          </div>`).join('')}
      </div>
    </details>

    <details class="collapse-card card" data-panel="set_autosave" style="margin-top:14px;"${panelOpenAttr('set_autosave')}><summary>${label('settings_autosave')}</summary>
      <div class="segmented" id="autosaveToggle" style="margin-top:10px;">
        <button data-on="1" class="${DATA.settings.autoSaveEnabled ? 'active' : ''}">مفعّل</button>
        <button data-on="0" class="${!DATA.settings.autoSaveEnabled ? 'active' : ''}">معطّل</button>
      </div>
      <div class="form-grid" style="grid-template-columns:1fr 1fr; margin-top:10px; max-width:340px;">
        <label class="field">كل<input type="number" id="autosave_min" value="${DATA.settings.autoSaveMinutes}"></label>
        <label class="field">الوحدة<select id="autosave_unit">
          <option value="seconds" ${DATA.settings.autoSaveUnit === 'seconds' ? 'selected' : ''}>ثانية</option>
          <option value="minutes" ${DATA.settings.autoSaveUnit === 'minutes' ? 'selected' : ''}>دقيقة</option>
          <option value="hours" ${DATA.settings.autoSaveUnit === 'hours' ? 'selected' : ''}>ساعة</option>
        </select></label>
      </div>
      <div class="form-actions"><button class="btn sm" id="saveAutosave">حفظ</button></div></details>

    <details class="collapse-card card" data-panel="set_monthcompare" style="margin-top:14px;"${panelOpenAttr('set_monthcompare')}><summary>${label('settings_monthcompare')}</summary>
      <p class="muted" style="font-size:12px; margin-top:6px;">ينبّهك تلقائيًا بعد 15 يومًا من الشهر الجديد (وتذكير إضافي بعد أسبوع) هل هذا الشهر أفضل أو أسوأ من الشهر الماضي.</p>
      <div class="segmented" id="monthCompareToggle" style="margin-top:10px;">
        <button data-on="1" class="${DATA.settings.monthComparisonAlertsEnabled ? 'active' : ''}">مفعّل</button>
        <button data-on="0" class="${!DATA.settings.monthComparisonAlertsEnabled ? 'active' : ''}">معطّل</button>
      </div>
    </details>

    <details class="collapse-card card" data-panel="set_sections" style="margin-top:14px;"${panelOpenAttr('set_sections')}><summary>${label('settings_sections')}</summary>
      <p class="muted" style="font-size:12px; margin-top:6px;">عطّل أي قسم لا تحتاجه فيختفي من التطبيق دون التأثير على حساباتك (تبقى كما هي وتظهر فورًا عند إعادة التفعيل). كل أقسام التطبيق مدرجة هنا ما عدا الإعدادات نفسها.</p>
      <div style="margin-top:10px;">
        ${NAV_TOGGLEABLE.map(([k, lk]) => `
          <div class="list-row"><span>${label(lk)}</span>
            <button class="btn ${DATA.settings.disabledSections.includes(k) ? 'ghost' : ''} sm" data-togglesection="${k}">${DATA.settings.disabledSections.includes(k) ? 'مُعطَّل - تفعيل' : 'مفعّل - تعطيل'}</button>
          </div>`).join('')}
        <div class="muted" style="font-size:11px; margin-top:10px; border-top:1px solid var(--border); padding-top:10px;">تبويبات فرعية داخل "الجرد السنوي":</div>
        ${[['investment', 'الاستثمار'], ['outflows', 'الإخراجات']].map(([k, l]) => `
          <div class="list-row"><span>${l}</span>
            <button class="btn ${DATA.settings.disabledSections.includes(k) ? 'ghost' : ''} sm" data-togglesection="${k}">${DATA.settings.disabledSections.includes(k) ? 'مُعطَّل - تفعيل' : 'مفعّل - تعطيل'}</button>
          </div>`).join('')}
      </div>
    </details>

    <details class="collapse-card card" data-panel="set_schedmodes" style="margin-top:14px;"${panelOpenAttr('set_schedmodes')}><summary>${label('settings_schedmodes')}</summary>
      <p class="muted" style="font-size:12px; margin-top:6px;">اختر أنواع الجدول التي تريد أن تظهر لك ضمن "التخطيط والتسعير" — يومي، أسبوعي، فصلي، سنوي. عناصرك المحفوظة تبقى محفوظة حتى لو أخفيت القسم.</p>
      <div style="margin-top:10px;">
        ${Object.entries(SCHEDULE_MODES_CFG).map(([k, c]) => `
          <div class="list-row"><span>${c.icon} ${c.label}</span>
            <button class="btn ${DATA.settings.scheduleModesEnabled[k] === false ? 'ghost' : ''} sm" data-toggleschedmode="${k}">${DATA.settings.scheduleModesEnabled[k] === false ? 'مُعطَّل - تفعيل' : 'مفعّل - تعطيل'}</button>
          </div>`).join('')}
      </div>
    </details>

    <details class="collapse-card card" data-panel="set_ai" style="margin-top:14px;"${panelOpenAttr('set_ai')}><summary>${label('settings_ai')}</summary>${aiProvidersCardHtml()}</details>

    <details class="collapse-card card" data-panel="set_backup" style="margin-top:14px;"${panelOpenAttr('set_backup')}><summary>${label('settings_backup')}</summary>
      <p class="muted" style="font-size:12px; margin-top:6px;">آخر حفظ: ${DATA.meta.lastSavedAt ? new Date(DATA.meta.lastSavedAt).toLocaleString('ar-DZ') : '—'}</p>
      <div class="form-actions" style="flex-wrap:wrap;"><button class="btn ghost sm" id="backupNowBtn">نسخة احتياطية الآن</button><button class="btn ghost sm" id="exportBtn">تصدير ملف</button><button class="btn ghost sm" id="importBtn">استيراد ملف</button></div>

      <div style="margin-top:16px; padding-top:14px; border-top:1px solid var(--border);">
        <div class="list-row"><strong>📦 نسخة احتياطية محلية تلقائية</strong>
          <button class="btn ${DATA.settings.autoBackupEnabled ? '' : 'ghost'} sm" id="toggleAutoBackup">${DATA.settings.autoBackupEnabled ? 'مفعّلة - إيقاف' : 'مُعطَّلة - تفعيل'}</button>
        </div>
        <p class="muted" style="font-size:12px; margin-top:4px;">نسخة مستقلة تُؤخذ تلقائيًا مرة كل يوم بالكثير على نفس الجهاز، ويُحتفظ بآخر نسختين بس (الحالية والسابقة). فعل أخذ النسخة نفسه محلي بحت — يستمر عادي حتى لو قطعت النت أو أوقفت تسجيل الدخول — أما إعداد التفعيل/الإيقاف هذا فيتزامن بين أجهزتك زي باقي الإعدادات.</p>
        <div id="autoBackupStatus" style="margin-top:10px; font-size:13px;">جاري التحقق من النسخ المحفوظة...</div>
        ${DATA.settings.autoBackupEnabled ? `<div class="form-actions" style="flex-wrap:wrap; margin-top:8px;">
          <button class="btn ghost sm" id="restoreCurrentBackupBtn">استعادة النسخة الحالية</button>
          <button class="btn ghost sm" id="restorePreviousBackupBtn">استعادة النسخة السابقة</button>
          ${window.Platform && Platform.platformName === 'electron' ? `<button class="btn ghost sm" id="pickBackupFolderBtn">اختيار مجلد الحفظ</button>` : ''}
        </div>` : ''}
      </div>
    </details>

    <details class="collapse-card card" data-panel="set_danger" style="margin-top:14px; border-color: rgba(239,90,111,0.4);"${panelOpenAttr('set_danger')}><summary style="color:var(--red);">${label('settings_danger')}</summary>
      <p class="muted" style="font-size:12px; margin-top:6px;">احذف بيانات شهر معيّن، سنة كاملة، أو كل شيء نهائيًا. هذا الإجراء لا يمكن التراجع عنه بعد إغلاق البرنامج (زر ⏪ يعمل فقط خلال هذه الجلسة).</p>
      <div class="form-grid" style="grid-template-columns: 1fr 1fr 1fr; margin-top:10px;">
        <label class="field">النطاق<select id="wipe_scope">
          <option value="month">شهر معيّن</option><option value="year">سنة كاملة</option><option value="all">كل البيانات نهائيًا</option>
        </select></label>
        <label class="field" id="wipe_year_field">السنة<select id="wipe_year">${DATA.settings.years.map(y2 => `<option>${y2}</option>`).join('')}</select></label>
        <label class="field" id="wipe_month_field">الشهر<select id="wipe_month">${MONTH_NAMES.map((n, i) => `<option value="${i + 1}">${n}</option>`).join('')}</select></label>
      </div>
      <div class="form-actions"><button class="btn danger sm" id="wipeDataBtn">مسح الآن</button></div>
    </details>`;
  bindAiProviderEvents(view);
  bindPanelToggles(view);
  if (window.UpdateCheck) UpdateCheck.paintStatusPanel();
  $$('[data-theme]', view).forEach(el => el.addEventListener('click', () => { DATA.settings.theme = el.dataset.theme; applyTheme(); persist(true); renderSettings(); }));
  $$('[data-perfmode]', view).forEach(el => el.addEventListener('click', () => { DATA.settings.performanceMode = el.dataset.perfmode; applyPerfMode(); persist(true); renderSettings(); }));
  $$('[data-navmove]', view).forEach(el => el.addEventListener('click', () => {
    const [key, dir] = el.dataset.navmove.split(':');
    const order = orderedNavItems().map(([k]) => k).filter(k => k !== 'settings');
    const i = order.indexOf(key); const j = dir === 'up' ? i - 1 : i + 1;
    if (j < 0 || j >= order.length) return;
    [order[i], order[j]] = [order[j], order[i]];
    DATA.settings.navOrder = [...order, 'settings'];
    persist(true); buildNav(); renderSettings();
  }));
  $('#monthCompareToggle').addEventListener('click', (e) => {
    const b = e.target.closest('button[data-on]'); if (!b) return;
    DATA.settings.monthComparisonAlertsEnabled = b.dataset.on === '1';
    persist(true); renderSettings();
  });
  $$('[data-togglesection]', view).forEach(el => el.addEventListener('click', () => {
    const k = el.dataset.togglesection;
    if (DATA.settings.disabledSections.includes(k)) DATA.settings.disabledSections = DATA.settings.disabledSections.filter(x => x !== k);
    else DATA.settings.disabledSections.push(k);
    persist(true); buildNav(); renderSettings();
  }));
  $$('[data-toggleschedmode]', view).forEach(el => el.addEventListener('click', () => {
    const k = el.dataset.toggleschedmode;
    DATA.settings.scheduleModesEnabled[k] = DATA.settings.scheduleModesEnabled[k] === false ? true : false;
    persist(true); renderSettings();
  }));
  $('#autosaveToggle').addEventListener('click', (e) => { const b = e.target.closest('button[data-on]'); if (!b) return; $$('#autosaveToggle button').forEach(x => x.classList.toggle('active', x === b)); });
  $('#saveAutosave')?.addEventListener('click', () => {
    const unit = $('#autosave_unit').value;
    let val = parseFloat($('#autosave_min').value) || 1;
    // ممنوع أقل من 30 ثانية مهما كانت الوحدة — قيمة أصغر من ذلك تلخبط التزامن بين الأجهزة
    const valSeconds = unit === 'seconds' ? val : unit === 'minutes' ? val * 60 : val * 3600;
    let clamped = false;
    if (valSeconds < 30) { val = unit === 'seconds' ? 30 : (30 / (unit === 'minutes' ? 60 : 3600)); clamped = true; }
    DATA.settings.autoSaveMinutes = val;
    DATA.settings.autoSaveUnit = unit;
    DATA.settings.autoSaveEnabled = $('#autosaveToggle button.active').dataset.on === '1';
    scheduleAutoSave(); persist(true);
    toast(clamped ? 'أقل مدة مسموحة 30 ثانية — تم ضبطها تلقائيًا لهذا الحد' : 'تم الحفظ');
  });

  const scopeSel = $('#wipe_scope');
  const updateWipeFields = () => {
    $('#wipe_year_field').style.display = scopeSel.value === 'all' ? 'none' : 'flex';
    $('#wipe_month_field').style.display = scopeSel.value === 'month' ? 'flex' : 'none';
  };
  scopeSel.addEventListener('change', updateWipeFields); updateWipeFields();

  $('#wipeDataBtn').addEventListener('click', () => {
    const scope = scopeSel.value;
    const yy = parseInt($('#wipe_year').value), mm = parseInt($('#wipe_month').value);
    const scopeLabel = scope === 'all' ? 'كل بيانات التطبيق نهائيًا (يرجع البرنامج كأنه مثبَّت جديدًا على الجهاز)' : scope === 'year' ? `كل بيانات سنة ${yy}` : `بيانات ${MONTH_NAMES[mm - 1]} ${yy}`;
    confirmDialog({
      title: '⚠️ تأكيد المسح',
      message: `أنت على وشك حذف ${scopeLabel}. هذا الإجراء نهائي بعد إغلاق البرنامج. هل أخذت نسخة احتياطية من الأعلى (النسخ الاحتياطي)؟`,
      confirmLabel: 'نعم، احذف نهائيًا', dangerous: true,
      onConfirm: () => {
        if (scope === 'all') { wipeEverything(); return; }
        const matchDate = (d) => scope === 'year' ? inYear(d, yy) : inMonth(d, yy, mm);
        DATA.transactions.forEach(t => { if (matchDate(t.date)) { t.deleted = true; t.updatedAt = Date.now(); } });
        DATA.investments.forEach(t => { if (matchDate(t.date)) { t.deleted = true; t.updatedAt = Date.now(); } });
        DATA.zakatPayments.forEach(z => { if (matchDate(z.date)) { z.deleted = true; z.updatedAt = Date.now(); } });
        persist(true); toast('تم المسح');
        renderSettings();
      }
    });
  });
  bindBackupEvents();

  $('#accountAvatarBtn')?.addEventListener('click', () => $('#accountAvatarInput').click());
  $('#accountAvatarInput')?.addEventListener('change', async (e) => {
    const file = e.target.files && e.target.files[0];
    if (!file) return;
    toast('جارٍ رفع الصورة...');
    try {
      await Auth.uploadAvatar(file);
      toast('تم تحديث الصورة');
      renderSettings();
      renderTopbarAccount();
    } catch (err) {
      toast((err && err.message) || 'تعذّر رفع الصورة');
    }
  });
  $('#saveUsernameBtn')?.addEventListener('click', async () => {
    const val = $('#accountUsernameInput').value.trim();
    if (!val) { toast('اكتب اسمًا صحيحًا'); return; }
    try {
      await Auth.updateProfile({ username: val });
      toast('تم حفظ الاسم');
      renderSettings();
      renderTopbarAccount();
    } catch (err) {
      toast((err && err.message) || 'تعذّر الحفظ');
    }
  });

  $('#signOutBtn')?.addEventListener('click', () => {
    confirmDialog({
      title: 'تسجيل الخروج',
      message: 'هذا يرجعك لشاشة الدخول. بياناتك المحفوظة على هذا الجهاز ما تتأثر إطلاقًا.',
      confirmLabel: 'خروج',
      onConfirm: async () => {
        await Auth.signOut();
        location.reload();
      }
    });
  });
}

/* ---------------- نافذة تأكيد عصرية (بدل confirm() القديمة في المتصفح) ---------------- */
// ⚠️ منطقة الخطر — "مسح كل البيانات نهائيًا": يرجع التطبيق لحالته الأولى تمامًا كأنه مثبَّت جديدًا على الجهاز.
// قبل هذا الإصلاح كان يمسح فقط (المعاملات/الاستثمارات/الزكاة/المشاريع/العملاء/الرزنامة) ويترك كل شيء
// آخر كما هو (الديون، المذكرة، التخطيط والتسعير، المواعيد، أموالي، الجدول المتكرر، الإعدادات...).
// كل مصفوفة تدخل بالمزامنة بين الأجهزة (انظر Sync.MERGE_ARRAYS/MERGE_BUCKETED) لازم "حذف ناعم"
// (deleted:true + updatedAt جديد) لا حذف فعلي من المصفوفة — وإلا أول سحب لاحق من جهاز ثاني أو من
// السحابة يرجّع البيانات القديمة من جديد لأنها ما زالت موجودة هناك بلا علامة حذف.
async function wipeEverything() {
  const now = Date.now();
  const softDeleteAll = (arr) => { (arr || []).forEach(x => { if (x && !x.deleted) { x.deleted = true; x.updatedAt = now; } }); };
  // كل المصفوفات المسطّحة المعرَّفة بمعرّف فريد (id) — تُمسح بعلامة حذف ناعم
  ['categories', 'clients', 'projects', 'transactions', 'alerts', 'calendarItems', 'zakatPayments', 'debts',
    'investments', 'plans', 'priceItems', 'priceAddons', 'quotes', 'pricingPresets',
    'assets', 'assetTransfers', 'assetOps', 'recurringTx', 'serviceTypes', 'appointments', 'dailySchedule']
    .forEach(key => softDeleteAll(DATA[key]));
  // الجداول المجدولة بحاوية (أسبوعي/فصلي/سنوي) — نفس المبدأ داخل كل يوم/فصل/شهر
  ['weeklySchedule', 'quarterlySchedule', 'yearlySchedule'].forEach(key => {
    const bucket = DATA[key] || {};
    Object.keys(bucket).forEach(k => softDeleteAll(bucket[k]));
  });
  // أنواع الأصول: نمسح القديمة ناعمًا ونرجّعها للقائمة الافتراضية (بدل ما تختفي "إضافة أصل" كليًا) — تمامًا كأول تشغيل
  softDeleteAll(DATA.assetTypes);
  DATA.assetTypes.push(...DEFAULT_ASSET_TYPES.map(t => ({ ...t, deleted: false, createdAt: now, updatedAt: now })));
  softDeleteAll(DATA.notifications); // الإشعارات ولقطات صافي الثروة وحالات الجرس صارت تتزامن — تُمسح بعلامة حذف ناعم حتى لا تعود من السحابة
  softDeleteAll(DATA.assetSnapshots);
  softDeleteAll(DATA.syncFlags);
  DATA.monthComparisonLog = [];
  // سجلّات محلية بحتة (ما تدخل المزامنة بين الأجهزة إطلاقًا) — تُصفَّر مباشرة
  DATA.meta = { lastSavedAt: null, lastSavedDevice: (DATA.meta && DATA.meta.lastSavedDevice) || null, seenDates: [], scheduleNotifyMarkers: { daily: null, weekly: null, quarterly: null, yearly: null }, lastScheduleNotifyDate: null };
  // الإعدادات والعناوين: نرجّعها لقيمها الافتراضية بالكامل — نسخة الجهاز هذا تكسب تلقائيًا بأي مزامنة
  // لاحقة لأنها الأحدث توقيتًا (settings/labels تُدمج حسب meta.lastSavedAt الأحدث، لا بمعرّف عنصر)
  DATA.settings = {
    theme: 'black', language: 'ar', defaultCurrency: 'DA', currencies: ['DA', 'USD', 'EUR'],
    autoSaveMinutes: 60, autoSaveUnit: 'seconds', zakatPercent: 2.5, investmentInitial: {}, exchangeRates: {},
    years: [new Date().getFullYear()], autoSaveEnabled: true, disabledSections: [],
    navOrder: NAV_ITEMS.map(([k]) => k), aiProviders: [], aiSmartModeEnabled: false,
    scheduleModesEnabled: { daily: true, weekly: true, quarterly: true, yearly: true },
    scheduleReminderEnabled: true, scheduleReminderTime: '08:00',
    workHours: { 0: { enabled: true, start: '09:00', end: '20:00' }, 1: { enabled: true, start: '09:00', end: '20:00' }, 2: { enabled: true, start: '09:00', end: '20:00' }, 3: { enabled: true, start: '09:00', end: '20:00' }, 4: { enabled: true, start: '09:00', end: '20:00' }, 5: { enabled: false, start: '09:00', end: '20:00' }, 6: { enabled: true, start: '09:00', end: '20:00' } },
    appointmentBufferMin: 10, performanceMode: 'auto', autoBackupEnabled: true, clientsPageMode: 'clients',
    monthComparisonAlertsEnabled: true, debtTypesMigrated: true, categoryColorsMigrated: true
  };
  DATA.labels = Object.assign({}, DEFAULT_LABELS);
  await persist(false);
  if (window.Sync && Sync.pushNow) { try { await Sync.pushNow(DATA); } catch (e) { /* بدون نت مثلًا — البيانات محفوظة محليًا وستُرفع بأقرب دورة مزامنة */ } }
  toast('تم مسح كل البيانات — البرنامج يرجع لحالته الأولى الآن');
  location.reload();
}

function confirmDialog({ title, message, confirmLabel = 'تأكيد', dangerous = false, onConfirm }) {
  const panel = $('#confirmPanel');
  panel.classList.remove('hidden');
  panel.innerHTML = `<div id="confirmBox">
    <div style="font-size:16px; font-weight:800; margin-bottom:10px;">${title}</div>
    <p class="muted" style="font-size:13px; line-height:1.8;">${message}</p>
    <div class="form-actions" style="justify-content:center; margin-top:16px;">
      <button class="btn ${dangerous ? 'danger' : ''}" id="confirmDialogYes">${confirmLabel}</button>
      <button class="btn ghost" id="confirmDialogNo">إلغاء</button>
    </div>
  </div>`;
  $('#confirmDialogYes').addEventListener('click', () => { panel.classList.add('hidden'); onConfirm(); });
  $('#confirmDialogNo').addEventListener('click', () => panel.classList.add('hidden'));
}

/* ============================================================
   رسوم إضافية: دائري + مؤشر صحة مالية + خريطة حرارية
   ============================================================ */
function donutChart(data, opts = {}) {
  const total = data.reduce((s, d) => s + d.value, 0);
  const size = opts.size || 240, r = 88, cx = size / 2, cy = size / 2;
  if (total <= 0) return '<p class="muted" style="font-size:12px;">لا بيانات كافية بعد</p>';
  const id = 'pie' + (chartIdCounter++);
  let angle = -90;
  const toXY = (a, radius) => [cx + radius * Math.cos(a * Math.PI / 180), cy + radius * Math.sin(a * Math.PI / 180)];
  const slicesData = data.map(d => {
    const frac = d.value / total;
    const startAngle = angle;
    let endAngle = angle + frac * 360;
    if (data.length === 1 || endAngle - startAngle >= 359.99) endAngle = startAngle + 359.99;
    angle = endAngle;
    const large = (endAngle - startAngle) > 180 ? 1 : 0;
    return { d, startAngle, endAngle, large };
  });
  // قرص مسطّح نظيف بدل التأثير "المجسّم" القديم (كان يترك طبقة/جدارًا باهتًا وفجوة ظاهرة بين الشرائح) — لمعان خفيف فقط عبر تدرّج شعاعي، بلا أي عمق أو "انفجار" للخارج
  const tops = slicesData.map((s, i) => {
    const [x1, y1] = toXY(s.startAngle, r), [x2, y2] = toXY(s.endAngle, r);
    const gradId = `pieg-${id}-${i}`;
    return `<g class="pie-slice-group" style="animation-delay:${i * 70}ms; transform-origin:${cx}px ${cy}px;">
      <defs><radialGradient id="${gradId}" cx="35%" cy="30%"><stop offset="0%" stop-color="${shadeColor(s.d.color, 22)}" /><stop offset="100%" stop-color="${s.d.color}" /></radialGradient></defs>
      <path class="pie-slice" d="M ${cx},${cy} L ${x1},${y1} A ${r},${r} 0 ${s.large} 1 ${x2},${y2} Z" fill="url(#${gradId})" stroke="rgba(0,0,0,0.3)" stroke-width="1.5" style="color:${s.d.color};"><title>${s.d.label}: ${fmt(s.d.value)}</title></path>
    </g>`;
  }).join('');
  const legend = data.map(d => `<div class="donut-legend-item"><span class="donut-legend-dot" style="background:${d.color}; color:${d.color};"></span>${d.label} · ${bidi(fmt(d.value))} (${Math.round(d.value / total * 100)}%)</div>`).join('');
  return `<div style="display:flex; gap:20px; flex-wrap:wrap; align-items:center;">
    <svg width="${size}" height="${size}" viewBox="0 0 ${size} ${size}" data-chart-anim="1">${tops}</svg>
    <div class="donut-legend">${legend}</div>
  </div>`;
}

function healthScoreRing(score) {
  score = Math.max(0, Math.min(100, Math.round(score)));
  const r = 46, c = 2 * Math.PI * r;
  const cappedScore = Math.min(score, 99.3); // يمنع تراكب طرفي الخط المستدير عند 100 بالضبط
  const color = score >= 60 ? '#22d3a8' : score >= 30 ? '#f5a623' : '#ef5a6f';
  const label = score >= 60 ? 'وضع صحي' : score >= 30 ? 'وضع مقبول' : 'يحتاج انتباه';
  return `<div style="display:flex; align-items:center; gap:16px;">
    <svg width="110" height="110" viewBox="0 0 110 110" class="health-score-ring hs-animate" data-chart-anim="1">
      <circle class="bg" cx="55" cy="55" r="${r}" fill="none" stroke-width="10"/>
      <circle class="fg" cx="55" cy="55" r="${r}" fill="none" stroke="${color}" stroke-width="10" stroke-linecap="round"
        stroke-dasharray="${c}" stroke-dashoffset="${c}" data-target-offset="${c - (cappedScore / 100) * c}"/>
    </svg>
    <div><div style="font-size:26px; font-weight:800; color:${color};">${score}</div><div class="muted" style="font-size:12px;">${label} · على أساس نسبة الادخار</div></div>
  </div>`;
}
// أُبقيت هذه الدالة لتوافق الاستدعاءات القديمة، وأصبحت الآن تُسلّم الحلقة لنظام "حركة الدخول عند الوصول فعليًا للشاشة" بدل تشغيلها فورًا
function animateHealthRings(root) {
  observeChartsForEntrance(root);
}
function computeHealthScore(income, expense) {
  if (income <= 0) return 0;
  const savingsRate = (income - expense) / income; // من -∞ إلى 1
  return Math.max(0, Math.min(100, Math.round(50 + savingsRate * 100)));
}

function heatmapGrid(year, currency) {
  const start = new Date(year, 0, 1), end = new Date(year, 11, 31);
  const dayNet = {};
  DATA.transactions.filter(t => !t.deleted && t.currency === currency && inYear(t.date, year)).forEach(t => {
    dayNet[t.date] = (dayNet[t.date] || 0) + (t.kind === 'income' ? t.amount : -t.amount);
  });
  DATA.zakatPayments.filter(z => !z.deleted && z.currency === currency && inYear(z.date, year)).forEach(z => {
    dayNet[z.date] = (dayNet[z.date] || 0) - z.amount;
  });
  const values = Object.values(dayNet).map(Math.abs);
  const maxAbs = Math.max(1, ...values);
  const cells = [];
  const leadingEmpty = start.getDay(); // 0=أحد
  for (let i = 0; i < leadingEmpty; i++) cells.push('<div class="heatmap-cell" style="background:transparent;"></div>');
  for (let d = new Date(start); d <= end; d.setDate(d.getDate() + 1)) {
    const ds = `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
    const net = dayNet[ds];
    let bg = 'rgba(255,255,255,0.05)';
    let glow = '';
    if (net !== undefined) {
      const intensity = 0.45 + 0.55 * (Math.abs(net) / maxAbs);
      const solidColor = net >= 0 ? `hsl(164, 75%, ${58 - intensity * 20}%)` : `hsl(353, 80%, ${62 - intensity * 18}%)`;
      bg = solidColor;
      glow = `box-shadow: 0 0 ${4 + intensity * 8}px ${net >= 0 ? 'rgba(34,211,168,' : 'rgba(239,90,111,'}${intensity * 0.7});`;
    }
    cells.push(`<div class="heatmap-cell" style="background:${bg}; ${glow}" title="${ds}: ${net !== undefined ? fmt(net) : 'لا نشاط'} ${currency}"></div>`);
  }
  return `<div class="heatmap-grid">${cells.join('')}</div>`;
}

/* ============================================================
   تصدير تقرير PDF (عبر نافذة الطباعة)
   ============================================================ */
function buildYearsCompareReportHtml() {
  const years = [...DATA.settings.years].sort((a, b) => a - b);
  const allTx = DATA.transactions.filter(t => !t.deleted);
  const activeCurs = currenciesWithActivity(allTx);
  const currencies = activeCurs.length ? activeCurs : DATA.settings.currencies;
  const body = currencies.map(cur => {
    const yearStats = years.map(y => {
      const income = realSum('income', t => t.currency === cur && inYear(t.date, y));
      const expense = realSum('expense', t => t.currency === cur && inYear(t.date, y));
      const debtFlow = debtFlowSum(t => t.currency === cur && inYear(t.date, y));
      const invest = DATA.investments.filter(t => !t.deleted && t.currency === cur && inYear(t.date, y)).reduce((s, t) => s + t.amount, 0);
      const outflows = DATA.zakatPayments.filter(z => !z.deleted && z.currency === cur && inYear(z.date, y)).reduce((s, z) => s + z.amount, 0);
      return { y, income, expense, debtFlow, invest, outflows, net: income - expense - outflows + debtFlow };
    });
    yearStats.forEach((s, i) => { s.growth = i > 0 && yearStats[i - 1].net !== 0 ? ((s.net - yearStats[i - 1].net) / Math.abs(yearStats[i - 1].net)) * 100 : null; });
    if (!yearStats.some(s => s.income || s.expense)) return '';
    const rows = yearStats.map(s => `<tr><td>${s.y}</td><td class="income">${fmt(s.income)}</td><td class="expense">${fmt(s.expense)}</td><td class="${s.net >= 0 ? 'pos' : 'neg'}">${fmt(s.net)}</td><td>${fmt(s.invest)}</td><td class="expense">${fmt(s.outflows)}</td><td class="${s.growth === null ? '' : s.growth >= 0 ? 'pos' : 'neg'}">${s.growth === null ? '—' : s.growth.toFixed(1) + '%'}</td></tr>`).join('');
    return `<h2>${cur}</h2><table><thead><tr><th>السنة</th><th>الدخل</th><th>المصاريف</th><th>الصافي</th><th>أرباح الاستثمار</th><th>الإخراجات</th><th>النمو</th></tr></thead><tbody>${rows}</tbody></table>`;
  }).join('');
  return { html: reportPageHtml('مقارنة السنوات — RD Flow', body), filename: 'مقارنة-السنوات.pdf' };
}
async function exportCompareReport(years, yearStats, cur) {
  const rows = yearStats.map(s => `<tr><td>${s.y}</td><td class="income">${fmt(s.income)}</td><td class="expense">${fmt(s.expense)}</td><td class="${s.net >= 0 ? 'pos' : 'neg'}">${fmt(s.net)}</td><td>${fmt(s.invest)}</td><td class="expense">${fmt(s.outflows)}</td><td class="${s.growth === null ? '' : s.growth >= 0 ? 'pos' : 'neg'}">${s.growth === null ? '—' : s.growth.toFixed(1) + '%'}</td></tr>`).join('');
  const body = `<table><thead><tr><th>السنة</th><th>الدخل</th><th>المصاريف</th><th>الصافي</th><th>أرباح الاستثمار</th><th>الإخراجات</th><th>النمو</th></tr></thead><tbody>${rows}</tbody></table>`;
  const html = reportPageHtml(`مقارنة السنوات (${cur}) — RD Flow`, body);
  toast('جارٍ إنشاء ملف PDF...');
  const res = await Platform.exportPDF(html, `مقارنة-السنوات-${cur}.pdf`);
  if (res.ok) toast('تم حفظ التقرير: ' + res.filePath);
  else if (res.error) toast('تعذّر حفظ التقرير');
}
function reportPageHtml(title, body) {
  return `<!DOCTYPE html><html lang="ar" dir="rtl"><head><meta charset="utf-8"><title>${title}</title>
    <style>
      body { font-family: Tahoma, Arial, sans-serif; direction:rtl; color:#111; padding:28px; }
      table { width:100%; border-collapse: collapse; margin-bottom:18px; }
      td, th { padding:6px 10px; border-bottom:1px solid #ddd; text-align:right; }
      th { color:#555; font-size:12.5px; }
      tr.tot td { font-weight:bold; border-top:2px solid #333; }
      h1 { font-size:20px; } h2 { font-size:16px; margin-top:22px; color:#222; } h3 { font-size:14.5px; margin-top:16px; color:#333; }
      .swatch { display:inline-block; width:10px; height:10px; border-radius:3px; margin-inline-end:7px; vertical-align:middle; }
      .income, .pos { color:#1a7f37; font-weight:700; }
      .expense, .neg { color:#c0392b; font-weight:700; }
      .badge { display:inline-block; padding:2px 8px; border-radius:999px; font-size:11px; font-weight:700; }
      .badge-green { background:#e5f6ea; color:#1a7f37; }
      .badge-red { background:#fbe9e7; color:#c0392b; }
    </style></head><body>
      <h1>${title}</h1>
      <p style="color:#666;">صدر بتاريخ ${new Date().toLocaleDateString('ar-DZ')}</p>
      ${body || '<p>لا توجد بيانات</p>'}
    </body></html>`;
}
// جدول تفصيلي حسب الفئة (بنفس ألوان كل فئة الحقيقية) لأي مجموعة حركات — يُستعمل داخل تقارير الدخل/المصاريف بدل الاكتفاء بمجموع واحد
function categoryBreakdownTable(list) {
  if (!list.length) return '';
  const byCategory = {};
  list.forEach(r => {
    const cat = DATA.categories.find(c => c.id === r.categoryId);
    const key = cat ? cat.id : 'other';
    if (!byCategory[key]) byCategory[key] = { label: cat ? cat.name : 'أخرى (بدون فئة)', value: 0, color: cat ? cat.color : '#6b7280' };
    byCategory[key].value += r.amount;
  });
  const rows = Object.values(byCategory).sort((a, b) => b.value - a.value);
  const total = rows.reduce((s, r) => s + r.value, 0);
  return `<table><tr><th>الفئة</th><th>المبلغ</th><th>النسبة</th></tr>
    ${rows.map(r => `<tr><td><span class="swatch" style="background:${r.color};"></span>${r.label}</td><td>${fmt(r.value)}</td><td>${total ? Math.round(r.value / total * 100) : 0}%</td></tr>`).join('')}
    <tr class="tot"><td>الإجمالي</td><td>${fmt(total)}</td><td>100%</td></tr></table>`;
}
function buildMonthReportHtml(y, m) {
  const currencies = DATA.settings.currencies;
  const title = `تقرير ${MONTH_NAMES[m - 1]} ${y} — RD Flow`;
  const body = currencies.map(cur => {
    const incomeList = txByKind('income').filter(t => inMonth(t.date, y, m) && t.currency === cur && t.mode !== 'debt');
    const expenseList = txByKind('expense').filter(t => inMonth(t.date, y, m) && t.currency === cur && t.mode !== 'debt');
    const income = incomeList.reduce((s, t) => s + t.amount, 0);
    const expense = expenseList.reduce((s, t) => s + t.amount, 0);
    const debtFlow = debtFlowSum(t => inMonth(t.date, y, m) && t.currency === cur);
    const zakatList = DATA.zakatPayments.filter(z => !z.deleted && inMonth(z.date, y, m) && z.currency === cur);
    const outflows = zakatList.reduce((s, z) => s + z.amount, 0);
    const investList = DATA.investments.filter(t => !t.deleted && t.currency === cur && inMonth(t.date, y, m));
    const invest = investList.reduce((s, t) => s + t.amount, 0);
    if (!income && !expense && !outflows && !invest && !debtFlow) return '';
    const net = income - expense - outflows + invest + debtFlow;
    return `<h2>${cur}</h2>
      <table>
        <tr><td>الدخل</td><td class="income">${fmt(income)}</td></tr>
        <tr><td>المصاريف</td><td class="expense">${fmt(expense)}</td></tr>
        <tr><td>حركة ديون (سلف/تسديد)</td><td class="${debtFlow >= 0 ? 'pos' : 'neg'}">${fmt(debtFlow)}</td></tr>
        <tr><td>الإخراجات (زكاة/صدقة)</td><td class="expense">${fmt(outflows)}</td></tr>
        <tr><td>الاستثمار</td><td>${fmt(invest)}</td></tr>
        <tr class="tot"><td>الصافي بعد كل شيء</td><td class="${net >= 0 ? 'pos' : 'neg'}">${fmt(net)}</td></tr>
      </table>
      ${incomeList.length ? `<h3>تفصيل الدخل حسب الفئة/المصدر</h3>${categoryBreakdownTable(incomeList)}` : ''}
      ${expenseList.length ? `<h3>تفصيل المصاريف حسب الفئة</h3>${categoryBreakdownTable(expenseList)}` : ''}
      ${investList.length ? `<h3>تفاصيل الاستثمار</h3><table><tr><th>التاريخ</th><th>ملاحظة</th><th>المبلغ</th></tr>${investList.map(t => `<tr><td>${t.date || ''}</td><td>${t.note || ''}</td><td>${fmt(t.amount)}</td></tr>`).join('')}</table>` : ''}
      ${zakatList.length ? `<h3>تفاصيل الإخراجات</h3><table><tr><th>التاريخ</th><th>الاسم</th><th>النسبة</th><th>المبلغ</th></tr>${zakatList.map(z => `<tr><td>${z.date || ''}</td><td>${z.name || 'زكاة'}</td><td>${z.percent ? z.percent + '%' : '—'}</td><td class="expense">${fmt(z.amount)}</td></tr>`).join('')}</table>` : ''}`;
  }).join('');
  return { html: reportPageHtml(title, body), filename: `تقرير-${MONTH_NAMES[m - 1]}-${y}.pdf` };
}
function buildYearReportHtml(y) {
  const currencies = DATA.settings.currencies;
  const title = `تقرير سنة ${y} — RD Flow`;
  const body = currencies.map(cur => {
    const incomeList = txByKind('income').filter(t => inYear(t.date, y) && t.currency === cur && t.mode !== 'debt');
    const expenseList = txByKind('expense').filter(t => inYear(t.date, y) && t.currency === cur && t.mode !== 'debt');
    const income = incomeList.reduce((s, t) => s + t.amount, 0);
    const expense = expenseList.reduce((s, t) => s + t.amount, 0);
    const debtFlow = debtFlowSum(t => inYear(t.date, y) && t.currency === cur);
    const zakatList = DATA.zakatPayments.filter(z => !z.deleted && inYear(z.date, y) && z.currency === cur);
    const outflows = zakatList.reduce((s, z) => s + z.amount, 0);
    if (!income && !expense && !outflows && !debtFlow) return '';
    const net = income - expense - outflows + debtFlow;
    return `<h2>${cur}</h2>
      <table>
        <tr><td>إجمالي الدخل</td><td class="income">${fmt(income)}</td></tr>
        <tr><td>إجمالي المصاريف</td><td class="expense">${fmt(expense)}</td></tr>
        <tr><td>حركة ديون (سلف/تسديد)</td><td class="${debtFlow >= 0 ? 'pos' : 'neg'}">${fmt(debtFlow)}</td></tr>
        <tr><td>الإخراجات (زكاة/صدقة)</td><td class="expense">${fmt(outflows)}</td></tr>
        <tr class="tot"><td>الصافي السنوي</td><td class="${net >= 0 ? 'pos' : 'neg'}">${fmt(net)}</td></tr>
      </table>
      ${incomeList.length ? `<h3>تفصيل الدخل حسب الفئة/المصدر</h3>${categoryBreakdownTable(incomeList)}` : ''}
      ${expenseList.length ? `<h3>تفصيل المصاريف حسب الفئة</h3>${categoryBreakdownTable(expenseList)}` : ''}
      ${zakatList.length ? `<h3>تفاصيل الإخراجات</h3><table><tr><th>التاريخ</th><th>الاسم</th><th>النسبة</th><th>المبلغ</th></tr>${zakatList.map(z => `<tr><td>${z.date || ''}</td><td>${z.name || 'زكاة'}</td><td>${z.percent ? z.percent + '%' : '—'}</td><td class="expense">${fmt(z.amount)}</td></tr>`).join('')}</table>` : ''}`;
  }).join('');
  return { html: reportPageHtml(title, body), filename: `تقرير-سنة-${y}.pdf` };
}
function buildCalendarReportHtml() {
  const items = DATA.calendarItems.filter(i => !i.deleted && i.kind === 'event').sort((a, b) => (a.date || '').localeCompare(b.date || ''));
  const rows = items.map(i => `<tr><td>${i.date || ''}</td><td>${i.title}</td><td>${i.note || ''}</td><td>${i.reminderAt ? new Date(i.reminderAt).toLocaleString('ar-DZ') : '—'}</td></tr>`).join('');
  const body = `<table><tr><th>التاريخ</th><th>العنوان</th><th>التفاصيل</th><th>التذكير</th></tr>${rows}</table>`;
  return { html: reportPageHtml('تقرير الرزنامة — RD Flow', items.length ? body : ''), filename: `تقرير-الرزنامة.pdf` };
}
function buildNotesReportHtml() {
  const items = DATA.calendarItems.filter(i => !i.deleted && i.kind === 'note').sort((a, b) => (b.date || '').localeCompare(a.date || ''));
  const rows = items.map(i => `<tr><td>${i.date || ''}</td><td>${i.title}</td><td>${i.note || ''}</td><td>${i.reminderAt ? new Date(i.reminderAt).toLocaleString('ar-DZ') : '—'}</td></tr>`).join('');
  const body = `<table><tr><th>التاريخ</th><th>العنوان</th><th>التفاصيل</th><th>التذكير</th></tr>${rows}</table>`;
  return { html: reportPageHtml('تقرير المذكرة — RD Flow', items.length ? body : ''), filename: `تقرير-المذكرة.pdf` };
}
function buildClientsReportHtml() {
  const clients = DATA.clients.filter(c => !c.deleted);
  const body = clients.map(c => {
    const projects = DATA.projects.filter(p => !p.deleted && p.clientId === c.id);
    const rows = projects.map(p => { const paid = computeProjectPaid(p); const remaining = p.agreedAmount - paid; return `<tr><td>${p.title || 'مشروع'}</td><td>${fmt(p.agreedAmount)}</td><td class="income">${fmt(paid)}</td><td class="${remaining > 0 ? 'expense' : ''}">${fmt(remaining)}</td></tr>`; }).join('');
    const totalAgreed = projects.reduce((s, p) => s + p.agreedAmount, 0), totalPaid = projects.reduce((s, p) => s + computeProjectPaid(p), 0);
    return `<h3>${c.name} (${c.currency})</h3><table><tr><th>المشروع</th><th>المتفَق عليه</th><th>المدفوع</th><th>المتبقي</th></tr>${rows}
      <tr class="tot"><td>الإجمالي</td><td>${fmt(totalAgreed)}</td><td class="income">${fmt(totalPaid)}</td><td class="${totalAgreed - totalPaid > 0 ? 'expense' : ''}">${fmt(totalAgreed - totalPaid)}</td></tr></table>`;
  }).join('');
  return { html: reportPageHtml('تقرير العملاء — RD Flow', body), filename: `تقرير-العملاء.pdf` };
}
function buildDebtsReportHtml() {
  const debts = DATA.debts.filter(d => !d.deleted);
  const rows = debts.map(d => { const paid = computeDebtPaid(d); const remaining = d.amount - paid;
    return `<tr><td>${d.name}</td><td><span class="badge ${d.type === 'they_owe_me' ? 'badge-green' : 'badge-red'}">${d.type === 'they_owe_me' ? label('debt_type_they_owe_me') : label('debt_type_i_owe')}</span></td>
    <td>${fmt(d.amount)} ${d.currency}</td><td class="income">${fmt(paid)} ${d.currency}</td><td class="${remaining > 0 ? 'expense' : ''}">${fmt(remaining)} ${d.currency}</td><td>${d.date || ''}</td></tr>`; }).join('');
  const body = `<table><tr><th>الاسم</th><th>النوع</th><th>المبلغ الكلي</th><th>المسدَّد</th><th>المتبقي</th><th>التاريخ</th></tr>${rows}</table>`;
  return { html: reportPageHtml('تقرير الديون — RD Flow', debts.length ? body : ''), filename: `تقرير-الديون.pdf` };
}
function buildPlansReportHtml() {
  const plans = DATA.plans.filter(p => !p.deleted);
  const body = plans.map(p => {
    const logs = (p.progressLog || []).map(l => `<tr><td>${new Date(l.date).toLocaleDateString('ar-DZ')}</td><td>${l.note}</td></tr>`).join('');
    return `<h3>${p.kind === 'goal' ? '🎯' : '🔁'} ${p.title} — ${RECURRENCE_LABELS[p.recurrence] || p.recurrence} <span class="badge ${p.status === 'archived' ? 'badge-red' : 'badge-green'}">${p.status === 'archived' ? 'مؤرشفة' : 'نشطة'}</span></h3>
      ${p.notes ? `<p>${p.notes}</p>` : ''}
      ${logs ? `<table><tr><th>التاريخ</th><th>التحديث</th></tr>${logs}</table>` : '<p style="color:#888;">لا توجد تحديثات مسجَّلة بعد</p>'}`;
  }).join('');
  return { html: reportPageHtml('تقرير التخطيط والأهداف — RD Flow', body), filename: `تقرير-التخطيط.pdf` };
}
function buildPricingReportHtml() {
  const items = DATA.priceItems.filter(x => !x.deleted);
  const priceRows = items.map(i => `<tr><td>${i.market}</td><td>${i.videoType}</td><td class="income">${fmt(i.basePrice)} ${i.currency}</td><td>${i.unit}</td><td>${i.minPrice ? fmt(i.minPrice) : '—'}</td></tr>`).join('');
  const quotes = DATA.quotes.filter(x => !x.deleted).sort((a, b) => b.createdAt - a.createdAt);
  const quoteRows = quotes.map(q => { const client = q.clientId ? DATA.clients.find(c => c.id === q.clientId) : null; return `<tr><td>${new Date(q.createdAt).toLocaleDateString('ar-DZ')}</td><td>${q.market}</td><td>${q.videoType}</td><td class="income">${fmt(q.total)} ${q.currency}</td><td>${client ? client.name : '—'}</td><td>${q.description || ''}</td></tr>`; }).join('');
  const body = `<h3>قائمة الأسعار</h3><table><tr><th>السوق</th><th>نوع الفيديو</th><th>السعر الأساسي</th><th>الوحدة</th><th>الحد الأدنى</th></tr>${priceRows}</table>
    <h3>عروض الأسعار المحفوظة</h3><table><tr><th>التاريخ</th><th>السوق</th><th>النوع</th><th>السعر</th><th>العميل</th><th>الوصف</th></tr>${quoteRows}</table>`;
  return { html: reportPageHtml('تقرير التسعير — RD Flow', body), filename: `تقرير-التسعير.pdf` };
}
function buildWealthReportHtml() {
  const currencies = DATA.settings.currencies;
  const nwSections = currencies.map(cur => {
    const nw = computeNetWorth(cur);
    if (!nw.manualAssets && !nw.theyOweMe && !nw.iOwe) return '';
    return `<h3>${cur}</h3><table><tr><td>إجمالي الأصول</td><td class="income">${fmt(nw.totalAssets)}</td></tr>
      <tr><td>إجمالي الالتزامات</td><td class="expense">${fmt(nw.totalLiabilities)}</td></tr>
      <tr class="tot"><td>صافي الثروة</td><td class="${nw.netWorth >= 0 ? 'pos' : 'neg'}">${fmt(nw.netWorth)}</td></tr></table>`;
  }).join('');
  const assets = DATA.assets.filter(a => !a.deleted);
  const assetRows = assets.map(a => `<tr><td>${assetTypeLabel(a.type)}</td><td>${a.name}</td><td class="income">${fmt(assetValue(a))} ${a.currency}</td><td>${a.lastUpdatedAt ? new Date(a.lastUpdatedAt).toLocaleDateString('ar-DZ') : '—'}</td></tr>`).join('');
  const recurring = DATA.recurringTx.filter(r => !r.deleted);
  const recRows = recurring.map(r => { const cat = DATA.categories.find(c => c.id === r.categoryId); return `<tr><td class="${r.kind === 'income' ? 'income' : 'expense'}">${r.kind === 'income' ? 'دخل' : 'مصروف'}</td><td>${cat ? `<span class="swatch" style="background:${cat.color};"></span>${cat.name}` : '—'}</td><td>${fmt(r.amount)} ${r.currency}</td><td>يوم ${r.dayOfMonth}</td><td><span class="badge ${r.active ? 'badge-green' : 'badge-red'}">${r.active ? 'مفعّل' : 'معطّل'}</span></td></tr>`; }).join('');
  const body = `<h2>صافي الثروة</h2>${nwSections || '<p>لا توجد بيانات كافية بعد</p>'}
    <h2>الأصول المُدخَلة يدويًا</h2><table><tr><th>النوع</th><th>الاسم</th><th>القيمة</th><th>آخر تحديث</th></tr>${assetRows}</table>
    <h2>الاقتطاعات المتكررة</h2><table><tr><th>النوع</th><th>الفئة</th><th>القيمة</th><th>يوم التكرار</th><th>الحالة</th></tr>${recRows}</table>`;
  return { html: reportPageHtml('تقرير أموالي — RD Flow', body), filename: `تقرير-اموالي.pdf` };
}
async function exportReport(scope, y, m) {
  const { html, filename } = scope === 'month' ? buildMonthReportHtml(y, m) : buildYearReportHtml(y);
  toast('جارٍ إنشاء ملف PDF...');
  const res = await Platform.exportPDF(html, filename);
  if (res.ok) toast('تم حفظ التقرير: ' + res.filePath);
  else if (res.error) toast('تعذّر حفظ التقرير');
}

function evaluateAlerts() {
  const alertNav = (a, extra) => Object.assign({ v: 'control', panels: ['ctrl_alerts'], focus: 'alert:' + a.id }, extra || {});
  DATA.alerts.filter(a => a.active && !a.deleted).forEach(a => {
    if (a.kind === 'investment_threshold') {
      const total = txByKind('income').filter(t => t.currency === a.params.currency).reduce((s, t) => s + t.amount, 0) - txByKind('expense').filter(t => t.currency === a.params.currency).reduce((s, t) => s + t.amount, 0);
      if (total >= a.params.amount && !a.lastTriggeredAt) { logNotify('التنبيهات الذكية', 'تنبيه مالي', `وصل رصيدك بـ${a.params.currency} إلى ${fmt(total)}`, null, alertNav(a)); a.lastTriggeredAt = Date.now(); }
    } else if (a.kind === 'expense_ratio') {
      const income = txByKind('income').filter(t => t.currency === a.params.currency).reduce((s, t) => s + t.amount, 0);
      const expense = txByKind('expense').filter(t => t.currency === a.params.currency).reduce((s, t) => s + t.amount, 0);
      const ym = todayISO().slice(0, 7); // مرة واحدة كل شهر بدل تكراره مع كل حركة جديدة (كان يغرق الإشعارات)
      if (income > 0 && a.lastTriggeredYM !== ym) { const ratio = (expense / income) * 100; if (ratio >= a.params.percent) { logNotify('التنبيهات الذكية', 'تنبيه مصاريف', `مصاريف ${a.params.currency} تجاوزت ${a.params.percent}% من الدخل`, null, alertNav(a)); a.lastTriggeredAt = Date.now(); a.lastTriggeredYM = ym; } }
    } else if (a.kind === 'category_threshold') {
      const total = txByKind('expense').filter(t => t.categoryId === a.params.categoryId && t.currency === a.params.currency).reduce((s, t) => s + t.amount, 0);
      if (total >= a.params.amount && !a.lastTriggeredAt) { const c = DATA.categories.find(c => c.id === a.params.categoryId); logNotify('التنبيهات الذكية', 'تنبيه مصاريف', `فئة "${c ? c.name : ''}" تجاوزت ${fmt(total)} ${a.params.currency}`, null, alertNav(a)); a.lastTriggeredAt = Date.now(); }
    } else if (a.kind === 'client_unpaid') {
      const unpaidOld = DATA.projects.some(p => !p.deleted && p.clientId === a.params.clientId && computeProjectPaid(p) < p.agreedAmount && (Date.now() - p.createdAt) / 86400000 >= a.params.days);
      if (unpaidOld && !a.lastTriggeredAt) { const c = DATA.clients.find(c => c.id === a.params.clientId); logNotify('العملاء', 'تنبيه عميل', `"${c ? c.name : ''}" لم يكتمل دفعه منذ ${a.params.days} يومًا`, null, { v: 'clients', mode: 'clients', focus: 'client:' + a.params.clientId }); a.lastTriggeredAt = Date.now(); }
    }
  });
}

boot();
