// ==========================================================================
// platform.js — طبقة العزل بين الواجهة (renderer.js) والمنصة الفعلية
// ==========================================================================
// الهدف: renderer.js ينادي دايمًا "Platform.شيء" وما يعرف ولا يهتم إذا كان
// شغال داخل Electron (ويندوز) أو داخل Capacitor (أندرويد). كل التفاصيل
// الخاصة بكل منصة محصورة هنا فقط.
//
// - داخل Electron: كل دالة هنا مجرد تمريرة مباشرة لـ window.api (نفسه المعرّف
//   في preload.js) — صفر تغيير في السلوك، صفر خطورة على نسخة ويندوز الشغالة.
// - داخل Capacitor: كل دالة مبنية بأدوات أندرويد الحقيقية (Filesystem,
//   LocalNotifications, Share, Device) عبر window.Capacitor.Plugins — بدون
//   أي bundler، وهذا مدعوم رسميًا من Capacitor (يُسجَّل كل plugin تلقائيًا).
//
// ⚠️ ملاحظة صريحة: الجزء الخاص بـ Electron مجرّب وشغال 100% (هو أصلاً نفس
// window.api الحالي). الجزء الخاص بـ Capacitor مكتوب بأفضل معرفة حالية
// بواجهة Capacitor، لكنه ما جُرّب على جهاز أندرويد حقيقي بعد — لازم تختبره
// بنفسك بعد ما تجهّز مشروع Capacitor محليًا (تفاصيل ذلك في ANDROID_SETUP.md).
// ==========================================================================

