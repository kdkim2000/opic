"use strict";
/* OPIc 연습 앱 — 바닐라 JS. 해시 라우팅: #/ , #/set/3 , #/practice/3/5[?g=2|list=hard] , #/exam/3 , #/hard */

const $app = document.getElementById("app");
const KEEP_RECORDINGS = 5;
const STATUS = { new: "미학습", hard: "어려움", ok: "보통", done: "완료" };
let DATA = null;
let cleanup = null; // 화면을 떠날 때 호출

/* ---------- 유틸 ---------- */
const esc = (s) => String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
const fmtTime = (s) => `${String(Math.floor(s / 60)).padStart(2, "0")}:${String(Math.floor(s % 60)).padStart(2, "0")}`;
const keyOf = (s, q) => `${s}:${q}`;
function toast(msg) {
  const t = document.getElementById("toast");
  t.textContent = msg; t.classList.add("show");
  clearTimeout(toast.t); toast.t = setTimeout(() => t.classList.remove("show"), 2400);
}
/** **굵게** 표기를 HTML 로 변환. 굵지 않은 부분은 span.t (가리기용) */
function renderScript(text) {
  return text.split(/\n\n+/).map((p) => "<p>" + p.split("**").map((seg, i) =>
    i % 2 ? `<b>${esc(seg)}</b>` : seg ? `<span class="t">${esc(seg)}</span>` : "").join("") + "</p>").join("");
}
const allQuestions = () => DATA.sets.flatMap((s) => s.groups.flatMap((g) => g.questions.map((q) => ({ s: s.id, g, q }))));
function findQ(s, no) {
  const set = DATA.sets.find((x) => x.id === s);
  for (const g of set?.groups ?? []) for (const q of g.questions) if (q.no === no) return { set, g, q };
  return null;
}

/* ---------- IndexedDB ---------- */
const db = (() => {
  let conn;
  const open = () => conn || (conn = new Promise((res, rej) => {
    const r = indexedDB.open("opic-practice", 1);
    r.onupgradeneeded = () => {
      const d = r.result;
      d.createObjectStore("progress", { keyPath: "key" });
      d.createObjectStore("recordings", { keyPath: "id", autoIncrement: true }).createIndex("byKey", "key");
      d.createObjectStore("settings", { keyPath: "name" });
    };
    r.onsuccess = () => res(r.result);
    r.onerror = () => rej(r.error);
  }));
  const run = async (store, mode, fn) => {
    const d = await open();
    return new Promise((res, rej) => {
      const tx = d.transaction(store, mode);
      const req = fn(tx.objectStore(store));
      tx.oncomplete = () => res(req?.result);
      tx.onerror = () => rej(tx.error);
    });
  };
  return {
    getProgress: (key) => run("progress", "readonly", (s) => s.get(key)),
    allProgress: () => run("progress", "readonly", (s) => s.getAll()),
    putProgress: (p) => run("progress", "readwrite", (s) => s.put(p)),
    recs: (key) => run("recordings", "readonly", (s) => s.index("byKey").getAll(key)),
    addRec: (r) => run("recordings", "readwrite", (s) => s.add(r)),
    delRec: (id) => run("recordings", "readwrite", (s) => s.delete(id)),
    getSetting: async (n, d) => (await run("settings", "readonly", (s) => s.get(n)))?.value ?? d,
    setSetting: (name, value) => run("settings", "readwrite", (s) => s.put({ name, value })),
  };
})();

async function updateProgress(s, no, patch) {
  const key = keyOf(s, no);
  const cur = (await db.getProgress(key)) || { key, status: "new", attempts: 0, lastPracticed: null };
  const next = { ...cur, ...patch };
  await db.putProgress(next);
  return next;
}
async function saveRecording(s, no, blob, mime, durationSec) {
  const key = keyOf(s, no);
  await db.addRec({ key, set: s, no, createdAt: Date.now(), mime, durationSec, blob });
  const list = (await db.recs(key)).sort((a, b) => a.createdAt - b.createdAt);
  for (const old of list.slice(0, Math.max(0, list.length - KEEP_RECORDINGS))) await db.delRec(old.id);
  const cur = (await db.getProgress(key)) || { key, status: "new", attempts: 0 };
  await updateProgress(s, no, { attempts: (cur.attempts || 0) + 1, lastPracticed: new Date().toISOString().slice(0, 10) });
}

/* ---------- 녹음 ---------- */
function pickMime() {
  const c = ["audio/webm;codecs=opus", "audio/webm", "audio/mp4", "audio/aac"];
  return c.find((m) => window.MediaRecorder && MediaRecorder.isTypeSupported(m)) || "";
}
async function getMic() {
  if (!navigator.mediaDevices?.getUserMedia || !window.MediaRecorder) throw new Error("이 브라우저는 녹음을 지원하지 않습니다.");
  try { return await navigator.mediaDevices.getUserMedia({ audio: true }); }
  catch (e) { throw new Error("마이크 권한이 필요합니다. 브라우저 설정에서 허용해 주세요."); }
}
/** 녹음 시작. 반환: { stop(): Promise<{blob, mime, durationSec}> } */
function startRecording(stream) {
  const mime = pickMime();
  const rec = new MediaRecorder(stream, mime ? { mimeType: mime } : undefined);
  const chunks = [];
  const t0 = Date.now();
  rec.ondataavailable = (e) => e.data.size && chunks.push(e.data);
  rec.start();
  return {
    stop: () => new Promise((res) => {
      rec.onstop = () => res({ blob: new Blob(chunks, { type: rec.mimeType || mime }), mime: rec.mimeType || mime,
        durationSec: Math.round((Date.now() - t0) / 1000) });
      rec.stop();
    }),
  };
}
const extOf = (mime) => (mime.includes("mp4") ? "m4a" : mime.includes("webm") ? "webm" : "audio");

/* ---------- 라우터 ---------- */
function route() {
  if (cleanup) { try { cleanup(); } catch (e) { /* noop */ } cleanup = null; }
  const [path, qs] = (location.hash.slice(1) || "/").split("?");
  const parts = path.split("/").filter(Boolean);
  const params = new URLSearchParams(qs || "");
  window.scrollTo(0, 0);
  if (!DATA) return;
  if (parts[0] === "set") return viewSet(+parts[1]);
  if (parts[0] === "practice") return viewPractice(+parts[1], +parts[2], params);
  if (parts[0] === "exam") return viewExam(+parts[1]);
  if (parts[0] === "hard") return viewHard();
  if (parts[0] === "basic") {
    if (parts[1] === "x" && parts[2]) {
      const cat = decodeURIComponent(parts[2]);
      return parts[3] !== undefined ? viewBasicCard("x", cat, +parts[3] || 0, params) : viewBasicCat(cat);
    }
    if (parts[1] === "f" && parts[2]) return viewBasicCard("f", decodeURIComponent(parts[2]), +parts[3] || 0, params);
    if (parts[1] === "chain") return viewBasicChain();
    return viewBasicHome();
  }
  if (parts[0] === "survey") {
    if (parts[1] === "run") return viewSurveyRun(params);
    if (parts[1] === "result") return viewSurveyResult();
    if (parts[1] === "edit") return viewSurveyEdit();
    return viewSurveyHome();
  }
  if (parts[0] === "drill") {
    if (parts.length >= 4) return viewDrillCard(decodeURIComponent(parts[1]), +parts[2], +parts[3]);
    if (parts[1]) return viewDrillTheme(decodeURIComponent(parts[1]));
    return viewDrillHome();
  }
  return viewHome();
}
window.addEventListener("hashchange", route);

const topbar = (title, back = "#/") => `<div class="topbar"><a class="back" href="${back}" aria-label="뒤로">‹</a><div class="title">${esc(title)}</div></div>`;
const badge = (st) => (st && st !== "new" ? `<span class="badge ${st}">${STATUS[st]}</span>` : "");

/* ---------- 홈 ---------- */
async function viewHome() {
  const prog = Object.fromEntries((await db.allProgress()).map((p) => [p.key, p]));
  const hardCount = Object.values(prog).filter((p) => p.status === "hard").length;
  const seriesOf = (s) => s.series || (s.id >= 16 ? "latest" : "legacy");
  const section = (title, series, collapsible) => {
    const sets = DATA.sets.filter((s) => seriesOf(s) === series);
    if (!sets.length) return "";
    let tDone = 0, tAll = 0;
    const cards = sets.map((s) => {
      const qs = s.groups.flatMap((g) => g.questions);
      const done = qs.filter((q) => prog[keyOf(s.id, q.no)]?.status === "done").length;
      tDone += done; tAll += qs.length;
      return `<div class="card"><div class="row spread"><b>opic${s.id}</b><span class="muted">${done}/${qs.length} 완료</span></div>
      <div class="bar"><i style="width:${qs.length ? (done / qs.length) * 100 : 0}%"></i></div>
      <div class="row"><a class="btn primary" href="#/exam/${s.id}">실전 모드</a><a class="btn" href="#/set/${s.id}">학습 모드</a></div></div>`;
    }).join("");
    const head = `<span class="sec-title">${esc(title)}</span><span class="muted sec-sum">${sets.length}세트 · ${tDone}/${tAll} 완료</span>`;
    return collapsible
      ? `<details class="series"><summary>${head}</summary>${cards}</details>`
      : `<section class="series"><div class="sec-head">${head}</div>${cards}</section>`;
  };
  $app.innerHTML = `<h1>OPIc 연습</h1>` +
    `<a class="card drill-entry" href="#/drill"><b>연습 모드 — 주제별 키워드 말하기</b>
    <p class="muted">동사·명사 키워드만 보고 영어식으로 상상하며 이야기를 이어 말해 보세요.</p></a>` +
    `<a class="card drill-entry" href="#/basic"><b>기초 모드 — 기본 표현·필러 연습</b>
    <p class="muted">자주 쓰는 표현을 묶어서 반복하고, 필러로 말이 끊기지 않게 이어 가는 연습을 해 보세요.</p></a>` +
    `<a class="card drill-entry" href="#/survey"><b>Survey 모드 — Background Survey 선택 연습</b>
    <p class="muted">실제 설문 화면처럼 직업·거주·여가·취미·운동·휴가 항목을 골라 보는 연습입니다.</p></a>` + section("최신 문제 (opic16~30)", "latest", false) +
    section("이전 문제 (opic1~8)", "legacy", true) + `<div class="card"><a class="btn" href="#/hard">어려움 문항 모아 연습 (${hardCount})</a>
    <p class="muted">녹음과 학습 기록은 이 기기 안에만 저장됩니다. 브라우저 데이터를 지우면 함께 삭제됩니다.</p></div>`;
}

