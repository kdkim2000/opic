"""앱 데이터 생성: app/data/questions.json 을 만들고 음원을 app/audio/ 로 복사한다.

입력 (세트별 경로는 SET_CONFIG: 1~8 legacy=test/ansewer, 16~30 latest=test2/answer2)
  test/opic{N}.txt                  그룹 헤더([...])와 그룹 순서
  test/mp3/manifest.csv             질문 목록, 질문 텍스트, 질문 MP3 경로
  ansewer/mp3/manifest_opic{N}.csv  모델 답변 MP3 경로
  ansewer/opic{N}_answers.md        스크립트(> 인용문), 핵심 표현(- 핵심:), 문항 제목(## Q번호.)
사용법: python tools/build_data.py
"""
import csv, json, re, shutil, datetime, pathlib

ROOT = pathlib.Path(__file__).resolve().parent.parent
APP = ROOT / "app"
# 세트별 입력 소스 설정. 질문 manifest 의 file 은 q_dir 기준 상대경로, 답변 파일은 a_mp3 평면 폴더.
LEGACY = dict(series="legacy", header="test/opic{n}.txt", q_manifest="test/mp3/manifest.csv", q_dir="test/mp3",
              a_script="ansewer/opic{n}_answers.md", a_manifest="ansewer/mp3/manifest_opic{n}.csv", a_dir="ansewer/mp3")
LATEST = dict(series="latest", header="test2/Opic{n}.txt", q_manifest="test2/mp3/manifest.csv", q_dir="test2/mp3",
              a_script="answer2/opic{n}_answers.md", a_manifest="answer2/mp3/manifest_opic{n}.csv", a_dir="answer2/mp3")
SET_CONFIG = {**{n: LEGACY for n in range(1, 9)}, **{n: LATEST for n in range(16, 31)}}


def read_csv(p):
    with open(p, encoding="utf-8-sig", newline="") as f:
        return list(csv.DictReader(f))


def group_headers(n, cfg):
    """[그룹] 헤더 목록 (g번호 = 순서). [Background Survey] 블록은 제외."""
    out = []
    for line in open(ROOT / cfg["header"].format(n=n), encoding="utf-8-sig"):
        m = re.match(r"\[(.+)\]\s*$", line.strip())
        if m and m.group(1).strip().lower() != "background survey":
            out.append(m.group(1))
    return out


def parse_answers(n, cfg):
    res, cur = {}, None
    p = ROOT / cfg["a_script"].format(n=n)
    for line in open(p, encoding="utf-8-sig"):
        line = line.rstrip("\n")
        m = re.match(r"## Q(\d+)\.\s*(.*)", line)
        if m:
            cur = int(m.group(1))
            title = re.sub(r"\s*\([^)]*(지어낸|임의|동일|확정)[^)]*\)", "", m.group(2)).strip()
            res[cur] = {"title": title, "script": [], "keyPoints": []}
            continue
        if cur is None:
            continue
        if line.startswith(">"):
            t = line[1:].strip()
            if t:
                res[cur]["script"].append(t)
        elif line.startswith("- 핵심:"):
            res[cur]["keyPoints"] = re.findall(r"`([^`]+)`", line)
    for v in res.values():
        v["script"] = "\n\n".join(v["script"]).replace("⚠️", "").strip()
    return res


def main():
    qcache, sets, warnings, total, counts = {}, [], [], 0, {}
    for n in sorted(SET_CONFIG):
        cfg = SET_CONFIG[n]
        need = [cfg["header"].format(n=n), cfg["a_script"].format(n=n), cfg["a_manifest"].format(n=n), cfg["q_manifest"]]
        absent = [x for x in need if not (ROOT / x).exists()]
        if len(absent) == len(need) or not (ROOT / cfg["q_manifest"]).exists():
            warnings.append(f"opic{n}: 소스 폴더/파일 없음 -> 건너뜀 ({', '.join(absent)})")
            continue
        if absent:
            warnings.append(f"opic{n}: 일부 소스 파일 없음 -> 건너뜀 ({', '.join(absent)})")
            continue
        if cfg["q_manifest"] not in qcache:
            qcache[cfg["q_manifest"]] = read_csv(ROOT / cfg["q_manifest"])
        qrows = qcache[cfg["q_manifest"]]
        headers = group_headers(n, cfg)
        answers = parse_answers(n, cfg)
        arows = {int(r["question"]): r for r in read_csv(ROOT / cfg["a_manifest"].format(n=n))}
        groups, cnt = {}, 0
        for r in (r for r in qrows if int(r["set"]) == n):
            q, g = int(r["question"]), int(r["group"])
            hdr = headers[g - 1] if g - 1 < len(headers) else r["group_name"]
            if g - 1 >= len(headers):
                warnings.append(f"opic{n} Q{q}: 그룹 헤더 없음 (group_name 사용)")
            grp = groups.setdefault(g, {
                "id": g, "name": r["group_name"], "label": hdr,
                "sudden": "돌발" in hdr, "roleplay": hdr.startswith("롤플레이"), "questions": []})
            a = answers.get(q)
            ar = arows.get(q)
            if not a or not ar:
                warnings.append(f"opic{n} Q{q}: 답변 스크립트/음원 없음 (질문만 포함)")
            q_src = ROOT / cfg["q_dir"] / r["file"]
            if not q_src.exists():
                warnings.append(f"opic{n} Q{q}: 질문 음원 파일 없음 {q_src.name} (제외)")
                continue
            q_dst = APP / "audio" / "q" / r["file"]
            q_dst.parent.mkdir(parents=True, exist_ok=True)
            shutil.copy2(q_src, q_dst)
            item = {"no": q, "text": r["text"], "title": a["title"] if a else "",
                    "qAudio": f"audio/q/{r['file']}", "aAudio": None,
                    "script": a["script"] if a else "", "keyPoints": a["keyPoints"] if a else []}
            if ar:
                a_src = ROOT / cfg["a_dir"] / ar["file"]
                if a_src.exists():
                    a_dst = APP / "audio" / "a" / f"opic{n}" / ar["file"]
                    a_dst.parent.mkdir(parents=True, exist_ok=True)
                    shutil.copy2(a_src, a_dst)
                    item["aAudio"] = f"audio/a/opic{n}/{ar['file']}"
                else:
                    warnings.append(f"opic{n} Q{q}: 답변 음원 파일 없음 {ar['file']}")
            grp["questions"].append(item)
            total += 1
            cnt += 1
        for g in groups.values():
            g["questions"].sort(key=lambda x: x["no"])
        sets.append({"id": n, "series": cfg["series"], "groups": [groups[k] for k in sorted(groups)]})
        counts[n] = cnt

    out = APP / "data" / "questions.json"
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text(json.dumps({"generatedAt": datetime.date.today().isoformat(), "sets": sets},
                              ensure_ascii=False, indent=1), encoding="utf-8")
    print(f"sets={len(sets)} questions={total} -> {out}")
    print("per-set:", " ".join(f"{n}:{c}" for n, c in counts.items()))
    print(f"warnings={len(warnings)}")
    for w in warnings:
        print("WARN", w)


if __name__ == "__main__":
    main()
