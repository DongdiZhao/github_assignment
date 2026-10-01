'use strict';

/* ================= 数据准备 ================= */
const WORDS = [];
const GROUPS = []; // {key, cat, catName, name, words:[]}
VOCAB.forEach(cat => {
  cat.groups.forEach((g, gi) => {
    const key = `${cat.id}:${gi}`;
    const grp = { key, cat: cat.id, catName: cat.name, name: g.name, words: [] };
    g.words.forEach(([en, ipa, zh, ex, exZh]) => {
      const w = { id: en.toLowerCase(), en, ipa, zh, ex, exZh, cat: cat.id, catName: cat.name, group: g.name, gkey: key };
      WORDS.push(w);
      grp.words.push(w);
    });
    GROUPS.push(grp);
  });
});
const WORD_BY_ID = Object.fromEntries(WORDS.map(w => [w.id, w]));
const GROUP_BY_KEY = Object.fromEntries(GROUPS.map(g => [g.key, g]));

/* ================= 存储 ================= */
const STORE_KEY = 'nutrition_vocab_v1';
const DAY = 86400000;
const INTERVAL_DAYS = [0, 1, 2, 4, 7, 15, 30]; // 记忆盒子对应的复习间隔
const MASTER_BOX = 4;

function defaultState() {
  return {
    scope: GROUPS.map(g => g.key),
    words: {},
    history: [],
    daily: {},
    settings: { rate: 0.9, accent: 'en-US', enVoice: '', zhVoice: '', autoSpeak: true, learnOrder: 'smart' },
    voice: { mode: 'listen', repeat: 1, spell: false, example: true, exampleZh: true, count: 20, source: 'smart', think: 5 },
    quiz: { count: 20, types: ['en2zh', 'zh2en', 'listen', 'spell', 'blank'], source: 'all' },
  };
}
function loadState() {
  const d = defaultState();
  try {
    const raw = JSON.parse(localStorage.getItem(STORE_KEY) || 'null');
    if (!raw) return d;
    return {
      ...d, ...raw,
      settings: { ...d.settings, ...raw.settings },
      voice: { ...d.voice, ...raw.voice },
      quiz: { ...d.quiz, ...raw.quiz },
      scope: (raw.scope || d.scope).filter(k => GROUP_BY_KEY[k]),
    };
  } catch (e) {
    return d;
  }
}
let S = loadState();
if (!S.scope.length) S.scope = defaultState().scope;
function save() {
  try { localStorage.setItem(STORE_KEY, JSON.stringify(S)); } catch (e) { toast('保存失败：存储空间不足'); }
}

/* ================= 工具函数 ================= */
const $ = sel => document.querySelector(sel);
const esc = s => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const shuffle = arr => { const a = arr.slice(); for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; } return a; };
const pick = arr => arr[Math.floor(Math.random() * arr.length)];
const todayKey = (t = Date.now()) => { const d = new Date(t); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; };
const fmtTime = t => { const d = new Date(t); return `${d.getMonth() + 1}/${d.getDate()} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`; };

function toast(msg, ms = 2000) {
  const el = $('#toast');
  el.textContent = msg;
  el.classList.remove('hidden');
  clearTimeout(toast.t);
  toast.t = setTimeout(() => el.classList.add('hidden'), ms);
}

function levenshtein(a, b) {
  const m = a.length, n = b.length;
  if (!m) return n; if (!n) return m;
  let prev = Array.from({ length: n + 1 }, (_, i) => i);
  for (let i = 1; i <= m; i++) {
    const cur = [i];
    for (let j = 1; j <= n; j++) {
      cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    }
    prev = cur;
  }
  return prev[n];
}
const similarity = (a, b) => 1 - levenshtein(a, b) / Math.max(a.length, b.length, 1);

// 在例句中定位单词（兼容复数、时态等变化）
function wordRegex(en) {
  let base = en.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  if (/y$/i.test(en)) base = base.slice(0, -1) + '(?:y|ies)';
  return new RegExp('\\b' + base + '(?:s|es|ed|ing|d)?\\b', 'i');
}
function highlight(sentence, en) {
  const re = wordRegex(en);
  const m = sentence.match(re);
  if (!m) return esc(sentence);
  const i = m.index;
  return esc(sentence.slice(0, i)) + '<mark>' + esc(m[0]) + '</mark>' + esc(sentence.slice(i + m[0].length));
}
function blankOut(sentence, en) {
  const re = wordRegex(en);
  if (!re.test(sentence)) return null;
  return esc(sentence.replace(re, '\u0000')).replace('\u0000', '<b>_______</b>');
}

/* ================= 学习进度 ================= */
function prog(w, create) {
  let r = S.words[w.id];
  if (!r && create) r = S.words[w.id] = { box: 0, due: 0, seen: 0, right: 0, wrong: 0, streak: 0, wb: false, last: 0 };
  return r || { box: 0, due: 0, seen: 0, right: 0, wrong: 0, streak: 0, wb: false, last: 0 };
}
function status(w) {
  const r = prog(w);
  if (!r.seen) return 'new';
  return r.box >= MASTER_BOX ? 'mastered' : 'learning';
}
function bumpDaily(field, n = 1) {
  const k = todayKey();
  const d = S.daily[k] || (S.daily[k] = { learned: 0, reviewed: 0, quiz: 0, listened: 0 });
  d[field] = (d[field] || 0) + n;
}
function grade(w, ok) {
  const r = prog(w, true);
  const now = Date.now();
  if (!r.seen) bumpDaily('learned');
  r.seen++;
  r.last = now;
  if (ok) {
    r.right++;
    r.streak++;
    r.box = Math.min(r.box + 1, INTERVAL_DAYS.length - 1);
    if (r.wb && r.streak >= 2) r.wb = false; // 连续答对两次移出错题本
  } else {
    r.wrong++;
    r.streak = 0;
    r.box = r.box >= 3 ? 1 : 0;
    r.wb = true;
  }
  r.due = now + (r.box === 0 ? 5 * 60000 : INTERVAL_DAYS[r.box] * DAY);
  bumpDaily('reviewed');
  save();
}
function markSeen(w) {
  const r = prog(w, true);
  if (!r.seen) { bumpDaily('learned'); r.due = Date.now(); }
  r.seen++;
  r.last = Date.now();
  bumpDaily('listened');
  save();
}
const isDue = w => { const r = prog(w); return r.seen > 0 && r.due <= Date.now(); };

function scopeWords() {
  const set = new Set(S.scope);
  return WORDS.filter(w => set.has(w.gkey));
}
function scopeLabel() {
  const set = new Set(S.scope);
  const n = scopeWords().length;
  if (set.size === GROUPS.length) return `全部板块 · ${n}词`;
  const fullCats = VOCAB.filter(c => GROUPS.filter(g => g.cat === c.id).every(g => set.has(g.key)));
  const fullKeys = new Set(GROUPS.filter(g => fullCats.some(c => c.id === g.cat)).map(g => g.key));
  const parts = fullCats.map(c => c.name).concat(S.scope.filter(k => !fullKeys.has(k)).map(k => GROUP_BY_KEY[k].name));
  return `${parts.join('、')} · ${n}词`;
}

// 智能排序：先到期复习，再新词，再其他（按熟练度从低到高）
function smartQueue(words) {
  const now = Date.now();
  const due = [], fresh = [], rest = [];
  words.forEach(w => {
    const r = prog(w);
    if (!r.seen) fresh.push(w);
    else if (r.due <= now) due.push(w);
    else rest.push(w);
  });
  due.sort((a, b) => prog(a).due - prog(b).due);
  rest.sort((a, b) => prog(a).box - prog(b).box || prog(a).due - prog(b).due);
  return [...due, ...fresh, ...rest];
}
// 加权随机抽样：错得多、不熟、到期的词更容易被抽到，但每次都不同
function weightedSample(words, n) {
  return words.map(w => {
    const r = prog(w);
    let weight = 1;
    if (r.wb) weight += 3;
    weight += Math.min(r.wrong, 5) * 0.5;
    weight += r.seen ? (6 - r.box) * 0.4 : 1;
    if (isDue(w)) weight += 1;
    return { w, k: Math.pow(Math.random(), 1 / weight) };
  }).sort((a, b) => b.k - a.k).slice(0, n).map(x => x.w);
}