/* ---------- 세트 ---------- */
async function viewSet(sid) {
  const set = DATA.sets.find((s) => s.id === sid);
  if (!set) return (location.hash = "#/");
  const prog = Object.fromEntries((await db.allProgress()).map((p) => [p.key, p]));
  $app.innerHTML = topbar(`opic${sid}`) + `<a class="btn primary big" href="#/exam/${sid}">실전 모드 시작</a>` +
    set.groups.map((g) => {
      const first = g.questions[0].no;
      return `<h2>${esc(g.label)} <a class="tag" href="#/practice/${sid}/${first}?g=${g.id}">그룹 연속 연습</a></h2><div class="card">` +
        g.questions.map((q) => {
          const p = prog[keyOf(sid, q.no)];
          return `<a class="qrow" href="#/practice/${sid}/${q.no}"><span class="no">Q${q.no}</span><span class="tt">${esc(q.title || q.text)}</span>
            ${badge(p?.status)}${p?.attempts ? `<span class="muted">${p.attempts}회</span>` : ""}</a>`;
        }).join("") + `</div>`;
    }).join("");
}

/* ---------- 어려움 모아 보기 ---------- */
async function viewHard() {
  const prog = await db.allProgress();
  const hard = new Set(prog.filter((p) => p.status === "hard").map((p) => p.key));
  const list = allQuestions().filter(({ s, q }) => hard.has(keyOf(s, q.no)));
  $app.innerHTML = topbar("어려움 문항") + (list.length
    ? (`<a class="btn primary big" href="#/practice/${list[0].s}/${list[0].q.no}?list=hard">처음부터 연습</a><div class="card">` +
      list.map(({ s, q }) => `<a class="qrow" href="#/practice/${s}/${q.no}?list=hard"><span class="no">${s}-Q${q.no}</span><span class="tt">${esc(q.title || q.text)}</span></a>`).join("") + "</div>")
    : `<p class="muted">아직 "어려움"으로 표시한 문항이 없습니다.</p>`);
}

/* ---------- 연습(학습) ---------- */
async function viewPractice(sid, no, params) {
  const found = findQ(sid, no);
  if (!found) return (location.hash = "#/");
  const { g, q } = found;
  const prog = (await db.getProgress(keyOf(sid, no))) || { status: "new", attempts: 0 };
  const speed = await db.getSetting("speed", "0.9");

  // 이전/다음 큐
  let queue;
  if (params.get("list") === "hard") {
    const hard = new Set((await db.allProgress()).filter((p) => p.status === "hard").map((p) => p.key));
    queue = allQuestions().filter((x) => hard.has(keyOf(x.s, x.q.no)) || (x.s === sid && x.q.no === no));
  } else if (params.get("g")) {
    queue = allQuestions().filter((x) => x.s === sid && x.g.id === g.id);
  } else queue = allQuestions().filter((x) => x.s === sid);
  const idx = queue.findIndex((x) => x.s === sid && x.q.no === no);
  const suffix = params.get("list") ? "?list=" + params.get("list") : params.get("g") ? "?g=" + params.get("g") : "";
  const link = (x) => (x ? `#/practice/${x.s}/${x.q.no}${suffix}` : null);
  const prev = link(queue[idx - 1]), next = link(queue[idx + 1]);

  $app.innerHTML = topbar(`opic${sid} · Q${no} · ${g.label}`, `#/set/${sid}`) + `
    <div class="card"><div class="row spread"><b>질문</b><button id="qPlay">▶ 질문 듣기</button></div>
      <p class="qtext" id="qText">${esc(q.text)}</p></div>
    <div class="card"><div class="row spread"><b>내 답변 스크립트</b><button id="mask">가리기</button></div>
      <div class="script" id="script">${q.script ? renderScript(q.script) : '<p class="muted">스크립트가 없습니다.</p>'}</div>
      ${q.keyPoints.length ? `<div class="keys">${q.keyPoints.map((k) => `<span>${esc(k)}</span>`).join("")}</div>` : ""}</div>
    <div class="card"><b>모델 답변</b>
      ${q.aAudio ? `<div class="row" style="margin-top:8px">
        <button id="aPlay" class="primary">▶ 재생</button><button id="aBack">⏪10</button><button id="aFwd">10⏩</button>
        <select id="rate" aria-label="속도">${["0.75", "0.9", "1", "1.15"].map((v) => `<option value="${v}" ${v === speed ? "selected" : ""}>${v}x</option>`).join("")}</select>
        <select id="repeat" aria-label="반복"><option value="1">1회</option><option value="3">3회</option><option value="inf">무한</option></select></div>
        <input type="range" id="seek" min="0" max="100" value="0" step="0.1" aria-label="재생 위치">
        <div class="muted" id="aTime">00:00</div>` : '<p class="muted">모델 답변 음원이 없습니다.</p>'}</div>
    <div class="card"><b>내 녹음</b>
      <div class="row spread" style="margin:8px 0"><button id="rec" class="rec">● 녹음</button><span class="timer" id="recTimer">00:00</span></div>
      <div class="row"><button id="compare">모델 ↔ 내 녹음 번갈아 듣기</button></div>
      <div id="recList"></div></div>
    <div class="card"><b>자기 평가</b> <span class="muted" id="attempts">${prog.attempts || 0}회 연습</span>
      <div class="row" style="margin-top:8px">${["hard", "ok", "done"].map((k) => `<button data-st="${k}" class="${prog.status === k ? "sel" : ""}">${STATUS[k]}</button>`).join("")}</div></div>
    <div class="nav">${prev ? `<button onclick="location.hash='${prev}'">‹ 이전</button>` : "<span style='flex:1'></span>"}
      ${next ? `<button class="primary" onclick="location.hash='${next}'">다음 ›</button>` : "<span style='flex:1'></span>"}</div>`;

  const $ = (id) => document.getElementById(id);
  const qAudio = new Audio(q.qAudio);
  const aAudio = q.aAudio ? new Audio(q.aAudio) : null;
  let myAudio = null, urls = [], recorder = null, stream = null, timerId = null, recording = false, compareStep = 0;
  const players = () => [qAudio, aAudio, myAudio].filter(Boolean);
  const stopAll = () => players().forEach((a) => a.pause());
  const setBusy = (busy) => ["qPlay", "aPlay", "aBack", "aFwd", "compare"].forEach((id) => $(id) && ($(id).disabled = busy));

  // 질문
  $("qPlay").onclick = () => { stopAll(); qAudio.currentTime = 0; qAudio.play(); };
  // 스크립트 가리기
  $("mask").onclick = () => { const m = $("script").classList.toggle("mask"); $("mask").textContent = m ? "보이기" : "가리기"; };
  // 모델 답변
  if (aAudio) {
    let plays = 0;
    aAudio.playbackRate = +speed;
    $("aPlay").onclick = () => {
      if (!aAudio.paused) { aAudio.pause(); return; }
      stopAll(); plays = 0; aAudio.playbackRate = +$("rate").value; aAudio.play();
    };
    aAudio.onplay = () => ($("aPlay").textContent = "⏸ 일시정지");
    aAudio.onpause = () => ($("aPlay").textContent = "▶ 재생");
    aAudio.ontimeupdate = () => {
      if (aAudio.duration) $("seek").value = (aAudio.currentTime / aAudio.duration) * 100;
      $("aTime").textContent = `${fmtTime(aAudio.currentTime)} / ${fmtTime(aAudio.duration || 0)}`;
    };
    aAudio.onended = () => {
      if (compareStep === 1) return nextCompare();
      plays++; const r = $("repeat").value;
      if (r === "inf" || plays < +r) { aAudio.currentTime = 0; aAudio.play(); }
    };
    $("seek").oninput = () => { if (aAudio.duration) aAudio.currentTime = (+$("seek").value / 100) * aAudio.duration; };
    $("aBack").onclick = () => (aAudio.currentTime = Math.max(0, aAudio.currentTime - 10));
    $("aFwd").onclick = () => (aAudio.currentTime = Math.min(aAudio.duration || 0, aAudio.currentTime + 10));
    $("rate").onchange = () => { aAudio.playbackRate = +$("rate").value; db.setSetting("speed", $("rate").value); };
  }
  // 평가
  document.querySelectorAll("[data-st]").forEach((b) => (b.onclick = async () => {
    await updateProgress(sid, no, { status: b.dataset.st, lastPracticed: new Date().toISOString().slice(0, 10) });
    document.querySelectorAll("[data-st]").forEach((x) => x.classList.toggle("sel", x === b));
    toast(`"${STATUS[b.dataset.st]}"로 표시했습니다`);
  }));

  // 내 녹음 목록
  async function renderRecs() {
    urls.forEach(URL.revokeObjectURL); urls = [];
    const list = (await db.recs(keyOf(sid, no))).sort((a, b) => b.createdAt - a.createdAt);
    $("recList").innerHTML = list.length ? list.map((r, i) => {
      const u = URL.createObjectURL(r.blob); urls.push(u);
      const d = new Date(r.createdAt);
      return `<div class="rec-item" data-id="${r.id}"><span class="grow">${i === 0 ? "최근 · " : ""}${d.getMonth() + 1}/${d.getDate()} ${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")} · ${fmtTime(r.durationSec)}</span>
        <button data-play="${u}">▶</button><a class="btn" href="${u}" download="opic${sid}_q${no}_${r.createdAt}.${extOf(r.mime)}">⬇</a><button data-del="${r.id}">🗑</button></div>`;
    }).join("") : '<p class="muted">아직 녹음이 없습니다.</p>';
    $("recList").querySelectorAll("[data-play]").forEach((b) => (b.onclick = () => {
      stopAll(); myAudio = new Audio(b.dataset.play); myAudio.play();
    }));
    $("recList").querySelectorAll("[data-del]").forEach((b) => (b.onclick = async () => {
      await db.delRec(+b.dataset.del); renderRecs();
    }));
  }
  renderRecs();

  // 녹음
  $("rec").onclick = async () => {
    if (recording) {
      clearInterval(timerId);
      const r = await recorder.stop();
      stream.getTracks().forEach((t) => t.stop());
      recording = false; $("rec").textContent = "● 녹음"; setBusy(false);
      await saveRecording(sid, no, r.blob, r.mime, r.durationSec);
      $("attempts").textContent = `${(await db.getProgress(keyOf(sid, no))).attempts}회 연습`;
      renderRecs(); toast("녹음을 저장했습니다");
      return;
    }
    try { stream = await getMic(); } catch (e) { return toast(e.message); }
    stopAll(); setBusy(true);
    recorder = startRecording(stream); recording = true;
    $("rec").textContent = "■ 정지";
    const t0 = Date.now();
    timerId = setInterval(() => ($("recTimer").textContent = fmtTime((Date.now() - t0) / 1000)), 250);
  };

  // 번갈아 듣기: 모델 답변 → 내 최근 녹음
  async function nextCompare() {
    if (compareStep === 1) {
      const list = (await db.recs(keyOf(sid, no))).sort((a, b) => b.createdAt - a.createdAt);
      compareStep = 0;
      if (!list.length) return toast("내 녹음이 없습니다");
      const u = URL.createObjectURL(list[0].blob); urls.push(u);
      myAudio = new Audio(u); myAudio.play();
    }
  }
  $("compare").onclick = () => {
    if (!aAudio) return toast("모델 답변이 없습니다");
    stopAll(); compareStep = 1; aAudio.currentTime = 0; aAudio.playbackRate = +$("rate").value; aAudio.play();
  };

  cleanup = () => {
    clearInterval(timerId); stopAll();
    if (recording && stream) stream.getTracks().forEach((t) => t.stop());
    urls.forEach(URL.revokeObjectURL);
  };
}

