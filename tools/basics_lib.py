"""기초 모드(basics) 소스 파서: basics/expr_*.md, basics/fillers.md -> basics.json 과 같은 구조의 딕셔너리.

형식 (utf-8-sig, CRLF 허용)
  expr_N.md                       fillers.md
    # cat: opinion | 의견·생각          # group: stall | 시간 벌기
    ## opinion-01                       ## stall-01
    - pattern: I think (that) ~         - filler: Well,
    - meaning: ...                      - meaning: ...
    - when: ...                         - when: ...
    - ex: English | 한글  (2~3개)       - ex: English | 한글
    - from: 16:8, 19:2  (선택)          # chain
                                        - starters: a | b | c   (starters/connectors/closers/rescue)
오류는 BasicsError(파일명·항목 id 포함)로 보고한다.
"""
import pathlib, re

ROOT = pathlib.Path(__file__).resolve().parent.parent
BASICS = ROOT / "basics"
AUDIO_PREFIX = "audio/b"

CAT_ORDER = ["opinion", "reason", "start", "twist", "feeling", "compare", "describe",
             "habit", "prefer", "ask", "problem", "guess", "wrapup", "thanks"]
GROUP_ORDER = ["stall", "link", "honest", "fix", "explain", "close"]
CHAIN_KEYS = ["starters", "connectors", "closers", "rescue"]


class BasicsError(Exception):
    pass


def speak_text(s):
    """음성 합성용 정리: `~` 제거, 괄호 문자만 제거(내용 유지), 공백 정리."""
    s = s.replace("~", " ").replace("(", "").replace(")", "")
    s = re.sub(r"\s+", " ", s).strip()
    return re.sub(r"\s+([,.!?;:])", r"\1", s)


def _audio(stem):
    return f"{AUDIO_PREFIX}/{stem}.mp3"


def _read_lines(path):
    return pathlib.Path(path).read_text(encoding="utf-8-sig").splitlines()


def _parse_file(path, kind, state):
    """kind: 'cat' | 'group'. state: {'sections': {id: {...}}, 'chain': {...}, 'ids': {id: file}}"""
    fname = pathlib.Path(path).name
    head_re = re.compile(r"#\s*" + ("cat" if kind == "cat" else "group") + r"\s*:\s*([a-z]+)\s*\|\s*(.+?)\s*$")
    sec, item, in_chain = None, None, False
    for ln, raw in enumerate(_read_lines(path), 1):
        line = raw.strip()
        if not line:
            continue
        where = f"{fname}:{ln}"
        if line.startswith("# "):
            if kind == "group" and re.match(r"#\s*chain\s*$", line, re.I):
                in_chain, sec, item = True, None, None
                continue
            m = head_re.match(line)
            if not m:
                raise BasicsError(f"{where}: 헤더 형식 오류 '{line}' (예: # {'cat' if kind == 'cat' else 'group'}: id | 라벨)")
            in_chain, item = False, None
            sid, label = m.group(1), m.group(2)
            valid = CAT_ORDER if kind == "cat" else GROUP_ORDER
            if sid not in valid:
                raise BasicsError(f"{where}: 알 수 없는 {'카테고리' if kind == 'cat' else '필러 그룹'} id '{sid}' (허용: {', '.join(valid)})")
            sec = state["sections"].setdefault(sid, {"id": sid, "label": label, "items": []})
            continue
        if line.startswith("## "):
            if sec is None:
                raise BasicsError(f"{where}: 카테고리/그룹 헤더 이전에 항목 '{line}'")
            iid = line[3:].strip()
            if not re.fullmatch(re.escape(sec["id"]) + r"-\d{2}", iid):
                raise BasicsError(f"{where}: 항목 id '{iid}' 는 '{sec['id']}-NN' 형식이어야 함")
            if iid in state["ids"]:
                raise BasicsError(f"{where}: 항목 id '{iid}' 중복 (이미 {state['ids'][iid]} 에 있음)")
            state["ids"][iid] = fname
            item = {"id": iid, "_file": fname, "_ex": []}
            sec["items"].append(item)
            continue
        m = re.match(r"[-*]\s*([A-Za-z]+)\s*:\s*(.*)$", line)
        if not m:
            raise BasicsError(f"{where}: 해석할 수 없는 줄 '{line}'")
        key, val = m.group(1).lower(), m.group(2).strip()
        if in_chain:
            if key not in CHAIN_KEYS:
                raise BasicsError(f"{where}: chain 키 '{key}' 는 {CHAIN_KEYS} 중 하나여야 함")
            state["chain"][key] = [x.strip() for x in val.split("|") if x.strip()]
            continue
        if item is None:
            raise BasicsError(f"{where}: 항목(## id) 밖의 속성 '{line}'")
        if key == "ex":
            if "|" not in val:
                raise BasicsError(f"{fname} [{item['id']}]: ex 는 '영어 | 한글' 형식이어야 함 -> '{val}'")
            en, ko = (x.strip() for x in val.split("|", 1))
            item["_ex"].append((en, ko))
        elif key == "from":
            item["from"] = [x.strip() for x in val.split(",") if x.strip()]
        elif key in ("pattern", "filler", "meaning", "when"):
            item[key] = val
        else:
            raise BasicsError(f"{fname} [{item['id']}]: 알 수 없는 속성 '{key}'")


