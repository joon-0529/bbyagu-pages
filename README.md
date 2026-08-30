# 별별야구: The Game — 웹페이지

App Store Connect 심사에 필요한 두 URL을 제공하는 공개 저장소입니다.
게임 소스는 별도 비공개 저장소에 있습니다.

| 페이지 | 용도 |
|---|---|
| `index.html` | 지원 URL |
| `privacy.html` | 개인정보 처리방침 URL |

## ⚠ 이 파일들을 여기서 직접 고치지 마세요

두 페이지는 **앱 소스에서 생성**합니다. 앱 안 약관(`main.swift` 의 `termsLines`)이
정본이고, 따로 고치면 앱과 웹이 어긋납니다.

본 저장소(게임 소스)에서:

```bash
python3 tools-gen-pages.py          # docs/ 갱신
cp docs/*.html ~/Desktop/bbyagu-pages/   # 여기로 복사
```

## Pages 설정

Settings → Pages → Source: `Deploy from a branch` → Branch `main`, 폴더 `/ (root)`