/* ---------- 연습 모드(주제별 키워드 말하기) ---------- */
const seriesRank = (sid) => { const st = DATA.sets.find((x) => x.id === sid); return ((st?.series || (sid >= 16 ? "latest" : "legacy")) === "latest") ? 0 : 1; };
/** 주제 안 문항 큐: 최신 시리즈 먼저, 그 안에서는 세트 번호·원래 순서 */
function themeQueue(themeId) {
  return allQuestions().map((x, i) => ({ ...x, i })).filter((x) => x.g.theme === themeId)
    .sort((a, b) => seriesRank(a.s) - seriesRank(b.s) || a.s - b.s || a.i - b.i);
}
const drillHref = (themeId, x) => `#/drill/${encodeURIComponent(themeId)}/${x.s}/${x.q.no}`;

async function viewDrillHome() {
  const themes = (DATA.themes || []).slice().sort((a, b) => (a.order ?? 0) - (b.order ?? 0));
  if (!themes.length) {
    $app.innerHTML = topbar("연습 모드") + `<p class="muted">주제 데이터가 아직 준비되지 않았습니다. 데이터를 다시 빌드한 뒤 확인해 주세요.</p>`;
    return;
  }
  const prog = Object.fromEntries((await db.allProgress()).map((p) => [p.key, p]));
  const all = allQuestions();
  const SECS = [["intro", "① 자기소개"], ["survey", "② Survey 주제"], ["sudden", "③ 돌발 주제 (비슷한 주제 묶음)"], ["roleplay", "④ 롤플레이 (상황별)"]];
  const card = (t) => {
    const qs = all.filter((x) => x.g.theme === t.id);
    const done = qs.filter((x) => prog[keyOf(x.s, x.q.no)]?.status === "done").length;
    return `<a class="card theme-card" href="#/drill/${encodeURIComponent(t.id)}"><div class="row spread"><b>${esc(t.label)}</b>
      <span class="muted">${done}/${qs.length} 완료</span></div>
      <div class="bar"><i style="width:${qs.length ? (done / qs.length) * 100 : 0}%"></i></div>
      <span class="muted">문항 ${qs.length}개</span></a>`;
  };
  const known = new Set(SECS.map((x) => x[0]));
  const others = themes.filter((t) => !known.has(t.kind));
  const secHtml = SECS.map(([kind, title]) => {
    const ts = themes.filter((t) => t.kind === kind);
    return ts.length ? `<h2>${esc(title)}</h2>${ts.map(card).join("")}` : "";
  }).join("") + (others.length ? `<h2>기타</h2>${others.map(card).join("")}` : "");
  $app.innerHTML = topbar("연습 모드") + `<p class="muted">주제를 골라 키워드로 이야기를 이어 말하는 연습입니다. 진행 기록은 학습·실전 모드와 공유됩니다.</p>` + secHtml;
}

async function viewDrillTheme(themeId) {
  const theme = (DATA.themes || []).find((t) => t.id === themeId);
  if (!theme) return (location.hash = "#/drill");
  const prog = Object.fromEntries((await db.allProgress()).map((p) => [p.key, p]));
  const queue = themeQueue(themeId);
  $app.innerHTML = topbar(theme.label, "#/drill") + (queue.length
    ? `<a class="btn primary big" href="${drillHref(themeId, queue[0])}">처음부터 연속 연습</a><div class="card">` +
      queue.map((x) => {
        const p = prog[keyOf(x.s, x.q.no)];
        return `<a class="qrow" href="${drillHref(themeId, x)}"><span class="no wide">${x.s}-Q${x.q.no}</span><span class="tt">${esc(x.q.title || x.q.text)}</span>
          ${badge(p?.status)}${p?.attempts ? `<span class="muted">${p.attempts}회</span>` : ""}</a>`;
      }).join("") + `</div>`
    : `<p class="muted">이 주제에 해당하는 문항이 없습니다.</p>`);
}

async function viewDrillCard(themeId, sid, no) {
  const found = findQ(sid, no);
  if (!found) return (location.hash = "#/drill");
  const { q } = found;
  const theme = (DATA.themes || []).find((t) => t.id === themeId);
  const prog = (await db.getProgress(keyOf(sid, no))) || { status: "new", attempts: 0 };
  let level = +(await db.getSetting("drillLevel", 1));
  if (![1, 2, 3].includes(level)) level = 1;

  const queue = themeQueue(themeId);
  const idx = queue.findIndex((x) => x.s === sid && x.q.no === no);
  const prev = idx > 0 ? drillHref(themeId, queue[idx - 1]) : null;
  const next = idx >= 0 && queue[idx + 1] ? drillHref(themeId, queue[idx + 1]) : null;

  const kw = q.keywords || {};
  const beats = kw.beats || [], verbs = kw.verbs || [], nouns = kw.nouns || [];
  const hasKw = beats.length + verbs.length + nouns.length > 0;
  const fallback = !hasKw ? (q.keyPoints || []) : [];

  $app.innerHTML = topbar(`${theme ? theme.label : "연습"} · ${sid}-Q${no}`, `#/drill/${encodeURIComponent(themeId)}`) + `
    <div class="card"><div class="row spread"><b>질문</b><button id="qPlay">▶ 질문 듣기</button></div>
      <p class="qtext">${esc(q.text)}</p></div>
    <div class="card"><div class="row spread"><b>스토리 키워드</b>
      <div class="lvl" role="group" aria-label="난이도">${[1, 2, 3].map((n) => `<button data-lv="${n}">Lv${n}</button>`).join("")}</div></div>
      <p class="muted" id="lvHint"></p><div id="scaffold"></div></div>
    <div class="card"><b>내 녹음</b> <span class="muted">목표 60~90초</span>
      <div class="row spread" style="margin:8px 0"><button id="rec" class="rec">● 녹음</button><span class="timer" id="recTimer">00:00</span></div>
      <div id="recList"></div></div>
    <div class="card"><b>확인하기</b>
      <div class="row" style="margin:8px 0"><button id="showScript">스크립트 보기</button>
        ${q.aAudio ? `<button id="aPlay">🔊 모델 답변 듣기</button>` : ""}</div>
      <div class="script" id="script" hidden>${q.script ? renderScript(q.script) : '<p class="muted">스크립트가 없습니다.</p>'}</div></div>
    <div class="card"><b>자기 평가</b> <span class="muted" id="attempts">${prog.attempts || 0}회 연습</span>
      <div class="row" style="margin-top:8px">${["hard", "ok", "done"].map((k) => `<button data-st="${k}" class="${prog.status === k ? "sel" : ""}">${STATUS[k]}</button>`).join("")}</div></div>
    <div class="nav">${prev ? `<button onclick="location.hash='${prev}'">‹ 이전</button>` : "<span style='flex:1'></span>"}
      ${next ? `<button class="primary" onclick="location.hash='${next}'">다음 ›</button>` : "<span style='flex:1'></span>"}</div>`;

  const $ = (id) => document.getElementById(id);
  const qAudio = new Audio(q.qAudio);
  const aAudio = q.aAudio ? new Audio(q.aAudio) : null;
  let myAudio = null, urls = [], recorder = null, stream = null, timerId = null, recording = false;
  const used = new Set();
  const stopAll = () => [qAudio, aAudio, myAudio].filter(Boolean).forEach((a) => a.pause());
  const setBusy = (busy) => ["qPlay", "aPlay"].forEach((id) => $(id) && ($(id).disabled = busy));

  // 스캐폴드: Lv1 beats+동사+명사 / Lv2 동사+명사 / Lv3 명사만
  const HINT = { 1: "Lv1 · 장면 단계 + 동사 + 명사", 2: "Lv2 · 동사 + 명사", 3: "Lv3 · 명사만 (나머지는 상상해서!)" };
  const chipGroup = (label, cls, list) => (list.length ? `<div class="chips"><span class="chip-label">${label}</span>${list.map((w) => {
    const k = cls + ":" + w;
    return `<button class="chip ${cls}${used.has(k) ? " used" : ""}" data-chip="${esc(k)}" aria-pressed="${used.has(k)}">${esc(w)}</button>`;
  }).join("")}</div>` : "");
  const shownChips = () => (!hasKw ? fallback.map((w) => "kp:" + w)
    : [...(level <= 2 ? verbs.map((w) => "verb:" + w) : []), ...nouns.map((w) => "noun:" + w)]);
  function renderScaffold() {
    document.querySelectorAll("[data-lv]").forEach((b) => b.classList.toggle("sel", +b.dataset.lv === level));
    $("lvHint").textContent = hasKw ? HINT[level] : "";
    $("scaffold").innerHTML = !hasKw
      ? `<p class="muted">키워드 준비 중입니다. 대신 스크립트의 핵심 표현을 참고하세요.</p>${chipGroup("표현", "kp", fallback)}`
      : (level === 1 && beats.length ? `<ol class="beats">${beats.map((b) => `<li>${esc(b)}</li>`).join("")}</ol>` : "") +
        (level <= 2 ? chipGroup("동사", "verb", verbs) : "") + chipGroup("명사", "noun", nouns);
    $("scaffold").querySelectorAll("[data-chip]").forEach((b) => (b.onclick = () => {
      const k = b.dataset.chip;
      if (used.has(k)) used.delete(k); else used.add(k);
      b.classList.toggle("used", used.has(k)); b.setAttribute("aria-pressed", used.has(k));
      const all = shownChips();
      if (used.has(k) && all.length && all.every((c) => used.has(c))) toast("키워드를 모두 사용했어요!");
    }));
  }
  document.querySelectorAll("[data-lv]").forEach((b) => (b.onclick = () => {
    level = +b.dataset.lv; db.setSetting("drillLevel", level); renderScaffold();
  }));
  renderScaffold();

  // 질문 / 스크립트 / 모델 답변
  $("qPlay").onclick = () => { stopAll(); qAudio.currentTime = 0; qAudio.playbackRate = 1; qAudio.play(); };
  $("showScript").onclick = () => { const h = $("script").toggleAttribute("hidden"); $("showScript").textContent = h ? "스크립트 보기" : "스크립트 숨기기"; };
  if (aAudio) {
    aAudio.onplay = () => ($("aPlay").textContent = "⏸ 일시정지");
    aAudio.onpause = () => ($("aPlay").textContent = "🔊 모델 답변 듣기");
    $("aPlay").onclick = async () => {
      if (!aAudio.paused) { aAudio.pause(); return; }
      stopAll(); aAudio.playbackRate = +(await db.getSetting("speed", "0.9")); aAudio.play();
    };
  }
  // 평가
  document.querySelectorAll("[data-st]").forEach((b) => (b.onclick = async () => {
    await updateProgress(sid, no, { status: b.dataset.st, lastPracticed: new Date().toISOString().slice(0, 10) });
    document.querySelectorAll("[data-st]").forEach((x) => x.classList.toggle("sel", x === b));
    toast(`"${STATUS[b.dataset.st]}"로 표시했습니다`);
  }));

  // 내 녹음 목록
  async function renderRecs() {
    urls.forEach(URL.revokeObjectURL); urls = [];
    const list = (await db.recs(keyOf(sid, no))).sort((a, b) => b.createdAt - a.createdAt);
    $("recList").innerHTML = list.length ? list.map((r, i) => {
      const u = URL.createObjectURL(r.blob); urls.push(u);
      const d = new Date(r.createdAt);
      return `<div class="rec-item"><span class="grow">${i === 0 ? "최근 · " : ""}${d.getMonth() + 1}/${d.getDate()} ${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")} · ${fmtTime(r.durationSec)}</span>
        <button data-play="${u}">▶</button><button data-del="${r.id}">🗑</button></div>`;
    }).join("") : '<p class="muted">아직 녹음이 없습니다.</p>';
    $("recList").querySelectorAll("[data-play]").forEach((b) => (b.onclick = () => {
      if (recording) return;
      stopAll(); myAudio = new Audio(b.dataset.play); myAudio.play();
    }));
    $("recList").querySelectorAll("[data-del]").forEach((b) => (b.onclick = async () => {
      await db.delRec(+b.dataset.del); renderRecs();
    }));
  }
  renderRecs();

  // 녹음 (녹음 중에는 오디오 재생 차단)
  $("rec").onclick = async () => {
    if (recording) {
      clearInterval(timerId);
      const r = await recorder.stop();
      stream.getTracks().forEach((t) => t.stop());
      recording = false; $("rec").textContent = "● 녹음"; setBusy(false);
      await saveRecording(sid, no, r.blob, r.mime, r.durationSec);
      $("attempts").textContent = `${(await db.getProgress(keyOf(sid, no))).attempts}회 연습`;
      renderRecs(); toast("녹음을 저장했습니다");
      return;
    }
    try { stream = await getMic(); } catch (e) { return toast(e.message); }
    stopAll(); setBusy(true);
    recorder = startRecording(stream); recording = true;
    $("rec").textContent = "■ 정지";
    const t0 = Date.now();
    timerId = setInterval(() => ($("recTimer").textContent = fmtTime((Date.now() - t0) / 1000)), 250);
  };

  cleanup = () => {
    clearInterval(timerId); stopAll();
    if (recording && stream) stream.getTracks().forEach((t) => t.stop());
    urls.forEach(URL.revokeObjectURL);
  };
}

