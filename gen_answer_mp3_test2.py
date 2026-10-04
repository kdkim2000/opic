"""answer2/opic{N}_answers.md (N=16~30) 의 답변(> 인용문)을 쉐도잉용 MP3로 변환한다.

gen_answer_mp3.py 와 같은 음성/속도/파싱 규칙. 파일명은 질문 음원(test2/mp3/opic{N}/)에 _answer 를 붙인다.
출력: answer2/mp3/opic{N}_g##_{slug}_q##_answer.mp3 + answer2/mp3/manifest_opic{N}.csv  (ansewer/mp3 와 동일 구조)

사용법:
  python gen_answer_mp3_test2.py 16 17        # 지정 세트 전체
  python gen_answer_mp3_test2.py 16 --q 3 7   # 16세트의 Q3, Q7 만 (수정 후)
  --force 로 기존 파일도 재생성 (기본은 존재하면 건너뜀)
"""
import re, sys, asyncio, csv, pathlib, edge_tts

ROOT = pathlib.Path(__file__).parent
OUT = ROOT / "answer2" / "mp3"
VOICE, RATE = "en-US-AndrewNeural", "-10%"

args = sys.argv[1:]
force = "--force" in args
only = set()
if "--q" in args:
    i = args.index("--q")
    only = {int(a) for a in args[i + 1:] if a.isdigit()}
    args = args[:i]
sets = [int(a) for a in args if a.isdigit()]


def parse(n):
    ans, cur = {}, None
    for line in open(ROOT / "answer2" / f"opic{n}_answers.md", encoding="utf-8"):
        m = re.match(r"## Q(\d+)\.", line)
        if m:
            cur = int(m.group(1)); ans[cur] = []; continue
        if cur and line.startswith(">") and line[1:].strip():
            ans[cur].append(line[1:].strip())
    return ans


def clean(parts):
    t = " ".join(parts).replace("**", "").replace("⚠️", "")
    t = re.sub(r"\s*\.\.\.\s*", ". ", t)  # 롤플레이 대기 구간
    return re.sub(r"\s+", " ", t).strip()


async def synth(txt, path):
    for _ in range(3):
        try:
            await edge_tts.Communicate(txt, VOICE, rate=RATE).save(str(path))
            if path.stat().st_size > 1000:
                return True
        except Exception as e:
            err = e
        await asyncio.sleep(2)
    path.unlink(missing_ok=True)
    print("FAIL", path.name)
    return False


async def main():
    OUT.mkdir(parents=True, exist_ok=True)
    sem = asyncio.Semaphore(4)
    jobs = []
    for n in sets:
        qf = {int(re.search(r"_q(\d+)\.mp3$", p.name).group(1)): p.stem
              for p in (ROOT / "test2" / "mp3" / f"opic{n}").glob("*.mp3")}
        ans = parse(n)
        assert set(ans) == set(qf), f"opic{n}: 문항 불일치 {set(ans) ^ set(qf)}"
        rows = []
        for q in sorted(ans):
            txt, name = clean(ans[q]), f"{qf[q]}_answer.mp3"
            rows.append([n, q, name, txt])
            path = OUT / name
            if (not only or q in only) and (force or not path.exists()):
                jobs.append((txt, path))
        with open(OUT / f"manifest_opic{n}.csv", "w", encoding="utf-8-sig", newline="") as f:
            w = csv.writer(f); w.writerow(["set", "question", "file", "text"]); w.writerows(rows)

    async def w(j):
        async with sem:
            return await synth(*j)
    ok = await asyncio.gather(*[w(j) for j in jobs])
    print("generated", sum(ok), "of", len(jobs))

asyncio.run(main())
