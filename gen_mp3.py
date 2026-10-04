import re, asyncio, pathlib, csv, edge_tts

MAP = [("자기소개", "intro"), ("의류", "clothing"), ("호텔", "hotel"), ("생일파티", "birthday-party"), ("집", "home"), ("영화표", "movie-ticket"), ("영화 보기", "movie"),
       ("휴일", "holiday"), ("재활용", "recycling"), ("해변", "beach"), ("국내여행", "domestic-travel"),
       ("해외여행", "overseas-travel"), ("콘서트", "concert"), ("캠핑", "camping"), ("카페", "cafe"),
       ("지형 / 야외", "terrain-outdoor"), ("지형 / 비슷", "terrain-similar-country"),
       ("인터넷", "internet"), ("음악 기기", "music-device"), ("음악 감상", "music"), ("은행", "bank"),
       ("여가", "leisure"), ("약속", "appointment"), ("식당", "restaurant"), ("산업", "industry"),
       ("모임", "gathering"), ("친척 집", "house-sitting"), ("롤플레이 — 여행", "travel"),
       ("병원", "hospital"), ("공원", "park"), ("가구", "furniture"), ("날씨", "weather"),
       ("교통", "transport"), ("가족", "family-friends")]
VOICE = "en-US-AvaNeural"
ROOT = pathlib.Path(__file__).parent
OUT = ROOT / "test" / "mp3"


def slug(h):
    for k, v in MAP:
        if k in h:
            return v
    raise SystemExit("unmapped group: " + h)


jobs, rows = [], []
import sys
SETS = [int(a) for a in sys.argv[1:]] or range(1, 9)
for n in SETS:
    g = 0
    grp = ""
    for line in open(ROOT / "test" / f"opic{n}.txt", encoding="utf-8"):
        line = line.strip()
        m = re.match(r"\[(.+)\]$", line)
        if m:
            g += 1
            hdr = m.group(1)
            grp = slug(hdr)
            if hdr.startswith("롤플레이"):
                grp = "rp-" + grp
            if "돌발" in hdr:
                grp = "sudden-" + grp
            continue
        m = re.match(r"Q(\d+)\.\s*(.+)", line)
        if m:
            q = int(m.group(1))
            txt = m.group(2).replace("(*) ", "").replace("(*)", "")
            d = OUT / f"opic{n}"
            d.mkdir(parents=True, exist_ok=True)
            p = d / f"opic{n}_g{g:02d}_{grp}_q{q:02d}.mp3"
            jobs.append((txt, p))
            rows.append([n, g, grp, q, f"opic{n}/{p.name}", txt])


async def run(txt, p):
    err = None
    for _ in range(3):
        try:
            await edge_tts.Communicate(txt, VOICE, rate="-5%").save(str(p))
            return
        except Exception as e:
            err = e
            await asyncio.sleep(2)
    print("FAIL", p, err)


async def main():
    sem = asyncio.Semaphore(4)

    async def w(j):
        async with sem:
            await run(*j)

    await asyncio.gather(*[w(j) for j in jobs])


asyncio.run(main())
MF = OUT / "manifest.csv"
old = []
if MF.exists():
    old = [r for r in csv.reader(open(MF, encoding="utf-8-sig"))][1:]
    old = [r for r in old if int(r[0]) not in SETS]
with open(MF, "w", encoding="utf-8-sig", newline="") as f:
    w = csv.writer(f)
    w.writerow(["set", "group", "group_name", "question", "file", "text"])
    w.writerows(sorted(old + [[str(c) for c in r] for r in rows], key=lambda r: (int(r[0]), int(r[3]))))
print(len(jobs))