/* ---------- 실전 모드 ---------- */
async function viewExam(sid) {
  const set = DATA.sets.find((s) => s.id === sid);
  if (!set) return (location.hash = "#/");
  const items = set.groups.flatMap((g) => g.questions.map((q) => ({ g, q })));
  $app.innerHTML = topbar(`opic${sid} 실전 모드`) + `<div class="stage">
    <p>Eva의 질문을 듣고, 질문이 끝나면 3초 뒤 자동으로 녹음이 시작됩니다.<br>답변이 끝나면 <b>답변 끝</b>을 누르세요. (목표 60~90초)</p>
    <p class="muted">질문 다시 듣기는 문항당 1회만 가능합니다. 마이크 권한을 허용해 주세요.</p>
    <button class="primary big" id="start">시작 (${items.length}문항)</button></div>`;
  const stage = () => $app.querySelector(".stage");

  let stream = null, audio = null, timerId = null, cdId = null, rec = null, aborted = false;
  cleanup = () => {
    aborted = true; clearInterval(timerId); clearInterval(cdId);
    audio?.pause(); stream?.getTracks().forEach((t) => t.stop());
  };
  document.getElementById("start").onclick = async () => {
    try { stream = await getMic(); } catch (e) { return toast(e.message); }
    const results = [];
    for (let i = 0; i < items.length && !aborted; i++) {
      const { q } = items[i];
      const dur = await runQuestion(q, i);
      if (aborted) return;
      results.push({ q, dur });
    }
    if (aborted) return;
    stream.getTracks().forEach((t) => t.stop());
    stage().innerHTML = `<div class="big-no">수고하셨습니다 🎉</div><p class="muted">각 문항의 녹음은 학습 모드에서 다시 들을 수 있습니다.</p>
      <div class="card" style="text-align:left">${results.map((r) => `<a class="qrow" href="#/practice/${sid}/${r.q.no}"><span class="no">Q${r.q.no}</span><span class="tt">${esc(r.q.title || r.q.text)}</span><span class="muted">${fmtTime(r.dur)}</span></a>`).join("")}</div>
      <a class="btn primary big" href="#/set/${sid}">세트로 돌아가기</a>`;
  };

  function runQuestion(q, i) {
    return new Promise((resolve) => {
      let replayLeft = 1;
      const render = (body) => (stage().innerHTML = `<div class="big-no">Q${q.no} / ${items[items.length - 1].q.no}</div>${body}`);
      const play = () => {
        render(`<p>🔊 질문을 듣고 있습니다…</p>`);
        audio = new Audio(q.qAudio);
        audio.onended = countdown;
        audio.onerror = () => { toast("질문 음원을 불러오지 못했습니다"); countdown(); };
        audio.play().catch(() => {
          render(`<button class="primary big" id="pl">▶ 질문 재생</button>`);
          document.getElementById("pl").onclick = () => { render(`<p>🔊 질문을 듣고 있습니다…</p>`); audio.play(); };
        });
      };
      const countdown = () => {
        let n = 3;
        const draw = () => render(`<div class="count">${n}</div>
          <button id="replay" ${replayLeft ? "" : "disabled"}>질문 다시 듣기 (${replayLeft})</button>`);
        draw();
        document.getElementById("replay").onclick = () => { replayLeft--; clearInterval(cdId); play(); };
        cdId = setInterval(() => {
          n--;
          if (n <= 0) { clearInterval(cdId); return record(); }
          draw();
          const btn = document.getElementById("replay");
          if (btn) btn.onclick = () => { replayLeft--; clearInterval(cdId); play(); };
        }, 1000);
      };
      const record = () => {
        rec = startRecording(stream);
        const t0 = Date.now();
        render(`<p><span class="dot"></span>녹음 중</p><div class="timer" id="t">00:00</div>
          <p class="muted">${i + 1} / ${items.length}</p><button class="rec big" id="stop">답변 끝</button>`);
        timerId = setInterval(() => { const t = document.getElementById("t"); if (t) t.textContent = fmtTime((Date.now() - t0) / 1000); }, 250);
        document.getElementById("stop").onclick = async () => {
          clearInterval(timerId);
          const r = await rec.stop();
          await saveRecording(sid, q.no, r.blob, r.mime, r.durationSec);
          resolve(r.durationSec);
        };
      };
      play();
    });
  }
}

/* ---------- 기초 모드(기본 표현 · 필러 연습) ---------- */
let BASICS = null, basicsP = null;
/** basics.json 은 기초 모드 진입 시 한 번만 로드해 캐시. 실패하면 null 반환 + 안내문 */
function loadBasics() {
  if (BASICS) return Promise.resolve(BASICS);
  if (!basicsP) basicsP = fetch("data/basics.json", { cache: "no-cache" }).then((r) => { if (!r.ok) throw new Error(r.status); return r.json(); })
    .then((j) => (BASICS = j)).catch((e) => { basicsP = null; throw e; });
  return basicsP;
}
async function needBasics(title) {
  try { return await loadBasics(); }
  catch (e) {
    $app.innerHTML = topbar(title) + `<p class="muted">기초 모드 데이터를 불러오지 못했습니다. 데이터를 다시 빌드한 뒤 확인해 주세요. (${esc(e.message)})</p>`;
    return null;
  }
}
const today = () => new Date().toISOString().slice(0, 10);
const shuffle = (a) => { a = a.slice(); for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; } return a; };
const bKey = (id) => "basic:" + id;
async function loadMastery(items) {
  const m = new Map();
  await Promise.all(items.map(async (it) => m.set(it.id, await db.getSetting(bKey(it.id), null))));
  return m;
}
/** 진행 기록 저장: {mastered, reps, last}. rep=true 면 연습 횟수 +1 */
async function bumpBasic(id, { mastered, rep }) {
  const cur = (await db.getSetting(bKey(id), null)) || { mastered: false, reps: 0 };
  const next = { mastered: mastered ?? !!cur.mastered, reps: (cur.reps || 0) + (rep ? 1 : 0), last: today() };
  await db.setSetting(bKey(id), next);
  return next;
}
/** 오디오 재생 + 대기를 한 곳에서 관리(정리 시 전부 취소) */
function makeAudioCtl() {
  let a = null, pending = null; const timers = new Map();
  const ctl = {
    play(src, rate = 1) {
      ctl.stop();
      return new Promise((res) => {
        const au = a = new Audio(src); au.playbackRate = rate; pending = res;
        const fin = (v) => { if (a === au) { a = null; pending = null; } res(v); };
        au.onended = () => fin({ ok: true, dur: (isFinite(au.duration) ? au.duration : 0) / rate });
        au.onerror = () => fin({ ok: false, dur: 0 });
        au.play().catch(() => fin({ ok: false, dur: 0 }));
      });
    },
    sleep: (ms) => new Promise((res) => { const id = setTimeout(() => { timers.delete(id); res(); }, ms); timers.set(id, res); }),
    stop() {
      if (a) { a.onended = a.onerror = null; a.pause(); a = null; }
      if (pending) { const p = pending; pending = null; p({ ok: false, cancelled: true, dur: 0 }); }
      timers.forEach((res, id) => { clearTimeout(id); res(); }); timers.clear();
    },
  };
  return ctl;
}
const SPEEDS = ["0.75", "0.9", "1"];
const speedSel = (v) => `<select class="spd" aria-label="배속">${SPEEDS.map((x) => `<option value="${x}" ${x === v ? "selected" : ""}>${x}x</option>`).join("")}</select>`;

/* 기초 홈 */
async function viewBasicHome() {
  const B = await needBasics("기초 모드"); if (!B) return;
  const all = [...B.categories.flatMap((c) => c.items), ...B.fillerGroups.flatMap((g) => g.items)];
  const mast = await loadMastery(all);
  const card = (href, label, items) => {
    const done = items.filter((it) => mast.get(it.id)?.mastered).length;
    return `<a class="card theme-card" href="${href}"><div class="row spread"><b>${esc(label)}</b><span class="muted">${done}/${items.length} 마스터</span></div>
      <div class="bar"><i style="width:${items.length ? (done / items.length) * 100 : 0}%"></i></div><span class="muted">항목 ${items.length}개</span></a>`;
  };
  $app.innerHTML = topbar("기초 모드") +
    `<p class="muted">자주 쓰는 표현을 반복해 입에 붙이고, 필러로 말이 끊기지 않게 이어 가는 연습입니다.</p>` +
    `<h2>① 기본 표현</h2>` + B.categories.map((c) => card(`#/basic/x/${encodeURIComponent(c.id)}`, c.label, c.items)).join("") +
    `<h2>② 필러 연습</h2>` + B.fillerGroups.map((g) => card(`#/basic/f/${encodeURIComponent(g.id)}`, g.label, g.items)).join("") +
    `<a class="btn primary big" href="#/basic/chain" style="margin-top:12px">필러 챌린지 — 45초 이어 말하기</a>`;
}

