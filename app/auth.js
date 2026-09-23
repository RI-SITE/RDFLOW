// ==========================================================================
// auth.js — تسجيل الدخول/إنشاء حساب عبر Supabase Auth (بريد + كلمة سر + اسم مستخدم)
// ==========================================================================
// ملف مستقل تمامًا عن platform.js: كل شي هنا عبارة عن fetch() عادي لخدمة
// Supabase، فنفس الكود بالضبط يشتغل جوا Electron وجوا Capacitor بدون أي فرق.
//
// القرار المتفق عليه: بريد + كلمة سر + اسم مستخدم يختاره كل فرد، بدون رابط
// تأكيد بالبريد (Confirm email معطّل من لوحة Supabase)، وبقاء تسجيل الدخول
// دائم على الجهاز (نفس مبدأ Supabase الافتراضي: refresh token محفوظ محليًا).
//
// ⚠️ خطوة لازمة قبل التجربة: عوّض القيمتين تحت بقيم مشروعك الحقيقي.
// تلقاهم بلوحة Supabase: Settings → API
//   - Project URL          → SUPABASE_URL   (مثال: https://xxxxxxxxxxxx.supabase.co)
//   - anon public API key  → SUPABASE_ANON_KEY
//
// ⚠️ نطاق هذه الخطوة بالذات: الدخول/التسجيل فقط (بوابة قبل استخدام التطبيق).
// بيانات التطبيق (الحركات، العملاء...) لسا محفوظة محليًا بنفس طريقة
// Platform.load/save القديمة بدون أي تغيير — المزامنة بين الأجهزة عبر حساب
// المستخدم هذا هي المرحلة الجاية المتفق عليها بعدين، مو الآن.
// ==========================================================================

