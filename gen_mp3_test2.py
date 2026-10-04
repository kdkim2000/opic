"""test2/Opic{N}.txt (N=16~30) 의 질문을 Eva 음성 MP3로 변환한다.

파일명 규칙(기존 test/mp3 와 동일, 앱에서 파싱하기 쉽게 고정):
  test2/mp3/opic{N}/opic{N}_g{그룹번호:02d}_{slug}_q{문항번호:02d}.mp3
  - 돌발 그룹은 slug 앞에 'sudden-', 롤플레이 그룹은 'rp-' 를 붙인다.
  - test2/mp3/manifest.csv 컬럼: set,group,group_name,question,file,text  (file 은 mp3 폴더 기준 상대경로)

사용법:
  python gen_mp3_test2.py --dry-run          # 파일명/매핑만 점검 (음원 생성 안 함)
  python gen_mp3_test2.py 16 17 18           # 지정한 세트만 생성 (여러 에이전트가 병렬 실행 가능)
  python gen_mp3_test2.py --manifest         # 폴더의 결과로 manifest.csv 재구성(전체 세트 기준)
이미 존재하는 mp3 는 건너뛴다(--force 로 재생성).
"""
import re, sys, asyncio, pathlib, csv
ROOT = pathlib.Path(__file__).parent
SRC = ROOT / "test2"
OUT = SRC / "mp3"
VOICE, RATE = "en-US-AvaNeural", "-5%"   # gen_mp3.py 와 동일

# 헤더 문구(괄호 '(돌발)' 제외) → slug. 새 주제가 나오면 여기에 추가한다.
SLUG = {
    "자기소개": "intro", "건강": "health", "카페 / 커피전문점": "cafe", "음악 감상": "music",
    "집 / 거주": "home", "집 / 주거": "home", "공원 가기": "park", "영화 보기": "movie",
    "해변 가기": "beach", "국내여행": "domestic-travel", "해외여행": "overseas-travel",
    "가구": "furniture", "가전제품": "appliance", "가족·친구": "family-friends", "교통수단": "transport",
    "국가 간 관계": "international-relations", "기술": "technology", "날씨": "weather",
    "모임·축하": "gathering", "산업 / 직업": "industry-job", "산업 / 회사 / 커리어": "industry-career",
    "식당 / 외식": "restaurant", "약속": "appointment", "여가 시간": "leisure", "은행": "bank",
    "음식 / 식품": "food", "의류 / 패션": "clothing", "인터넷": "internet", "재활용": "recycling",
    "지형 / 자연": "terrain-nature", "포장 / 배달 음식": "takeout-delivery", "호텔": "hotel",
    "휴대폰": "mobile-phone", "휴일 / 명절": "holiday",
    # 롤플레이 (헤더에서 '롤플레이 — ' 제거 후)
    "건강식품 가게": "health-food-store", "공원": "park", "기술 산업 / 친구": "tech-industry-friend",
    "렌터카": "rental-car", "면접": "interview", "미용실": "hair-salon", "여행사": "travel-agency",
    "자동차 고장": "car-breakdown", "항공편 지연": "flight-delay", "해외여행 / 날씨": "overseas-weather",
    "헬스장": "gym", "호텔 / 분실물": "hotel-lost-item", "홀리데이 파티": "holiday-party",
    "휴대폰 구매": "phone-purchase",
}


def parse(n):
    """세트 n 의 [(그룹번호, 그룹명(slug), 문항번호, 텍스트, 헤더)] 반환."""
    src = next(SRC.glob(f"[Oo]pic{n}.txt"))
    g, grp, hdr, rows = 0, "", "", []
    for line in open(src, encoding="utf-8-sig"):
        line = line.strip()
        m = re.match(r"\[(.+)\]$", line)
        if m and m.group(1) != "Background Survey":
            g += 1
            hdr = m.group(1)
            key = re.sub(r"\s*\(돌발\)$", "", hdr)
            rp = key.startswith("롤플레이")
            key = re.sub(r"^롤플레이\s*—\s*", "", key)
            if key not in SLUG:
                raise SystemExit(f"unmapped group in opic{n}: {hdr!r}")
            grp = SLUG[key]
            if rp:
                grp = "rp-" + grp
            if "(돌발)" in hdr:
                grp = "sudden-" + grp
            continue
        m = re.match(r"Q(\d+)\.\s*(.+)", line)
        if m:
            txt = m.group(2).replace("(*) ", "").replace("(*)", "").strip()
            rows.append((g, grp, int(m.group(1)), txt, hdr))
    return rows


def jobs_for(n):
    out = []
    for g, grp, q, txt, _ in parse(n):
        p = OUT / f"opic{n}" / f"opic{n}_g{g:02d}_{grp}_q{q:02d}.mp3"
        out.append((n, g, grp, q, p, txt))
    return out


async def synth(txt, p):
    import edge_tts
    err = None
    for _ in range(3):
        try:
            await edge_tts.Communicate(txt, VOICE, rate=RATE).save(str(p))
            if p.stat().st_size > 1000:
                return True
        except Exception as e:
            err = e
        await asyncio.sleep(2)
    print("FAIL", p.name, err)
    p.unlink(missing_ok=True)
    return False


async def generate(jobs, force):
    sem = asyncio.Semaphore(4)
    done = 0

    async def w(j):
        nonlocal done
        _, _, _, _, p, txt = j
        if p.exists() and not force:
            return
        p.parent.mkdir(parents=True, exist_ok=True)
        async with sem:
            done += await synth(txt, p)
    await asyncio.gather(*[w(j) for j in jobs])
    print("generated", done, "of", len(jobs))


def write_manifest():
    rows = []
    for n in range(16, 31):
        for _, g, grp, q, p, txt in jobs_for(n):
            if p.exists():
                rows.append([n, g, grp, q, f"opic{n}/{p.name}", txt])
    OUT.mkdir(parents=True, exist_ok=True)
    with open(OUT / "manifest.csv", "w", encoding="utf-8-sig", newline="") as f:
        w = csv.writer(f)
        w.writerow(["set", "group", "group_name", "question", "file", "text"])
        w.writerows(rows)
    print("manifest rows", len(rows))


if __name__ == "__main__":
    a = sys.argv[1:]
    force = "--force" in a
    sets = [int(x) for x in a if x.isdigit()]
    if "--manifest" in a:
        write_manifest()
    elif "--dry-run" in a:
        for n in sets or range(16, 31):
            js = jobs_for(n)
            print(n, len(js), [f"{j[4].name}" for j in js][:3], "...")
        names = [j[4].name for n in range(16, 31) for j in jobs_for(n)]
        assert len(names) == len(set(names)), "중복 파일명"
        print("total", len(names), "unique OK")
    else:
        jobs = [j for n in sets for j in jobs_for(n)]
        asyncio.run(generate(jobs, force))
