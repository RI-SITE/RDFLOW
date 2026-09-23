// ==========================================================================
// sync.js — مزامنة بيانات RD Flow بين الأجهزة عبر Supabase (جدول app_data)
// ==========================================================================
// ملف مستقل عن platform.js تمامًا (بنفس فلسفة auth.js): مجرد fetch() عادي
// لجدول Postgres واحد عبر Supabase REST (PostgREST) — بدون مكتبة supabase-js،
// بدون bundler، ونفس الكود بالضبط يشتغل جوا Electron وجوا Capacitor.
//
// ⚠️ قبل التجربة: تأكد إنك نفّذت SYNC_DATABASE_SETUP.sql من لوحة Supabase مرة
// وحدة (SQL Editor ← New query ← الصق ← Run). بدونه كل طلب هنا بيفشل بخطأ
// "relation app_data does not exist" أو ما شابه.
//
// (تنويه: القيم تحت هي نفس مشروعك بالضبط الموجودة أصلاً في auth.js — كودك
// الحالي فيها Supabase URL و anon key حقيقيين، فما يحتاج تغيير شي هنا لو
// عندك auth.js شغّال فعلاً؛ فقط تأكد الاثنين يشيرون لنفس المشروع.)
// ==========================================================================

(function () {
  const SUPABASE_URL = 'https://dgjtxoefvwazqnhftqxj.supabase.co';
  const SUPABASE_ANON_KEY = 'sb_publishable_bWAB03ZIM1sK-Bzm1g1OZw_JdXese5w';
  const TABLE = 'app_data';

  // نفس الحقول اللي هي مصفوفات سجلات لها id فريد عالميًا (device+timestamp+random) —
  // هذي وحدها اللي نعمل لها "دمج بالإضافة" الحقيقي؛ الباقي (settings/labels) إعدادات
  // عامة، ندمجها بطريقة أبسط (نسخة الجهاز اللي حفظ أخيرًا تكسب عند التعارض).
  // ⚠️ وسّعت هالقائمة لتغطي كل قسم بالتطبيق فيه سجلات (خطط، أسعار، عروض، أصول،
  // مواعيد، معاملات متكررة...) — قبل كذا أقسام كثيرة كانت أصلًا برّا نطاق
  // المزامنة كليًا (تفضل بس بالجهاز اللي انسوت فيه)، وهذا بالضبط اللي طلبته.
  // (assetSnapshots كانت خارج المزامنة لأنها بلا id — صار لكل لقطة id ثابت snap_YYYY-MM-DD فدخلت المزامنة)
  const MERGE_ARRAYS = [
    'categories', 'clients', 'projects', 'transactions', 'alerts', 'calendarItems', 'zakatPayments', 'debts',
    'investments', 'plans', 'priceItems', 'priceAddons', 'quotes', 'pricingPresets',
    'assets', 'assetTransfers', 'assetOps', 'recurringTx', 'serviceTypes', 'appointments', 'assetTypes', 'notifications',
    'dailySchedule',
    'assetSnapshots', 'syncFlags' // لقطات صافي الثروة اليومية + حالات الجرس (مقروء) وعلامات مقارنة الشهر — صارت تتزامن
  ];
  // حقول "مجدولة بحاوية" — مو مصفوفة واحدة، هي كائن مفاتيحه أرقام (يوم 0-6،
  // فصل 1-4، شهر 1-12) وكل مفتاح قيمته مصفوفة سجلات لها id. هذي كانت كليًا
  // برّا نطاق المزامنة (لا array-merge ولا حتى جزء من settings) — "جدولي"
  // بكل تبويباته (أسبوعي/فصلي/سنوي) ما كان يتزامن إطلاقًا، لا إضافة ولا حذف
  const MERGE_BUCKETED = ['weeklySchedule', 'quarterlySchedule', 'yearlySchedule'];
  // لقطات صافي الثروة القديمة كانت بلا id — نمنحها id ثابتًا من تاريخها قبل أي دمج (وإلا يتجاهلها الدمج فتضيع)
  function ensureSyncIds(d) {
    if (d && Array.isArray(d.assetSnapshots)) d.assetSnapshots.forEach(s => { if (s && !s.id && s.date) { s.id = 'snap_' + s.date; if (s.updatedAt == null) s.updatedAt = 1; } });
    return d;
  }
  function mergeBucketed(localObj, remoteObj) {
    const keys = new Set([...Object.keys(localObj || {}), ...Object.keys(remoteObj || {})]);
    const out = {};
    keys.forEach(k => { out[k] = mergeArrayById((localObj || {})[k], (remoteObj || {})[k]); });
    return out;
  }

  function restUrl(path) { return `${SUPABASE_URL}/rest/v1/${path}`; }
  const LOG = (...args) => console.log('🔄 RD-SYNC:', ...args);

  async function authedFetch(path, opts) {
    opts = opts || {};
    const session = window.Auth ? await Auth.ensureValidSession() : null;
    if (!session) { LOG('لا يوجد تسجيل دخول سارٍ — تم إلغاء الطلب:', path); throw new Error('لا يوجد تسجيل دخول سارٍ'); }
    const headers = Object.assign({
      apikey: SUPABASE_ANON_KEY,
      Authorization: `Bearer ${session.access_token}`,
      'Content-Type': 'application/json'
    }, opts.headers || {});
    return fetch(restUrl(path), Object.assign({}, opts, { headers }));
  }

  // دمج مصفوفة واحدة: اتحاد بالـid (زي ما هو متفق عليه من التصميم الأصلي —
  // "إضافة لا استبدال"). لو نفس الـid طلع بالطرفين (نادر جدًا، شبه مستحيل
  // بسبب نظام المعرّفات)، ناخذ النسخة الأحدث تعديلًا (updatedAt).
  // ⚠️ الترتيب النهائي مرتّب دايمًا حسب id (بدل ترتيب الوصول) — لأن أي فرق
  // بالترتيب بس (بلا أي فرق بالمحتوى) كان يخلي مقارنة "قبل/بعد" بـrenderer.js
  // تعتقد إن فيه تحديث جديد كل دورة سحب، فيرن التنبيه بلا داعي حتى لو ما
  // تغيّر شي فعليًا — هذا بالضبط سبب مشكلة "التنبيه المتكرر بلا فايدة"
  function mergeArrayById(localArr, remoteArr) {
    const map = new Map();
    (remoteArr || []).forEach(r => r && r.id && map.set(r.id, r));
    (localArr || []).forEach(l => {
      if (!l || !l.id) return;
      const r = map.get(l.id);
      if (!r) { map.set(l.id, l); return; }
      const lt = l.updatedAt || 0, rt = r.updatedAt || 0;
      map.set(l.id, lt >= rt ? l : r);
    });
    return Array.from(map.values()).sort((a, b) => String(a.id).localeCompare(String(b.id)));
  }

  // يرجّع نسخة من DATA بنفس ترتيب المصفوفات الثابت اللي ترجعه mergeArrayById —
  // نستخدمها بـrenderer.js عشان نقارن "قبل الدمج" و"بعد الدمج" بنفس الأساس،
  // فما يطلع فرق وهمي بسبب الترتيب، بس فرق حقيقي لو فيه محتوى جديد فعلًا
  function normalize(obj) {
    if (!obj) return obj;
    const clone = JSON.parse(JSON.stringify(obj));
    ensureSyncIds(clone);
    MERGE_ARRAYS.forEach(k => {
      if (Array.isArray(clone[k])) clone[k] = clone[k].slice().sort((a, b) => String(a && a.id).localeCompare(String(b && b.id)));
    });
    MERGE_BUCKETED.forEach(k => {
      if (clone[k] && typeof clone[k] === 'object') {
        Object.keys(clone[k]).forEach(bucket => {
          if (Array.isArray(clone[k][bucket])) clone[k][bucket] = clone[k][bucket].slice().sort((a, b) => String(a && a.id).localeCompare(String(b && b.id)));
        });
      }
    });
    return clone;
  }

  function mergeData(local, remote) {
    if (!remote) return ensureSyncIds(local);
    if (!local) return ensureSyncIds(remote);
    ensureSyncIds(local); ensureSyncIds(remote);
    const merged = JSON.parse(JSON.stringify(local));
    MERGE_ARRAYS.forEach(k => { merged[k] = mergeArrayById(local[k], remote[k]); });
    MERGE_BUCKETED.forEach(k => { merged[k] = mergeBucketed(local[k], remote[k]); });
    const localTs = (local.meta && local.meta.lastSavedAt) || 0;
    const remoteTs = (remote.meta && remote.meta.lastSavedAt) || 0;
    if (remoteTs > localTs) {
      merged.settings = Object.assign({}, local.settings || {}, remote.settings || {});
      merged.labels = Object.assign({}, local.labels || {}, remote.labels || {});
    }
    return merged;
  }

  // تُنادى مرة وحدة عند فتح التطبيق (بعد Platform.load المحلي، وقبل الرسم):
  // تجيب نسخة الحساب من Supabase وتدمجها مع النسخة المحلية، وترجّع الناتج
  // المدموج (بدون ما تحفظه هي بنفسها — bootApp يتكفّل بالحفظ محليًا بعدها)
  async function pullAndMerge(localData) {
    if (pushPending) { LOG('سحب مؤجّل: فيه رفع معلّق لسا'); return localData; }
    try {
      LOG('بدأ السحب...');
      const res = await authedFetch(`${TABLE}?select=data&limit=1`, { method: 'GET' });
      if (!res.ok) {
        const errBody = await res.text().catch(() => '');
        console.error('RD Flow sync pull failed:', res.status, errBody);
        return localData;
      }
      const rows = await res.json().catch(() => []);
      LOG('السحب نجح، عدد الصفوف المرجعة:', rows.length);
      const remote = rows && rows[0] && rows[0].data;
      if (!remote) LOG('⚠️ ما فيه صف بالسحابة لهالمستخدم إطلاقًا (أول مرة، أو الرفع الأول ما تم بعد)');
      const merged = mergeData(localData, remote);
      LOG('انتهى الدمج.');
      return merged;
    } catch (e) {
      console.error('RD Flow sync pull error:', e);
      // بدون نت، أو الجدول لسا ما انبنى، أو أي خلل: التطبيق يكمل بالبيانات
      // المحلية بدون توقف — المزامنة "إضافية" مو شرط تشغيل زي ما اتفقنا من البداية
      return localData;
    }
  }

  // تُنادى بعد كل حفظ محلي (persist)، بتأخير بسيط (debounce) حتى ما نرسل طلب
  // شبكة مع كل ضغطة — نجمع كل التغييرات القريبة من بعض بطلب واحد.
  // ⚠️ مهم: من لحظة جدولة الرفع لين ما يخلص فعليًا (نجح أو فشل)، نعتبر حالة
  // "رفع معلّق" — أي سحب (pull) يحاول يشتغل بهالفترة لازم ينتظر، وإلا ممكن
  // يجيب نسخة قديمة من السحابة ويدمجها فوق تغيير لسا ما وصل للسحابة (بالضبط
  // المشكلة اللي صارت مع الاستيراد: سحب قديم يوصل قبل الرفع الجديد وينقض عليه)
  let pushTimer = null;
  let pushMaxTimer = null;
  let pushPending = false;
  function isPushPending() { return pushPending; }
  function schedulePush(data) {
    pushPending = true;
    if (pushTimer) clearTimeout(pushTimer);
    pushTimer = setTimeout(() => { pushTimer = null; if (pushMaxTimer) { clearTimeout(pushMaxTimer); pushMaxTimer = null; } push(data); }, 3000);
    // ⚠️ حماية من "التأجيل الأبدي": لو صار حفظ متكرر جدًا (حفظ تلقائي بفواصل
    // قصيرة، أو عدة تعديلات متتالية) يصفّر عداد الـ3 ثواني بدون توقف، الرفع
    // ما يصير أبدًا. هذا المؤقّت الثاني يضمن رفع خلال 8 ثواني كحد أقصى دايمًا،
    // بغض النظر عن أي حفظ إضافي يصير بالمنتصف
    if (!pushMaxTimer) pushMaxTimer = setTimeout(() => { pushMaxTimer = null; if (pushTimer) { clearTimeout(pushTimer); pushTimer = null; } push(data); }, 8000);
  }
  // رفع فوري بدون انتظار الـ3 ثواني — يُستخدم لعمليات "استبدال كامل" (زي
  // استيراد نسخة احتياطية) حيث ما نقدر نتحمل احتمال سحب قديم يسبقنا
  function pushNow(data) {
    if (pushTimer) { clearTimeout(pushTimer); pushTimer = null; }
    if (pushMaxTimer) { clearTimeout(pushMaxTimer); pushMaxTimer = null; }
    pushPending = true;
    return push(data);
  }

  // ⚠️ بدون هذا التتبّع: لو فشل رفع (بسبب انقطاع نت وقت المحاولة تحديدًا)،
  // التعديلات المحلية تبقى محفوظة بأمان على الجهاز، بس ما حد يعيد محاولة
  // رفعها للسحابة تلقائيًا إلا لو المستخدم سوّى تعديل جديد يشغّل دورة رفع
  // ثانية من الصفر — فلو ما ضاف شي جديد بعد رجوع النت، تبقى معلّقة للأبد.
  // هالعلم يخلي دورة المزامنة الدورية (initPeriodicSync بـrenderer.js) تعيد
  // محاولة الرفع تلقائيًا أول ما تشتغل بعد فشل سابق، بدل انتظار تعديل جديد
  let hasFailedPush = false;
  function hasUnsyncedChanges() { return hasFailedPush; }

  async function push(data) {
    try {
      const session = window.Auth && Auth.getSession();
      if (!session) { LOG('رفع ملغى: ما فيه جلسة دخول'); return; }
      // ⚠️ إصلاح جوهري: قبل أي رفع، نسحب آخر نسخة من السحابة وندمجها مع
      // المحلية أولًا. من دون هالخطوة، الرفع "يكتب فوق" السحابة بالكامل —
      // فلو جهاز ثاني رفع تغييرًا (زي تعديل إعداد) بنفس الدقيقة تقريبًا، ورفعنا
      // إحنا بعده بنسخة محلية ما تعرف عن تغييره، رفعتنا تمحي تغييره بالغلط
      // (بالضبط اللي صار مع "رأس المال الأولي": 60 رجعت 20). الحل: كل رفع
      // يصير أولًا "سحب+دمج+رفع"، مو "رفع خام" مباشرة.
      ensureSyncIds(data);
      let toSend = data;
      try {
        const pullRes = await authedFetch(`${TABLE}?select=data&limit=1`, { method: 'GET' });
        if (pullRes.ok) {
          const rows = await pullRes.json().catch(() => []);
          const remote = rows && rows[0] && rows[0].data;
          if (remote) {
            const merged = mergeData(data, remote);
            if (JSON.stringify(normalize(merged)) !== JSON.stringify(normalize(data))) {
              toSend = merged;
              if (onMergedCallback) onMergedCallback(merged); // نبلّغ renderer.js عشان يحدّث DATA والشاشة فورًا، بدل ما ينتظر دورة السحب الجاية
            }
          }
        }
      } catch (e) { /* لو فشل السحب التمهيدي (بدون نت مثلًا)، نكمل ونرفع النسخة المحلية زي ما هي بدل ما نوقف كليًا */ }

      LOG('بدأ الرفع لحساب:', session.user && session.user.id);
      const res = await authedFetch(`${TABLE}?on_conflict=user_id`, {
        method: 'POST',
        headers: { Prefer: 'resolution=merge-duplicates' },
        body: JSON.stringify({ user_id: session.user.id, data: toSend, updated_at: new Date().toISOString() })
      });
      if (!res.ok) {
        const errBody = await res.text().catch(() => '');
        console.error('RD Flow sync push failed:', res.status, errBody);
        hasFailedPush = true;
      } else {
        LOG('الرفع نجح ✅');
        hasFailedPush = false;
      }
    } catch (e) {
      console.error('RD Flow sync push error:', e);
      // فشل الإرسال (بدون نت مثلًا) ما يوقف ولا يزعج المستخدم — بيانات الجهاز
      // محفوظة محليًا أصلاً، وبتنرفع تلقائيًا بأقرب دورة مزامنة دورية (أو
      // أول persist() جاي، أيهما أسبق) بدل ما تبقى معلّقة للأبد
      hasFailedPush = true;
    } finally {
      pushPending = false;
    }
  }

  // renderer.js يسجّل هالدالة مرة عند الإقلاع — تُنادى لما الرفع نفسه يكتشف
  // تغييرات من جهاز ثاني (عبر السحب التمهيدي قبل الرفع) عشان تحدّث DATA
  // والشاشة فورًا، بدل ما تنتظر دورة السحب الدورية العادية (لين 30 ثانية)
  let onMergedCallback = null;
  function setOnMerged(fn) { onMergedCallback = fn; }

  // نبضة خفيفة تمنع مشروع Supabase المجاني من "النوم" بعد فترة خمول طويلة.
  // هذي وحدها ما تكفي لو التطبيق نفسه ما يفتحه أحد لفترة طويلة — الحل الكامل
  // لهذي النقطة مذكور بالتعليمات المرفقة (خدمة خارجية مجانية تسوي بينغ دوري).
  async function pingKeepAlive() {
    try { await authedFetch(`${TABLE}?select=user_id&limit=1`, { method: 'GET' }); } catch (e) { /* تجاهل */ }
  }

  LOG('تم تحميل ملف sync.js بنجاح ✅');
  window.Sync = { pullAndMerge, schedulePush, pushNow, isPushPending, hasUnsyncedChanges, pingKeepAlive, normalize, MERGE_ARRAYS, MERGE_BUCKETED, setOnMerged };
})();
