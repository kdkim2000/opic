"""basics/expr_*.md, basics/fillers.md 의 패턴·필러·예문을 MP3 로 변환한다 (tools/basics_lib.py 로 파싱).

출력: basics/mp3/<id>_p.mp3, <id>_e1.mp3 ...   (build_data.py 가 app/audio/b/ 로 복사)

사용법:
  python gen_basic_mp3.py                  # 없는 클립만 생성
  python gen_basic_mp3.py --force          # 기존 파일도 재생성
  python gen_basic_mp3.py --only opinion-  # id 접두어로 일부만 (여러 개 가능: --only opinion- stall-)
  python gen_basic_mp3.py --dry-run        # 생성 없이 클립 수·샘플 출력
"""
import sys, asyncio, pathlib

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parent / "tools"))
import basics_lib

ROOT = pathlib.Path(__file__).parent
OUT = ROOT / "basics" / "mp3"
VOICE, RATE = "en-US-AndrewNeural", "-10%"

args = sys.argv[1:]
force = "--force" in args
dry = "--dry-run" in args
only = []
if "--only" in args:
    only = [a for a in args[args.index("--only") + 1:] if not a.startswith("--")]


async def synth(txt, path):
    import edge_tts
    for _ in range(3):
        try:
            await edge_tts.Communicate(txt, VOICE, rate=RATE).save(str(path))
            if path.stat().st_size > 1000:
                return True
        except Exception:
            pass
        await asyncio.sleep(2)
    path.unlink(missing_ok=True)
    print("FAIL", path.name)
    return False


async def run(jobs):
    sem = asyncio.Semaphore(4)

    async def w(j):
        async with sem:
            return await synth(*j)
    return await asyncio.gather(*[w(j) for j in jobs])


def main():
    try:
        allc = basics_lib.clips()
    except basics_lib.BasicsError as e:
        print("ERROR", e)
        sys.exit(1)
    sel = [c for c in allc if not only or any(c[0].startswith(p) for p in only)]
    todo = [(t, OUT / f"{stem}.mp3") for stem, t in sel if force or not (OUT / f"{stem}.mp3").exists()]
    print(f"clips total={len(allc)} selected={len(sel)} to-generate={len(todo)} skipped={len(sel) - len(todo)}")
    if dry:
        for stem, t in sel[:8]:
            print(f"  {stem}: {t}")
        return
    OUT.mkdir(parents=True, exist_ok=True)
    ok = asyncio.run(run(todo)) if todo else []
    print(f"generated {sum(ok)} of {len(todo)}; failed {len(ok) - sum(ok)}; skipped(existing) {len(sel) - len(todo)}")


main()