/* ================= 语音合成（TTS） ================= */
const hasTTS = 'speechSynthesis' in window;
let voices = [];
function loadVoices() { if (hasTTS) voices = speechSynthesis.getVoices(); }
if (hasTTS) { loadVoices(); speechSynthesis.onvoiceschanged = loadVoices; }
const EN = () => S.settings.accent;
const ZH = 'zh-CN';
function pickVoice(lang) {
  const pref = lang.startsWith('en') ? S.settings.enVoice : S.settings.zhVoice;
  const norm = v => v.lang.replace('_', '-');
  return voices.find(v => v.voiceURI === pref && norm(v).slice(0, 2) === lang.slice(0, 2)) ||
    voices.find(v => norm(v) === lang && v.localService) ||
    voices.find(v => norm(v) === lang) ||
    voices.find(v => norm(v).startsWith(lang.slice(0, 2)));
}
function speak(text, lang, rateMul = 1) {
  return new Promise(resolve => {
    if (!hasTTS || !text) return resolve();
    const u = new SpeechSynthesisUtterance(text);
    u.lang = lang;
    const v = pickVoice(lang);
    if (v) u.voice = v;
    u.rate = Math.max(0.4, Math.min(2, S.settings.rate * rateMul));
    let done = false;
    const fin = () => { if (!done) { done = true; clearTimeout(t); resolve(); } };
    u.onend = fin;
    u.onerror = fin;
    // 部分浏览器不触发 onend，用估算时长兜底
    const est = 1500 + text.length * (lang.startsWith('zh') ? 330 : 95) / u.rate;
    const t = setTimeout(fin, est + 3000);
    speechSynthesis.speak(u);
  });
}
function speakNow(text, lang, rateMul) {
  if (!hasTTS) { toast('当前浏览器不支持语音播报'); return Promise.resolve(); }
  speechSynthesis.cancel();
  return speak(text, lang, rateMul);
}
const spellOut = en => en.toUpperCase().replace(/[^A-Z0-9]/g, ' ').split('').filter(c => c !== ' ').join(', ');

