// ==========================================================================
// update-check.js — الجولة D: نظام التحديث داخل التطبيق
// ==========================================================================
// يقرأ version.json من موقع التحميل (الجولة E) ويقارنه بنسخة التطبيق الحالية.
// - لا يعمل إطلاقًا في وضع التجربة (demo) — راجع platform.js
// - لا يوقف التطبيق أبدًا لو بدون إنترنت: أي فشل بالفحص يُتجاهل بصمت وتُعاد
//   المحاولة لاحقًا تلقائيًا، بدون أي رسالة خطأ مزعجة للمستخدم
// - تحديث عادي (latest > نسختك): إشعار علوي قابل للإغلاق، يتذكّر أنك تجاهلت
//   هذه النسخة تحديدًا فلا يعاود إزعاجك بنفس الرقم
// - تحديث إجباري (نسختك < minRequired بملف version.json): بعد فتحتين للتطبيق
//   يظهر حاجز كامل الشاشة لا يمكن إغلاقه، مع توضيح أن البيانات آمنة على
//   الجهاز، وزر لتصدير نسخة احتياطية فورية قبل التحديث
// - "تحديث الآن" فعليًا بضغطة واحدة، بلا خطوات يدوية:
//     • ويندوز (Electron): يستخدم Platform.updater الحقيقي (electron-updater) —
//       يتحقق، ينزّل بالخلفية تلقائيًا، ويعرض شريط تقدّم حقيقي، وزر واحد أخير
//       "أعد التشغيل والتثبيت الآن" يغلق التطبيق ويثبّت ويعيد فتحه بنفسه
//     • أندرويد: لا يوجد "صامت تمامًا" ممكن خارج متجر تطبيقات (قيد أمان نظام
//       أندرويد نفسه، وليس قصورًا بالتطبيق) — لكن الزر يفتح رابط ملف الـAPK
//       مباشرة بمدير تنزيلات الجهاز، فيبدأ التنزيل تلقائيًا، وبانتهائه يظهر
//       إشعار "تثبيت" جاهز من نظام أندرويد نفسه، ضغطة واحدة عليه يكفي —
//       بدون فتح الموقع، بدون خطوات يدوية إضافية
//     • أي حالة أخرى (متصفح عادي بلا Platform.updater): رابط الموقع كخيار احتياطي فقط
// - حالة الفحص (آخر تحقق، النسخة الحالية والأحدث) تُعرض أيضًا داخل
//   الإعدادات ← 🔄 التحديثات (renderer.js يستدعي UpdateCheck.paintStatusPanel)
// ==========================================================================
(function () {
  const APP_VERSION = 27; // ⚠️ حدّثه مع كل رفع نسخة جديدة (يطابق version.json → latest)

  // نفس الرابط المستخدم في package.json (build.publish.url) وفي renderer.js
  // (SITE_URL) — استبدله بنفس القيمة في الأماكن الثلاثة عند تجهيز الاستضافة
  const SITE_URL = 'https://ri-site.github.io/RDFLOW/';
  const CHECK_URL = SITE_URL + 'version.json';

  const LS_KEY = 'rdflow_update_state_v1';
  const OPENS_BEFORE_FORCED_BLOCK = 3; // "بعد 3 دخول لازم يحدّث" — لا استثناء، أي نسخة أحدث تصير إجبارية بعد 3 فتحات

  function loadState() {
    try { return JSON.parse(localStorage.getItem(LS_KEY)) || {}; } catch (e) { return {}; }
  }
  function saveState(s) { try { localStorage.setItem(LS_KEY, JSON.stringify(s)); } catch (e) { /* تخزين محلي غير متاح - نتجاهل بصمت */ } }

  const state = loadState();
  state.opens = (state.opens || 0) + 1;
  saveState(state);

  let lastInfo = null;
  let lastCheckedAt = null;
  let lastError = null;
  let checking = false;

  // حالة التحديث الأصلي الحقيقي (Electron فقط حاليًا): idle | checking | downloading | downloaded | error
  let nativeStatus = 'idle';
  let nativePercent = 0;
  let nativeStuckTimer = null;
  const NATIVE_STUCK_TIMEOUT_MS = 20000; // لا نحبس المستخدم بشريط عالق للأبد — بعد 20 ثانية بلا أي تقدّم نحوّلها خطأ واضح فيه مخرج يدوي

  function armStuckTimer() {
    clearStuckTimer();
    nativeStuckTimer = setTimeout(() => {
      if (nativeStatus === 'checking' || nativeStatus === 'downloading') { nativeStatus = 'error'; paintAll(); }
    }, NATIVE_STUCK_TIMEOUT_MS);
  }
  function clearStuckTimer() { if (nativeStuckTimer) { clearTimeout(nativeStuckTimer); nativeStuckTimer = null; } }

  function isDemo() { return !!(window.Platform && Platform.platformName === 'demo'); }
  function hasNativeUpdater() { return !!(window.Platform && Platform.updater && Platform.platformName === 'electron'); }
  function isAndroid() { return !!(window.Platform && Platform.platformName === 'android' && Platform.updater); }

  if (hasNativeUpdater()) {
    Platform.updater.onEvent((payload) => {
      const s = (payload && payload.status) || 'idle';
      nativeStatus = s === 'checking' ? 'checking' : s === 'available' ? 'downloading' : s === 'downloading' ? 'downloading'
        : s === 'downloaded' ? 'downloaded' : s === 'error' ? 'error' : s === 'not-available' ? 'idle' : nativeStatus;
      if (payload && typeof payload.percent === 'number') nativePercent = payload.percent;
      if (s === 'error') console.error('[RD-UPDATER]', (payload && payload.message) || 'unknown error'); // تشخيص مؤقت — يظهر السبب الحقيقي بالكونسول
      if (nativeStatus === 'checking' || nativeStatus === 'downloading') armStuckTimer(); else clearStuckTimer();
      paintAll();
    });
  }

  function escapeHtml(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }

  async function check() {
    if (isDemo() || checking) return;
    checking = true;
    try {
      const res = await fetch(CHECK_URL + '?t=' + Date.now(), { cache: 'no-store' });
      if (!res.ok) throw new Error('HTTP ' + res.status);
      const info = await res.json();
      lastInfo = info;
      lastCheckedAt = Date.now();
      lastError = null;
      state.lastKnownLatest = info.latest;
      saveState(state);
      handleResult(info);
    } catch (e) {
      // بدون إنترنت أو الموقع غير متاح مؤقتًا — لا نزعج المستخدم، فقط نسجّل الخطأ لعرضه داخل الإعدادات إن أراد
      lastError = String((e && e.message) || e);
    } finally {
      checking = false;
      paintStatusPanel();
    }
  }

  function handleResult(info) {
    if (!info || typeof info.latest !== 'number') return;

    const isOutdated = info.latest > APP_VERSION;

    if (isOutdated && state.dismissedVersion !== info.latest) {
      showSoftBanner(info);
    }

    // ⚠️ لازم يكون دائمًا محدّثًا — ما فيه "لسا مقبول لأن نسختك أكبر من الحد الأدنى".
    // أي نسخة أحدث (latest > نسختك) تصير إجبارية بعد 3 فتحات، بغض النظر عن minRequired.
    const criticalNow = typeof info.minRequired === 'number' && APP_VERSION < info.minRequired;
    if (isOutdated && (criticalNow || state.opens >= OPENS_BEFORE_FORCED_BLOCK)) {
      showForcedBlock(info);
    }
  }

  // زر "تحديث الآن" الموحّد: فعليًا بضغطة واحدة حسب المنصّة، رابط الموقع خيار أخير فقط
  function triggerUpdate(info) {
    if (hasNativeUpdater()) {
      nativeStatus = 'checking'; paintAll(); armStuckTimer();
      Platform.updater.check().then((r) => { if (!r || !r.ok) { console.error('[RD-UPDATER] check() failed:', r && r.reason); nativeStatus = 'error'; clearStuckTimer(); paintAll(); } });
      return;
    }
    if (isAndroid() && info && info.downloads && info.downloads.android) {
      Platform.updater.downloadApk(info.downloads.android);
      return;
    }
    window.open(SITE_URL, '_blank', 'noopener');
  }

  function nativeStatusLine() {
    if (nativeStatus === 'checking') return 'جارٍ التحقق من وجود تحديث...';
    if (nativeStatus === 'downloading') return `جارٍ تنزيل التحديث تلقائيًا... ${nativePercent}%`;
    if (nativeStatus === 'downloaded') return '✅ التحديث جاهز — اضغط لإعادة التشغيل والتثبيت الآن';
    if (nativeStatus === 'error') return '⚠️ تعذّر تنزيل التحديث تلقائيًا — جرّب رابط الموقع بالأسفل';
    return '';
  }

  function nativeActionButtonHtml(idPrefix) {
    if (!hasNativeUpdater()) return '';
    if (nativeStatus === 'downloaded') return `<button class="btn" type="button" id="${idPrefix}InstallBtn">🔁 أعد التشغيل والتثبيت الآن</button>`;
    // حتى لو التحميل التلقائي عالق أو ما استجاب، يبقى رابط يدوي شغّال دائمًا — ما نحبس أحد بلا مخرج
    if (nativeStatus === 'downloading' || nativeStatus === 'checking') {
      return `<div class="update-progress"><div class="update-progress-bar${nativeStatus === 'checking' ? ' checking' : ''}" style="width:${nativeStatus === 'checking' ? 40 : nativePercent}%"></div></div>
        <a class="btn ghost sm" style="margin-top:6px;" href="${SITE_URL}" target="_blank" rel="noopener">أو نزّل يدويًا من الموقع</a>`;
    }
    return `<button class="btn" type="button" id="${idPrefix}UpdateBtn">⬇️ تحديث الآن (تلقائي)</button>`;
  }

  function bindNativeActionButton(root, idPrefix, info) {
    const scope = root || document;
    const installBtn = scope.querySelector('#' + idPrefix + 'InstallBtn');
    if (installBtn) installBtn.addEventListener('click', () => Platform.updater.install());
    const updateBtn = scope.querySelector('#' + idPrefix + 'UpdateBtn');
    if (updateBtn) updateBtn.addEventListener('click', () => triggerUpdate(info));
  }

  function showSoftBanner(info) {
    if (document.getElementById('updateSoftBanner')) return;
    const bar = document.createElement('div');
    bar.id = 'updateSoftBanner';
    bar.className = 'update-soft-banner';
    renderSoftBanner(bar, info);
    document.body.appendChild(bar);
  }
  function renderSoftBanner(bar, info) {
    const native = hasNativeUpdater() || isAndroid();
    bar.innerHTML = `
      <span>🔔 تحديث جديد متوفر — v${info.latest}${info.notes ? ' · ' + escapeHtml(info.notes) : ''} ${native && nativeStatusLine() ? '· ' + nativeStatusLine() : ''}</span>
      <span class="update-soft-actions">
        ${native ? nativeActionButtonHtml('softBanner') : `<a href="${SITE_URL}" target="_blank" rel="noopener">تحميل</a>`}
        <button type="button" id="updateSoftDismiss">✕</button>
      </span>`;
    bindNativeActionButton(bar, 'softBanner', info);
    const dismiss = bar.querySelector('#updateSoftDismiss');
    if (dismiss) dismiss.addEventListener('click', () => { state.dismissedVersion = info.latest; saveState(state); bar.remove(); });
  }

  function showForcedBlock(info) {
    if (document.getElementById('updateForcedBlock')) return;
    const wrap = document.createElement('div');
    wrap.id = 'updateForcedBlock';
    wrap.className = 'update-forced-block';
    renderForcedBlock(wrap, info);
    document.body.appendChild(wrap);
  }
  function renderForcedBlock(wrap, info) {
    const native = hasNativeUpdater() || isAndroid();
    wrap.innerHTML = `
      <div class="update-forced-card">
        <h2>⚠️ تحديث إجباري</h2>
        <p>نسختك الحالية (v${APP_VERSION}) لم تعد مدعومة، ولازم تحدّث لأحدث نسخة (v${info.latest}) عشان تكمل استخدام التطبيق.</p>
        <p class="muted">بياناتك آمنة ومحفوظة على جهازك بغض النظر عن هذا — يمكنك أخذ نسخة احتياطية الآن قبل التحديث إن أردت الاطمئنان.</p>
        ${native && nativeStatusLine() ? `<p class="muted">${nativeStatusLine()}</p>` : ''}
        <div class="update-forced-actions">
          ${native ? nativeActionButtonHtml('forced') : `<a class="btn" href="${SITE_URL}" target="_blank" rel="noopener">تحميل التحديث الآن</a>`}
          <button type="button" class="btn ghost" id="updateForcedBackupBtn">📦 تصدير نسخة احتياطية أولًا</button>
        </div>
        <p class="muted update-forced-note" id="updateForcedBackupNote"></p>
      </div>`;
    bindNativeActionButton(wrap, 'forced', info);
    const backupBtn = wrap.querySelector('#updateForcedBackupBtn');
    if (backupBtn) backupBtn.addEventListener('click', async () => {
      const note = wrap.querySelector('#updateForcedBackupNote');
      try {
        if (window.Platform && Platform.exportToFile) {
          await Platform.exportToFile(window.DATA || {});
          if (note) note.textContent = '✅ تم حفظ النسخة الاحتياطية.';
        }
      } catch (e) {
        if (note) note.textContent = 'تعذّر التصدير — حاول مرة أخرى.';
      }
    });
  }

  function paintAll() {
    paintStatusPanel();
    const bar = document.getElementById('updateSoftBanner'); if (bar && lastInfo) renderSoftBanner(bar, lastInfo);
    const wrap = document.getElementById('updateForcedBlock'); if (wrap && lastInfo) renderForcedBlock(wrap, lastInfo);
  }

  function paintStatusPanel() {
    const el = document.getElementById('updateStatusPanel');
    if (!el) return;

    if (isDemo()) {
      el.innerHTML = `<p class="muted" style="font-size:12px; margin:0;">فحص التحديثات غير متاح في وضع التجربة.</p>`;
      return;
    }

    const latest = lastInfo ? lastInfo.latest : (state.lastKnownLatest || null);
    const native = hasNativeUpdater() || isAndroid();
    let statusLine;
    if (native && nativeStatusLine()) statusLine = nativeStatusLine();
    else if (lastError && !lastInfo) statusLine = '⚠️ تعذّر التحقق (لا يوجد إنترنت حاليًا على الأرجح) — ستُعاد المحاولة تلقائيًا';
    else if (checking && latest == null) statusLine = 'جارٍ التحقق من وجود تحديث...';
    else if (latest == null) statusLine = 'لم يُجرَ فحص بعد.';
    else if (latest > APP_VERSION) statusLine = `🔔 تحديث جديد متوفر: v${latest}`;
    else statusLine = '✅ لديك أحدث نسخة';

    el.innerHTML = `
      <p class="muted" style="font-size:12px; margin:0 0 8px;">
        النسخة الحالية: v${APP_VERSION}${lastCheckedAt ? ' · آخر تحقق: ' + new Date(lastCheckedAt).toLocaleString('ar-DZ') : ''}
      </p>
      <p style="margin:0 0 10px;">${statusLine}</p>
      <div class="form-actions">
        <button class="btn ghost sm" type="button" id="updateCheckNowBtn">تحقق الآن</button>
        ${latest != null && latest > APP_VERSION ? (native ? nativeActionButtonHtml('panel') : `<a class="btn sm" href="${SITE_URL}" target="_blank" rel="noopener">تحميل التحديث</a>`) : ''}
      </div>`;
    const btn = document.getElementById('updateCheckNowBtn');
    if (btn) btn.addEventListener('click', check);
    if (latest != null && latest > APP_VERSION) bindNativeActionButton(el, 'panel', lastInfo);
  }

  window.UpdateCheck = { check, paintStatusPanel, getVersion: () => APP_VERSION, getSiteUrl: () => SITE_URL };

  // أول فحص بعد ثانيتين (نعطي الواجهة وقتًا تُقلع)، وبعدها كل 6 ساعات طول ما التطبيق مفتوح
  setTimeout(check, 2000);
  setInterval(check, 6 * 60 * 60 * 1000);
})();