/* 카테고리 항목 목록 */
async function viewBasicCat(catId) {
  const B = await needBasics("기초 모드"); if (!B) return;
  const cat = B.categories.find((c) => c.id === catId);
  if (!cat) return (location.hash = "#/basic");
  const mast = await loadMastery(cat.items);
  const base = `#/basic/x/${encodeURIComponent(catId)}`;
  $app.innerHTML = topbar(cat.label, "#/basic") +
    `<div class="row"><a class="btn primary grow" href="${base}/0">처음부터 묶어서 연습</a><a class="btn grow" href="${base}/0?tab=mix">섞어 말하기</a></div><div class="card">` +
    cat.items.map((it, i) => `<a class="qrow brow" href="${base}/${i}"><span class="no">${i + 1}</span>
      <span class="tt2"><b>${esc(it.pattern)}</b><span class="muted">${esc(it.meaning)}</span></span>${mast.get(it.id)?.mastered ? '<span class="ck" title="마스터">✔</span>' : ""}</a>`).join("") + `</div>`;
}

/* 패턴/필러 카드(공통) — kind: "x" 표현, "f" 필러 */
async function viewBasicCard(kind, gid, idx, params) {
  const B = await needBasics("기초 모드"); if (!B) return;
  const grp = (kind === "x" ? B.categories : B.fillerGroups).find((g) => g.id === gid);
  if (!grp) return (location.hash = "#/basic");
  const list = grp.items;
  if (!list.length) return (location.hash = "#/basic");
  if (idx < 0 || idx >= list.length) return (location.hash = `#/basic/${kind}/${encodeURIComponent(gid)}/0`);
  const item = list[idx];
  const key = (it) => (kind === "x" ? it.pattern : it.filler);
  const base = `#/basic/${kind}/${encodeURIComponent(gid)}`;
  const TABS = kind === "x" ? [["listen", "① 듣기"], ["repeat", "② 따라 말하기"], ["swap", "③ 바꿔 말하기"], ["mix", "④ 섞어 말하기"]]
    : [["listen", "① 듣기"], ["repeat", "② 따라 말하기"]];
  let tab = params.get("tab"); if (!TABS.some((t) => t[0] === tab)) tab = "listen";
  let speed = await db.getSetting("basicSpeed", "0.9"); if (!SPEEDS.includes(speed)) speed = "0.9";
  let mast = await db.getSetting(bKey(item.id), null);
  const sents = [{ tag: kind === "x" ? "패턴" : "필러", en: key(item), ko: item.meaning, audio: item.audio },
    ...(item.examples || []).map((e, i) => ({ tag: "예문 " + (i + 1), en: e.en, ko: e.ko, audio: e.audio }))];
  const prev = idx > 0 ? `${base}/${idx - 1}` : null, next = idx < list.length - 1 ? `${base}/${idx + 1}` : null;

  $app.innerHTML = topbar(grp.label, kind === "x" ? base : "#/basic") + `
    <div class="card" id="head"></div>
    <div class="tabs" role="tablist">${TABS.map(([k, l]) => `<button role="tab" data-tab="${k}">${l}</button>`).join("")}</div>
    <div class="card" id="body"></div>
    <div class="row spread" id="foot"></div>
    <div class="nav">${prev ? `<button onclick="location.hash='${prev}'">‹ 이전</button>` : "<span style='flex:1'></span>"}
      ${next ? `<button class="primary" onclick="location.hash='${next}'">다음 ›</button>` : "<span style='flex:1'></span>"}</div>`;
  const $ = (id) => document.getElementById(id);
  const ctl = makeAudioCtl();
  let run = 0, stream = null, recorder = null, tmpUrl = null, recTimer = null, recording = false;
  const stopMic = () => { clearInterval(recTimer); stream?.getTracks().forEach((t) => t.stop()); stream = null; recording = false; };
  const halt = () => { run++; ctl.stop(); };
  cleanup = () => { halt(); stopMic(); if (tmpUrl) URL.revokeObjectURL(tmpUrl); };

  const head = () => {
    $("head").innerHTML = tab === "mix" ? `<b>섞어 말하기</b> <span class="muted">${esc(grp.label)} 패턴을 한글 뜻만 보고 말해 보세요</span>`
      : `<div class="row spread"><span class="muted">${idx + 1} / ${list.length}</span>${mast?.mastered ? '<span class="ck">✔ 마스터</span>' : ""}</div>
        <div class="pat">${esc(key(item))}</div><div>${esc(item.meaning)}</div>${item.when ? `<p class="muted">${esc(item.when)}</p>` : ""}`;
  };
  const foot = () => {
    $("foot").innerHTML = tab === "mix" ? "" : `<button id="mastBtn" class="${mast?.mastered ? "sel" : ""}">${mast?.mastered ? "✔ 마스터함 (해제)" : "알았어요 (마스터 표시)"}</button>
      <span class="muted">${mast?.reps || 0}회 연습</span>`;
    const b = $("mastBtn");
    if (b) b.onclick = async () => { mast = await bumpBasic(item.id, { mastered: !mast?.mastered }); head(); foot(); toast(mast.mastered ? "마스터로 표시했어요" : "표시를 해제했어요"); };
  };
  const setSpeed = (v) => { speed = v; db.setSetting("basicSpeed", v); };

  /* ① 듣기 */
  function tabListen() {
    $("body").innerHTML = `<div class="row spread"><b>듣기</b>${speedSel(speed)}</div>` +
      sents.map((s, i) => `<div class="sent"><button data-p="${i}" aria-label="재생">▶</button>
        <div class="grow"><div class="tg">${esc(s.tag)}</div><div class="en">${esc(s.en)}</div><div class="muted">${esc(s.ko)}</div></div></div>`).join("");
    $("body").querySelector(".spd").onchange = (e) => setSpeed(e.target.value);
    $("body").querySelectorAll("[data-p]").forEach((b) => (b.onclick = async () => {
      const my = ++run; const r = await ctl.play(sents[+b.dataset.p].audio, +speed);
      if (my === run && !r.ok && !r.cancelled) toast("음원을 재생하지 못했습니다");
    }));
  }

  /* ② 따라 말하기: 듣기 → 클립 길이만큼 무음 → 반복 */
  function tabRepeat() {
    let n = 3, sel = 0, tmpHtml = "";
    const draw = () => {
      $("body").innerHTML = `<div class="row spread"><b>따라 말하기</b>${speedSel(speed)}</div>
        <p class="muted">문장을 고르고 시작하면 소리가 나온 뒤, 같은 길이의 빈 시간에 따라 말합니다.</p>
        <div class="chips">${sents.map((s, i) => `<button class="chip ${i === sel ? "sel" : ""}" data-s="${i}">${esc(s.tag)}</button>`).join("")}</div>
        <div class="sent-big"><div class="en">${esc(sents[sel].en)}</div><div class="muted">${esc(sents[sel].ko)}</div></div>
        <div class="row"><span class="muted">반복</span><button data-n="3" class="${n === 3 ? "sel" : ""}">3회</button><button data-n="5" class="${n === 5 ? "sel" : ""}">5회</button>
          <button class="primary grow" id="go">▶ 시작</button></div>
        <div class="step" id="st" aria-live="polite">&nbsp;</div><div class="bar"><i id="pg" style="width:0"></i></div>
        <div class="row spread" style="margin-top:8px"><button id="rec" class="rec">● 녹음 (선택)</button><span class="timer" id="rt">00:00</span></div><div id="mine">${tmpHtml}</div>`;
      $("body").querySelector(".spd").onchange = (e) => setSpeed(e.target.value);
      $("body").querySelectorAll("[data-s]").forEach((b) => (b.onclick = () => { halt(); sel = +b.dataset.s; draw(); }));
      $("body").querySelectorAll("[data-n]").forEach((b) => (b.onclick = () => { n = +b.dataset.n; draw(); }));
      $("go").onclick = go; bindRec(); bindMine();
    };
    const bindMine = () => { const p = document.getElementById("myPlay"); if (p) p.onclick = () => { ctl.stop(); new Audio(tmpUrl).play(); }; };
    function bindRec() {
      $("rec").onclick = async () => {
        if (recording) {
          clearInterval(recTimer); const r = await recorder.stop(); stopMic();
          if (tmpUrl) URL.revokeObjectURL(tmpUrl); tmpUrl = URL.createObjectURL(r.blob);
          tmpHtml = `<div class="rec-item"><span class="grow">내 녹음 (임시, 저장 안 됨) · ${fmtTime(r.durationSec)}</span><button id="myPlay">▶</button></div>`;
          $("rec").textContent = "● 녹음 (선택)"; $("mine").innerHTML = tmpHtml; bindMine(); return;
        }
        try { stream = await getMic(); } catch (e) { return toast(e.message); }
        recorder = startRecording(stream); recording = true; $("rec").textContent = "■ 정지";
        const t0 = Date.now(); recTimer = setInterval(() => { const t = document.getElementById("rt"); if (t) t.textContent = fmtTime((Date.now() - t0) / 1000); }, 250);
      };
    }
    async function go() {
      if ($("go").dataset.on) { halt(); draw(); return; }
      const my = ++run; ctl.stop(); $("go").dataset.on = 1; $("go").textContent = "■ 정지";
      const s = sents[sel];
      for (let i = 1; i <= n; i++) {
        $("st").textContent = `${i}/${n} · 듣기`; $("pg").style.width = ((i - 1) / n) * 100 + "%";
        const r = await ctl.play(s.audio, +speed); if (my !== run) return;
        $("st").textContent = `${i}/${n} · 따라 말하세요`;
        await ctl.sleep(Math.max(1200, (r.ok ? r.dur : 2) * 1000 + 300)); if (my !== run) return;
      }
      $("pg").style.width = "100%"; $("st").textContent = "완료!";
      mast = await bumpBasic(item.id, { rep: true }); if (my !== run) return; head(); foot();
      delete $("go").dataset.on; $("go").textContent = "▶ 다시 시작";
    }
    draw();
  }

  /* ③ 바꿔 말하기 (패턴 카드 전용) */
  function tabSwap() {
    let k = 0, shown = false;
    const ex = () => item.examples || [];
    const draw = () => {
      if (!ex().length) { $("body").innerHTML = `<p class="muted">예문이 없습니다.</p>`; return; }
      const e = ex()[k];
      $("body").innerHTML = `<b>바꿔 말하기</b> <span class="muted">${k + 1}/${ex().length}</span>
        <p class="muted">이 상황을 "${esc(key(item))}" 로 영어로 말해 보세요.</p>
        <div class="sent-big"><div class="ko-big">${esc(e.ko)}</div>
        <div id="ans" ${shown ? "" : "hidden"}><div class="en">${esc(e.en)}</div></div></div>
        <div class="row"><button id="show" class="primary grow">${shown ? "▶ 다시 듣기" : "정답 예문 보기 + 듣기"}</button>
        <button id="nx" class="grow">다음 상황 ›</button></div>`;
      $("show").onclick = async () => { shown = true; $("ans").hidden = false; $("show").textContent = "▶ 다시 듣기"; const my = ++run; await ctl.play(e.audio, +speed); void my; };
      $("nx").onclick = () => { halt(); k = (k + 1) % ex().length; shown = false; draw(); };
    };
    draw();
  }

  /* ④ 섞어 말하기 (카테고리 전체, 한글 뜻만 보고) */
  function tabMix() {
    let q = shuffle(list), i = 0, shown = false; const res = { ok: [], again: [] };
    const draw = () => {
      if (i >= q.length) {
        $("body").innerHTML = `<b>요약</b><div class="report"><div><span class="big-n">${res.ok.length}</span> 알았어요</div><div><span class="big-n">${res.again.length}</span> 다시</div></div>` +
          (res.again.length ? `<p class="muted">다시 볼 표현</p>${res.again.map((it) => `<div class="sent"><div class="grow"><b>${esc(key(it))}</b><div class="muted">${esc(it.meaning)}</div></div></div>`).join("")}` : `<p>모두 알고 있어요!</p>`) +
          `<div class="row"><button id="rs" class="primary grow">다시 섞어서 시작</button></div>`;
        $("rs").onclick = () => { q = shuffle(list); i = 0; shown = false; res.ok = []; res.again = []; draw(); };
        return;
      }
      const it = q[i];
      $("body").innerHTML = `<div class="row spread"><b>섞어 말하기</b><span class="muted">${i + 1}/${q.length}</span></div><div class="bar"><i style="width:${(i / q.length) * 100}%"></i></div>
        <div class="sent-big"><div class="ko-big">${esc(it.meaning)}</div><p class="muted">이 뜻의 표현을 소리 내어 말해 보세요.</p>
        <div id="ans" ${shown ? "" : "hidden"}><div class="en">${esc(key(it))}</div></div></div>
        <div class="row"><button id="show" class="grow">${shown ? "▶ 다시 듣기" : "정답 보기 + 듣기"}</button></div>
        <div class="row" style="margin-top:8px"><button id="again" class="grow">다시</button><button id="know" class="primary grow">알았어요</button></div>`;
      $("show").onclick = async () => { shown = true; $("ans").hidden = false; $("show").textContent = "▶ 다시 듣기"; ++run; await ctl.play(it.audio, +speed); };
      const adv = (okk) => { halt(); (okk ? res.ok : res.again).push(it); i++; shown = false; draw(); };
      $("know").onclick = async () => { await bumpBasic(it.id, { mastered: true, rep: true }); if (it.id === item.id) mast = await db.getSetting(bKey(item.id), null); adv(true); };
      $("again").onclick = async () => { await bumpBasic(it.id, { rep: true }); adv(false); };
    };
    draw();
  }

  const TAB_FN = { listen: tabListen, repeat: tabRepeat, swap: tabSwap, mix: tabMix };
  function show(t) {
    halt(); if (recording) { recorder?.stop(); stopMic(); }
    tab = t;
    $app.querySelectorAll("[data-tab]").forEach((b) => { const on = b.dataset.tab === t; b.classList.toggle("on", on); b.setAttribute("aria-selected", on); });
    head(); foot(); TAB_FN[t]();
  }
  $app.querySelectorAll("[data-tab]").forEach((b) => (b.onclick = () => show(b.dataset.tab)));
  show(tab);
}