def _finish(sections, order, key):
    out = []
    for sid in order:
        sec = sections.get(sid)
        if not sec:
            continue
        items = []
        for it in sec["items"]:
            need = [key, "meaning", "when"]
            miss = [k for k in need if not it.get(k)]
            if miss:
                raise BasicsError(f"{it['_file']} [{it['id']}]: 필수 필드 누락 {', '.join(miss)}")
            if len(it["_ex"]) < 2:
                raise BasicsError(f"{it['_file']} [{it['id']}]: ex 는 2개 이상 필요 (현재 {len(it['_ex'])})")
            if any(not en or not ko for en, ko in it["_ex"]):
                raise BasicsError(f"{it['_file']} [{it['id']}]: ex 의 영어/한글이 비어 있음")
            o = {"id": it["id"], key: it[key], "meaning": it["meaning"], "when": it["when"]}
            if key == "pattern":
                o["from"] = it.get("from", [])
            o["audio"] = _audio(f"{it['id']}_p")
            o["examples"] = [{"en": en, "ko": ko, "audio": _audio(f"{it['id']}_e{i}")}
                             for i, (en, ko) in enumerate(it["_ex"], 1)]
            items.append(o)
        out.append({"id": sec["id"], "label": sec["label"], "items": items})
    return out


def source_files():
    """존재하는 소스 파일: (expr 파일 목록, fillers 경로 또는 None)."""
    exprs = sorted(BASICS.glob("expr_*.md"), key=lambda p: [int(x) if x.isdigit() else x for x in re.split(r"(\d+)", p.name)])
    f = BASICS / "fillers.md"
    return exprs, (f if f.exists() else None)


def parse(basics_dir=None):
    """파싱 결과 {categories, fillerGroups, chain}. 소스가 전혀 없으면 빈 구조."""
    global BASICS
    if basics_dir:
        BASICS = pathlib.Path(basics_dir)
    exprs, fillers = source_files()
    ids = {}
    cs = {"sections": {}, "chain": {}, "ids": ids}
    for p in exprs:
        _parse_file(p, "cat", cs)
    fs = {"sections": {}, "chain": {}, "ids": ids}
    if fillers:
        _parse_file(fillers, "group", fs)
    return {"categories": _finish(cs["sections"], CAT_ORDER, "pattern"),
            "fillerGroups": _finish(fs["sections"], GROUP_ORDER, "filler"),
            "chain": {k: fs["chain"].get(k, []) for k in CHAIN_KEYS}}


def clips(data=None):
    """[(파일명 stem, 음성 합성 텍스트)] — <id>_p, <id>_e1 …"""
    data = data or parse()
    out = []
    for sec in data["categories"] + data["fillerGroups"]:
        for it in sec["items"]:
            out.append((f"{it['id']}_p", speak_text(it.get("pattern") or it.get("filler"))))
            for i, ex in enumerate(it["examples"], 1):
                out.append((f"{it['id']}_e{i}", speak_text(ex["en"])))
    return out


if __name__ == "__main__":
    d = parse()
    print(len(d["categories"]), "categories,", len(d["fillerGroups"]), "groups,", len(clips(d)), "clips")