/* ================= 语音识别 ================= */
const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
const hasSR = !!SR;
const normEn = s => s.toLowerCase().replace(/[^a-z0-9]/g, '');
function matchEn(texts, en) {
  const target = normEn(en);
  return texts.some(t => {
    const n = normEn(t);
    if (!n) return false;
    if (n === target || n.includes(target)) return true;
    if (similarity(n, target) >= 0.75) return true;
    // 逐段比较：识别结果里可能带有其他词
    const parts = t.toLowerCase().split(/\s+/);
    const len = en.split(/\s+/).length;
    for (let i = 0; i + len <= parts.length; i++) {
      if (similarity(normEn(parts.slice(i, i + len).join('')), target) >= 0.8) return true;
    }
    return false;
  });
}
function zhKeys(zh) {
  const keys = zh.split(/[；;，,、（）()“”"\s/]+/).map(s => s.trim()).filter(Boolean);
  // 单字关键词只有在它是主释义时才有效（如“钙”“铁”），避免“坏”“A”之类误判
  return keys.filter((k, i) => i === 0 || k.replace(/[^一-龥A-Za-z0-9]/g, '').length >= 2);
}
function matchZh(texts, zh) {
  const keys = zhKeys(zh);
  return texts.some(t => {
    const n = t.replace(/[\s，。,.!?！？、]/g, '').toLowerCase();
    if (!n) return false;
    return keys.some(k0 => {
      const k = k0.toLowerCase().replace(/[^一-龥a-z0-9]/g, '');
      if (!k) return false;
      if (n.includes(k)) return true;
      if (k.length >= 2) {
        let hit = 0;
        for (const ch of k) if (n.includes(ch)) hit++;
        if (hit / k.length >= 0.67 && n.length <= k.length * 2 + 4) return true;
      }
      return false;
    });
  });
}
function detectCommand(texts) {
  const t = texts.join(' ').toLowerCase();
  if (/停止|结束|退出|\bstop\b/.test(t)) return 'stop';
  if (/暂停|\bpause\b/.test(t)) return 'pause';
  if (/重复|再说|再读|再来一遍|\brepeat\b|\bagain\b/.test(t)) return 'repeat';
  if (/下一个|跳过|\bnext\b|\bskip\b/.test(t)) return 'skip';
  if (/不知道|不会|忘了|不记得|don'?t know|no idea|\bpass\b/.test(t)) return 'dunno';
  return null;
}

/* ================= 视图路由 ================= */
let currentTab = 'learn';
document.querySelectorAll('.tabbar button').forEach(b => {
  b.addEventListener('click', () => switchTab(b.dataset.tab));
});
function switchTab(tab) {
  if (VS && VS.running && tab !== 'voice') {
    stopVoice();
    toast('已结束语音学习');
  }
  currentTab = tab;
  document.querySelectorAll('.tabbar button').forEach(b => b.classList.toggle('active', b.dataset.tab === tab));
  if (hasTTS) speechSynthesis.cancel();
  render();
  window.scrollTo(0, 0);
}
function render() {
  ({ learn: renderLearn, voice: renderVoice, quiz: renderQuiz, stats: renderStats })[currentTab]();
}
function scopeBar() {
  return `<div class="scope-bar"><span class="label">📚 ${esc(scopeLabel())}</span><button class="chip" data-act="scope">选择范围</button></div>`;
}
document.addEventListener('click', e => {
  const t = e.target.closest('[data-act="scope"]');
  if (t) openScope();
  const sp = e.target.closest('[data-say]');
  if (sp) {
    const w = WORD_BY_ID[sp.dataset.id];
    const kind = sp.dataset.say;
    if (kind === 'word') speakNow(w.en, EN());
    if (kind === 'slow') speakNow(w.en, EN(), 0.6);
    if (kind === 'zh') speakNow(w.zh, ZH);
    if (kind === 'ex') speakNow(w.ex, EN());
    if (kind === 'exzh') speakNow(w.exZh, ZH);
  }
  const wd = e.target.closest('[data-word]');
  if (wd && !sp) openWord(WORD_BY_ID[wd.dataset.word]);
});

/* ================= 弹窗 ================= */
function openModal(html) {
  $('#modalCard').innerHTML = html;
  $('#modal').classList.remove('hidden');
}
function closeModal() { $('#modal').classList.add('hidden'); }
$('#modal').addEventListener('click', e => { if (e.target.id === 'modal' || e.target.closest('[data-close]')) closeModal(); });

function openScope() {
  const sel = new Set(S.scope);
  const draw = () => {
    openModal(`<h2>选择学习范围</h2>
      <p class="muted small">点板块名可整体选择 / 取消，也可以只选其中的主题。</p>
      ${VOCAB.map(c => {
        const gs = GROUPS.filter(g => g.cat === c.id);
        const all = gs.every(g => sel.has(g.key));
        const cnt = gs.reduce((s, g) => s + g.words.length, 0);
        return `<div class="cat-block">
          <div class="cat-head"><span>${c.icon} ${esc(c.name)} <span class="muted small">${cnt}词</span></span>
            <button class="chip ${all ? 'on' : ''}" data-cat="${c.id}">${all ? '✓ 全选' : '全选'}</button></div>
          <div class="muted small">${esc(c.desc)}</div>
          <div class="groups">${gs.map(g => `<button class="chip ${sel.has(g.key) ? 'on' : ''}" data-g="${g.key}">${esc(g.name)} ${g.words.length}</button>`).join('')}</div>
        </div>`;
      }).join('')}
      <div class="row" style="margin-top:12px">
        <button class="btn ghost" id="scAll">全部</button>
        <button class="btn ghost" id="scNone">清空</button>
        <button class="btn grow" id="scOk">确定（${GROUPS.filter(g => sel.has(g.key)).reduce((s, g) => s + g.words.length, 0)}词）</button>
      </div>`);
    const card = $('#modalCard');
    card.querySelectorAll('[data-g]').forEach(b => b.onclick = () => { sel.has(b.dataset.g) ? sel.delete(b.dataset.g) : sel.add(b.dataset.g); draw(); });
    card.querySelectorAll('[data-cat]').forEach(b => b.onclick = () => {
      const gs = GROUPS.filter(g => g.cat === b.dataset.cat);
      const all = gs.every(g => sel.has(g.key));
      gs.forEach(g => all ? sel.delete(g.key) : sel.add(g.key));
      draw();
    });
    $('#scAll').onclick = () => { GROUPS.forEach(g => sel.add(g.key)); draw(); };
    $('#scNone').onclick = () => { sel.clear(); draw(); };
    $('#scOk').onclick = () => {
      if (!sel.size) return toast('请至少选择一个主题');
      S.scope = GROUPS.map(g => g.key).filter(k => sel.has(k));
      save();
      learnSess = null;
      closeModal();
      render();
    };
  };
  draw();
}

function wordCardHtml(w, { hideZh = false } = {}) {
  const st = status(w);
  const stTxt = { new: '🆕 新词', learning: '🟠 学习中', mastered: '🟢 已掌握' }[st];
  return `<div class="card word-card">
    <div class="tag">${esc(w.catName)} · ${esc(w.group)}</div>
    <div class="status">${stTxt}</div>
    <div class="en" style="margin-top:14px">${esc(w.en)}</div>
    <div class="ipa">${esc(w.ipa)}</div>
    <div class="speak-row">
      <button class="speak-btn" data-say="word" data-id="${esc(w.id)}">🔊 发音</button>
      <button class="speak-btn" data-say="slow" data-id="${esc(w.id)}">🐢 慢速</button>
    </div>
    <div class="zh-wrap">
      ${hideZh
        ? `<button class="btn secondary reveal-btn" id="revealBtn">👀 显示释义和例句</button>`
        : `<div class="zh">${esc(w.zh)}</div>
          <div class="example">
            <div class="s-en">${highlight(w.ex, w.en)}</div>
            <div class="s-zh">${esc(w.exZh)}</div>
            <div class="speak-row" style="justify-content:flex-start">
              <button class="speak-btn" data-say="ex" data-id="${esc(w.id)}">🔊 读例句</button>
              <button class="speak-btn" data-say="exzh" data-id="${esc(w.id)}">🔊 中文</button>
            </div>
          </div>`}
    </div>
  </div>`;
}
function openWord(w) {
  const r = prog(w);
  openModal(`${wordCardHtml(w)}
    <p class="muted small center">学习 ${r.seen} 次 · 答对 ${r.right} · 答错 ${r.wrong}${r.wb ? ' · 在错题本中' : ''}</p>
    <button class="btn block secondary" data-close>关闭</button>`);
}

/* ================= 学习页 ================= */
let learnSess = null;
let learnView = 'card';
function buildLearnSession() {
  const words = scopeWords();
  const queue = S.settings.learnOrder === 'random' ? shuffle(words) : smartQueue(words);
  learnSess = { queue, i: 0, done: 0, revealed: false };
}
function renderLearn() {
  if (!learnSess) buildLearnSession();
  const words = scopeWords();
  const mastered = words.filter(w => status(w) === 'mastered').length;
  const learning = words.filter(w => status(w) === 'learning').length;
  const due = words.filter(isDue).length;
  const pm = words.length ? mastered / words.length * 100 : 0;
  const pl = words.length ? learning / words.length * 100 : 0;
  let html = scopeBar() + `<div class="card">
      <div class="row spread small"><span>已掌握 <b>${mastered}</b> · 学习中 <b>${learning}</b> · 待复习 <b style="color:var(--accent)">${due}</b></span>
      <span class="muted">共 ${words.length}</span></div>
      <div class="progress" style="margin-top:8px"><div class="p-master" style="width:${pm}%"></div><div class="p-learn" style="width:${pl}%"></div></div>
    </div>
    <div class="row" style="margin-bottom:12px">
      <div class="seg"><button data-lv="card" class="${learnView === 'card' ? 'on' : ''}">单词卡</button><button data-lv="list" class="${learnView === 'list' ? 'on' : ''}">词表</button></div>
      <span class="grow"></span>
      ${learnView === 'card' ? `<div class="seg"><button data-lo="smart" class="${S.settings.learnOrder === 'smart' ? 'on' : ''}">智能</button><button data-lo="random" class="${S.settings.learnOrder === 'random' ? 'on' : ''}">随机</button></div>` : ''}
    </div>`;
  if (learnView === 'list') {
    html += `<input class="search" id="search" placeholder="搜索英文或中文…" autocomplete="off">
      <div class="card" style="margin-top:12px"><ul class="word-list" id="wlist"></ul></div>`;
    $('#view').innerHTML = html;
    const draw = q => {
      q = (q || '').trim().toLowerCase();
      const list = words.filter(w => !q || w.en.toLowerCase().includes(q) || w.zh.includes(q));
      $('#wlist').innerHTML = list.map(w => `<li data-word="${esc(w.id)}">
          <span class="dot ${status(w)}"></span>
          <div class="grow"><div class="w">${esc(w.en)} <span class="muted small">${esc(w.ipa)}</span></div><div class="m">${esc(w.zh)}</div></div>
          <button class="speak-btn" data-say="word" data-id="${esc(w.id)}">🔊</button></li>`).join('') || '<li class="muted">没有找到</li>';
    };
    draw('');
    $('#search').addEventListener('input', e => draw(e.target.value));
  } else {
    const s = learnSess;
    if (s.i >= s.queue.length) {
      html += `<div class="card center"><h2>🎉 本轮学完了！</h2><p class="muted">这一轮你过了 ${s.done} 个单词。去测试一下记住了多少吧。</p>
        <div class="row"><button class="btn secondary grow" id="again">再学一轮</button><button class="btn grow" id="goQuiz">去测试</button></div></div>`;
      $('#view').innerHTML = html;
      $('#again').onclick = () => { buildLearnSession(); render(); };
      $('#goQuiz').onclick = () => switchTab('quiz');
    } else {
      const w = s.queue[s.i];
      const hide = prog(w).seen > 0 && !s.revealed;
      html += `<div class="muted small center" style="margin-bottom:6px">第 ${s.i + 1} / ${s.queue.length} 个${isDue(w) ? ' · 复习' : prog(w).seen ? '' : ' · 新词'}</div>`
        + wordCardHtml(w, { hideZh: hide })
        + (s.graded
          ? `<button class="btn block" id="gCont">继续 →</button>`
          : `<div class="grade-row"><button class="btn dunno" id="gNo">✗ 不认识</button><button class="btn know" id="gYes">✓ 认识</button></div>`)
        + `
        <div class="row" style="margin-top:10px"><button class="btn ghost grow" id="prev" ${s.i ? '' : 'disabled'}>← 上一个</button><button class="btn ghost grow" id="next">跳过 →</button></div>`;
      $('#view').innerHTML = html;
      if (hide) $('#revealBtn').onclick = () => { s.revealed = true; render(); };
      const advance = () => { s.i++; s.revealed = false; s.graded = false; render(); };
      if (s.graded) $('#gCont').onclick = advance;
      else {
        $('#gYes').onclick = () => { grade(w, true); s.done++; advance(); };
        $('#gNo').onclick = () => {
          grade(w, false); s.done++;
          // 不认识的词稍后在本轮再出现一次
          const pos = Math.min(s.queue.length, s.i + 4 + Math.floor(Math.random() * 3));
          if (s.queue.indexOf(w, s.i + 1) === -1) s.queue.splice(pos, 0, w);
          if (hide) { s.revealed = true; s.graded = true; render(); return; }
          advance();
        };
      }
      $('#next').onclick = advance;
      $('#prev').onclick = () => { s.i = Math.max(0, s.i - 1); s.revealed = false; s.graded = false; render(); };
      if (S.settings.autoSpeak && !s.spoken?.has(s.i)) {
        (s.spoken = s.spoken || new Set()).add(s.i);
        speakNow(w.en, EN());
      }
    }
  }
  document.querySelectorAll('[data-lv]').forEach(b => b.onclick = () => { learnView = b.dataset.lv; render(); });
  document.querySelectorAll('[data-lo]').forEach(b => b.onclick = () => { S.settings.learnOrder = b.dataset.lo; save(); buildLearnSession(); render(); });
}

/* ================= 语音学习 ================= */
const VOICE_MODES = [
  { id: 'listen', title: '🎧 纯听模式', desc: '自动连续播报：单词 → 中文释义 → 例句。适合走路、通勤、做家务时被动输入。', sr: false },
  { id: 'repeat', title: '🗣️ 跟读模式', desc: '播报单词后你跟着读，App 识别你的发音是否被听懂，读不准会放慢再示范。', sr: true },
  { id: 'en2zh', title: '💬 英译中问答', desc: 'App 读英文单词，你用中文说出意思，App 判断对错并讲解。', sr: true },
  { id: 'zh2en', title: '💬 中译英问答', desc: 'App 读中文释义，你说出英文单词，答错会告诉你正确读法和拼写。', sr: true },
];
let VS = null; // 当前语音会话
const INTERRUPT = { interrupt: true };
let audioCtx = null;
function beep(freq = 880, ms = 140) {
  try {
    audioCtx = audioCtx || new (window.AudioContext || window.webkitAudioContext)();
    const o = audioCtx.createOscillator(), g = audioCtx.createGain();
    o.frequency.value = freq;
    g.gain.setValueAtTime(0.15, audioCtx.currentTime);
    g.gain.exponentialRampToValueAtTime(0.001, audioCtx.currentTime + ms / 1000);
    o.connect(g).connect(audioCtx.destination);
    o.start(); o.stop(audioCtx.currentTime + ms / 1000);
  } catch (e) { /* 忽略 */ }
  return new Promise(r => setTimeout(r, ms + 60));
}

function renderVoice() {
  if (VS && (VS.running || VS.summary)) return renderLive();
  const v = S.voice;
  const seg = (key, opts) => `<div class="seg">${opts.map(([val, label]) => `<button data-v="${key}" data-val="${val}" class="${String(v[key]) === String(val) ? 'on' : ''}">${label}</button>`).join('')}</div>`;
  const tog = key => `<input type="checkbox" class="switch" data-vt="${key}" ${v[key] ? 'checked' : ''}>`;
  const mode = VOICE_MODES.find(m => m.id === v.mode);
  const wbCount = WORDS.filter(w => prog(w).wb).length;
  $('#view').innerHTML = scopeBar()
    + (!hasTTS ? `<div class="notice">⚠️ 当前浏览器不支持语音播报，请使用手机自带的 Safari（iPhone）或 Chrome（安卓）打开。</div>` : '')
    + (!hasSR ? `<div class="notice">ℹ️ 当前浏览器不支持语音识别，问答模式会改为“思考 ${v.think} 秒后公布答案”。安卓 Chrome、iPhone Safari 一般都支持识别。</div>` : '')
    + `<div class="card"><h2>选择模式</h2><div class="mode-list">
      ${VOICE_MODES.map(m => `<button class="mode ${m.id === v.mode ? 'on' : ''}" data-mode="${m.id}"><b>${m.title}</b><span>${m.desc}</span></button>`).join('')}
    </div></div>
    <div class="card"><h2>设置</h2>
      <div class="opt-row"><span>单词来源</span>${seg('source', [['smart', '智能'], ['random', '随机'], ['wrong', `错题本(${wbCount})`]])}</div>
      <div class="opt-row"><span>本轮数量</span>${seg('count', [[10, '10'], [20, '20'], [30, '30'], [0, '全部']])}</div>
      ${v.mode === 'listen' ? `<div class="opt-row"><span>每词重复</span>${seg('repeat', [[1, '1遍'], [2, '2遍'], [3, '3遍']])}</div>` : ''}
      ${(v.mode === 'listen' || v.mode === 'zh2en') ? `<div class="opt-row"><span>播报字母拼写</span>${tog('spell')}</div>` : ''}
      <div class="opt-row"><span>播报例句</span>${tog('example')}</div>
      <div class="opt-row"><span>例句后读中文翻译</span>${tog('exampleZh')}</div>
      ${(!hasSR && mode.sr) ? `<div class="opt-row"><span>思考时间</span>${seg('think', [[3, '3秒'], [5, '5秒'], [8, '8秒']])}</div>` : ''}
    </div>
    <button class="btn block big" id="vStart">▶ 开始</button>
    <p class="muted small" style="margin-top:12px">💡 学习过程中可以直接说语音指令：<b>“重复”</b>、<b>“下一个”</b>、<b>“不知道”</b>、<b>“暂停”</b>、<b>“停止”</b>（中译英模式请说英文：repeat / next / I don't know / pause / stop）。<br>
    💡 学习期间会尽量保持屏幕常亮；锁屏后浏览器会暂停播报，建议把手机放在口袋里时不要锁屏，或调低亮度。</p>`;
  document.querySelectorAll('[data-mode]').forEach(b => b.onclick = () => { v.mode = b.dataset.mode; save(); render(); });
  document.querySelectorAll('[data-v]').forEach(b => b.onclick = () => {
    const val = b.dataset.val;
    v[b.dataset.v] = /^\d+$/.test(val) ? +val : val;
    save(); render();
  });
  document.querySelectorAll('[data-vt]').forEach(b => b.onchange = () => { v[b.dataset.vt] = b.checked; save(); });
  $('#vStart').onclick = startVoice;
}

function pickVoiceWords() {
  const v = S.voice;
  let pool = v.source === 'wrong' ? WORDS.filter(w => prog(w).wb) : scopeWords();
  const n = v.count || pool.length;
  if (v.source === 'random' || v.source === 'wrong') return shuffle(pool).slice(0, n);
  if (v.mode === 'listen') return smartQueue(pool).slice(0, n);
  return shuffle(weightedSample(pool, n));
}

function startVoice() {
  if (!hasTTS) return toast('当前浏览器不支持语音播报');
  const list = pickVoiceWords();
  if (!list.length) return toast(S.voice.source === 'wrong' ? '错题本是空的 👍' : '没有可学习的单词');
  // iOS 需要在点击事件中同步“解锁”语音和音频
  speechSynthesis.cancel();
  const unlock = new SpeechSynthesisUtterance(' ');
  unlock.volume = 0;
  speechSynthesis.speak(unlock);
  try { audioCtx = audioCtx || new (window.AudioContext || window.webkitAudioContext)(); audioCtx.resume(); } catch (e) { /* 忽略 */ }
  VS = {
    running: true, list, i: 0, mode: S.voice.mode, interrupt: null, paused: false,
    asked: 0, correct: 0, wrong: [], silent: 0, state: '', heard: '', cancelers: new Set(), start: Date.now(),
  };
  keepAwake(true);
  render();
  runVoiceSession();
}
function stopVoice() {
  if (!VS) return;
  interrupt('stop');
  if (VS.resume) VS.resume();
}
function interrupt(action) {
  if (!VS) return;
  VS.interrupt = action;
  if (hasTTS) speechSynthesis.cancel();
  VS.cancelers.forEach(fn => fn());
}
const check = () => { if (VS.interrupt) throw INTERRUPT; };
async function say(text, lang, rateMul) {
  check();
  await speak(text, lang, rateMul);
  check();
}
function sleep(ms) {
  return new Promise(resolve => {
    const t = setTimeout(done, ms);
    function done() { clearTimeout(t); VS.cancelers.delete(done); resolve(); }
    VS.cancelers.add(done);
  }).then(check);
}
function hear(lang, ms = 7000) {
  return new Promise(resolve => {
    check();
    const rec = new SR();
    rec.lang = lang;
    rec.interimResults = true;
    rec.maxAlternatives = 5;
    rec.continuous = false;
    const finals = [];
    let interim = '', done = false;
    const fin = () => {
      if (done) return;
      done = true;
      clearTimeout(t);
      VS.cancelers.delete(fin);
      try { rec.abort(); } catch (e) { /* 忽略 */ }
      setListening(false);
      resolve(finals.length ? finals : (interim ? [interim] : []));
    };
    rec.onresult = e => {
      for (let i = e.resultIndex; i < e.results.length; i++) {
        const r = e.results[i];
        if (r.isFinal) for (let j = 0; j < r.length; j++) finals.push(r[j].transcript);
        else interim = r[0].transcript;
      }
      setHeard(finals[0] || interim);
      if (finals.length) fin();
    };
    rec.onerror = e => {
      if (e.error === 'not-allowed' || e.error === 'service-not-allowed') {
        VS.micDenied = true;
        toast('麦克风权限被拒绝，请在浏览器设置中允许使用麦克风', 4000);
      }
      fin();
    };
    rec.onend = fin;
    const t = setTimeout(fin, ms);
    VS.cancelers.add(fin);
    setHeard('');
    setListening(true);
    try { rec.start(); } catch (e) { fin(); }
  }).then(r => { check(); return r; });
}
function setState(txt) { VS.state = txt; const el = $('#lvState'); if (el) { el.textContent = txt; el.classList.remove('listening'); } }
function setListening(on) {
  const el = $('#lvState');
  if (on) { VS.state = '🎤 请说…'; if (el) { el.innerHTML = '<span class="mic-pulse"></span>请回答…'; el.classList.add('listening'); } }
  else if (el) el.classList.remove('listening');
}
function setHeard(txt) { VS.heard = txt; const el = $('#lvHeard'); if (el) el.textContent = txt ? `你说的是：“${txt}”` : ''; }
function setReveal(on) { if (VS.reveal === on) return; VS.reveal = on; if (currentTab === 'voice' && VS.running) renderLive(); }

async function askAndCheck(w, lang, matcher) {
  // 返回 true / false / null（没回答）
  for (let attempt = 0; attempt < 2; attempt++) {
    await beep();
    const heard = await hear(lang, 7000);
    if (!heard.length) {
      if (attempt === 0) { await say(lang === ZH ? '请说出中文意思' : '请说出英文单词', ZH); continue; }
      return null;
    }
    VS.silent = 0;
    if (matcher(heard)) return true;
    const cmd = detectCommand(heard);
    if (cmd === 'dunno') return false;
    if (cmd) { VS.interrupt = cmd; throw INTERRUPT; }
    return false;
  }
  return null;
}

async function runVoiceWord(w) {
  const v = S.voice;
  const mode = VS.mode;
  const example = async () => {
    if (!v.example) return;
    setState('📖 例句');
    await say(w.ex, EN());
    if (v.exampleZh) await say(w.exZh, ZH);
  };

  if (mode === 'listen') {
    for (let r = 0; r < v.repeat; r++) {
      setState('🔊 单词');
      await say(w.en, EN());
      await sleep(300);
      if (v.spell) { setState('🔤 拼写'); await say(spellOut(w.en), EN(), 0.85); await sleep(200); await say(w.en, EN()); }
      setState('🀄 释义');
      await say(w.zh, ZH);
      await example();
      await sleep(700);
    }
    markSeen(w);
    return;
  }

  if (mode === 'repeat') {
    setState('🔊 示范');
    await say(w.en, EN());
    await say(w.zh, ZH);
    if (!hasSR || VS.micDenied) {
      await say(w.en, EN(), 0.8);
      setState('🗣️ 请跟读');
      await sleep(3000);
    } else {
      let ok = false;
      for (let attempt = 0; attempt < 2 && !ok; attempt++) {
        if (attempt) { await say('再试一次', ZH); await say(w.en, EN(), 0.65); }
        await beep();
        const heard = await hear(EN(), 6000);
        if (!heard.length) { VS.silent++; break; }
        VS.silent = 0;
        if (matchEn(heard, w.en)) { ok = true; break; }
        const cmd = detectCommand(heard);
        if (cmd && cmd !== 'dunno') { VS.interrupt = cmd; throw INTERRUPT; }
      }
      VS.asked++;
      if (ok) { VS.correct++; await say('很好！', ZH); }
      else { VS.wrong.push(w.id); await say('没关系，再听一遍', ZH); await say(w.en, EN(), 0.6); }
    }
    await example();
    markSeen(w);
    await sleep(500);
    return;
  }

  // 问答模式
  const en2zh = mode === 'en2zh';
  setState(en2zh ? '🔊 这个单词是什么意思？' : '🔊 这个用英文怎么说？');
  if (en2zh) { await say(w.en, EN()); await sleep(400); await say(w.en, EN()); }
  else { await say(w.zh, ZH); }
  let result = null;
  if (hasSR && !VS.micDenied) {
    result = await askAndCheck(w, en2zh ? ZH : EN(), heard => en2zh ? matchZh(heard, w.zh) : matchEn(heard, w.en));
  } else {
    setState(`🤔 思考 ${v.think} 秒…`);
    await sleep(v.think * 1000);
  }
  setReveal(true);
  if (result === true) {
    VS.asked++; VS.correct++;
    setState('✅ 正确');
    await beep(1200, 100);
    await say('正确！', ZH);
    if (en2zh) await say(w.zh, ZH); else { await say(w.en, EN()); }
  } else {
    if (result === false) { VS.asked++; VS.wrong.push(w.id); setState('❌ 答案是'); await beep(300, 220); await say('不对哦，答案是', ZH); }
    else { setState('💡 答案是'); if (hasSR && !VS.micDenied) VS.silent++; await say('答案是', ZH); }
    if (en2zh) await say(w.zh, ZH);
    else {
      await say(w.en, EN());
      if (v.spell) await say(spellOut(w.en), EN(), 0.85);
      await say(w.en, EN(), 0.75);
    }
  }
  if (result !== null) grade(w, result); else markSeen(w);
  await example();
  await sleep(600);
}

async function runVoiceSession() {
  const s = VS;
  while (s.i < s.list.length) {
    s.reveal = s.mode === 'listen' || s.mode === 'repeat';
    s.heard = '';
    renderLive();
    try {
      await runVoiceWord(s.list[s.i]);
      s.i++;
      if (s.silent >= 3) { // 连续没有回应，自动暂停
        s.silent = 0;
        await say('好像没有听到你的回答，先暂停一下，点继续可以接着学。', ZH);
        s.interrupt = 'pause';
        throw INTERRUPT;
      }
    } catch (e) {
      if (e !== INTERRUPT) { console.error(e); s.i++; continue; }
      const a = s.interrupt;
      s.interrupt = null;
      if (a === 'stop') break;
      if (a === 'skip') s.i++;
      if (a === 'prev') s.i = Math.max(0, s.i - 1);
      if (a === 'pause') {
        s.paused = true;
        renderLive();
        await new Promise(r => { s.resume = r; });
        s.resume = null;
        s.paused = false;
        if (s.interrupt === 'stop') break;
        s.interrupt = null;
      }
    }
  }
  if (hasTTS) speechSynthesis.cancel();
  s.running = false;
  keepAwake(false);
  const isQA = s.mode !== 'listen';
  const done = Math.min(s.i, s.list.length);
  if (done > 0) {
    S.history.unshift({ t: Date.now(), kind: 'voice', mode: s.mode, scope: S.voice.source === 'wrong' ? '错题本' : scopeLabel(), total: isQA ? s.asked : done, correct: s.correct, wrong: s.wrong, dur: Date.now() - s.start });
    S.history = S.history.slice(0, 200);
    save();
  }
  s.summary = true;
  if (currentTab === 'voice') renderLive();
  if (done > 0) {
    const msg = isQA && s.asked ? `本轮结束，回答了${s.asked}个，答对${s.correct}个。` : `本轮结束，一共学习了${done}个单词。`;
    speak(msg, ZH);
  }
}

function renderLive() {
  const s = VS;
  if (s.summary) {
    const isQA = s.mode !== 'listen';
    const wrongs = [...new Set(s.wrong)].map(id => WORD_BY_ID[id]);
    $('#view').innerHTML = `<div class="card center"><h2>本轮完成 🎉</h2>
      ${isQA && s.asked ? `<div style="font-size:40px;font-weight:700">${s.correct} / ${s.asked}</div><p class="muted">答对 / 回答</p>` : `<p>共学习 ${Math.min(s.i, s.list.length)} 个单词</p>`}
      <p class="muted small">用时 ${Math.round((Date.now() - s.start) / 60000)} 分钟</p></div>
      ${wrongs.length ? `<div class="card"><h2>需要加强的词</h2><ul class="word-list">${wrongs.map(w => `<li data-word="${esc(w.id)}"><span class="dot learning"></span><div class="grow"><div class="w">${esc(w.en)}</div><div class="m">${esc(w.zh)}</div></div><button class="speak-btn" data-say="word" data-id="${esc(w.id)}">🔊</button></li>`).join('')}</ul></div>` : ''}
      <div class="row"><button class="btn secondary grow" id="vBack">返回设置</button><button class="btn grow" id="vAgain">再来一轮</button></div>`;
    $('#vBack').onclick = () => { VS = null; render(); };
    $('#vAgain').onclick = () => { VS = null; startVoice(); };
    return;
  }
  const w = s.list[Math.min(s.i, s.list.length - 1)];
  const modeInfo = VOICE_MODES.find(m => m.id === s.mode);
  const showAll = s.reveal || s.mode === 'listen' || s.mode === 'repeat';
  $('#view').innerHTML = `<div class="muted small center">${modeInfo.title} · 第 ${s.i + 1} / ${s.list.length} 个${s.asked ? ` · 答对 ${s.correct}/${s.asked}` : ''}</div>
    <div class="card live">
      <div style="font-size:30px;font-weight:700;word-break:break-word">${s.mode === 'zh2en' && !showAll ? '？' : esc(w.en)}</div>
      <div class="muted">${s.mode === 'zh2en' && !showAll ? '' : esc(w.ipa)}</div>
      <div style="font-size:20px;margin-top:8px">${s.mode === 'en2zh' && !showAll ? '？' : esc(w.zh)}</div>
      <div id="lvReveal" class="example ${showAll ? '' : 'hidden'}"><div class="s-en">${highlight(w.ex, w.en)}</div><div class="s-zh">${esc(w.exZh)}</div></div>
      <div class="state" id="lvState" style="margin-top:16px">${s.paused ? '⏸ 已暂停' : esc(s.state)}</div>
      <div class="heard" id="lvHeard">${s.heard ? `你说的是：“${esc(s.heard)}”` : ''}</div>
    </div>
    <div class="progress"><div class="p-master" style="width:${s.i / s.list.length * 100}%"></div></div>
    <div class="controls">
      <button class="btn secondary" data-vc="prev">⏮<br>上一个</button>
      <button class="btn" data-vc="${s.paused ? 'resume' : 'pause'}">${s.paused ? '▶<br>继续' : '⏸<br>暂停'}</button>
      <button class="btn secondary" data-vc="repeat">🔁<br>重复</button>
      <button class="btn secondary" data-vc="skip">⏭<br>跳过</button>
    </div>
    <button class="btn block danger" style="margin-top:10px" data-vc="stop">⏹ 结束本轮</button>`;
  document.querySelectorAll('[data-vc]').forEach(b => b.onclick = () => {
    const a = b.dataset.vc;
    if (a === 'resume') { if (s.resume) s.resume(); return; }
    if (s.paused) {
      if (a === 'stop') { s.interrupt = 'stop'; s.resume && s.resume(); return; }
      if (a === 'skip') s.i = Math.min(s.i + 1, s.list.length - 1);
      if (a === 'prev') s.i = Math.max(0, s.i - 1);
      s.resume && s.resume();
      return;
    }
    interrupt(a);
  });
}

let wakeLock = null;
async function keepAwake(on) {
  try {
    if (on && 'wakeLock' in navigator) wakeLock = await navigator.wakeLock.request('screen');
    else if (!on && wakeLock) { await wakeLock.release(); wakeLock = null; }
  } catch (e) { /* 不支持或被拒绝 */ }
}
document.addEventListener('visibilitychange', () => {
  if (VS && VS.running && document.visibilityState === 'visible') keepAwake(true);
});

/* ================= 测试 ================= */
const QTYPES = {
  en2zh: '看英文选释义',
  zh2en: '看中文选单词',
  listen: '听音选释义',
  spell: '拼写',
  blank: '例句填空',
};
let quizSess = null;

function renderQuiz() {
  if (quizSess) return quizSess.finished ? renderQuizResult() : renderQuestion();
  const q = S.quiz;
  const wbCount = WORDS.filter(w => prog(w).wb).length;
  const learned = scopeWords().filter(w => prog(w).seen).length;
  $('#view').innerHTML = scopeBar() + `<div class="card"><h2>出题范围</h2>
      <div class="row wrap">
        ${[['all', `学习范围全部`], ['learned', `只考学过的(${learned})`], ['wrong', `错题本(${wbCount})`]].map(([k, l]) => `<button class="chip ${q.source === k ? 'on' : ''}" data-qs="${k}">${l}</button>`).join('')}
      </div></div>
    <div class="card"><h2>题量</h2><div class="row wrap">
      ${[10, 20, 30, 50].map(n => `<button class="chip ${q.count === n ? 'on' : ''}" data-qc="${n}">${n} 题</button>`).join('')}
    </div></div>
    <div class="card"><h2>题型（随机混合）</h2><div class="row wrap">
      ${Object.entries(QTYPES).map(([k, l]) => `<button class="chip ${q.types.includes(k) ? 'on' : ''}" data-qt="${k}">${l}</button>`).join('')}
    </div>
    <p class="muted small" style="margin-top:10px">每次测试都会重新抽题、打乱顺序和选项；答错过、不熟悉、到期复习的单词会更容易被抽到。</p></div>
    <button class="btn block big" id="qStart">开始测试</button>`;
  document.querySelectorAll('[data-qs]').forEach(b => b.onclick = () => { q.source = b.dataset.qs; save(); render(); });
  document.querySelectorAll('[data-qc]').forEach(b => b.onclick = () => { q.count = +b.dataset.qc; save(); render(); });
  document.querySelectorAll('[data-qt]').forEach(b => b.onclick = () => {
    const t = b.dataset.qt;
    if (q.types.includes(t)) { if (q.types.length > 1) q.types = q.types.filter(x => x !== t); else toast('至少保留一种题型'); }
    else q.types.push(t);
    save(); render();
  });
  $('#qStart').onclick = () => startQuiz();
}

function startQuiz(fixedWords) {
  const q = S.quiz;
  let pool;
  if (fixedWords) pool = fixedWords;
  else if (q.source === 'wrong') pool = WORDS.filter(w => prog(w).wb);
  else if (q.source === 'learned') pool = scopeWords().filter(w => prog(w).seen);
  else pool = scopeWords();
  if (!pool.length) return toast(q.source === 'wrong' ? '错题本是空的 👍' : q.source === 'learned' ? '还没有学过的单词，先去学习吧' : '没有单词');
  const chosen = fixedWords ? shuffle(fixedWords) : shuffle(weightedSample(pool, Math.min(q.count, pool.length)));
  const qs = chosen.map(w => makeQuestion(w)).filter(Boolean);
  quizSess = { qs, i: 0, correct: 0, results: [], start: Date.now(), answered: false, label: fixedWords ? '错题重练' : (q.source === 'wrong' ? '错题本' : scopeLabel()) };
  render();
}

function distractors(w, n, keyFn) {
  const seen = new Set([keyFn(w)]);
  const out = [];
  const tiers = [
    shuffle(GROUP_BY_KEY[w.gkey].words),
    shuffle(WORDS.filter(x => x.cat === w.cat)),
    shuffle(WORDS),
  ];
  for (const tier of tiers) {
    for (const x of tier) {
      if (out.length >= n) return out;
      const k = keyFn(x);
      if (x.id === w.id || seen.has(k)) continue;
      seen.add(k);
      out.push(x);
    }
  }
  return out;
}
function makeQuestion(w) {
  let types = S.quiz.types.slice();
  if (!blankOut(w.ex, w.en)) types = types.filter(t => t !== 'blank');
  if (w.en.length > 18) types = types.filter(t => t !== 'spell');
  if (!hasTTS) types = types.filter(t => t !== 'listen');
  if (!types.length) types = ['en2zh'];
  const type = pick(types);
  const q = { w, type };
  if (type === 'en2zh' || type === 'listen') q.options = shuffle([w, ...distractors(w, 3, x => x.zh)]);
  if (type === 'zh2en' || type === 'blank') q.options = shuffle([w, ...distractors(w, 3, x => x.en.toLowerCase())]);
  return q;
}

function renderQuestion() {
  const s = quizSess;
  while (s.i < s.qs.length && s.qs[s.i].done) s.i++;
  if (s.i >= s.qs.length) return finishQuiz();
  const q = s.qs[s.i];
  const w = q.w;
  let body = '';
  if (q.type === 'en2zh') body = `<div class="q-prompt">${esc(w.en)}</div><div class="q-sub">${esc(w.ipa)}</div>`;
  if (q.type === 'zh2en') body = `<div class="q-prompt">${esc(w.zh)}</div>`;
  if (q.type === 'listen') body = `<div class="center" style="margin:18px 0"><button class="btn secondary big" id="qPlay">🔊 再听一遍</button></div>`;
  if (q.type === 'spell') body = `<div class="q-prompt">${esc(w.zh)}</div><div class="q-sub">${esc(w.ipa)}　<button class="speak-btn" id="qPlay">🔊 听发音</button></div>
    <input class="spell-input" id="spellIn" autocomplete="off" autocapitalize="off" autocorrect="off" spellcheck="false" placeholder="输入英文单词">
    <button class="btn block" style="margin-top:10px" id="spellOk">确定</button>`;
  if (q.type === 'blank') body = `<div class="q-sentence">${blankOut(w.ex, w.en)}</div><div class="q-sub" style="text-align:left">${esc(w.exZh)}</div>`;
  const opts = q.options ? `<div class="options">${q.options.map((o, i) => `<button class="option" data-opt="${i}">${esc(q.type === 'en2zh' || q.type === 'listen' ? o.zh : o.en)}</button>`).join('')}</div>` : '';
  $('#view').innerHTML = `<div class="q-head"><span class="q-type">${QTYPES[q.type]}</span><span>${s.i + 1} / ${s.qs.length} · 答对 ${s.correct}</span></div>
    <div class="progress" style="margin-bottom:12px"><div class="p-master" style="width:${s.i / s.qs.length * 100}%"></div></div>
    <div class="card">${body}${opts}<div id="fb"></div></div>
    <div class="row"><button class="btn ghost" id="qQuit">退出</button><span class="grow"></span><button class="btn hidden" id="qNext">下一题 →</button></div>`;
  s.answered = false;
  if (q.type === 'listen') { $('#qPlay').onclick = () => speakNow(w.en, EN()); speakNow(w.en, EN()); }
  if (q.type === 'spell') {
    $('#qPlay').onclick = () => speakNow(w.en, EN());
    const submit = () => {
      if (s.answered) return;
      const val = $('#spellIn').value;
      if (!val.trim()) return toast('请先输入');
      const ok = normEn(val) === normEn(w.en);
      $('#spellIn').style.borderColor = ok ? 'var(--good)' : 'var(--bad)';
      $('#spellIn').readOnly = true;
      answer(ok, val);
    };
    $('#spellOk').onclick = submit;
    $('#spellIn').addEventListener('keydown', e => { if (e.key === 'Enter') submit(); });
    setTimeout(() => $('#spellIn') && $('#spellIn').focus(), 50);
  }
  document.querySelectorAll('[data-opt]').forEach(b => b.onclick = () => {
    if (s.answered) return;
    const chosen = q.options[+b.dataset.opt];
    const ok = chosen.id === w.id;
    document.querySelectorAll('[data-opt]').forEach((x, i) => {
      if (q.options[i].id === w.id) x.classList.add('correct');
    });
    if (!ok) b.classList.add('wrong');
    answer(ok);
  });
  $('#qQuit').onclick = () => {
    if (s.results.length && confirm('退出并保存已作答的结果？')) { finishQuiz(); return; }
    if (!s.results.length) { quizSess = null; render(); }
  };
  $('#qNext').onclick = () => render();
}
function answer(ok, typed) {
  const s = quizSess;
  const q = s.qs[s.i];
  const w = q.w;
  s.answered = true;
  q.done = true;
  if (ok) s.correct++;
  s.results.push({ id: w.id, ok, type: q.type });
  grade(w, ok);
  bumpDaily('quiz');
  save();
  $('#fb').innerHTML = `<div class="feedback ${ok ? 'ok' : 'no'}">
    <div><b>${ok ? '✅ 正确' : '❌ 错误'}</b>${!ok && typed ? `　你的答案：${esc(typed)}` : ''}</div>
    <div style="margin-top:6px"><b style="font-size:18px">${esc(w.en)}</b> <span class="muted">${esc(w.ipa)}</span>
      <button class="speak-btn" data-say="word" data-id="${esc(w.id)}">🔊</button></div>
    <div>${esc(w.zh)}</div>
    <div class="small" style="margin-top:6px">${highlight(w.ex, w.en)}<br><span class="muted">${esc(w.exZh)}</span></div>
  </div>`;
  $('#qNext').classList.remove('hidden');
  if (S.settings.autoSpeak) speakNow(w.en, EN());
}
function finishQuiz() {
  const s = quizSess;
  s.finished = true;
  if (s.results.length) {
    S.history.unshift({ t: Date.now(), kind: 'quiz', mode: 'quiz', scope: s.label, total: s.results.length, correct: s.correct, wrong: s.results.filter(r => !r.ok).map(r => r.id), dur: Date.now() - s.start });
    S.history = S.history.slice(0, 200);
    save();
  }
  render();
}
function renderQuizResult() {
  const s = quizSess;
  const total = s.results.length;
  const pct = total ? Math.round(s.correct / total * 100) : 0;
  const wrongs = [...new Set(s.results.filter(r => !r.ok).map(r => r.id))].map(id => WORD_BY_ID[id]);
  const comment = pct >= 90 ? '太棒了！🏆' : pct >= 70 ? '不错，继续保持 💪' : pct >= 50 ? '还可以，错题再练练 📚' : '别灰心，多复习几遍就记住了 🌱';
  $('#view').innerHTML = `<div class="card center"><h2>测试完成</h2>
      <div style="font-size:48px;font-weight:700;color:var(--primary)">${pct}%</div>
      <div>${s.correct} / ${total} 题正确 · 用时 ${Math.max(1, Math.round((Date.now() - s.start) / 60000))} 分钟</div>
      <p class="muted">${comment}</p></div>
    ${wrongs.length ? `<div class="card"><h2>本次错题（已加入错题本）</h2><ul class="word-list">${wrongs.map(w => `<li data-word="${esc(w.id)}"><span class="dot learning"></span><div class="grow"><div class="w">${esc(w.en)} <span class="muted small">${esc(w.ipa)}</span></div><div class="m">${esc(w.zh)}</div></div><button class="speak-btn" data-say="word" data-id="${esc(w.id)}">🔊</button></li>`).join('')}</ul></div>` : ''}
    <div class="row">
      ${wrongs.length ? `<button class="btn secondary grow" id="qRetry">重练错题</button>` : ''}
      <button class="btn grow" id="qNew">再测一次</button>
    </div>
    <button class="btn ghost block" style="margin-top:10px" id="qHome">返回</button>`;
  if (wrongs.length) $('#qRetry').onclick = () => startQuiz(wrongs);
  $('#qNew').onclick = () => { quizSess = null; startQuiz(); };
  $('#qHome').onclick = () => { quizSess = null; render(); };
}

/* ================= 记录 ================= */
function streakDays() {
  let n = 0;
  let t = Date.now();
  const active = k => { const d = S.daily[k]; return d && (d.reviewed || d.quiz || d.listened || d.learned); };
  if (!active(todayKey(t))) t -= DAY; // 今天还没学也不打断连续记录
  while (active(todayKey(t))) { n++; t -= DAY; }
  return n;
}
function renderStats() {
  const seen = WORDS.filter(w => prog(w).seen).length;
  const mastered = WORDS.filter(w => status(w) === 'mastered').length;
  const due = WORDS.filter(isDue).length;
  const wb = WORDS.filter(w => prog(w).wb);
  const today = S.daily[todayKey()] || {};
  const days = [];
  for (let i = 6; i >= 0; i--) {
    const k = todayKey(Date.now() - i * DAY);
    const d = S.daily[k] || {};
    days.push({ label: k.slice(5).replace('-', '/'), v: (d.reviewed || 0) + (d.listened || 0) });
  }
  const maxV = Math.max(1, ...days.map(d => d.v));
  const modeName = { quiz: '📝 测试', listen: '🎧 纯听', repeat: '🗣️ 跟读', en2zh: '💬 英译中', zh2en: '💬 中译英' };
  $('#view').innerHTML = `<div class="stat-grid">
      <div class="stat"><div class="num">${seen}</div><div class="lbl">已学单词 / ${WORDS.length}</div></div>
      <div class="stat"><div class="num" style="color:var(--primary)">${mastered}</div><div class="lbl">已掌握</div></div>
      <div class="stat"><div class="num" style="color:var(--accent)">${due}</div><div class="lbl">待复习</div></div>
      <div class="stat"><div class="num">🔥 ${streakDays()}</div><div class="lbl">连续学习天数</div></div>
    </div>
    <div class="card" style="margin-top:12px"><h2>今天</h2>
      <div class="muted">新学 <b>${today.learned || 0}</b> 词 · 复习/答题 <b>${today.reviewed || 0}</b> 次 · 听学 <b>${today.listened || 0}</b> 次</div></div>
    <div class="card"><h2>近 7 天</h2><div class="bars">${days.map(d => `<div class="bar"><span>${d.v || ''}</span><i style="height:${d.v / maxV * 70}%"></i><span>${d.label}</span></div>`).join('')}</div></div>
    <div class="card"><h2>各板块进度</h2>
      ${VOCAB.map(c => {
        const ws = WORDS.filter(w => w.cat === c.id);
        const m = ws.filter(w => status(w) === 'mastered').length;
        const l = ws.filter(w => status(w) === 'learning').length;
        return `<div style="margin-bottom:12px"><div class="row spread small"><span>${c.icon} ${esc(c.name)}</span><span class="muted">掌握 ${m} · 学习中 ${l} · 共 ${ws.length}</span></div>
          <div class="progress" style="margin-top:4px"><div class="p-master" style="width:${m / ws.length * 100}%"></div><div class="p-learn" style="width:${l / ws.length * 100}%"></div></div></div>`;
      }).join('')}
      <div class="muted small">🟢 已掌握（连续答对多次）　🟠 学习中</div>
    </div>
    <div class="card"><div class="row spread"><h2>错题本（${wb.length}）</h2>${wb.length ? '<button class="chip" id="wbQuiz">测试错题</button>' : ''}</div>
      ${wb.length ? `<ul class="word-list">${wb.slice(0, 100).map(w => `<li data-word="${esc(w.id)}"><span class="dot learning"></span><div class="grow"><div class="w">${esc(w.en)}</div><div class="m">${esc(w.zh)} · 错 ${prog(w).wrong} 次</div></div><button class="speak-btn" data-say="word" data-id="${esc(w.id)}">🔊</button></li>`).join('')}</ul>
        <p class="muted small">错题连续答对 2 次后会自动移出错题本。</p>` : '<p class="muted">暂时没有错题 👍</p>'}
    </div>
    <div class="card"><h2>历史记录</h2>
      ${S.history.length ? `<ul class="word-list">${S.history.slice(0, 30).map(h => `<li><div class="grow"><div class="w">${modeName[h.mode] || h.mode} <span class="muted small">${fmtTime(h.t)}</span></div><div class="m">${esc(h.scope)}</div></div>
        <div>${h.mode === 'listen' ? `${h.total} 词` : `<b>${h.correct}</b>/${h.total}`}</div></li>`).join('')}</ul>` : '<p class="muted">还没有记录，去学习或测试吧。</p>'}
    </div>
    <div class="card"><h2>数据管理</h2>
      <p class="muted small">学习记录只保存在这台手机的浏览器里。换手机或清理浏览器数据前，请先导出备份。</p>
      <div class="row wrap">
        <button class="btn secondary" id="exp">导出备份</button>
        <label class="btn secondary" style="display:inline-block">导入备份<input type="file" id="imp" accept="application/json,.json" hidden></label>
        <button class="btn danger" id="reset">清空记录</button>
      </div>
    </div>`;
  if (wb.length) $('#wbQuiz').onclick = () => { S.quiz.source = 'wrong'; save(); switchTab('quiz'); startQuiz(); };
  $('#exp').onclick = () => {
    const blob = new Blob([JSON.stringify(S)], { type: 'application/json' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `营养学单词备份-${todayKey()}.json`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 2000);
  };
  $('#imp').onchange = e => {
    const f = e.target.files[0];
    if (!f) return;
    f.text().then(txt => {
      const data = JSON.parse(txt);
      if (!data || typeof data.words !== 'object') throw new Error('bad');
      localStorage.setItem(STORE_KEY, JSON.stringify(data));
      S = loadState();
      learnSess = null;
      toast('导入成功');
      render();
    }).catch(() => toast('文件格式不正确'));
  };
  $('#reset').onclick = () => {
    if (!confirm('确定清空所有学习记录吗？此操作无法撤销。')) return;
    const keep = { settings: S.settings, voice: S.voice, quiz: S.quiz, scope: S.scope };
    S = { ...defaultState(), ...keep };
    save();
    learnSess = null;
    render();
    toast('已清空');
  };
}

/* ================= 设置 ================= */
function openSettings() {
  loadVoices();
  const st = S.settings;
  const enVoices = voices.filter(v => v.lang.replace('_', '-').startsWith('en'));
  const zhVoices = voices.filter(v => /^(zh|cmn)/i.test(v.lang));
  openModal(`<h2>设置</h2>
    <label class="field">英语口音</label>
    <div class="seg"><button data-acc="en-US" class="${st.accent === 'en-US' ? 'on' : ''}">美式</button><button data-acc="en-GB" class="${st.accent === 'en-GB' ? 'on' : ''}">英式</button></div>
    <label class="field">英文语音</label>
    <select class="full" id="enV"><option value="">自动选择</option>${enVoices.map(v => `<option value="${esc(v.voiceURI)}" ${v.voiceURI === st.enVoice ? 'selected' : ''}>${esc(v.name)} (${esc(v.lang)})</option>`).join('')}</select>
    <label class="field">中文语音</label>
    <select class="full" id="zhV"><option value="">自动选择</option>${zhVoices.map(v => `<option value="${esc(v.voiceURI)}" ${v.voiceURI === st.zhVoice ? 'selected' : ''}>${esc(v.name)} (${esc(v.lang)})</option>`).join('')}</select>
    <label class="field">语速：<span id="rateV">${st.rate.toFixed(2)}</span></label>
    <input type="range" class="full" id="rate" min="0.5" max="1.3" step="0.05" value="${st.rate}">
    <div class="row" style="margin-top:8px"><button class="speak-btn" id="tEn">🔊 试听英文</button><button class="speak-btn" id="tZh">🔊 试听中文</button></div>
    <div class="opt-row" style="margin-top:8px"><span>学习/测试时自动朗读单词</span><input type="checkbox" class="switch" id="autoSp" ${st.autoSpeak ? 'checked' : ''}></div>
    <p class="muted small">提示：如果声音不自然，iPhone 可在「设置 → 辅助功能 → 朗读内容 → 声音」下载更高质量的英文/中文语音；安卓可在系统「文字转语音」设置中安装 Google 语音包。</p>
    <p class="muted small">词库共 ${WORDS.length} 词 · 语音识别：${hasSR ? '支持 ✅' : '不支持 ❌'} · 语音播报：${hasTTS ? '支持 ✅' : '不支持 ❌'}</p>
    <button class="btn block" data-close>完成</button>`);
  document.querySelectorAll('[data-acc]').forEach(b => b.onclick = () => { st.accent = b.dataset.acc; st.enVoice = ''; save(); openSettings(); });
  $('#enV').onchange = e => { st.enVoice = e.target.value; save(); };
  $('#zhV').onchange = e => { st.zhVoice = e.target.value; save(); };
  $('#rate').oninput = e => { st.rate = +e.target.value; $('#rateV').textContent = st.rate.toFixed(2); save(); };
  $('#tEn').onclick = () => speakNow('Carbohydrates are the body\'s main source of energy.', EN());
  $('#tZh').onclick = () => speakNow('碳水化合物是身体的主要能量来源。', ZH);
  $('#autoSp').onchange = e => { st.autoSpeak = e.target.checked; save(); };
}
$('#settingsBtn').onclick = openSettings;

/* ================= 启动 ================= */
render();
if ('serviceWorker' in navigator && location.protocol !== 'file:') {
  navigator.serviceWorker.register('sw.js').catch(() => {});
}