/* 필러 챌린지 */
const SIL = { FLOOR: 0.012, MULT: 3, CAL_MS: 500, MIN_SIL_MS: 350, FRAME_MS: 25, GOAL_S: 45 };
/** 침묵 분석기: AnalyserNode 로 ~25ms 마다 RMS 를 재고, 처음 0.5초의 하위 20% RMS×3(하한 0.012)을 임계값으로 사용.
 *  임계값 아래가 0.35초 이상 이어진 구간만 "침묵"으로 계산한다(단어 사이 짧은 숨은 말한 것으로 본다). */
function makeSilenceMeter(stream) {
  const AC = window.AudioContext || window.webkitAudioContext;
  const ctx = new AC();
  const src = ctx.createMediaStreamSource(stream);
  const an = ctx.createAnalyser(); an.fftSize = 1024; src.connect(an);
  const buf = new Float32Array(an.fftSize);
  const t0 = performance.now();
  const cal = []; let thr = null, silStart = null, last = t0; const sils = [];
  const id = setInterval(() => {
    const now = performance.now(); an.getFloatTimeDomainData(buf);
    let sum = 0; for (let i = 0; i < buf.length; i++) sum += buf[i] * buf[i];
    const rms = Math.sqrt(sum / buf.length); last = now;
    if (thr === null) {
      cal.push(rms);
      if (now - t0 >= SIL.CAL_MS) { cal.sort((a, b) => a - b); thr = Math.max(SIL.FLOOR, cal[Math.floor(cal.length * 0.2)] * SIL.MULT); silStart = null; }
      return;
    }
    if (rms < thr) { if (silStart === null) silStart = now; }
    else if (silStart !== null) { sils.push((now - silStart) / 1000); silStart = null; }
  }, SIL.FRAME_MS);
  if (ctx.state === "suspended") ctx.resume().catch(() => {});
  return {
    stop() {
      clearInterval(id); const now = performance.now();
      if (silStart !== null) sils.push((now - silStart) / 1000);
      ctx.close().catch(() => {});
      const total = (now - t0) / 1000, ana = Math.max(0.001, total - SIL.CAL_MS / 1000);
      const real = sils.filter((d) => d >= SIL.MIN_SIL_MS / 1000);
      const silTotal = real.reduce((a, b) => a + b, 0);
      return { total, threshold: thr, longest: real.length ? Math.max(...real) : 0, long2: real.filter((d) => d >= 2).length,
        ratio: Math.max(0, Math.min(1, 1 - silTotal / ana)) };
    },
    abort() { clearInterval(id); ctx.close().catch(() => {}); },
  };
}

async function viewBasicChain() {
  const B = await needBasics("필러 챌린지"); if (!B) return;
  const chain = B.chain || {};
  const surveyIds = new Set((DATA.themes || []).filter((t) => t.kind === "survey").map((t) => t.id));
  let pool = allQuestions().filter((x) => surveyIds.has(x.g.theme));
  if (!pool.length) pool = allQuestions();
  let cur = pool[Math.floor(Math.random() * pool.length)];
  const ctl = makeAudioCtl();
  let stream = null, recorder = null, meter = null, timerId = null, cdId = null, tmpUrl = null, run = 0, myAudio = null;
  const stopMic = () => { stream?.getTracks().forEach((t) => t.stop()); stream = null; };
  cleanup = () => {
    run++; ctl.stop(); clearInterval(timerId); clearInterval(cdId); meter?.abort(); meter = null; stopMic();
    myAudio?.pause(); if (tmpUrl) URL.revokeObjectURL(tmpUrl);
  };
  const $ = (id) => document.getElementById(id);
  const chips = (label, arr, cls) => (arr && arr.length ? `<div class="chips"><span class="chip-label wide">${label}</span>${arr.map((w) => `<button class="chip ${cls}" data-hl>${esc(w)}</button>`).join("")}</div>` : "");
  const bindChips = () => $app.querySelectorAll("[data-hl]").forEach((b) => (b.onclick = () => b.classList.toggle("hl")));

  function intro() {
    run++; ctl.stop(); clearInterval(timerId); clearInterval(cdId);
    $app.innerHTML = topbar("필러 챌린지", "#/basic") + `
      <div class="card"><div class="row spread"><b>질문</b><button id="qp">▶ 질문 듣기</button></div><p class="qtext">${esc(cur.q.text)}</p></div>
      <div class="card"><b>필러 칩</b> <span class="muted">탭하면 표시되고, 말할 때 소리 내어 써 보세요.</span>
        ${chips("시작", chain.starters, "verb")}${chips("이음", chain.connectors, "noun")}${chips("마무리", chain.closers, "kp")}${chips("막힐 때", chain.rescue, "rescue")}</div>
      <p class="muted">${SIL.GOAL_S}초 동안 끊기지 않고 이어 말해 보세요. 마이크 권한이 필요합니다. 녹음은 저장되지 않습니다.</p>
      <button class="primary big" id="go">시작 (3-2-1)</button>
      <div class="row" style="margin-top:8px"><button id="other" class="grow">다른 질문</button></div>`;
    bindChips();
    $("qp").onclick = () => { ctl.play(cur.q.qAudio, 1); };
    $("other").onclick = () => { if (pool.length > 1) { let n; do { n = pool[Math.floor(Math.random() * pool.length)]; } while (n === cur); cur = n; } intro(); };
    $("go").onclick = begin;
  }
  async function begin() {
    ctl.stop();
    try { stream = await getMic(); } catch (e) { return toast(e.message); }
    const my = ++run; let n = 3;
    $app.innerHTML = topbar("필러 챌린지", "#/basic") + `<div class="stage"><p class="qtext">${esc(cur.q.text)}</p><div class="count" id="cd">3</div><p class="muted">곧 녹음이 시작됩니다</p></div>`;
    cdId = setInterval(() => {
      n--; if (my !== run) return clearInterval(cdId);
      if (n <= 0) { clearInterval(cdId); return record(my); }
      $("cd").textContent = n;
    }, 1000);
  }
  function record(my) {
    if (my !== run || !stream) return;
    let m;
    try { m = makeSilenceMeter(stream); } catch (e) { m = null; }
    meter = m; recorder = startRecording(stream);
    const t0 = Date.now();
    $app.innerHTML = topbar("필러 챌린지", "#/basic") + `<div class="stage"><p class="qtext">${esc(cur.q.text)}</p>
      <p><span class="dot"></span>녹음 중</p><div class="timer" id="t">00:00</div><p class="muted">목표 ${SIL.GOAL_S}초 · 말이 막히면 필러로 이어 가세요</p>
      <div class="bar"><i id="pg" style="width:0"></i></div><button class="rec big" id="end">끝내기</button></div>
      <div class="card">${chips("시작", chain.starters, "verb")}${chips("이음", chain.connectors, "noun")}${chips("막힐 때", chain.rescue, "rescue")}</div>`;
    bindChips();
    let done = false;
    const finish = async () => {
      if (done) return; done = true; clearInterval(timerId);
      const stats = meter ? meter.stop() : null; meter = null;
      const r = await recorder.stop(); stopMic();
      if (my === run) report(stats, r);
    };
    timerId = setInterval(() => {
      const s = (Date.now() - t0) / 1000; const t = $("t"); if (t) t.textContent = fmtTime(s);
      const pg = $("pg"); if (pg) pg.style.width = Math.min(100, (s / SIL.GOAL_S) * 100) + "%";
      if (s >= SIL.GOAL_S) finish();
    }, 250);
    $("end").onclick = finish;
  }
  function report(st, r) {
    if (tmpUrl) URL.revokeObjectURL(tmpUrl); tmpUrl = URL.createObjectURL(r.blob);
    let body;
    if (!st) body = `<p class="muted">이 브라우저에서는 침묵 측정을 지원하지 않습니다. 녹음 시간 ${fmtTime(r.durationSec)}</p>`;
    else {
      const pct = Math.round(st.ratio * 100);
      let msg, rescue = false;
      if (st.longest >= 3) { msg = "막힐 땐 rescue 표현을 쓰세요. 말을 멈추기 전에 한마디 먼저 꺼내는 연습을 해 보세요."; rescue = true; }
      else if (st.longest >= 2) { msg = "조금 끊겼어요. 시작·이음 필러로 다음 말을 준비해 보세요."; }
      else if (pct < 60) { msg = "침묵이 길진 않지만 말한 비율이 낮아요. 문장을 조금 더 이어 보세요."; }
      else msg = "끊김 없이 잘 이어 갔어요!";
      body = `<div class="report"><div><span class="big-n">${fmtTime(st.total)}</span>총 시간</div><div><span class="big-n">${pct}%</span>말한 비율</div>
        <div><span class="big-n">${st.longest.toFixed(1)}초</span>최장 침묵</div><div><span class="big-n">${st.long2}회</span>2초 이상 침묵</div></div>
        <p class="msg ${st.longest >= 3 ? "bad" : st.longest >= 2 ? "warn" : "good"}">${esc(msg)}</p>${rescue ? chips("막힐 때", chain.rescue, "rescue") : ""}`;
    }
    $app.innerHTML = topbar("챌린지 결과", "#/basic") + `<div class="card">${body}</div>
      <div class="card"><b>내 녹음</b> <span class="muted">(임시, 저장 안 됨)</span><div class="row" style="margin-top:8px"><button id="mp">▶ 내 녹음 듣기</button>
        ${cur.q.aAudio ? `<button id="ap">🔊 모델 답변 듣기</button>` : ""}</div></div>
      <div class="row"><button id="again" class="primary grow">다시 도전</button><button id="other" class="grow">다른 질문</button></div>`;
    bindChips();
    $("mp").onclick = () => { ctl.stop(); myAudio?.pause(); myAudio = new Audio(tmpUrl); myAudio.play(); };
    const ap = $("ap"); if (ap) ap.onclick = () => { myAudio?.pause(); ctl.play(cur.q.aAudio, 0.9); };
    $("again").onclick = () => { myAudio?.pause(); intro(); };
    $("other").onclick = () => { myAudio?.pause(); if (pool.length > 1) { let n; do { n = pool[Math.floor(Math.random() * pool.length)]; } while (n === cur); cur = n; } intro(); };
  }
  intro();
}

