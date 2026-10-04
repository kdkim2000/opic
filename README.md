# OPIc 연습 (Eva Practice)

OPIc 모의고사 질문을 Eva 음성으로 듣고, 내 답변 스크립트를 보며 녹음·쉐도잉하는 모바일 우선 PWA와 콘텐츠 제작 도구 모음입니다. 자세한 요구사항은 [PRD.md](PRD.md)를 보세요.

## 구성

| 경로 | 내용 |
| --- | --- |
| `test/` | 이전 문제 1~8: 질문 원문(`opic1~8.txt`)과 질문 MP3(`test/mp3/`, `manifest.csv`) |
| `ansewer/` | 이전 문제 1~8: 답변 스크립트(`opicN_answers.md`)와 모델 답변 MP3(`ansewer/mp3/`) |
| `test2/` | 최신 문제 16~30: 질문 원문(`Opic16~30.txt`)과 질문 MP3(`test2/mp3/opicN/`, `manifest.csv`) |
| `answer2/` | 최신 문제 16~30: 답변 스크립트(`opicN_answers.md`)와 답변 MP3(`answer2/mp3/`, `manifest_opicN.csv`) |
| `app/` | 정적 PWA (`index.html`, `app.js`, `style.css`, `sw.js`) |
| `tools/build_data.py` | 앱 데이터(`app/data/questions.json`) 생성과 음원 복사 |
| `gen_mp3.py` | 질문 MP3 생성 (edge-tts, `en-US-AvaNeural`) |
| `gen_answer_mp3.py` | 답변 MP3 생성 (edge-tts, `en-US-AndrewNeural`) |
| `gen_mp3_test2.py`, `gen_answer_mp3_test2.py` | 최신 문제(16~30)용 질문/답변 MP3 생성. 파일명 규칙은 이전 문제와 동일 |
| `docs/` | AI-DLC 설계 산출물 |

## 사용법

```bash
pip install edge-tts

# 답변 수정 후 MP3 재생성 (세트 번호, 문항 번호 지정 가능)
python gen_answer_mp3.py --set 3 5 7
# 최신 문제(16~30) 답변: python gen_answer_mp3_test2.py 16 --q 3 7   (--force 로 전체 재생성)

# 앱 데이터 생성 + 음원 복사 (세트 1~8 + 16~30, 총 23세트 344문항) (app/audio, app/data/questions.json 은 git 에 올리지 않는다)
python tools/build_data.py

# 로컬 실행
cd app && python -m http.server 8765   # http://localhost:8765
```

폰에서 녹음하려면 HTTPS가 필요하므로 아래 GitHub Pages로 배포해서 사용합니다.

## 배포 (GitHub Actions → GitHub Pages)

`main`(또는 `master`) 브랜치에 푸시하면 [.github/workflows/deploy.yml](.github/workflows/deploy.yml)이 자동으로 실행됩니다.

```text
push → build: python tools/build_data.py   (questions.json 생성, 음원을 app/audio 로 복사)
     → 점검: 문항 수와 음원 누락 검사 (누락이 있으면 배포 중단)
     → app/ 폴더를 Pages 아티팩트로 업로드 → deploy
```

- 빌드에 외부 패키지가 필요 없습니다. (`edge-tts`는 MP3를 새로 만들 때만 로컬에서 사용)
- 음원 원본(`test/mp3`, `ansewer/mp3`)은 저장소에 커밋하고, 앱용 복사본(`app/audio`)과 `questions.json`은 CI가 매번 새로 만듭니다.
- 앱은 상대 경로만 사용하므로 `https://<계정>.github.io/<저장소>/` 같은 하위 경로에서도 동작합니다. (이 구조로 로컬 검증 완료)

### 최초 1회 설정

1. GitHub에 저장소를 만들고 푸시합니다.
2. 저장소 **Settings → Pages → Build and deployment → Source** 를 **GitHub Actions** 로 바꿉니다.
3. **Actions** 탭에서 워크플로 실행이 끝나면 Pages 주소가 표시됩니다. 폰에서 그 주소로 접속해 "홈 화면에 추가"를 하세요.

### 콘텐츠 수정 후 반영

```bash
# 1. ansewer/opicN_answers.md 수정
python gen_answer_mp3.py --set N [문항번호...]   # 바뀐 문항 MP3 재생성
git add -A && git commit -m "답변 수정" && git push   # CI가 빌드·배포
```

### 주의: 공개 범위

GitHub Pages 사이트는 **저장소가 비공개여도 주소를 아는 누구나 접근할 수 있습니다**(Enterprise 플랜 제외). 답변 스크립트와 음원에 가족·직장 이야기가 들어 있으므로, 공개되어도 괜찮은 내용인지 확인하세요. 개인 이야기를 숨기려면 다음 중 하나를 고려합니다.

- 주소(저장소 이름)를 추측하기 어렵게 짓고 공유하지 않기 (보안이 아니라 가림막)
- Netlify/Cloudflare Pages 등 접근 제한(비밀번호)을 지원하는 호스팅 사용
- 스크립트의 실명·회사명 등을 일반화

## 개인정보

답변 스크립트에 가족·직장 등 개인 이야기가 들어 있으므로 저장소는 **비공개(Private)** 로 두는 것을 권장합니다. 단, 위 "주의: 공개 범위"처럼 Pages 사이트 자체는 공개된다는 점에 유의하세요.