(function () {
  // ------------------------------------------------------------------------
  // فرع «وضع التجربة» (ضيف بلا حساب): يُفعَّل بـ ?demo=1 بالرابط أو نطاق فرعي
  // يبدأ بـdemo. — يشتغل بمتصفح عادي بلا Electron وبلا Capacitor. كل التخزين
  // بالذاكرة فقط (متغيّر JS عادي، ليس حتى localStorage) فيضيع تلقائيًا عند
  // تحديث الصفحة — بالضبط الأثر المطلوب: يجرّب الزائر ويعدّل بحرية، ولا يبقى
  // أي أثر لأي زائر آخر ولا حتى لنفسه بعد التحديث. لا تسجيل دخول ولا مزامنة
  // إطلاقًا هنا (renderer.js/sync.js يتحققان من platformName ويتجاوزانها).
  // ------------------------------------------------------------------------
  const demoUid = () => 'demo_' + Math.random().toString(36).slice(2, 10) + Date.now().toString(36);
  const DAY = 86400000;
  const daysAgo = (n) => new Date(Date.now() - n * DAY).toISOString().slice(0, 10);
  const monthsAgo = (n, day) => { const d = new Date(); d.setDate(1); d.setMonth(d.getMonth() - n); if (day) d.setDate(Math.min(day, 28)); return d.toISOString().slice(0, 10); };
  // بيانات تجريبية غنية وعامة (تصلح لأي زائر، لا مرتبطة بمهنة محدَّدة) — على مدار 3 سنوات كاملة،
  // بتواريخ نسبية لليوم الحالي حتى تبدو الرسوم والإحصائيات "حية" دائمًا بغضّ النظر عن تاريخ الزيارة،
  // بعدة عملات (DA/USD/EUR)، ولتُظهر كل قسم بالتطبيق فعليًا مليئًا بمحتوى واقعي وصالح للأرشيف السنوي
  function buildDemoData() {
    const now = Date.now();
    // بيانات التجربة تتغيّر عشوائيًا كل مرة تُفتح الصفحة (بدل ثابتة دائمًا) — نفس الواقعية والهيكل، بأسماء وأرقام مختلفة في كل زيارة
    const pick = (arr) => arr[Math.floor(Math.random() * arr.length)];
    const shuffleTake = (arr, n) => { const a = arr.slice(); for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; } return a.slice(0, n); };
    const jitter = 0.75 + Math.random() * 0.65; // معامل عشوائي عام (٪75–140٪) يُطبَّق على أغلب المبالغ الرئيسية بالدينار
    const J = (n) => Math.round(n * jitter);
    const CLIENT_NAME_POOL = [
      'شركة الأفق للتوريدات', 'مؤسسة النجاح للاستشارات', 'متجر البيت الذكي (أونلاين)', 'شركة الرواد للتجارة',
      'مجموعة النخبة العقارية', 'مصنع الجودة للأثاث', 'مؤسسة الإبداع التقني', 'شركة الوفاء للمقاولات'
    ];
    const clientNames = shuffleTake(CLIENT_NAME_POOL, 3);
    const DEBT_NAME_POOL_I_OWE = ['أخوي (سلفة عاجلة)', 'صاحبي كريم', 'الجار أبو محمد', 'زميل العمل'];
    const DEBT_NAME_POOL_THEY_OWE = ['دفعة متأخرة من عميل', 'قريبي (سلفة قديمة)', 'صديق الجامعة'];
    const cat = (id, name, type, color) => ({ id, name, type, color, deleted: false, updatedAt: 1 });
    const categories = [
      cat('dcat_salary', 'راتب / دخل رئيسي', 'income', '#22d3a8'), cat('dcat_freelance', 'عمل حر ومشاريع', 'income', '#4f7cff'),
      cat('dcat_sales', 'عمولات ومبيعات', 'income', '#a855f7'), cat('dcat_invret', 'أرباح استثمار', 'income', '#f59e0b'),
      cat('dcat_housing', 'سكن وإيجار', 'expense', '#ef5a6f'), cat('dcat_bills', 'فواتير ومرافق', 'expense', '#eab308'),
      cat('dcat_shopping', 'تسوق ومصاريف شخصية', 'expense', '#f97316'), cat('dcat_transport', 'تنقلات ومواصلات', 'expense', '#64748b'),
      cat('dcat_health', 'صحة وعلاج', 'expense', '#ec4899'), cat('dcat_edu', 'تعليم وتطوير', 'expense', '#38bdf8')
    ];
    const clients = [
      { id: 'dcl_1', name: clientNames[0], currency: 'DA', createdAt: now - 900 * DAY, deleted: false, updatedAt: 1 },
      { id: 'dcl_2', name: clientNames[1], currency: 'DA', createdAt: now - 700 * DAY, deleted: false, updatedAt: 1 },
      { id: 'dcl_3', name: clientNames[2], currency: 'DA', createdAt: now - 500 * DAY, deleted: false, updatedAt: 1 },
      { id: 'dcl_4', name: 'Global Remote Co.', currency: 'USD', createdAt: now - 400 * DAY, deleted: false, updatedAt: 1 },
      { id: 'dcl_5', name: 'Client Europe (Freelance)', currency: 'EUR', createdAt: now - 300 * DAY, deleted: false, updatedAt: 1 }
    ];
    const projects = [
      { id: 'dpr_1', clientId: 'dcl_1', title: 'عقد توريد سنوي', agreedAmount: J(180000), currency: 'DA', deleted: false, updatedAt: 1 },
      { id: 'dpr_2', clientId: 'dcl_2', title: 'استشارة تطوير أعمال', agreedAmount: J(90000), currency: 'DA', deleted: false, updatedAt: 1 },
      { id: 'dpr_3', clientId: 'dcl_3', title: 'إدارة المتجر الإلكتروني', agreedAmount: J(60000), currency: 'DA', deleted: false, updatedAt: 1 },
      { id: 'dpr_4', clientId: 'dcl_4', title: 'Monthly Retainer', agreedAmount: 4200, currency: 'USD', deleted: false, updatedAt: 1 },
      { id: 'dpr_5', clientId: 'dcl_5', title: 'Freelance Design Project', agreedAmount: 1800, currency: 'EUR', deleted: false, updatedAt: 1 }
    ];
    const transactions = [];
    const mkTx = (kind, mode, amount, currency, date, categoryId, note, extra) => transactions.push(Object.assign(
      { id: demoUid(), kind, mode, amount, currency, date, categoryId: categoryId || null, note: note || '', flagged: false, createdAt: now, updatedAt: now, deleted: false }, extra || {}));

    // دخل: راتب/دخل رئيسي ثابت تقريبًا على 3 سنوات كاملة (36 شهرًا)، بزيادة تدريجية بسيطة
    for (let m = 35; m >= 0; m--) mkTx('income', 'general', J(45000) + (35 - m) * 300, 'DA', monthsAgo(m, 1), 'dcat_salary', 'راتب / دخل الشهر');
    // دخل عملاء موزّع على 5 مشاريع بنسب دفع مختلفة (بعضها مكتمل، بعضها جزئي) — يظهر تنوع حالة الدفع بصفحة العملاء
    mkTx('income', 'client', J(90000), 'DA', monthsAgo(30, 10), null, 'الدفعة الأولى', { projectId: 'dpr_1' });
    mkTx('income', 'client', J(90000), 'DA', monthsAgo(18, 5), null, 'الدفعة الثانية والأخيرة', { projectId: 'dpr_1' });
    mkTx('income', 'client', J(45000), 'DA', monthsAgo(20, 15), null, 'دفعة أولى', { projectId: 'dpr_2' });
    mkTx('income', 'client', J(20000), 'DA', monthsAgo(9, 15), null, 'دفعة إضافية (لسا ناقص من العقد)', { projectId: 'dpr_2' });
    for (let m = 14; m >= 0; m -= 2) mkTx('income', 'client', J(5000), 'DA', monthsAgo(m, 20), null, 'دفعة دورية', { projectId: 'dpr_3' });
    for (let m = 17; m >= 0; m--) mkTx('income', 'client', 350, 'USD', monthsAgo(m, 7), null, 'Monthly retainer', { projectId: 'dpr_4' });
    for (let m = 22; m >= 2; m -= 4) mkTx('income', 'client', 300, 'EUR', monthsAgo(m, 12), null, 'Design milestone', { projectId: 'dpr_5' });
    // دخل عام متفرق (عمولات/مبيعات) على مدار 3 سنوات
    for (let m = 35; m >= 0; m -= 3) mkTx('income', 'general', J(3000) + Math.round(Math.random() * 4000), 'DA', monthsAgo(m, 22), 'dcat_sales', 'عمولة/بيع متفرق');
    // أرباح استثمار (تقريبًا سنويًا، بتزايد)
    mkTx('income', 'general', J(6000), 'DA', monthsAgo(30, 1), 'dcat_invret', 'عائد استثمار — السنة الأولى');
    mkTx('income', 'general', J(8500), 'DA', monthsAgo(18, 1), 'dcat_invret', 'عائد استثمار — السنة الثانية');
    mkTx('income', 'general', J(11000), 'DA', monthsAgo(6, 1), 'dcat_invret', 'عائد استثمار — السنة الثالثة');
    // مصاريف ثابتة تقريبًا كل شهر على مدار 3 سنوات: سكن، فواتير، تنقلات، تسوق
    for (let m = 35; m >= 0; m--) mkTx('expense', 'general', J(15000), 'DA', monthsAgo(m, 1), 'dcat_housing', 'إيجار الشهر');
    for (let m = 35; m >= 0; m--) mkTx('expense', 'general', J(2200) + Math.round(Math.random() * 800), 'DA', monthsAgo(m, 5), 'dcat_bills', 'كهرباء وماء وإنترنت');
    for (let m = 35; m >= 0; m--) mkTx('expense', 'general', J(1500) + Math.round(Math.random() * 1000), 'DA', monthsAgo(m, 20), 'dcat_transport', 'وقود ومواصلات');
    for (let m = 35; m >= 0; m--) mkTx('expense', 'general', J(1200) + Math.round(Math.random() * 1800), 'DA', monthsAgo(m, 12), 'dcat_shopping', 'تسوق ومصاريف شخصية');
    // صحة (كل 4 أشهر تقريبًا) وتعليم/تطوير (كل 6 أشهر تقريبًا)
    for (let m = 32; m >= 0; m -= 4) mkTx('expense', 'general', J(2000) + Math.round(Math.random() * 3000), 'DA', monthsAgo(m, 14), 'dcat_health', 'فحص طبي / علاج');
    for (let m = 30; m >= 0; m -= 6) mkTx('expense', 'general', J(4000) + Math.round(Math.random() * 3000), 'DA', monthsAgo(m, 17), 'dcat_edu', 'دورة تدريبية / كتب');
    // مصاريف بعملات أخرى (لإظهار تعدد العملات بالمصاريف أيضًا، لا فقط بالدخل)
    mkTx('expense', 'general', 60, 'USD', monthsAgo(10, 9), 'dcat_bills', 'اشتراك أداة عمل شهري بالدولار');
    mkTx('expense', 'general', 45, 'EUR', monthsAgo(5, 9), 'dcat_bills', 'اشتراك خدمة أوروبية');
    // مصروفان كبيران لمرة واحدة (سنة 1 وسنة 2) — يظهران بوضوح بالأرشيف السنوي
    mkTx('expense', 'general', J(55000), 'DA', monthsAgo(28, 9), null, 'شراء جهاز/معدة كبيرة');
    mkTx('expense', 'general', J(38000), 'DA', monthsAgo(11, 14), null, 'إصلاح/صيانة كبيرة');

    // ديون: واحد عليك، واحد لك، وواحد قديم مسدَّد بالكامل (يظهر تاريخ الديون المسوّاة أيضًا)
    const debts = [
      { id: 'ddebt_1', name: pick(DEBT_NAME_POOL_I_OWE), type: 'i_owe', currency: 'DA', amount: J(15000), paidAmount: J(5000), date: daysAgo(40), note: '', reminderAt: null, notifiedAt: null, flagged: false, fromTxId: null, createdAt: now, updatedAt: now, deleted: false },
      { id: 'ddebt_2', name: pick(DEBT_NAME_POOL_THEY_OWE), type: 'they_owe_me', currency: 'DA', amount: J(4000), paidAmount: 0, date: daysAgo(20), note: '', reminderAt: null, notifiedAt: null, flagged: false, fromTxId: null, createdAt: now, updatedAt: now, deleted: false },
      { id: 'ddebt_3', name: 'صديق (سلفة قديمة، مسدَّدة)', type: 'i_owe', currency: 'DA', amount: J(8000), paidAmount: J(8000), date: daysAgo(300), note: '', reminderAt: null, notifiedAt: null, flagged: false, fromTxId: null, createdAt: now - 300 * DAY, updatedAt: now - 250 * DAY, deleted: false }
    ];

    // أنواع الأصول (لازم تكون موجودة حتى تعمل نافذة "أين تضيف المبلغ" واختيار الأصل الافتراضي للاقتطاعات)
    const assetTypes = [
      { id: 'cash', icon: '💵', name: 'نقدًا', deleted: false, createdAt: now, updatedAt: 1 },
      { id: 'bank', icon: '🏦', name: 'حساب بنكي', deleted: false, createdAt: now, updatedAt: 1 },
      { id: 'card', icon: '💳', name: 'بطاقة', deleted: false, createdAt: now, updatedAt: 1 },
      { id: 'ewallet', icon: '📱', name: 'محفظة إلكترونية', deleted: false, createdAt: now, updatedAt: 1 },
      { id: 'project', icon: '📦', name: 'مشروع/استثمار', deleted: false, createdAt: now, updatedAt: 1 },
      { id: 'other', icon: '💎', name: 'أصل آخر', deleted: false, createdAt: now, updatedAt: 1 }
    ];
    // أصول بعدة عملات، مع عمليات فعلية داخل كل نافذة (تُظهر ميزة الأصول بكامل تفاصيلها)
    const assets = [
      { id: 'dass_bank', type: 'bank', name: 'الحساب البنكي', value: 0, currency: 'DA', notes: '', lastUpdatedAt: now, createdAt: now - 900 * DAY, updatedAt: now, deleted: false },
      { id: 'dass_cash', type: 'cash', name: 'الكاش', value: 0, currency: 'DA', notes: '', lastUpdatedAt: now, createdAt: now - 900 * DAY, updatedAt: now, deleted: false },
      { id: 'dass_wallet', type: 'ewallet', name: 'محفظة إلكترونية', value: 0, currency: 'DA', notes: '', lastUpdatedAt: now, createdAt: now - 500 * DAY, deleted: false, updatedAt: now },
      { id: 'dass_bank_usd', type: 'bank', name: 'حساب بالدولار', value: 0, currency: 'USD', notes: '', lastUpdatedAt: now, createdAt: now - 400 * DAY, updatedAt: now, deleted: false },
      { id: 'dass_save_eur', type: 'other', name: 'مدخرات باليورو', value: 0, currency: 'EUR', notes: '', lastUpdatedAt: now, createdAt: now - 300 * DAY, updatedAt: now, deleted: false }
    ];
    const assetOps = [
      { id: demoUid(), assetId: 'dass_bank', kind: 'in', amount: J(90000), who: clientNames[0], date: monthsAgo(30, 10), note: '', createdAt: now, updatedAt: now, deleted: false },
      { id: demoUid(), assetId: 'dass_bank', kind: 'in', amount: J(45000), who: clientNames[1], date: monthsAgo(20, 15), note: '', createdAt: now, updatedAt: now, deleted: false },
      { id: demoUid(), assetId: 'dass_bank', kind: 'out', amount: -J(55000), who: '', note: 'شراء جهاز/معدة كبيرة', date: monthsAgo(28, 9), createdAt: now, updatedAt: now, deleted: false },
      { id: demoUid(), assetId: 'dass_bank', kind: 'out', amount: -J(38000), who: '', note: 'إصلاح/صيانة كبيرة', date: monthsAgo(11, 14), createdAt: now, updatedAt: now, deleted: false },
      { id: demoUid(), assetId: 'dass_cash', kind: 'in', amount: J(20000), who: 'دخل متفرق', date: monthsAgo(1, 18), note: '', createdAt: now, updatedAt: now, deleted: false },
      { id: demoUid(), assetId: 'dass_wallet', kind: 'in', amount: J(12000), who: clientNames[2], date: monthsAgo(2, 3), note: '', createdAt: now, updatedAt: now, deleted: false },
      { id: demoUid(), assetId: 'dass_bank_usd', kind: 'in', amount: 350, who: 'Global Remote Co.', date: monthsAgo(1, 7), note: '', createdAt: now, updatedAt: now, deleted: false },
      { id: demoUid(), assetId: 'dass_bank_usd', kind: 'in', amount: 350, who: 'Global Remote Co.', date: monthsAgo(2, 7), note: '', createdAt: now, updatedAt: now, deleted: false },
      { id: demoUid(), assetId: 'dass_save_eur', kind: 'in', amount: 300, who: 'Client Europe', date: monthsAgo(2, 12), note: '', createdAt: now, updatedAt: now, deleted: false }
    ];
    // تحويل بين أصولك الخاصة — يُظهر ميزة "تحويل بين أصولك" فعليًا بسجل حقيقي
    const assetTransfers = [
      { id: demoUid(), fromAssetId: 'dass_bank', toAssetId: 'dass_wallet', amount: J(10000), currency: 'DA', date: daysAgo(35), note: 'تحويل جزء للمحفظة الإلكترونية', createdAt: now, updatedAt: now, deleted: false },
      { id: demoUid(), fromAssetId: 'dass_cash', toAssetId: 'dass_bank', amount: J(5000), currency: 'DA', date: daysAgo(12), note: 'إيداع نقدي بالبنك', createdAt: now, updatedAt: now, deleted: false }
    ];
    // اقتطاعان متكرران: واحد بأصل افتراضي (يُخصم تلقائيًا عند التوليد — يُظهر ميزة الأصل الافتراضي حيّة)، وآخر بلا أصل (يظهر بقائمة "بانتظار الأصل")
    const recurringTx = [
      { id: 'drec_1', kind: 'expense', categoryId: 'dcat_housing', amount: J(15000), currency: 'DA', dayOfMonth: 1, note: '', assetTypeId: 'bank', active: true, lastGeneratedYM: monthsAgo(1).slice(0, 7), createdAt: now - 900 * DAY, updatedAt: now, deleted: false },
      { id: 'drec_2', kind: 'expense', categoryId: 'dcat_bills', amount: J(2500), currency: 'DA', dayOfMonth: 5, note: '', assetTypeId: null, active: true, lastGeneratedYM: monthsAgo(1).slice(0, 7), createdAt: now - 900 * DAY, updatedAt: now, deleted: false }
    ];
    // استثمار موزَّع على 3 سنوات، بعدة عملات، بإيداعات وسحوبات — يظهر منحنى استثمار حقيقي لا نقطة واحدة
    const investments = [
      { id: demoUid(), date: monthsAgo(33, 5), amount: J(20000), note: 'إيداع رأس مال أولي', currency: 'DA', deleted: false },
      { id: demoUid(), date: monthsAgo(24, 10), amount: J(8000), note: 'إيداع إضافي', currency: 'DA', deleted: false },
      { id: demoUid(), date: monthsAgo(18, 6), amount: -J(5000), note: 'سحب جزئي', currency: 'DA', deleted: false },
      { id: demoUid(), date: monthsAgo(12, 3), amount: J(10000), note: 'إيداع سنوي', currency: 'DA', deleted: false },
      { id: demoUid(), date: monthsAgo(6, 9), amount: 500, note: 'إيداع بالدولار', currency: 'USD', deleted: false },
      { id: demoUid(), date: daysAgo(6), amount: J(3000), note: 'إيداع شهري', currency: 'DA', deleted: false },
      { id: demoUid(), date: daysAgo(2), amount: -J(800), note: 'سحب جزئي', currency: 'DA', deleted: false }
    ];
    // زكاة على مدار 3 سنوات (مسدَّدة سابقًا + دفعة حالية قيد الإخراج) — يُظهر قسم الإخراجات بتاريخه الكامل
    const zakatPayments = [
      { id: demoUid(), name: 'زكاة المال — السنة الأولى', amount: J(2400), currency: 'DA', date: monthsAgo(24, 1), delivered: true, deliveredAt: now - 700 * DAY, deleted: false },
      { id: demoUid(), name: 'زكاة المال — السنة الثانية', amount: J(2900), currency: 'DA', date: monthsAgo(12, 1), delivered: true, deliveredAt: now - 350 * DAY, deleted: false },
      { id: demoUid(), name: 'زكاة المال — النصف الأول', amount: J(3200), currency: 'DA', date: daysAgo(90), delivered: true, deliveredAt: now - 85 * DAY, deleted: false },
      { id: demoUid(), name: 'زكاة المال — النصف الثاني (قيد الإخراج)', amount: J(3400), currency: 'DA', date: daysAgo(5), delivered: false, deliveredAt: null, deleted: false }
    ];
    const calendarItems = [
      { id: demoUid(), title: 'تسليم مشروع متجر البيت الذكي', date: daysAgo(-5), time: '17:00', note: '', reminderAt: now + 3 * DAY, notifiedAt: null, flagged: true, deleted: false, createdAt: now, updatedAt: now },
      { id: demoUid(), title: 'مراجعة الميزانية الشهرية', date: daysAgo(-1), time: '20:00', note: '', reminderAt: now + DAY, notifiedAt: null, flagged: false, deleted: false, createdAt: now, updatedAt: now }
    ];
    // منحنى صافي الثروة على 3 سنوات كاملة (كل ~13 يومًا، ≈84 نقطة) — بدل نقطة واحدة، حتى تظهر رسمة "أموالي" غنية وواقعية من أول لحظة
    const assetSnapshots = [];
    const SNAP_SPAN_DAYS = 3 * 365, SNAP_STEP = 13;
    for (let d = SNAP_SPAN_DAYS; d >= 0; d -= SNAP_STEP) {
      const progress = 1 - d / SNAP_SPAN_DAYS; // 0 → 1 من الماضي إلى اليوم
      const noise = Math.sin(d / 47) * 4000 + Math.cos(d / 29) * 2000;
      const da = Math.round(J(30000) + progress * J(100000) + noise);
      const usd = Math.round(200 + progress * 900 + Math.sin(d / 60) * 60);
      const eur = Math.round(100 + progress * 600 + Math.cos(d / 55) * 40);
      const date = daysAgo(d);
      assetSnapshots.push({ id: 'snap_' + date, date, netWorth: { DA: Math.max(5000, da), USD: Math.max(50, usd), EUR: Math.max(30, eur) }, createdAt: now, updatedAt: now, deleted: false });
    }
    const curYear = new Date().getFullYear();
    return {
      settings: { theme: 'black', language: 'ar', defaultCurrency: 'DA', currencies: ['DA', 'USD', 'EUR'], years: [curYear - 2, curYear - 1, curYear], autoSaveEnabled: true, autoSaveMinutes: 60, autoSaveUnit: 'seconds', disabledSections: [], investmentInitial: {}, exchangeRates: {}, navOrder: [], aiProviders: [], aiSmartModeEnabled: false, monthComparisonAlertsEnabled: true },
      labels: {}, meta: {}, categories, clients, projects, transactions, investments, calendarItems, zakatPayments, alerts: [], debts,
      assets, assetOps, assetTransfers, assetTypes, assetSnapshots, recurringTx, syncFlags: [], notifications: [],
      plans: [], priceItems: [], priceAddons: [], quotes: [], pricingPresets: [], serviceTypes: [], appointments: [], dailySchedule: [],
      weeklySchedule: { 0: [], 1: [], 2: [], 3: [], 4: [], 5: [], 6: [] }, quarterlySchedule: { 1: [], 2: [], 3: [], 4: [] }, yearlySchedule: { 1: [], 2: [], 3: [], 4: [], 5: [], 6: [], 7: [], 8: [], 9: [], 10: [], 11: [], 12: [] }, monthComparisonLog: []
    };
  }

  const isDemoMode = (new URLSearchParams(location.search).get('demo') === '1') || /^demo\./.test(location.hostname);
  if (isDemoMode) {
    let demoData = null; // تُبنى مرة واحدة فقط عند أول Platform.load() لهذه الجلسة
    const NEEDS_APP_MSG = { ok: false, needsMainUpdate: false, demoUnavailable: true, error: 'هذه الميزة متاحة في التطبيق الحقيقي فقط — هذا مجرد وضع تجربة' };
    window.Platform = {
      platformName: 'demo',
      load: async () => { if (!demoData) demoData = buildDemoData(); return JSON.parse(JSON.stringify(demoData)); },
      save: async (data) => { demoData = data; return true; }, // بالذاكرة فقط — لا كتابة قرص ولا شبكة إطلاقًا
      backupNow: async () => NEEDS_APP_MSG,
      newId: async () => demoUid(),
      deviceId: async () => 'demo-device',
      exportToFile: async () => NEEDS_APP_MSG,
      importFromFile: async () => NEEDS_APP_MSG,
      notify: () => {}, // لا إشعارات نظام حقيقية بمتصفح تجربة
      onNavigate: () => {},
      exportPDF: async () => NEEDS_APP_MSG,
      exportPDFBatch: async () => NEEDS_APP_MSG,
      aiChat: async () => ({ ok: false, failed: [{ id: 'demo', error: 'الذكاء الاصطناعي متاح في التطبيق الحقيقي فقط' }] }),
      autoBackup: async () => NEEDS_APP_MSG,
      listBackups: async () => ({ current: null, previous: null, needsMainUpdate: false }),
      restoreBackup: async () => NEEDS_APP_MSG,
      pickBackupFolder: async () => NEEDS_APP_MSG
    };
    return;
  }


  const isElectron = !!window.api;
  const isCapacitorNative = !!(window.Capacitor && typeof window.Capacitor.isNativePlatform === 'function' && window.Capacitor.isNativePlatform());

  // ------------------------------------------------------------------------
  // فرع Electron
  // ------------------------------------------------------------------------
  if (isElectron) {
    let _deviceIdCache = null;
    window.Platform = {
      platformName: 'electron',
      load: (...a) => window.api.load(...a),
      // ⚠️ إصلاح جوهري: window.api.save الأصلي (بملف main.js، قديم من قبل نظام
      // المزامنة) ما يحدّث data.meta.lastSavedAt/lastSavedDevice. ونظام حل
      // تعارض الإعدادات (settings) بالمزامنة يعتمد بالكامل على هالحقل ليقرر
      // مين نسخة الإعدادات الأحدث. من دونه، ويندوز يظهر "أقدم" دايمًا مقابل
      // أي جهاز أندرويد (اللي يحدّثه صح بفرعه بالأسفل) — فتخسر تعديلات ويندوز
      // كل تعارض بالإعدادات (رأس المال الأولي، ساعات الدوام، جدولي...)، بالضبط
      // العرض اللي وصفته: "يقبل بس تعديلات الهاتف". نحدّثه هنا قبل التمرير
      // لـwindow.api.save، بدون أي حاجة نلمس main.js/preload.js الأصليين.
      save: async (data) => {
        if (!_deviceIdCache) { try { _deviceIdCache = await window.api.deviceId(); } catch (e) { _deviceIdCache = 'pc-unknown'; } }
        data.meta = data.meta || {};
        data.meta.lastSavedAt = Date.now();
        data.meta.lastSavedDevice = _deviceIdCache;
        // ⚠️ إصلاح جوهري (بديل الطريقة القديمة اللي سببت كارثة "JWT expired"):
        // renderer.js يحفظ نسخته من DATA كل شوي (كل تعديل، كل autosave) بنسخة
        // محمّلة بالذاكرة من وقت فتح التطبيق — لو تركنا auth.js يحفظ الجلسة
        // بمكان منفصل بنفس الوقت، أي حفظ عادي من renderer.js كان "يرجّع" جلسة
        // قديمة فوق الجديدة (سباق كتابة). الحل الصحيح: هنا فقط، بمكان واحد،
        // نلصق دايمًا الجلسة *الحيّة* الحقيقية (من localStorage عبر auth.js)
        // على أي حفظ يصير، من أي جهة كانت — فما يصير تعارض إطلاقًا
        if (window.Auth && window.Auth.getSession) {
          data._authSession = window.Auth.getSession();
          data._rememberedAccounts = window.Auth.getRememberedAccounts ? window.Auth.getRememberedAccounts() : data._rememberedAccounts;
        }
        return window.api.save(data);
      },
      backupNow: (...a) => window.api.backupNow(...a),
      newId: (...a) => window.api.newId(...a),
      deviceId: (...a) => window.api.deviceId(...a),
      exportToFile: (...a) => window.api.exportToFile(...a),
      importFromFile: (...a) => window.api.importFromFile(...a),
      notify: (...a) => window.api.notify(...a),
      onNavigate: (...a) => window.api.onNavigate(...a),
      exportPDF: (...a) => window.api.exportPDF(...a),
      exportPDFBatch: (...a) => window.api.exportPDFBatch(...a),
      aiChat: (...a) => window.api.aiChat(...a),
      // ---------------- النسخ الاحتياطي التلقائي (يوميًا، نسختين، محلي بحت) ----------------
      // دوال جديدة كليًا، ما تلمس زر "نسخة احتياطية الآن" القديم (backupNow) فوق
      // ولا تتعارض معاه. لو main.js/preload.js ما عندهم بعد هالدوال، نرجّع
      // علامة واضحة (needsMainUpdate) بدل ما نطيح بخطأ — الواجهة تعرض رسالة
      // توضيحية بدلها بدل ما تنكسر
      autoBackup: (data) => window.api.autoBackup ? window.api.autoBackup(data) : Promise.resolve({ ok: false, needsMainUpdate: true }),
      listBackups: () => window.api.listBackups ? window.api.listBackups() : Promise.resolve({ current: null, previous: null, needsMainUpdate: true }),
      restoreBackup: (which) => window.api.restoreBackup ? window.api.restoreBackup(which) : Promise.resolve({ ok: false, needsMainUpdate: true }),
      pickBackupFolder: () => window.api.pickBackupFolder ? window.api.pickBackupFolder() : Promise.resolve({ ok: false, needsMainUpdate: true }),
      // ---------- التحديث التلقائي الحقيقي: فحص + تنزيل + تثبيت بضغطة واحدة ----------
      // لو main.js/preload.js القديمين (قبل هذا التحديث) ما عندهم بعد updater،
      // نرجّع null بهدوء — update-check.js يتراجع تلقائيًا لرابط الموقع اليدوي
      updater: window.api.updater ? {
        check: () => window.api.updater.check(),
        install: () => window.api.updater.install(),
        onEvent: (cb) => window.api.updater.onEvent(cb)
      } : null
    };
    return;
  }

  // ------------------------------------------------------------------------
  // فرع Capacitor (أندرويد)
  // ------------------------------------------------------------------------
  const P = (window.Capacitor && window.Capacitor.Plugins) || {};
  const { Filesystem, LocalNotifications, Share, Device } = P;

  const DATA_FILE = 'rdflow-data.json';
  const DEVICE_ID_FILE = 'rdflow-device-id.txt';
  const DIR_DATA = 'DATA';   // يعادل Directory.Data — تخزين داخلي خاص بالتطبيق
  const DIR_CACHE = 'CACHE'; // يعادل Directory.Cache — ملفات مؤقتة للمشاركة/التصدير

  let _deviceId = null;
  let _navigateCb = null;
  let _notifListenerBound = false;

  function randomHex(bytes) {
    const arr = new Uint8Array(bytes);
    (window.crypto || window.msCrypto).getRandomValues(arr);
    return Array.from(arr).map(b => b.toString(16).padStart(2, '0')).join('');
  }

  async function getOrCreateDeviceId() {
    if (_deviceId) return _deviceId;
    try {
      const res = await Filesystem.readFile({ path: DEVICE_ID_FILE, directory: DIR_DATA, encoding: 'utf8' });
      _deviceId = (res.data || '').trim();
      if (_deviceId) return _deviceId;
    } catch (e) { /* أول تشغيل، ما فيه ملف بعد */ }
    // نحاول نستخدم معرّف الجهاز الحقيقي من Capacitor Device، وإلا نولّد واحد عشوائي
    let base = 'and-' + randomHex(4);
    try {
      if (Device && Device.getId) {
        const d = await Device.getId();
        if (d && d.identifier) base = 'and-' + d.identifier.replace(/-/g, '').slice(0, 12);
      }
    } catch (e) { /* نكتفي بالعشوائي */ }
    _deviceId = base;
    await Filesystem.writeFile({ path: DEVICE_ID_FILE, directory: DIR_DATA, data: _deviceId, encoding: 'utf8' });
    return _deviceId;
  }

  // نفس معادلة المعرّف الفريد المتفق عليها من الأول: جهاز + وقت بالميلي ثانية + رقم عشوائي
  async function cuid() {
    const dev = await getOrCreateDeviceId();
    return `${dev}_${Date.now()}_${randomHex(2)}`;
  }

  function defaultData(deviceId) {
    return {
      version: 1,
      deviceId,
      settings: {
        theme: 'black', language: 'ar', defaultCurrency: 'DA',
        currencies: ['DA', 'USD', 'EUR'], autoSaveMinutes: 60, autoSaveUnit: 'seconds', zakatPercent: 2.5
      },
      labels: {
        nav_dashboard: 'الرئيسية', nav_income: 'جدول العمل', nav_expenses: 'المصاريف',
        nav_clients: 'العملاء', nav_investment: 'الاستثمار', nav_outflows: 'الإخراجات',
        nav_yearly: 'الأرشيف الزمني', nav_calendar: 'الرزنامة', nav_notes: 'المذكرة',
        nav_control: 'مركز التحكم', nav_settings: 'الإعدادات',
        source_general: 'مصدر عادي', source_client: 'عميل / مشروع',
        debt_type_i_owe: 'شخص سلفني / سلفت من شخص',
        debt_type_they_owe_me: 'أنا سلفت لشخص / أخرجت من صندوقي',
        debts_summary_title: 'صافي وضعك بالديون'
      },
      categories: [], clients: [], projects: [], transactions: [], alerts: [],
      calendarItems: [], zakatPayments: [], debts: [],
      meta: { lastSavedAt: null, lastSavedDevice: deviceId }
    };
    // ملاحظة: فئات المصاريف/الدخل الافتراضية (عمل حر، أكل ومشروبات...) موجودة
    // فقط بنسخة Electron حاليًا (main.js). أول تشغيل على أندرويد بيبدأ بقائمة
    // فئات فاضية والمستخدم يضيفها بنفسه من مركز التحكم، أو لاحقًا نضيفها هنا
    // كمان لو حاب نفس التجربة بالضبط من أول تشغيل.
  }

  window.Platform = {
    platformName: 'android',

    async load() {
      const deviceId = await getOrCreateDeviceId();
      try {
        const res = await Filesystem.readFile({ path: DATA_FILE, directory: DIR_DATA, encoding: 'utf8' });
        return JSON.parse(res.data);
      } catch (e) {
        const fresh = defaultData(deviceId);
        await this.save(fresh);
        return fresh;
      }
    },

    async save(data) {
      const deviceId = await getOrCreateDeviceId();
      data.meta = data.meta || {};
      data.meta.lastSavedAt = Date.now();
      data.meta.lastSavedDevice = deviceId;
      // ⚠️ نفس الإصلاح المطبّق بفرع Electron أعلاه — راجع تعليقه هناك للتفاصيل:
      // نلصق دايمًا الجلسة الحيّة الحقيقية هنا مركزيًا قبل أي حفظ فعلي، بدل ما
      // نترك auth.js يحفظها بمكان منفصل ويصير سباق كتابة يرجّع جلسة قديمة
      if (window.Auth && window.Auth.getSession) {
        data._authSession = window.Auth.getSession();
        data._rememberedAccounts = window.Auth.getRememberedAccounts ? window.Auth.getRememberedAccounts() : data._rememberedAccounts;
      }
      await Filesystem.writeFile({ path: DATA_FILE, directory: DIR_DATA, data: JSON.stringify(data, null, 2), encoding: 'utf8', recursive: true });
      return { ok: true, savedAt: data.meta.lastSavedAt };
    },

    async backupNow(data) {
      const stamp = new Date().toISOString().replace(/[:.]/g, '-');
      const file = `backups/backup_${stamp}.json`;
      try {
        await Filesystem.writeFile({ path: file, directory: DIR_DATA, data: JSON.stringify(data, null, 2), encoding: 'utf8', recursive: true });
        return { ok: true, file };
      } catch (e) {
        return { ok: false, error: String(e) };
      }
    },

    // ---------------- النسخ الاحتياطي التلقائي (يوميًا، نسختين بس، محلي بحت) ----------------
    // نمط آمن: نكتب أول شي بملف مؤقت، نتأكد إنه سليم فعلًا (نقرأه ونتحقق من
    // شكله)، وبعدها بس نرقّي الملفات (جديدة→حالية، حالية→سابقة، حذف الأقدم).
    // لو صار أي خطأ بالمنتصف (انقطاع كهرباء، تجمّد)، آخر نسخة سليمة عندنا
    // لسا موجودة بلا ما تنمسح — ما ينفع "احذف القديمة" قبل التأكد من الجديدة
    async autoBackup(data) {
      const tmp = 'backups/backup_new.json';
      try {
        await Filesystem.writeFile({ path: tmp, directory: DIR_DATA, data: JSON.stringify(data, null, 2), encoding: 'utf8', recursive: true });
        const check = await Filesystem.readFile({ path: tmp, directory: DIR_DATA, encoding: 'utf8' });
        const parsed = JSON.parse(check.data);
        if (!parsed || !Array.isArray(parsed.transactions)) throw new Error('ملف النسخة غير سليم');
        try { await Filesystem.deleteFile({ path: 'backups/backup_previous.json', directory: DIR_DATA }); } catch (e) { /* ممكن ما فيه نسخة سابقة أصلًا، عادي */ }
        try { await Filesystem.rename({ from: 'backups/backup_current.json', to: 'backups/backup_previous.json', directory: DIR_DATA }); } catch (e) { /* أول مرة يصير نسخ، ما فيه "حالية" بعد */ }
        await Filesystem.rename({ from: tmp, to: 'backups/backup_current.json', directory: DIR_DATA });
        return { ok: true, savedAt: Date.now() };
      } catch (e) {
        return { ok: false, error: String(e) };
      }
    },

    async listBackups() {
      const out = { current: null, previous: null };
      try { out.current = (await Filesystem.stat({ path: 'backups/backup_current.json', directory: DIR_DATA })).mtime; } catch (e) { /* ما فيه بعد */ }
      try { out.previous = (await Filesystem.stat({ path: 'backups/backup_previous.json', directory: DIR_DATA })).mtime; } catch (e) { /* ما فيه بعد */ }
      return out;
    },

    async restoreBackup(which) {
      try {
        const res = await Filesystem.readFile({ path: `backups/backup_${which}.json`, directory: DIR_DATA, encoding: 'utf8' });
        return { ok: true, data: JSON.parse(res.data) };
      } catch (e) {
        return { ok: false, error: String(e) };
      }
    },

    // ما نحتاجه بالأندرويد: مجلد ثابت + زر "تصدير ملف" اليدوي (فوق) يغطي
    // حاجة "احفظه وين أحب" وقت ما المستخدم يبيها بنفسه
    async pickBackupFolder() { return { ok: false, unsupported: true }; },

    async newId() { return cuid(); },
    async deviceId() { return getOrCreateDeviceId(); },

    // نكتب الملف مؤقتًا ثم نفتح نافذة المشاركة الأندرويد — المستخدم يختار وين
    // يحفظه (Drive، تطبيق الملفات، إلخ) بدل صلاحيات تخزين معقّدة
    async exportToFile(data) {
      try {
        const filename = `rdflow-نسخة-${Date.now()}.json`;
        const w = await Filesystem.writeFile({ path: filename, directory: DIR_CACHE, data: JSON.stringify(data, null, 2), encoding: 'utf8' });
        await Share.share({ title: 'نسخة من البيانات', url: w.uri, dialogTitle: 'احفظ أو شارك ملف البيانات' });
        return { ok: true, filePath: 'تمت المشاركة (اخترت الوجهة بنفسك)' };
      } catch (e) {
        return { ok: false, error: String(e) };
      }
    },

    // نستخدم <input type="file"> عادي بدل أي إضافة خاصة — يشتغل داخل واجهة
    // Capacitor نفسها ويفتح منتقي ملفات أندرويد الحقيقي
    async importFromFile() {
      return new Promise((resolve) => {
        const input = document.createElement('input');
        input.type = 'file';
        input.accept = 'application/json';
        input.style.display = 'none';
        input.addEventListener('change', () => {
          const file = input.files && input.files[0];
          if (!file) { resolve({ ok: false }); document.body.removeChild(input); return; }
          const reader = new FileReader();
          reader.onload = () => {
            try {
              const parsed = JSON.parse(reader.result);
              resolve({ ok: true, data: parsed });
            } catch (e) {
              resolve({ ok: false, error: 'الملف تالف أو غير صالح' });
            }
            document.body.removeChild(input);
          };
          reader.onerror = () => { resolve({ ok: false, error: 'تعذّرت قراءة الملف' }); document.body.removeChild(input); };
          reader.readAsText(file);
        });
        document.body.appendChild(input);
        input.click();
      });
    },

    async notify(title, body, navigateTo) {
      try {
        const perm = await LocalNotifications.requestPermissions();
        if (perm.display !== 'granted') return { ok: false };
        const id = Date.now() % 2147483647;
        await LocalNotifications.schedule({
          notifications: [{
            id, title: title || 'RD Flow', body: body || '',
            schedule: { at: new Date(Date.now() + 300) },
            extra: navigateTo ? { navigateTo } : undefined
          }]
        });
        return { ok: true };
      } catch (e) {
        return { ok: false, error: String(e) };
      }
    },

    onNavigate(cb) {
      _navigateCb = cb;
      if (_notifListenerBound || !LocalNotifications) return;
      _notifListenerBound = true;
      LocalNotifications.addListener('localNotificationActionPerformed', (action) => {
        const view = action && action.notification && action.notification.extra && action.notification.extra.navigateTo;
        if (view && _navigateCb) _navigateCb(view);
      });
    },

    // بدون مكتبة PDF موحّدة (حسب القرار المتفق عليه): نكتب التقرير كملف HTML
    // ونفتح مشاركة أندرويد — المستخدم يفتحه بأي متصفح ويسوي "طباعة ← حفظ كـ PDF".
    // هذا أبسط طريق مضمون بدون إضافة native plugin جديد يحتاج اختبار إضافي.
    async exportPDF(html, suggestedName) {
      try {
        const filename = (suggestedName || `تقرير-${Date.now()}.pdf`).replace(/\.pdf$/i, '.html');
        const w = await Filesystem.writeFile({ path: filename, directory: DIR_CACHE, data: html, encoding: 'utf8' });
        await Share.share({ title: suggestedName || 'تقرير', url: w.uri, dialogTitle: 'افتح بالمتصفح ثم اختر "طباعة ← حفظ كـ PDF"' });
        return { ok: true, filePath: 'شارك كملف HTML — احفظه PDF من قائمة الطباعة بالمتصفح' };
      } catch (e) {
        return { ok: false, error: String(e) };
      }
    },

    async exportPDFBatch(items) {
      const saved = [];
      for (const item of items) {
        const res = await this.exportPDF(item.html, item.filename);
        if (res.ok) saved.push(item.filename || 'تقرير');
      }
      return { ok: saved.length > 0, dir: 'شُوركت كل ملف على حدة', saved };
    },

    // نفس منطق main.js بالضبط لكل مزوّد، فقط منقول لـ fetch من المتصفح مباشرة.
    // ⚠️ بعض المزوّدين (خصوصًا Google) ممكن يرفض الطلب بسبب CORS من داخل
    // WebView — إذا صار كذا، الحل يكون عبر سيرفر وسيط بسيط (تصلح فيه لاحقًا
    // طبقة المزامنة نفسها كنقطة تمرير). اختبر هذا الجزء أول شي على جهاز حقيقي.
    async aiChat(providers, prompt) {
      async function callAnthropic(p) {
        const res = await fetch('https://api.anthropic.com/v1/messages', {
          method: 'POST',
          headers: { 'x-api-key': p.apiKey, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
          body: JSON.stringify({ model: p.model || 'claude-sonnet-5', max_tokens: 1024, messages: [{ role: 'user', content: prompt }] })
        });
        const data = await res.json();
        if (!res.ok) throw new Error((data && data.error && data.error.message) || `HTTP ${res.status}`);
        return (data.content || []).map(c => c.text || '').join('\n').trim();
      }
      async function callOpenAI(p) {
        const res = await fetch('https://api.openai.com/v1/chat/completions', {
          method: 'POST', headers: { Authorization: `Bearer ${p.apiKey}`, 'content-type': 'application/json' },
          body: JSON.stringify({ model: p.model || 'gpt-4o-mini', messages: [{ role: 'user', content: prompt }] })
        });
        const data = await res.json();
        if (!res.ok) throw new Error((data && data.error && data.error.message) || `HTTP ${res.status}`);
        return (data.choices && data.choices[0] && data.choices[0].message && data.choices[0].message.content || '').trim();
      }
      async function callGoogle(p) {
        const model = p.model || 'gemini-flash-latest';
        const res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent?key=${encodeURIComponent(p.apiKey)}`, {
          method: 'POST', headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ contents: [{ parts: [{ text: prompt }] }] })
        });
        const data = await res.json();
        if (!res.ok) throw new Error((data && data.error && data.error.message) || `HTTP ${res.status}`);
        const parts = (data.candidates && data.candidates[0] && data.candidates[0].content && data.candidates[0].content.parts) || [];
        return parts.map(pt => pt.text || '').join('\n').trim();
      }
      async function callCustom(p) {
        if (!p.endpoint) throw new Error('لا يوجد رابط API للنموذج المخصّص');
        const res = await fetch(p.endpoint, {
          method: 'POST', headers: { Authorization: `Bearer ${p.apiKey}`, 'content-type': 'application/json' },
          body: JSON.stringify({ model: p.model || 'default', messages: [{ role: 'user', content: prompt }] })
        });
        const data = await res.json();
        if (!res.ok) throw new Error((data && data.error && data.error.message) || `HTTP ${res.status}`);
        return (data.choices && data.choices[0] && data.choices[0].message && data.choices[0].message.content || '').trim();
      }
      const failed = [];
      for (const p of (providers || [])) {
        try {
          let text;
          if (p.provider === 'anthropic') text = await callAnthropic(p);
          else if (p.provider === 'openai') text = await callOpenAI(p);
          else if (p.provider === 'google') text = await callGoogle(p);
          else text = await callCustom(p);
          if (text) return { ok: true, text, usedId: p.id, failed };
          failed.push({ id: p.id, error: 'رد فارغ من النموذج' });
        } catch (e) {
          failed.push({ id: p.id, error: String((e && e.message) || e) });
        }
      }
      return { ok: false, failed };
    },
    // ---------- تحديث أندرويد: أفضل ما يمكن بدون متجر تطبيقات ----------
    // لا يوجد "تحديث صامت" حقيقي ممكن خارج Google Play إطلاقًا (قيود أندرويد
    // الأمنية)، لكن هذا أقرب ما يمكن: يفتح رابط ملف الـAPK مباشرة بمدير التنزيلات
    // الافتراضي بالجهاز (بدل فتح صفحة الموقع كاملة)، فيبدأ التنزيل تلقائيًا،
    // وبمجرد اكتمل يظهر إشعار "تثبيت" جاهز من نظام أندرويد نفسه — ضغطة واحدة
    // فقط، تمامًا كأي تطبيق يُوزَّع خارج المتجر (F-Droid وغيره)
    updater: {
      downloadApk: (url) => { try { window.open(url, '_system'); return true; } catch (e) { try { location.href = url; return true; } catch (e2) { return false; } } }
    }
  };
})();
