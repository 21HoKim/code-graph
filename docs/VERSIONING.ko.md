# 버전 번호

[README](../README.ko.md) · [English](VERSIONING.md) · [사용 설명서](GUIDE.ko.md) · [변경 기록](../CHANGELOG.ko.md) · [릴리스](https://github.com/21HoKim/code-graph/releases)

- 형식: **MAJOR.MINOR.PATCH** 숫자 세 개(예: **0.5.0**)

| 자리 | 0.5.0에서 | 올라가는 때 | 결정 방식 |
| --- | --- | --- | --- |
| MAJOR | 0 | 기존 사용 방식이 깨지는 변경: 설정·`.codegraph.json` 키의 삭제·이름 변경, 예전 파일을 못 읽는 형식 변경 | 직접 |
| MINOR | 5 | 눈에 띄는 새 기능: 새 실행 방식·화면·프로젝트 파일(실시간 보기, `.codegraph.json`, 컨테이너별 보기) | 직접 |
| PATCH | 0 | 그 밖의 모든 확장 변경: 버그 수정, 작은 개선 | 릴리스마다 자동 |

- **0.4.1 → 0.4.2**: 그냥 받아도 되는 수정
- **0.4.x → 0.5.0**: [변경 기록](../CHANGELOG.ko.md)에서 볼 만한 새 기능
- MAJOR 변경: 설정 확인 필요

## 1.0 이전

- MAJOR **0** 동안: 아직 성장 단계, MINOR 버전에서 기본 동작 변경 가능
  - 예: 0.5.0의 실행 & 추적 20초 시간 제한 삭제(프로그램 종료나 멈추기 버튼까지 실행)
  - 이런 변경은 전부 변경 기록의 해당 버전 아래에 기록
- **1.0** 이후: 1.x 동안 설정, `.codegraph.json` 키, 추적·그래프 파일 형식의 호환 유지, 호환을 깨는 변경은 2.0에서만

## 릴리스 과정

- 계기: 확장을 바꾸는 커밋(`src/`, `runtime/`, `media/`, `l10n/`, `schemas/`, `package.json` …)의 `main` 반영 → **Publish** 워크플로 실행

1. 타입 검사·테스트 — 하나라도 실패하면 릴리스 중단
2. 버전 결정(`scripts/release-version.mjs`): `package.json` 버전이 모든 릴리스보다 높으면 그 버전, 아니면 최근 릴리스의 다음 PATCH
3. 패키징 → VS Code 마켓플레이스 게시 → `vX.Y.Z` GitHub 릴리스 첨부(이전 릴리스 이후 변경 전체 링크 포함)
4. 같은 패키지의 [Open VSX](https://open-vsx.org/extension/21HoKim/code-graph-vscode) 게시 — Cursor, VSCodium, Windsurf, Theia의 확장 출처(저장소 변수 `OPEN_VSX`가 `true`일 때)

- 새 MINOR·MAJOR: `package.json`에 그 버전 기록(`npm version minor --no-git-tag-version`) 후 푸시
- 그 뒤 다음 변경까지: 릴리스마다 PATCH만 증가(0.5.0 → 0.5.1, 0.5.2, …)
  - 마켓플레이스가 0.5.3이어도 저장소 `package.json`은 0.5.0 그대로, 정확한 버전은 배포 패키지에만 기록
- 문서만 바꾼 커밋(`README`, `CHANGELOG`, `docs/`): 릴리스 제외, README·CHANGELOG 변경은 다음 릴리스 때 마켓플레이스 페이지에 반영

## 변경 내용 확인 위치

- [CHANGELOG.ko.md](../CHANGELOG.ko.md)([English](../CHANGELOG.md)): 버전별 **추가 / 변경 / 수정**, 마켓플레이스 **Changelog** 탭은 영어판
- [GitHub 릴리스](https://github.com/21HoKim/code-graph/releases): 모든 버전의 노트(영어, 아래에 접힌 한국어)와 `.vsix`
- 마켓플레이스 **Version History** 탭
- 업데이트: VS Code 자동 처리
- 예전 버전으로 되돌리기: 확장 ⚙ 메뉴의 **다른 버전 설치…** 항목, 또는 릴리스의 `.vsix` 설치

## 그 밖의 번호

| 위치 | 번호 | 뜻 |
| --- | --- | --- |
| 추적 원본 파일(`.jsonl`)의 첫 줄 | `code-graph-trace/1` | 추적 형식 버전, 예전 CodeGraph가 새 형식을 못 읽게 될 때만 증가 |
| **그래프를 JSON으로 내보내기** 명령·`code-graph <dir> -o`로 만든 그래프, `code-graph trace -o`로 만든 실행 기록 | `"schema": 1` | 그 파일들의 형식 버전 |
| `package.json` → `engines.vscode` | `^1.85.0` | 확장이 동작하는 가장 오래된 VS Code 버전 |

## 지금까지의 버전

| 버전 | 주요 내용 |
| --- | --- |
| 0.1.0 | 정적 회로도: C, C++, Python의 블록·전선 표현 |
| 0.2.0 | 회로도 위 영향 범위까지 보이는 컴파일 검사, 스레드·데이터·크래시를 담는 실행 & 추적 |
| 0.2.1 | 마켓플레이스 첫 릴리스, 액티비티 바의 CodeGraph 패널 |
| 0.3.0 | 프로젝트 방식 그대로의 빌드(make, CMake), Docker Compose 실행 & 추적 |
| 0.4.0 | 모든 Docker 구성 추적, 특이한 환경용 `.codegraph.json`, 사용법·예시·GIF 중심 README |
| 0.4.1 | 컨테이너별 보기, 라이브러리가 부르는 라이브러리 탐색 |
| 0.5.0 | 실시간 보기, 시간 제한 삭제, 멈춰도 추적 유지 |
| 0.6.0 | 컨테이너 카드(실시간·재생), 실시간 레인, 스레드 하나 추적, 표기와 무관한 C++ 스레드 인식, 스레드 시작 주체의 실행 중 기록 |