/* ---------- Survey 모드 (Background Survey 선택 연습 — 다른 콘텐츠와 연동하지 않는 독립 기능) ---------- */
let SURVEY = null, surveyP = null;
/** survey.json 은 Survey 모드 진입 시 한 번만 로드해 캐시 */
function loadSurvey() {
  if (SURVEY) return Promise.resolve(SURVEY);
  if (!surveyP) surveyP = fetch("data/survey.json", { cache: "no-cache" }).then((r) => { if (!r.ok) throw new Error(r.status); return r.json(); })
    .then((j) => (SURVEY = j)).catch((e) => { surveyP = null; throw e; });
  return surveyP;
}
async function needSurvey(title) {
  try { return await loadSurvey(); }
  catch (e) {
    $app.innerHTML = topbar(title) + `<p class="muted">Survey 데이터를 불러오지 못했습니다. 잠시 후 다시 시도해 주세요. (${esc(e.message)})</p>`;
    return null;
  }
}
let svRun = null;    // 진행 중 선택 상태(메모리)
let svResult = null; // 마지막 채점 결과(메모리)
const svQ = (S, id) => S.questions.find((q) => q.id === id);
const svLabel = (q, id) => q.options.find((o) => o.id === id)?.ko ?? id;
const svSum = (S, getN) => S.minTotal.questions.reduce((a, id) => a + getN(id), 0);
const svNos = (S) => { const n = S.minTotal.questions.map((id) => svQ(S, id)?.no); return n.length > 1 ? n[0] + "~" + n[n.length - 1] : String(n[0]); };

/** 저장된 시나리오(없거나 깨졌으면 기본값)를 질문별 {must, count} 로 정규화 */
async function svLoadScenario(S) {
  const saved = await db.getSetting("survey:scenario", null);
  const out = {};
  for (const q of S.questions) {
    const valid = new Set(q.options.map((o) => o.id));
    let src = saved && saved[q.id] && Array.isArray(saved[q.id].must) ? saved[q.id] : (S.defaultScenario || {})[q.id];
    src = src || { must: [] };
    const must = (src.must || []).filter((id) => valid.has(id));
    out[q.id] = q.type === "single" ? { must: must.slice(0, 1), count: 1 }
      : { must, count: Math.max(must.length, +src.count || must.length) };
  }
  return out;
}

/** 질문 1개 채점. 단일: 선택 ∈ must / 복수: must ⊆ 선택 이고 |선택| == count */
function svGrade(q, selSet, sc) {
  const must = sc.must, sel = [...selSet];
  const missing = must.filter((id) => !selSet.has(id));
  const extra = sel.filter((id) => !must.includes(id));
  const expect = q.type === "single" ? 1 : (sc.count || must.length);
  const ok = q.type === "single" ? sel.length === 1 && must.includes(sel[0]) : missing.length === 0 && sel.length === expect;
  return { id: q.id, ok, missing, extra, selected: sel.length, expect, freeAllowed: Math.max(0, expect - must.length) };
}

/** 선택 카드 1개. f: { sel, hint, fb("ok"|"no"|"") } */
function svOptHtml(q, o, f) {
  const marks = [];
  if (f.fb === "ok") marks.push("✔ 맞음");
  else if (f.fb === "no") marks.push("⚠ 시나리오에 없음");
  else if (f.sel) marks.push("✔ 선택");
  if (f.hint && !f.sel) marks.push("★ 시나리오");
  else if (f.hint && f.sel && !f.fb) marks.push("★");
  return `<button type="button" class="opt${f.sel ? " sel" : ""}${f.hint ? " hint" : ""}${f.fb ? " " + f.fb : ""}" role="${q.type === "single" ? "radio" : "checkbox"}"
    aria-checked="${!!f.sel}" data-q="${esc(q.id)}" data-o="${esc(o.id)}"><span class="o-txt"><span class="o-ko">${esc(o.ko)}</span><span class="o-en">${esc(o.en)}</span></span>
    <span class="o-mark">${marks.map(esc).join(" ")}</span></button>`;
}
const svQHead = (q, note) => `<div class="sv-qh"><span class="sv-no">${esc(q.no)}.</span><span class="sv-qt"><b>${esc(q.ko)}</b><span class="o-en">${esc(q.en)}</span></span></div>
  <p class="muted sv-note">${q.type === "single" ? "하나만 선택" : "복수 선택"}${note ? " · " + esc(note) : ""}</p>`;
const svModeLabel = (m) => (m === "exam" ? "시험처럼" : "가이드");

/* 모드 홈 */
async function viewSurveyHome() {
  svRun = null;
  const S = await needSurvey("Survey 모드"); if (!S) return;
  const sc = await svLoadScenario(S);
  const hist = (await db.getSetting("survey:history", [])).slice(-5).reverse();
  const total = svSum(S, (id) => sc[id].count);
  const sum = S.questions.map((q) => {
    const m = sc[q.id].must, free = q.type === "multi" ? sc[q.id].count - m.length : 0;
    return `<div class="sv-sum"><b>${esc(q.no)}. ${esc(q.ko)}</b><div class="muted">${m.length ? esc(m.map((id) => svLabel(q, id)).join(", ")) : "(미지정)"}${q.type === "multi" ? ` · 총 ${sc[q.id].count}개${free > 0 ? ` (+자유 ${free}개)` : ""}` : ""}</div></div>`;
  }).join("");
  const fmtD = (iso) => { const d = new Date(iso); return isNaN(d) ? "" : `${d.getMonth() + 1}/${d.getDate()} ${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`; };
  $app.innerHTML = topbar("Survey 모드") +
    `<p class="muted">${esc(S.note || "이 연습은 앱의 다른 콘텐츠를 바꾸지 않습니다.")}</p>
    <div class="card"><b>내 시나리오</b>${sum}
      <p class="muted sv-total">${esc(svNos(S))}번 합계 ${total}개${total < S.minTotal.min ? ` (${S.minTotal.min}개 미만 — 수정 필요)` : ""}</p></div>
    <div class="sv-actions"><a class="btn primary" id="svG" href="#/survey/run?mode=guide">가이드 연습</a>
      <a class="btn primary" id="svE" href="#/survey/run?mode=exam">시험처럼 연습</a>
      <a class="btn" href="#/survey/edit">내 시나리오 수정</a></div>
    <div class="card"><b>최근 기록</b>${hist.length ? hist.map((h) => `<div class="qrow sv-hist"><span class="no wide">${esc(fmtD(h.date))}</span>
      <span class="tt">${svModeLabel(h.mode)}</span><span>${Math.round(h.accuracy)}%</span><span class="muted">${fmtTime(h.seconds || 0)}</span></div>`).join("") : '<p class="muted">아직 기록이 없습니다.</p>'}</div>
    <p class="muted">이 시나리오로 나올 수 있는 주제는 <a href="#/drill">연습 모드의 Survey 주제</a>에서 연습하세요. 시험 시기에 따라 항목·조건이 달라질 수 있습니다.</p>`;
  document.getElementById("svG").onclick = document.getElementById("svE").onclick = () => { svRun = null; };
}

