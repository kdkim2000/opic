"""ansewer/opic{N}_answers.md 의 답변(> 인용문)을 쉐도잉용 MP3로 변환한다.

사용법:
  python gen_answer_mp3.py            # opic1 전체
  python gen_answer_mp3.py 7 13       # opic1 의 Q7, Q13 만 다시 생성 (수정 후)
  python gen_answer_mp3.py --set 2    # opic2 전체 (ansewer/opic2_answers.md 가 있을 때)
파일명은 질문 음원(test/mp3/opic{N}/)과 같은 규칙에 _answer 를 붙인다.
"""
import re, sys, asyncio, csv, pathlib, edge_tts

ROOT = pathlib.Path(__file__).parent
OUT = ROOT / "ansewer" / "mp3"
VOICE = "en-US-AndrewNeural"  # 남성 화자 (쉐도잉용, 자연스러운 미국 영어)
RATE = "-10%"                 # 쉐도잉하기 쉽게 약간 느리게

args = sys.argv[1:]
SET = 1
if "--set" in args:
    i = args.index("--set")
    SET = int(args[i + 1])
    del args[i:i + 2]
ONLY = {int(a) for a in args}

q_files = {}
for p in (ROOT / "test" / "mp3" / f"opic{SET}").glob("*.mp3"):
    q_files[int(re.search(r"_q(\d+)\.mp3$", p.name).group(1))] = p.stem

answers = {}
cur = None
for line in open(ROOT / "ansewer" / f"opic{SET}_answers.md", encoding="utf-8"):
    m = re.match(r"## Q(\d+)\.", line)
    if m:
        cur = int(m.group(1))
        answers[cur] = []
        continue
    if cur and line.startswith(">"):
        t = line[1:].strip()
        if t:
            answers[cur].append(t)


def clean(parts):
    t = " ".join(parts).replace("**", "").replace("⚠️", "")
    t = re.sub(r"\s*\.\.\.\s*", ". ", t)  # 롤플레이 대기 구간
    return re.sub(r"\s+", " ", t).strip()


async def run(txt, path):
    err = None
    for _ in range(3):
        try:
            await edge_tts.Communicate(txt, VOICE, rate=RATE).save(str(path))
            return
        except Exception as e:
            err = e
            await asyncio.sleep(2)
    print("FAIL", path, err)


async def main():
    sem = asyncio.Semaphore(3)

    async def w(txt, path):
        async with sem:
            await run(txt, path)

    await asyncio.gather(*[w(t, p) for t, p in jobs])


OUT.mkdir(parents=True, exist_ok=True)
jobs, rows = [], []
for q in sorted(answers):
    txt = clean(answers[q])
    name = f"{q_files[q]}_answer.mp3"
    rows.append([SET, q, name, txt])
    if not ONLY or q in ONLY:
        jobs.append((txt, OUT / name))

asyncio.run(main())
with open(OUT / f"manifest_opic{SET}.csv", "w", encoding="utf-8-sig", newline="") as f:
    w = csv.writer(f)
    w.writerow(["set", "question", "file", "text"])
    w.writerows(rows)
print("generated", len(jobs))
