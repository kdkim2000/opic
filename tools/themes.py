"""주제(theme) 정의와 그룹 슬러그 -> 주제 매핑. 매핑 누락 시 KeyError 로 빌드 실패."""

# (id, label, kind)  -- 목록 순서가 곧 order
_DEFS = [
    ("intro", "자기소개", "intro"),
    ("home", "집·거주", "survey"),
    ("cafe", "카페", "survey"),
    ("music", "음악 감상", "survey"),
    ("movie", "영화", "survey"),
    ("concert", "콘서트", "survey"),
    ("park", "공원·캠핑", "survey"),
    ("beach", "해변", "survey"),
    ("domestic-travel", "국내여행", "survey"),
    ("overseas-travel", "해외여행", "survey"),
    ("health", "건강·운동", "sudden"),
    ("food", "음식·외식·배달", "sudden"),
    ("tech", "기술·인터넷·휴대폰·가전", "sudden"),
    ("nature", "날씨·자연·지형", "sudden"),
    ("daily", "일상·약속·여가·교통", "sudden"),
    ("social", "모임·명절·가족·친구", "sudden"),
    ("work", "산업·직업·회사", "sudden"),
    ("life", "의생활·주거·서비스", "sudden"),
    ("society", "환경·사회", "sudden"),
    ("rp-travel", "롤플레이: 여행", "roleplay"),
    ("rp-service", "롤플레이: 서비스·쇼핑", "roleplay"),
    ("rp-plan", "롤플레이: 약속·계획", "roleplay"),
    ("rp-work", "롤플레이: 직장·생활문제", "roleplay"),
]
THEMES = [{"id": i, "label": l, "kind": k, "order": n} for n, (i, l, k) in enumerate(_DEFS, 1)]

# 접두어를 뗀 슬러그 -> 주제. (sudden- / rp- 는 별도 표)
_PLAIN = {
    "intro": "intro", "home": "home", "cafe": "cafe", "music": "music", "music-device": "music",
    "movie": "movie", "concert": "concert", "park": "park", "camping": "park", "beach": "beach",
    "domestic-travel": "domestic-travel", "overseas-travel": "overseas-travel",
    "family-friends": "social",
}
_SUDDEN = {
    "health": "health",
    "restaurant": "food", "takeout-delivery": "food", "food": "food",
    "internet": "tech", "technology": "tech", "mobile-phone": "tech", "appliance": "tech",
    "weather": "nature", "terrain-outdoor": "nature", "terrain-similar-country": "nature", "terrain-nature": "nature",
    "appointment": "daily", "leisure": "daily", "transport": "daily",
    "gathering": "social", "holiday": "social", "family-friends": "social",
    "industry": "work", "industry-job": "work", "industry-career": "work",
    "clothing": "life", "furniture": "life", "hotel": "life", "bank": "life", "home": "life",
    "recycling": "society", "international-relations": "society",
}
_RP = {
    "rp-travel": ["travel-agency", "rental-car", "flight-delay", "hotel-lost-item", "overseas-weather", "travel", "beach"],
    "rp-service": ["hair-salon", "health-food-store", "gym", "phone-purchase", "hospital", "furniture", "movie-ticket"],
    "rp-plan": ["park", "holiday-party", "birthday-party", "house-sitting", "tech-industry-friend", "home"],
    "rp-work": ["interview", "recycling", "car-breakdown"],
}
_RP_MAP = {s: t for t, ss in _RP.items() for s in ss}
_IDS = {t["id"] for t in THEMES}
assert set(_PLAIN.values()) | set(_SUDDEN.values()) | set(_RP_MAP.values()) <= _IDS
assert len(_RP_MAP) == sum(len(v) for v in _RP.values())  # 슬러그 중복 금지


def theme_for(group_name):
    """그룹 name 슬러그 -> theme id. 매핑이 없으면 KeyError."""
    if group_name.startswith("sudden-"):
        table, key = _SUDDEN, group_name[len("sudden-"):]
    elif group_name.startswith("rp-"):
        table, key = _RP_MAP, group_name[len("rp-"):]
    else:
        table, key = _PLAIN, group_name
    if key not in table:
        raise KeyError(f"themes.py: 주제 매핑 없음 -> '{group_name}'")
    return table[key]
