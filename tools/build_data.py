"""앱 데이터 생성: app/data/questions.json 을 만들고 음원을 app/audio/ 로 복사한다.

입력
  test/opic{N}.txt                  그룹 헤더([...])와 그룹 순서
  test/mp3/manifest.csv             질문 목록, 질문 텍스트, 질문 MP3 경로
  ansewer/mp3/manifest_opic{N}.csv  모델 답변 MP3 경로
  ansewer/opic{N}_answers.md        스크립트(> 인용문), 핵심 표현(- 핵심:), 문항 제목(## Q번호.)
사용법: python tools/build_data.py
"""
import csv, json, re, shutil, datetime, pathlib

ROOT = pathlib.Path(__file__).resolve().parent.parent
APP = ROOT / "app"
SETS = range(1, 9)


def read_csv(p):
    with open(p, encoding="utf-8-sig", newline="") as f:
        return list(csv.DictReader(f))


def group_headers(n):
    """[그룹] 헤더 목록 (g번호 = 순서)."""
    out = []
    for line in open(ROOT / "test" / f"opic{n}.txt", encoding="utf-8"):
        m = re.match(r"\[(.+)\]\s*$", line.strip())
        if m:
            out.append(m.group(1))
    return out


def parse_answers(n):
    res, cur = {}, None
    p = ROOT / "ansewer" / f"opic{n}_answers.md"
    for line in open(p, encoding="utf-8"):
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
    qrows = read_csv(ROOT / "test" / "mp3" / "manifest.csv")
    sets, warnings, total = [], [], 0
    for n in SETS:
        headers = group_headers(n)
        answers = parse_answers(n)
        arows = {int(r["question"]): r for r in read_csv(ROOT / "ansewer" / "mp3" / f"manifest_opic{n}.csv")}
        groups = {}
        for r in (r for r in qrows if int(r["set"]) == n):
            q, g = int(r["question"]), int(r["group"])
            hdr = headers[g - 1] if g - 1 < len(headers) else r["group_name"]
            grp = groups.setdefault(g, {
                "id": g, "name": r["group_name"], "label": hdr,
                "sudden": "돌발" in hdr, "roleplay": hdr.startswith("롤플레이"), "questions": []})
            a = answers.get(q)
            ar = arows.get(q)
            if not a or not ar:
                warnings.append(f"opic{n} Q{q}: 답변 스크립트/음원 없음 (질문만 포함)")
            q_src = ROOT / "test" / "mp3" / r["file"]
            q_dst = APP / "audio" / "q" / r["file"]
            q_dst.parent.mkdir(parents=True, exist_ok=True)
            shutil.copy2(q_src, q_dst)
            item = {"no": q, "text": r["text"], "title": a["title"] if a else "",
                    "qAudio": f"audio/q/{r['file']}", "aAudio": None,
                    "script": a["script"] if a else "", "keyPoints": a["keyPoints"] if a else []}
            if ar:
                a_src = ROOT / "ansewer" / "mp3" / ar["file"]
                a_dst = APP / "audio" / "a" / f"opic{n}" / ar["file"]
                a_dst.parent.mkdir(parents=True, exist_ok=True)
                shutil.copy2(a_src, a_dst)
                item["aAudio"] = f"audio/a/opic{n}/{ar['file']}"
            grp["questions"].append(item)
            total += 1
        for g in groups.values():
            g["questions"].sort(key=lambda x: x["no"])
        sets.append({"id": n, "groups": [groups[k] for k in sorted(groups)]})

    out = APP / "data" / "questions.json"
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text(json.dumps({"generatedAt": datetime.date.today().isoformat(), "sets": sets},
                              ensure_ascii=False, indent=1), encoding="utf-8")
    print(f"sets={len(sets)} questions={total} -> {out}")
    for w in warnings:
        print("WARN", w)


if __name__ == "__main__":
    main()