(function () {
  const SUPABASE_URL = 'https://dgjtxoefvwazqnhftqxj.supabase.co';
  const SUPABASE_ANON_KEY = 'sb_publishable_bWAB03ZIM1sK-Bzm1g1OZw_JdXese5w';

  const STORAGE_KEY = 'rdflow_auth_session';

  function authUrl(path) { return `${SUPABASE_URL}/auth/v1${path}`; }

  // ------------------------------------------------------------------------
  // تخزين الجلسة محليًا (localStorage يبقى بين مرات فتح التطبيق تلقائيًا،
  // بالضبط زي سلوك Supabase الافتراضي على الويب)
  // ------------------------------------------------------------------------
  function getSession() {
    try { return JSON.parse(localStorage.getItem(STORAGE_KEY)); }
    catch (e) { return null; }
  }

  function saveSession(raw) {
    if (!raw || !raw.access_token) return null;
    const stored = {
      access_token: raw.access_token,
      refresh_token: raw.refresh_token,
      expires_at: raw.expires_at ? raw.expires_at * 1000 : (Date.now() + (raw.expires_in || 3600) * 1000),
      // آخر مرة تأكدنا إن الجلسة شغّالة فعليًا (دخول جديد، أو تجديد توكن ناجح،
      // أو مجرد فتح التطبيق — راجع touchLastOpened تحت). عليها وحدها يعتمد
      // فحص "مرّ شهرين بلا استخدام" — بدون أي علاقة بالإنترنت أو بصلاحية
      // التوكن اللحظية
      lastOpenedAt: Date.now(),
      user: {
        id: raw.user.id,
        email: raw.user.email,
        username: (raw.user.user_metadata && raw.user.user_metadata.username) || '',
        avatar_url: (raw.user.user_metadata && raw.user.user_metadata.avatar_url) || ''
      }
    };
    localStorage.setItem(STORAGE_KEY, JSON.stringify(stored));
    persistToDurable();
    return stored;
  }

  function clearSession() { localStorage.removeItem(STORAGE_KEY); persistToDurable(); }

  // ------------------------------------------------------------------------
  // نسخة احتياطية دائمة من الجلسة عبر Platform (نفس القناة اللي تحفظ بيها
  // بيانات التطبيق نفسها — مضمونة ومجرّبة على ويندوز وأندرويد). السبب: كان
  // فيه بلاغ إن ويندوز صار يطلب تسجيل دخول كل مرة، وهذا يصير لو localStorage
  // انمسحت لأي سبب (كاش، إعادة تثبيت، إلخ) — بينما ملف بيانات التطبيق نفسه
  // (data.json) يبقى سليم دايمًا. فنخزّن نسخة من الجلسة جوا نفس الملف هذا
  // كـ"شبكة أمان"، ونرجّعها لـlocalStorage تلقائيًا أول ما التطبيق يفتح لو
  // لقيناها فاضية. هذا كله بصمت بالخلفية، ما يوقف ولا يبطّئ أي شي بالواجهة.
  let _persistTimer = null;
  function persistToDurable() {
    if (!window.Platform || !window.Platform.load || !window.Platform.save) return;
    clearTimeout(_persistTimer);
    // نأخر شوية ونجمع أكثر من تغيير متقارب بطلب حفظ واحد بدل عدة طلبات متتالية.
    // ⚠️ ملاحظة: ما نلمس raw._authSession/_rememberedAccounts يدويًا هنا — صار
    // Platform.save نفسه (بملف platform.js) يلصقها تلقائيًا من الجلسة الحيّة
    // الحقيقية بكل حفظ، من أي مصدر. هذا يمنع سباق الكتابة اللي كان يرجّع جلسة
    // قديمة فوق جديدة (سبب مشكلة "JWT expired" السابقة). كل اللي نسويه هنا هو
    // مجرد "لمسة حفظ" فورية عشان النسخة الدائمة تتحدّث بسرعة بعد دخول/خروج،
    // بدل ما تنتظر أول حفظ عادي من renderer.js
    _persistTimer = setTimeout(async () => {
      try {
        const raw = await window.Platform.load();
        await window.Platform.save(raw);
      } catch (e) { /* فشل الحفظ الاحتياطي بصمت — localStorage يبقى يخدم عادي */ }
    }, 400);
  }

  // تُنادى مرة وحدة عند بداية فتح التطبيق (قبل أي فحص جلسة) — ترجّع النسخة
  // الدائمة لـlocalStorage لو انمسحت، بدون ما تلمس نسخة localStorage لو
  // موجودة أصلًا وسليمة
  async function restoreFromDurableIfNeeded() {
    if (!window.Platform || !window.Platform.load) return;
    try {
      const raw = await window.Platform.load();
      if (!raw) return;
      if (!getSession() && raw._authSession) {
        localStorage.setItem(STORAGE_KEY, JSON.stringify(raw._authSession));
      }
      if (!getRememberedAccounts().length && raw._rememberedAccounts && raw._rememberedAccounts.length) {
        localStorage.setItem(ACCOUNTS_KEY, JSON.stringify(raw._rememberedAccounts));
      }
    } catch (e) { /* تجاهل — نكمل بمحتوى localStorage الحالي كيفما كان */ }
  }

  // تُنادى مرة كل ما ينفتح التطبيق بنجاح (بغض النظر كليًا عن الإنترنت) —
  // تجدّد "عداد الشهرين" اللي يقرر هل نطلب تسجيل دخول تاني أو لا
  function touchLastOpened() {
    const s = getSession();
    if (!s) return;
    s.lastOpenedAt = Date.now();
    localStorage.setItem(STORAGE_KEY, JSON.stringify(s));
    persistToDurable();
  }

  // مهلة "الـ6 أشهر" قبل ما نطلب تسجيل دخول تاني لو التطبيق فعلاً ما انفتح
  // خلالها إطلاقًا (لا علاقة لها بانقطاع النت أو بانتهاء صلاحية التوكن اللحظية)
  const SESSION_GRACE_MS = 183 * 24 * 60 * 60 * 1000; // ~6 أشهر (183 يوم)
  function isSessionStale(s) {
    const last = (s && s.lastOpenedAt) || 0;
    return !last || (Date.now() - last > SESSION_GRACE_MS);
  }

  // ------------------------------------------------------------------------
  // "تذكّر بيانات الدخول" — قائمة صغيرة بآخر الحسابات اللي سجّل بيها هالجهاز
  // بالذات (محليًا فقط، ما ترتفع لأي مكان). لما تضغط بخانة البريد، تطلع لك
  // كخيارات جاهزة (نفس فكرة "تذكر كلمة السر" بالمتصفح)، وتختار وحدة فتتعبى
  // خانتي البريد وكلمة السر تلقائيًا.
  // ⚠️ Electron ما فيه مدير كلمات سر مدمج زي كروم (هذا سبب عدم ظهورها من قبل
  // رغم إن الحقول أصلًا معلَّمة بـautocomplete الصحيح) — لهذا بنينا واحد خفيف
  // بالتطبيق نفسه بدلها.
  const ACCOUNTS_KEY = 'rdflow_remembered_accounts';
  function getRememberedAccounts() {
    try { return JSON.parse(localStorage.getItem(ACCOUNTS_KEY)) || []; }
    catch (e) { return []; }
  }
  function rememberAccount(email, password) {
    let list = getRememberedAccounts().filter(a => a.email !== email);
    list.unshift({ email, password });
    if (list.length > 5) list = list.slice(0, 5);
    localStorage.setItem(ACCOUNTS_KEY, JSON.stringify(list));
    persistToDurable();
  }

  function forgetAccount(email) {
    const list = getRememberedAccounts().filter(a => a.email !== email);
    localStorage.setItem(ACCOUNTS_KEY, JSON.stringify(list));
    persistToDurable();
    return list;
  }

  // ------------------------------------------------------------------------
  // نداءات Supabase Auth REST مباشرة (بدون مكتبة supabase-js — أبسط، وما
  // يحتاج bundler، ويتماشى مع سياسة CSP الحالية بدون فتحها لسكربتات خارجية)
  // ------------------------------------------------------------------------
  async function apiCall(path, body, extraHeaders) {
    let res;
    try {
      res = await fetch(authUrl(path), {
        method: 'POST',
        headers: Object.assign({ 'Content-Type': 'application/json', apikey: SUPABASE_ANON_KEY }, extraHeaders || {}),
        body: JSON.stringify(body)
      });
    } catch (e) {
      // فشل الاتصال نفسه (بدون نت، DNS، إلخ) — مختلف تمامًا عن "السيرفر رفض
      // الطلب". نعلّمه بعلامة خاصة عشان اللي يستقبل الخطأ (ensureValidSession)
      // يقدر يفرّق: انقطاع نت مؤقت لا يستدعي حذف الجلسة، عكس رفض حقيقي من السيرفر
      const err = new Error('تعذّر الاتصال بالسيرفر — تأكد من اتصال الإنترنت وحاول مرة أخرى.');
      err.isNetworkError = true;
      throw err;
    }
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(translateError(data.msg || data.error_description || data.error || 'حدث خطأ غير متوقع'));
    return data;
  }

  function translateError(msg) {
    const m = String(msg).toLowerCase();
    if (m.includes('already registered') || m.includes('already exists') || m.includes('already been'))
      return 'هذا البريد مسجّل من قبل — جرّب "تسجيل الدخول" بدل إنشاء حساب جديد.';
    if (m.includes('invalid login credentials'))
      return 'البريد أو كلمة السر غير صحيحة.';
    if (m.includes('password') && (m.includes('6') || m.includes('short') || m.includes('weak')))
      return 'كلمة السر لازم تكون 6 خانات على الأقل.';
    if (m.includes('email') && m.includes('invalid'))
      return 'صيغة البريد الإلكتروني غير صحيحة.';
    if (m.includes('ضع-رابط') || m.includes('ضع-مفتاح') || m.includes('fetch'))
      return 'إعداد الاتصال بـ Supabase ناقص — تأكد إنك عوّضت SUPABASE_URL و SUPABASE_ANON_KEY داخل auth.js.';
    return msg;
  }

  async function signUp(email, password, username) {
    const data = await apiCall('/signup', { email, password, data: { username: username || '' } });
    if (!data.access_token) {
      // يصير هذا فقط لو "Confirm email" لسا مفعّل بالخطأ بلوحة Supabase
      throw new Error('تم إنشاء الحساب لكن الدخول ما صار تلقائي — يبدو "Confirm email" لسا مفعّل. عطّله من Authentication → Providers → Email بلوحة Supabase.');
    }
    return saveSession(data);
  }

  async function signIn(email, password) {
    const data = await apiCall('/token?grant_type=password', { email, password });
    return saveSession(data);
  }

  async function refreshSession(refresh_token) {
    const data = await apiCall('/token?grant_type=refresh_token', { refresh_token });
    return saveSession(data);
  }

  async function signOut() {
    const s = getSession();
    if (s && s.access_token) {
      try { await apiCall('/logout', {}, { Authorization: `Bearer ${s.access_token}` }); }
      catch (e) { /* حتى لو فشل الطلب، نمسح الجلسة محليًا ونطلع المستخدم برا */ }
    }
    clearSession();
  }

  // تعديل الاسم/الصورة الظاهرين بالتطبيق (user_metadata بحساب Supabase نفسه)
  async function updateProfile(patch) {
    const s = getSession();
    if (!s) throw new Error('لازم تسجّل دخول أول.');
    let res;
    try {
      res = await fetch(`${SUPABASE_URL}/auth/v1/user`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json', apikey: SUPABASE_ANON_KEY, Authorization: `Bearer ${s.access_token}` },
        body: JSON.stringify({ data: patch })
      });
    } catch (e) {
      throw new Error('تعذّر الاتصال بالسيرفر — تأكد من الإنترنت.');
    }
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(translateError(data.msg || data.error_description || data.error || 'تعذّر تحديث الحساب'));
    s.user.username = (data.user_metadata && data.user_metadata.username) || s.user.username;
    s.user.avatar_url = (data.user_metadata && data.user_metadata.avatar_url) || s.user.avatar_url;
    localStorage.setItem(STORAGE_KEY, JSON.stringify(s));
    return s;
  }

  // رفع صورة شخصية لـ Supabase Storage (bucket اسمه "avatars" — راجع تعليمات
  // إعداده بالرسالة) ثم حفظ رابطها بالحساب عبر updateProfile
  async function uploadAvatar(file) {
    const s = getSession();
    if (!s) throw new Error('لازم تسجّل دخول أول.');
    const ext = (file.name.split('.').pop() || 'jpg').toLowerCase().replace(/[^a-z0-9]/g, '') || 'jpg';
    const path = `${s.user.id}/avatar.${ext}`;
    let res;
    try {
      res = await fetch(`${SUPABASE_URL}/storage/v1/object/avatars/${path}`, {
        method: 'POST',
        headers: {
          apikey: SUPABASE_ANON_KEY,
          Authorization: `Bearer ${s.access_token}`,
          'Content-Type': file.type || 'application/octet-stream',
          'x-upsert': 'true'
        },
        body: file
      });
    } catch (e) {
      throw new Error('تعذّر الاتصال بالسيرفر — تأكد من الإنترنت.');
    }
    if (!res.ok) {
      const d = await res.json().catch(() => ({}));
      throw new Error(translateError(d.message || d.error || 'تعذّر رفع الصورة — تأكد إنك جهّزت bucket اسمه "avatars" بلوحة Supabase.'));
    }
    const publicUrl = `${SUPABASE_URL}/storage/v1/object/public/avatars/${path}?t=${Date.now()}`;
    return updateProfile({ avatar_url: publicUrl });
  }

  // تجيب أحدث بيانات الحساب (الاسم/الصورة) من Supabase مباشرة، بدون انتظار
  // تجديد الجلسة الطبيعي (اللي يصير مرة كل ساعة تقريبًا) — هذا اللي يخلي
  // تغيير الصورة/الاسم من جهاز يوصل للجهاز الثاني بسرعة (خلال دورة المزامنة
  // العادية كل 30 ثانية)، بدل ما ينتظر لين تتجدد الجلسة تلقائيًا
  async function fetchLatestUser() {
    const s = getSession();
    if (!s) return null;
    let res;
    try {
      res = await fetch(`${SUPABASE_URL}/auth/v1/user`, {
        headers: { apikey: SUPABASE_ANON_KEY, Authorization: `Bearer ${s.access_token}` }
      });
    } catch (e) { return null; }
    if (!res.ok) return null;
    const data = await res.json().catch(() => ({}));
    if (!data || !data.id) return null;
    s.user.username = (data.user_metadata && data.user_metadata.username) || s.user.username;
    s.user.avatar_url = (data.user_metadata && data.user_metadata.avatar_url) || s.user.avatar_url;
    localStorage.setItem(STORAGE_KEY, JSON.stringify(s));
    return s;
  }

  // تجديد الجلسة "مقفول" — لو فيه تجديد شغّال أصلًا (مثلًا نداء متزامن من
  // مزامنة دورية بنفس اللحظة)، أي نداء ثاني ينتظر نفس النتيجة بدل ما يرسل
  // طلب تجديد ثاني بنفس الـrefresh_token القديم. هذا مهم جدًا: Supabase يبطّل
  // التوكن القديم فور نجاح أول تجديد له (rotation) — فأي طلب تجديد ثاني
  // متزامن بنفس التوكن القديم يرجع "مرفوض" من السيرفر حتى لو الأول نجح فعلاً.
  // قبل هذا الإصلاح، رفض كهذا كان يمسح الجلسة كليًا (clearSession) رغم إن
  // عند المستخدم جلسة صالحة فعليًا — وهذا بالضبط سبب "يطلب تسجيل دخول بلا سبب"
  let refreshInFlight = null;
  function withTimeout(promise, ms) {
    return Promise.race([
      promise,
      new Promise((resolve) => setTimeout(() => resolve(null), ms))
    ]);
  }

  // تتأكد إن في جلسة صالحة للاستخدام محليًا **فورًا وبدون أي انتظار شبكة**.
  // الشرط الوحيد اللي يمنع دخول المستخدم: مافيش جلسة محفوظة إطلاقًا (أول
  // استخدام، أو تسجيل خروج يدوي)، أو مرّ شهرين كاملين بدون ما يفتح المستخدم
  // التطبيق (isSessionStale) — لا علاقة لهذا الشرط بالإنترنت مطلقًا.
  // أي مشكلة نت، أو حتى رفض حقيقي من السيرفر لطلب تجديد التوكن، لا تمسح
  // الجلسة أبدًا بعد اليوم — نكمل بالجلسة المحفوظة القديمة ونحاول التجديد
  // بالخلفية بصمت (بحد أقصى 3 ثواني انتظار، وإلا نكمل بالقديمة ونتركه يكمل
  // لحاله وقتما ينجح)
  async function ensureValidSession() {
    const s = getSession();
    if (!s) return null;
    // ⚠️ جلسة قديمة من قبل إضافة تتبّع "آخر فتح" (s.lastOpenedAt غير موجود
    // إطلاقًا) — هذي جلسة صالحة فعليًا وشغّالة من قبل، بس ما فيها الحقل
    // الجديد بعد. نعتبرها "مفتوحة الآن" ونبدأ نتبعها من هاللحظة، بدل ما نطلب
    // تسجيل دخول تاني لمجرد إننا حدّثنا الكود — وهذا بالضبط كان سبب "أصبح
    // يطلب تسجيل دخول كل مرة" بعد أول تحديث لهذا الملف
    if (s.lastOpenedAt == null) {
      s.lastOpenedAt = Date.now();
      localStorage.setItem(STORAGE_KEY, JSON.stringify(s));
    } else if (isSessionStale(s)) {
      return null;
    }
    if (Date.now() < s.expires_at - 60000) return s; // لسا سارٍ، ما نحتاج أي طلب شبكة إطلاقًا

    if (!refreshInFlight) {
      refreshInFlight = refreshSession(s.refresh_token)
        .catch(() => null) // فشل التجديد (نت مقطوع، أو رفض من السيرفر) — ما نمسح الجلسة إطلاقًا
        .finally(() => { refreshInFlight = null; });
    }
    const refreshed = await withTimeout(refreshInFlight, 3000);
    return refreshed || s; // فشل أو تأخر التجديد: نكمل بالجلسة المحفوظة القديمة، ما نطرد المستخدم أبدًا
  }

  // ------------------------------------------------------------------------
  // واجهة شاشة الدخول/التسجيل
  // ------------------------------------------------------------------------
  function screenHtml(mode) {
    const isLogin = mode === 'login';
    return `
      <div class="auth-card card">
        <div class="auth-brand">
          <img src="assets/rdflow-logo-mark.png" alt="RD Flow" draggable="false">
          <h1>RD <span>Flow</span></h1>
        </div>
        <div class="segmented auth-tabs">
          <button type="button" data-mode="login" class="${isLogin ? 'active' : ''}">تسجيل الدخول</button>
          <button type="button" data-mode="register" class="${!isLogin ? 'active' : ''}">حساب جديد</button>
        </div>
        <form id="authForm" class="auth-form" novalidate>
          ${!isLogin ? `<label class="field">اسمك اللي يظهر بالتطبيق<input type="text" id="auth_username" placeholder="مثلًا: ياسين" maxlength="24" required></label>` : ''}
          <label class="field auth-email-field">البريد الإلكتروني
            <input type="email" id="auth_email" placeholder="name@example.com" required autocomplete="off">
            ${isLogin ? `<div id="authRememberedDrop" class="auth-remembered-drop hidden"></div>` : ''}
          </label>
          <label class="field">كلمة السر<input type="password" id="auth_password" placeholder="6 خانات على الأقل" minlength="6" required autocomplete="${isLogin ? 'current-password' : 'new-password'}"></label>
          <div id="authError" class="auth-error hidden"></div>
          <button type="submit" class="btn" id="authSubmitBtn">${isLogin ? 'دخول' : 'إنشاء الحساب'}</button>
        </form>
      </div>`;
  }

  // قائمة الحسابات المحفوظة بهالجهاز — بديل مدير كلمات السر (Electron ما فيه
  // وحد مدمج). تظهر فور الضغط على خانة البريد، وكل حساب فيها يعرض البريد
  // وكلمة السر مباشرة (مطفّاة نقطًا مع زر عين لإظهارها)، وبضغطة وحدة تتعبى
  // الخانتين وتصير جاهزة للدخول فورًا.
  function renderRememberedDropdown(host) {
    const drop = host.querySelector('#authRememberedDrop');
    const emailEl = host.querySelector('#auth_email');
    const passEl = host.querySelector('#auth_password');
    if (!drop || !emailEl || !passEl) return;
    const accounts = getRememberedAccounts();

    function close() { drop.classList.add('hidden'); drop.innerHTML = ''; }
    function open() {
      const list = getRememberedAccounts();
      if (!list.length) { close(); return; }
      drop.innerHTML = list.map((a, i) => `
        <div class="auth-remembered-row" data-i="${i}">
          <div class="arr-info">
            <div class="arr-email">${a.email}</div>
            <div class="arr-pass"><span class="arr-pass-dots">••••••••</span><span class="arr-pass-plain hidden">${a.password}</span></div>
          </div>
          <button type="button" class="arr-eye" data-i="${i}" title="إظهار كلمة السر">👁</button>
          <button type="button" class="arr-remove" data-i="${i}" title="حذف">✕</button>
        </div>`).join('');
      drop.classList.remove('hidden');

      drop.querySelectorAll('.arr-eye').forEach(btn => {
        btn.addEventListener('click', (e) => {
          e.stopPropagation();
          const row = btn.closest('.auth-remembered-row');
          row.querySelector('.arr-pass-dots').classList.toggle('hidden');
          row.querySelector('.arr-pass-plain').classList.toggle('hidden');
        });
      });
      drop.querySelectorAll('.arr-remove').forEach(btn => {
        btn.addEventListener('click', (e) => {
          e.stopPropagation();
          const a = list[Number(btn.dataset.i)];
          forgetAccount(a.email);
          open();
        });
      });
      drop.querySelectorAll('.auth-remembered-row').forEach(row => {
        row.addEventListener('click', () => {
          const a = list[Number(row.dataset.i)];
          emailEl.value = a.email;
          passEl.value = a.password;
          close();
        });
      });
    }

    if (accounts.length) {
      emailEl.addEventListener('focus', open);
      emailEl.addEventListener('click', open);
      document.addEventListener('click', (e) => {
        if (!drop.contains(e.target) && e.target !== emailEl) close();
      });
    }
  }

  // onSuccess(session) تنادى بعد نجاح الدخول/التسجيل
  function mount(onSuccess) {
    let mode = 'login';
    const host = document.getElementById('authScreen');
    if (!host) { console.error('لا يوجد #authScreen في index.html'); return; }
    host.classList.remove('hidden');

    function render() {
      host.innerHTML = screenHtml(mode);
      host.querySelectorAll('[data-mode]').forEach((b) => {
        b.addEventListener('click', () => { mode = b.dataset.mode; render(); });
      });

      const form = host.querySelector('#authForm');
      const errBox = host.querySelector('#authError');
      const btn = host.querySelector('#authSubmitBtn');
      // القائمة الجديدة (الحسابات المحفوظة بهالجهاز) تتكفل بالتعبئة التلقائية
      // عند الضغط على خانة البريد — بديل مدير كلمات السر المدمج (غير متوفر
      // داخل Electron)، تعرض البريد وكلمة السر مباشرة وبضغطة وحدة تتعبى الخانتين
      if (mode === 'login') renderRememberedDropdown(host);

      form.addEventListener('submit', async (e) => {
        e.preventDefault();
        errBox.classList.add('hidden');

        const email = host.querySelector('#auth_email').value.trim();
        const password = host.querySelector('#auth_password').value;
        const usernameEl = host.querySelector('#auth_username');
        const username = usernameEl ? usernameEl.value.trim() : '';

        if (mode === 'register' && !username) {
          errBox.textContent = 'اكتب اسمك اللي يظهر بالتطبيق.';
          errBox.classList.remove('hidden');
          return;
        }
        if (password.length < 6) {
          errBox.textContent = 'كلمة السر لازم تكون 6 خانات على الأقل.';
          errBox.classList.remove('hidden');
          return;
        }

        btn.disabled = true;
        btn.classList.add('loading');
        try {
          const session = mode === 'register'
            ? await signUp(email, password, username)
            : await signIn(email, password);
          rememberAccount(email, password); // ينحفظ بس بعد نجاح فعلي، محليًا بهالجهاز بس
          const card = host.querySelector('.auth-card');
          if (card) card.classList.add('auth-success');
          setTimeout(() => { host.classList.add('hidden'); host.innerHTML = ''; onSuccess(session); }, 320);
        } catch (err) {
          errBox.textContent = (err && err.message) || 'حدث خطأ، حاول مرة أخرى.';
          errBox.classList.remove('hidden');
          btn.disabled = false;
          btn.classList.remove('loading');
        }
      });
    }

    render();
  }

  window.Auth = { getSession, ensureValidSession, signOut, mount, updateProfile, uploadAvatar, fetchLatestUser, touchLastOpened, restoreFromDurableIfNeeded, getRememberedAccounts };
})();