/* 실행 화면 */
async function viewSurveyRun(params) {
  const S = await needSurvey("Survey 모드"); if (!S) return;
  const mode = params.get("mode") === "exam" ? "exam" : "guide";
  const onlyIds = (params.get("only") || "").split(",").filter((id) => svQ(S, id));
  const only = onlyIds.length ? new Set(onlyIds) : null;
  const sc = await svLoadScenario(S);
  const key = mode + "|" + onlyIds.join(",");
  if (!svRun || svRun.key !== key) svRun = { key, mode, only, sc, t0: Date.now(), sel: Object.fromEntries(S.questions.map((q) => [q.id, new Set()])) };
  const run = svRun;
  const pages = S.pages.map((p) => p.questions.filter((id) => !only || only.has(id))).filter((a) => a.length);
  if (!pages.length) return (location.hash = "#/survey");
  const page = Math.min(pages.length, Math.max(1, parseInt(params.get("page"), 10) || 1));
  const base = `#/survey/run?mode=${mode}${onlyIds.length ? "&only=" + onlyIds.join(",") : ""}`;
  const last = page === pages.length;
  const askedIds = pages.flat();

  $app.innerHTML = `<div class="topbar"><a class="back" href="#/survey" aria-label="뒤로">‹</a>
    <div class="title">${svModeLabel(mode)} 연습 · ${page}/${pages.length}쪽</div>${mode === "exam" ? '<span class="timer" id="svT">00:00</span>' : ""}</div>
    <div id="svBody"></div>`;
  const $ = (id) => document.getElementById(id);
  const tb = $app.querySelector(".topbar");
  const tick = () => { const t = $("svT"); if (t) t.textContent = fmtTime((Date.now() - run.t0) / 1000); };
  tick();
  const timerId = mode === "exam" ? setInterval(tick, 500) : null;
  let submitting = false;
  cleanup = () => { clearInterval(timerId); };

  function draw() {
    const y = window.scrollY;
    const qs = pages[page - 1].map((id) => svQ(S, id));
    const total = svSum(S, (id) => run.sel[id].size);
    const needMin = !only && S.minTotal.questions.every((id) => pages[page - 1].includes(id));
    const singlesDone = qs.every((q) => q.type !== "single" || run.sel[q.id].size > 0);
    let reason = "";
    if (!singlesDone) reason = "모든 질문에서 하나씩 선택해 주세요.";
    else if (needMin && total < S.minTotal.min) reason = `${svNos(S)}번 합계가 ${S.minTotal.min}개 이상이어야 합니다. (현재 ${total}개)`;
    $("svBody").innerHTML =
      (needMin ? `<div class="counter ${total >= S.minTotal.min ? "met" : ""}" id="svCnt" style="top:${tb.offsetHeight}px">선택 ${total}개 / ${S.minTotal.min}개 이상 필요${total >= S.minTotal.min ? " ✔" : ""}</div>` : "") +
      qs.map((q) => {
        const c = run.sc[q.id], selSet = run.sel[q.id];
        const note = mode === "guide" ? (q.type === "single" ? "총 1개 선택" : `총 ${c.count}개 선택 (현재 ${selSet.size}개)`) : (q.type === "multi" ? `현재 ${selSet.size}개` : "");
        return `<section class="card sv-q">${svQHead(q, note)}<div class="sv-opts" role="${q.type === "single" ? "radiogroup" : "group"}">` +
          q.options.map((o) => {
            const sel = selSet.has(o.id), inMust = c.must.includes(o.id);
            return svOptHtml(q, o, { sel, hint: mode === "guide" && inMust, fb: mode === "guide" && sel ? (inMust ? "ok" : "no") : "" });
          }).join("") + `</div></section>`;
      }).join("") +
      `<div class="sv-actions">${page > 1 ? `<a class="btn" href="${base}&page=${page - 1}">‹ Back</a>` : ""}
        <button type="button" class="primary" id="svNext" ${reason ? "disabled" : ""}>${last ? "제출" : "Next ›"}</button></div>` +
      `<p class="muted sv-reason" id="svReason" ${reason ? "" : "hidden"}>${esc(reason)}</p>`;
    window.scrollTo(0, y);
    $("svNext").onclick = async () => {
      if (submitting) return;
      if (!last) { location.hash = `${base}&page=${page + 1}`; return; }
      submitting = true; $("svNext").disabled = true;
      const seconds = Math.round((Date.now() - run.t0) / 1000);
      const per = askedIds.map((id) => svGrade(svQ(S, id), run.sel[id], run.sc[id]));
      const correct = per.filter((r) => r.ok).length;
      const accuracy = per.length ? (correct / per.length) * 100 : 0;
      let prev = null;
      try {
        const hist = await db.getSetting("survey:history", []);
        prev = hist.length ? hist[hist.length - 1] : null;
        await db.setSetting("survey:history", [...hist, { date: new Date().toISOString(), mode, accuracy: Math.round(accuracy * 10) / 10, seconds, wrong: per.length - correct }].slice(-20));
      } catch (e) { toast("기록을 저장하지 못했습니다"); }
      svResult = { mode, per, correct, accuracy, seconds, prev };
      svRun = null;
      location.hash = "#/survey/result";
    };
  }
  $("svBody").addEventListener("click", (e) => {
    const b = e.target.closest(".opt"); if (!b) return;
    const q = svQ(S, b.dataset.q), set = run.sel[q.id], id = b.dataset.o;
    if (q.type === "single") { set.clear(); set.add(id); }
    else if (set.has(id)) set.delete(id); else set.add(id);
    draw();
  });
  draw();
}

/* 결과 */
async function viewSurveyResult() {
  const S = await needSurvey("Survey 결과"); if (!S) return;
  const R = svResult;
  if (!R) return (location.hash = "#/survey");
  const pct = Math.round(R.accuracy);
  let cmp = "첫 기록입니다";
  if (R.prev) { const d = pct - Math.round(R.prev.accuracy); cmp = `직전 기록(${Math.round(R.prev.accuracy)}%) 대비 ${d > 0 ? "+" : ""}${d}%p`; }
  const wrongIds = R.per.filter((r) => !r.ok).map((r) => r.id);
  const list = (q, ids) => ids.map((id) => svLabel(q, id)).join(", ");
  $app.innerHTML = topbar("Survey 결과", "#/survey") + `<div class="card"><div class="report">
      <div><span class="big-n">${pct}%</span>정확도 (${R.correct}/${R.per.length})</div><div><span class="big-n">${fmtTime(R.seconds)}</span>소요 시간</div></div>
      <p class="muted">${esc(svModeLabel(R.mode))} · ${esc(cmp)}</p></div>` +
    R.per.map((r) => {
      const q = svQ(S, r.id);
      const lines = [];
      if (!r.ok) {
        if (r.missing.length) lines.push(`빠뜨린 항목: ${esc(list(q, r.missing))}`);
        if (r.extra.length) lines.push(`${q.type === "single" ? "선택한 항목" : "시나리오에 없는데 고른 항목"}: ${esc(list(q, r.extra))}${r.freeAllowed ? ` (자유 선택 허용 ${r.freeAllowed}개)` : ""}`);
        if (q.type === "multi" && r.selected !== r.expect) lines.push(`개수: 선택 ${r.selected}개 / 기준 ${r.expect}개 (${r.selected > r.expect ? "+" : ""}${r.selected - r.expect})`);
        if (q.type === "single" && !r.selected) lines.push("선택하지 않았습니다");
      }
      return `<div class="card sv-res ${r.ok ? "ok" : "bad"}"><div class="row spread"><b>${esc(q.no)}. ${esc(q.ko)}</b><span class="${r.ok ? "ck" : "sv-warn"}">${r.ok ? "✅ 정답" : "⚠ 확인"}</span></div>
        ${lines.map((l) => `<p class="muted sv-line">${l}</p>`).join("")}</div>`;
    }).join("") +
    `<div class="sv-actions">${wrongIds.length ? `<a class="btn primary" id="svW" href="#/survey/run?mode=${R.mode}&only=${wrongIds.join(",")}">틀린 질문만 다시</a>` : ""}
      <a class="btn ${wrongIds.length ? "" : "primary"}" id="svA" href="#/survey/run?mode=${R.mode}">처음부터 다시</a>
      <a class="btn" href="#/survey">모드 홈</a></div>`;
  const reset = () => { svRun = null; };
  const w = document.getElementById("svW"); if (w) w.onclick = reset;
  document.getElementById("svA").onclick = reset;
}

/* 시나리오 편집 */
async function viewSurveyEdit() {
  const S = await needSurvey("시나리오 수정"); if (!S) return;
  const sc = await svLoadScenario(S);
  const auto = {}; // count 가 must 개수를 따라가는 중인지
  for (const q of S.questions) auto[q.id] = sc[q.id].count === sc[q.id].must.length;
  const $ = (id) => document.getElementById(id);
  const warnHtml = () => {
    const t = svSum(S, (id) => sc[id].count);
    return t < S.minTotal.min ? `<span class="sv-warn">⚠ ${svNos(S)}번 합계 ${t}개 — ${S.minTotal.min}개 이상이어야 실제 설문처럼 진행됩니다.</span>` : `<span class="ck">✔ 합계 ${t}개</span>`;
  };
  $app.innerHTML = topbar("시나리오 수정", "#/survey") +
    `<p class="muted">반드시 고를 항목을 정하세요. 복수 질문은 총 선택 개수를 정하면 지정 외 나머지는 자유 선택이 됩니다.</p><div id="svBody"></div>
     <div class="sv-actions"><button type="button" class="primary" id="svSave">저장</button><button type="button" id="svReset">기본값으로 되돌리기</button></div>`;
  function draw() {
    const y = window.scrollY;
    $("svBody").innerHTML = S.questions.map((q) => {
      const c = sc[q.id];
      return `<section class="card sv-q">${svQHead(q, "")}<div class="sv-opts">` +
        q.options.map((o) => svOptHtml(q, o, { sel: c.must.includes(o.id) })).join("") + `</div>` +
        (q.type === "multi" ? `<label class="sv-count">총 개수 <input type="number" inputmode="numeric" min="${c.must.length}" max="${q.options.length}" value="${c.count}" data-cnt="${esc(q.id)}"> 개
          <span class="muted">(지정 ${c.must.length}개${c.count > c.must.length ? ` + 자유 ${c.count - c.must.length}개` : ""})</span></label>` : "") + `</section>`;
    }).join("") + `<p class="sv-sumwarn" id="svWarn">${warnHtml()}</p>`;
    window.scrollTo(0, y);
  }
  $("svBody").addEventListener("click", (e) => {
    const b = e.target.closest(".opt"); if (!b) return;
    const q = svQ(S, b.dataset.q), c = sc[q.id], id = b.dataset.o;
    if (q.type === "single") c.must = [id];
    else {
      c.must = c.must.includes(id) ? c.must.filter((x) => x !== id) : [...c.must, id];
      if (auto[q.id] || c.count < c.must.length) c.count = c.must.length;
    }
    draw();
  });
  $("svBody").addEventListener("input", (e) => {
    const inp = e.target.closest("[data-cnt]"); if (!inp) return;
    const q = svQ(S, inp.dataset.cnt), c = sc[q.id];
    const n = parseInt(inp.value, 10);
    if (!isNaN(n)) { c.count = Math.min(q.options.length, Math.max(c.must.length, n)); auto[q.id] = c.count === c.must.length; }
    $("svWarn").innerHTML = warnHtml();
  });
  $("svBody").addEventListener("change", (e) => { if (e.target.closest("[data-cnt]")) draw(); });
  $("svSave").onclick = async () => {
    const miss = S.questions.find((q) => q.type === "single" && sc[q.id].must.length !== 1);
    if (miss) return toast(`${miss.no}번 질문의 항목을 선택해 주세요`);
    const obj = {};
    for (const q of S.questions) obj[q.id] = { must: sc[q.id].must.slice(), count: sc[q.id].count };
    await db.setSetting("survey:scenario", obj);
    toast("시나리오를 저장했습니다");
  };
  $("svReset").onclick = async () => {
    await db.setSetting("survey:scenario", null);
    const fresh = await svLoadScenario(S);
    for (const q of S.questions) { sc[q.id] = fresh[q.id]; auto[q.id] = fresh[q.id].count === fresh[q.id].must.length; }
    draw(); toast("기본값으로 되돌렸습니다");
  };
  draw();
}

/* ---------- 시작 ---------- */
(async function init() {
  try {
    const res = await fetch("data/questions.json", { cache: "no-cache" });
    DATA = await res.json();
  } catch (e) {
    $app.innerHTML = `<p class="muted">데이터를 불러오지 못했습니다. (${esc(e.message)})</p>`;
    return;
  }
  if ("serviceWorker" in navigator) navigator.serviceWorker.register("sw.js").catch(() => {});
  route();
})();
