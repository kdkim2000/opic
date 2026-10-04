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
  return viewHome();
}
window.addEventListener("hashchange", route);

const topbar = (title, back = "#/") => `<div class="topbar"><a class="back" href="${back}" aria-label="뒤로">‹</a><div class="title">${esc(title)}</div></div>`;
const badge = (st) => (st && st !== "new" ? `<span class="badge ${st}">${STATUS[st]}</span>` : "");

/* ---------- 홈 ---------- */
async function viewHome() {
  const prog = Object.fromEntries((await db.allProgress()).map((p) => [p.key, p]));
  const hardCount = Object.values(prog).filter((p) => p.status === "hard").length;
  $app.innerHTML = `<h1>OPIc 연습</h1>` + DATA.sets.map((s) => {
    const qs = s.groups.flatMap((g) => g.questions);
    const done = qs.filter((q) => prog[keyOf(s.id, q.no)]?.status === "done").length;
    return `<div class="card"><div class="row spread"><b>opic${s.id}</b><span class="muted">${done}/${qs.length} 완료</span></div>
      <div class="bar"><i style="width:${(done / qs.length) * 100}%"></i></div>
      <div class="row"><a class="btn primary" href="#/exam/${s.id}">실전 모드</a><a class="btn" href="#/set/${s.id}">학습 모드</a></div></div>`;
  }).join("") + `<div class="card"><a class="btn" href="#/hard">어려움 문항 모아 연습 (${hardCount})</a>
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
