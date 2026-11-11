# CodeGraph 사용 설명서

[README](../README.ko.md) · [English](GUIDE.md) · [아키텍처](ARCHITECTURE.md) · [로드맵](ROADMAP.md) · [변경 기록](../CHANGELOG.ko.md) · [버전 번호](VERSIONING.ko.md)

- [설치](#설치)
- [회로도](#회로도)
- [컴파일 검사](#컴파일-검사)
- [실행 & 추적](#실행--추적)
- [Docker Compose](#docker-compose)
- [.codegraph.json](#codegraphjson)
- [명령, 단축키, 설정](#명령-단축키-설정)
- [명령줄](#명령줄)
- [제한 사항](#제한-사항)

## 설치

- **마켓플레이스**: **확장** 뷰에서 **CodeGraph** 검색, 또는 `code --install-extension 21HoKim.code-graph-vscode` 실행([마켓플레이스 페이지](https://marketplace.visualstudio.com/items?itemName=21HoKim.code-graph-vscode))
- **Cursor, VSCodium, Windsurf, Theia**: **확장** 뷰에서 **CodeGraph** 검색, [Open VSX](https://open-vsx.org/extension/21HoKim/code-graph-vscode) 경유 설치
- **VSIX**: [릴리스](https://github.com/21HoKim/code-graph/releases)마다 `.vsix` 첨부, VS Code **확장** 뷰의 `…` → **VSIX에서 설치…** 메뉴
- **소스에서**:

  ```bash
  git clone https://github.com/21HoKim/code-graph && cd code-graph
  npm ci
  npm run build          # dist/: 확장, 파싱 워커, 웹뷰, WASM 문법, 런타임 트레이서
  npm test
  npx @vscode/vsce package --no-dependencies   # -> code-graph-vscode-<버전>.vsix
  ```

  - 설치 없이 개발 빌드 실행: `code --extensionDevelopmentPath="$PWD" examples/cpp/router`
- **예제 코드**: [examples/](../examples/README.ko.md)
  - C·C++·Python별 기능 폴더(calls, threads, classes, returns, trace, failures, live, problems)와 폴더별 확인표
  - 실제 코드에 가까운 프로그램 몇 개, Docker Compose용 컨테이너 두 개짜리 예제
- **요구 사항**
  - 신뢰하지 않는 워크스페이스: 컴파일 검사·실행 & 추적 비활성(내 컴파일러와 프로그램을 실행하는 기능)
  - 필요한 도구: `gcc` 또는 `clang`(Linux, macOS, Windows MinGW는 미검증), Python 3.8+, 컨테이너용 Docker(Compose v2)

## 회로도

- **C, C++, Python**: tree-sitter(WebAssembly) 파싱, 네이티브 의존성 없음
- **언어별 단계**
  - C++: 폴더 → 파일 → 네임스페이스 → 클래스 → 함수
  - C: 파일 → 함수
  - Python: 패키지 → 모듈 → 클래스 → 함수
  - 전선: 보이는 블록 기준 병합, 블록 더블클릭으로 제자리 펼치기
- **C++ 두 가지 묶음**: **파일 기준**(물리 구조), **심볼 기준**(파일과 무관한 네임스페이스 → 클래스 → 메서드)
- **헤더가 소스를 감싸는 배치**(파일 기준, C/C++): `router.cpp`를 자기 헤더 `router.h` 안에 배치
  - 헤더에 선언된 것: 헤더 단계(호출하는 쪽에서 보는 모습, 전선의 도착 지점)
  - 소스에만 있는 것(static 함수, 익명 네임스페이스): 소스 블록 안
  - 자기만의 것이 없는 소스: 별도 블록 없음
  - 끄기: `codeGraph.headerWrapsSource`
- **블록 배지**
  - `↻N`: 양 끝이 모두 블록 안이라 바깥으로 전선이 나가지 않는 호출 수, 클릭 시 그 호출 목록과 코드
  - `+N`: 접힌 블록 안 항목 수, 클릭 시 블록 펼치기
- **상세 패널**
  - 함수: 매개변수·반환 타입 전체, 모든 `return` 문, 들어오고 나가는 호출의 문장 전체(현재 색 테마, 클릭 시 해당 위치로 이동)
  - 클래스: 멤버 변수, 부모·자식 클래스, 객체 생성 위치, 객체 위치(다른 클래스의 멤버, 매개변수, 반환값)
  - **멤버를 읽고 쓰는 곳** 항목: 멤버별 읽는 함수·쓰는 함수 수
    - 이름만 쓴 경우까지 포함(`cfg.link.peer.port`, `p->len = 0`, `self.port`, 메서드 안의 `port_`), 멤버 타입·부모 클래스 추적
    - 펼치면 해당 줄 목록, 회로에서 해당 함수 강조(파랑 = 읽기, 주황 = 쓰기)
- **전류**: 호출자 → 피호출자 방향의 인자 흐름, 반대 방향의 주황 반환값 흐름, 블록 클릭 시 전선 내용(`(pkt, 100) ⟲ bool`) 표시
- **정적 스레드 분석**: `std::thread`, `std::async`, `std::jthread`, `pthread_create`, `threading.Thread(target=…)`, `executor.submit`, `asyncio.create_task` 등의 주황 ⚡ 전선
- **연결 신뢰도**: **확정**, **유력**(타입 추론), **추정**(이름만 일치, 점선)
- **기타**: 회로/네트워크 배치, 소스로 이동, 커서 따라가기, 저장 시 바뀐 부분만 재분석

| 클래스 단계 (C++) | 네트워크 배치 (Python) |
| --- | --- |
| ![C++ 라우터 클래스 단계: 폴더·파일·네임스페이스 영역](images/circuit-cpp.png) | ![Python 파이프라인 네트워크 배치](images/network-python.png) |

## 컴파일 검사

- **실제 툴체인**
  - C/C++: 번역 단위별 `gcc`/`clang -fsyntax-only`(`compile_commands.json`, 없으면 makefile 플래그)
  - Python: 파일별 `compile()`, pyflakes가 있으면 정의 안 된 이름까지
  - 시점: 회로도를 열 때 전체, 저장 시 영향받는 단위만
- **컴파일러 없이 찾는 문제**: 파싱 오류, 선언만 있고 정의 없는 함수, 호출되는 `NotImplementedError` 스텁, 정의 안 된 Python 이름, 없는 상대 import·로컬 `#include`
- **영향 범위**
  - 깨진 블록: **빨강**
  - 그 블록을 쓰는 호출자: 거리와 함께 **주황**(`⚠ +1`)
  - 깨진 곳을 거쳐야만 닿는 블록: **회색**(전류 없음)
  - 깨진 곳으로 들어가는 전선: 끊김 표시
- **문제 패널**: 오류별 위치, 영향받는 블록 수, 주황 블록의 원인 끊김 경로

## 실행 & 추적

- **한 번에 진행**: 컴파일 검사 → 빌드(C/C++) → 추적 실행 → 재생, 빌드·링크·실행 실패도 빨간 블록 표시
- **C / C++**
  - 소스 복사본의 함수 본문마다 `{` 줄에 프로브 삽입 → 컴파일러 줄 번호 유지
  - 작은 런타임의 기록 항목: 스레드별 호출, 인자 값, `this`·포인터 식별자
  - 크래시(`SIGSEGV`, 잡히지 않은 예외) 시 모든 스레드의 현재 함수 기록
- **프로젝트 방식 그대로의 빌드**
  - makefile·CMake: 프로그램별 소스, 정의(`-DNODE_A`), include·라이브러리 플래그, 실행 위치를 `make -n` 드라이런·CMake 링크 파일에서 수집 → `../cfg` 같은 상대 경로 해석
  - 빌드 시스템 없음: `main`에 필요한 번역 단위를 그래프에서 탐색
  - 링크 시 심볼 누락: 보통 그 심볼을 제공하는 라이브러리(OpenSSL, Boost.JSON, libm …) 추가 후 재시도
  - 실행 시: 링크에 쓴 라이브러리 폴더(`-L`, `-rpath`)를 라이브러리 경로에 추가 → 의존 라이브러리(Boost.JSON → Boost.Container)도 같은 폴더에서 탐색, `-rpath`가 RUNPATH로 기록되는 배포판(Ubuntu, Debian)도 동일
  - 그 밖의 빌드(스크립트, Meson, Bazel …): `.codegraph.json`의 `run.build`·`run.program`, 컴파일러를 전부 감싼 워크스페이스 복사본에서 실행
- **Python**: 표준 라이브러리만 쓰는 트레이서(3.12+는 `sys.monitoring`, 그 전은 `sys.setprofile`), 워크스페이스 코드의 호출·반환·예외, 값, 객체 식별자를 스레드별 기록
- **실시간**
  - 회로: 스레드별 현재 호출 스택을 스레드 색으로 강조, 방금 일어난 호출의 전선 흐름, 바쁜 함수에 방금 받은 호출 수(`+120`)
  - 아래 막대: 스레드, 시간, **■ 멈추기** 버튼, 스레드별 호출 스택 레인
  - 레인 끌기·Shift + 휠: 지난 시점 보기 / **⏭ 지금으로** 버튼·더블클릭: 다시 따라가기
  - 스레드 클릭(칩이나 레인의 이름): 회로에서 그 스레드만 추적, 지나간 길은 켜진 채 유지, 다시 클릭 시 모든 스레드로 복귀
  - 실행 기간: 프로그램 종료 또는 멈추기 버튼까지(`run.timeoutSeconds`로 제한 가능, 기본값 0 = 제한 없음)
  - 멈춘 뒤: 그때까지의 기록 전부 유지, 바로 재생
  - 오래 실행 시: 재생은 처음 `run.maxEvents`개 호출만 자세히, 실시간 보기는 끝까지 표시
- **재생**
  - 스레드 레인의 재생, 탐색, 한 단계씩 넘기기
  - 스레드별 호출 스택 블록의 스레드 색 강조, 전선을 따라 달리는 펄스, 블록으로 들어가는 값
  - 한 번도 실행 안 된 블록: 흐리게 / 실행해야 드러나는 호출(가상 함수, 콜백): 새 전선
  - 재생 위치 막대·위쪽 시간 눈금 끌기: 그 시점으로 이동 / 다른 곳 끌기: 보이는 구간 이동
  - 확대 시 레인 아래 가로 스크롤바
  - Shift + 휠(아래: 뒤쪽, 위: 앞쪽)·트랙패드 가로 스크롤: 좌우 이동
  - 휠: 레인 위아래 스크롤 / Ctrl(⌘) + 휠·핀치: 포인터 위치 기준 확대·축소
  - 클릭: 그 시점으로 이동 / 더블클릭: 전체 보기
  - 회로도의 Shift + 휠: 같은 방향 좌우 이동
  - 왼쪽 아래 범례: 스레드별 색(8개까지, **+N개 더** 버튼으로 전체 목록 휠 스크롤), 회로를 가리면 범례 제목 클릭으로 접기
- **데이터 추적**: 여러 스레드가 쓰는 객체 목록(모든 스레드의 같은 `Router`, `PacketQueue`, `ringbuf_t*`), 하나를 고르면 그 객체가 거쳐 간 함수의 순서대로 강조

| C++ 라우터 실행 & 추적 | 세 스레드가 공유하는 링 버퍼의 경로 |
| --- | --- |
| ![rx·tx 스레드가 자기 블록을 밝히고 값이 전선을 탐](images/trace-cpp.png) | ![producer, consumer, main을 거치는 링 버퍼](images/data-trail.png) |

## Docker Compose

- **Docker Compose로 실행 & 추적**: 워크스페이스 Compose 프로젝트를 이미지·네트워크·고정 주소·헬스체크 그대로 실행
  - 추적 프로세스별 추적 파일 → 한 시계로 병합, 컨테이너별 스레드 레인
  - 모든 빌드는 추적용 복사본에서 진행(워크스페이스 변경 없음), 종료 후 프로젝트 내림
- **컨테이너 카드**: 컨테이너가 여럿일 때 실시간 보기·재생 모두 회로 오른쪽에 컨테이너별 카드
  - 내용: 실행 중·종료 상태, 스레드·호출 수(실시간은 초당 호출 수 포함), 활동 그래프
  - 클릭: 그 컨테이너만 표시(다른 컨테이너 코드는 흐리게, 레인은 그 컨테이너 스레드만)
  - Ctrl(⌘) + 클릭: 선택 추가·제외 / 하나만 보일 때 다시 클릭: 전체로 복귀
  - **⧉** 버튼: 별도 창 열기(실행 중에도 가능)
  - 실시간 보기에서 고른 선택의 재생 유지
- **컨테이너별 회로도**: **⧉ 컨테이너별로 보기** 버튼(툴바, 실행 요약) 또는 **CodeGraph: 컨테이너별로 회로도 열기** 명령
  - 컨테이너 목록(스레드·호출 수, 종료 상태)에서 체크한 것만 회로도 옆에 하나씩 열기
  - 각 창: 그 컨테이너의 스레드·호출·데이터만, 같은 시계로 함께 재생
  - 실행 요약의 컨테이너 이름 클릭: 그것 하나만 열기
  - 컨테이너마다 VS Code를 붙일 필요 없이 Compose 실행 한 번으로 전체 추적
  - 다른 곳에서 쓴 추적 파일(기계·컨테이너별 하나): **추적 파일 불러오기…** 명령으로 여러 개 선택 → 한 타임라인으로 병합

![node-b와 node-a를 나란히, 함께 재생](images/per-container.png)

- **Compose 파일 선택**: 워크스페이스 루트의 `compose.yaml` / `docker-compose.yml`(`.yml`·`.yaml` 모두)과 override 파일, `docker compose`와 같은 방식
  - 다른 파일: `.codegraph.json`의 `compose.files`(와 `profiles`)
- **추적 대상 서비스**: 컨테이너 안에 워크스페이스의 C, C++, Python 소스가 있는 서비스

| 서비스 상황 | CodeGraph 처리 |
| --- | --- |
| 워크스페이스나 그 안의 폴더 마운트(`- ./:/app`) | 그 자리에 추적용 복사본 마운트, 시작 시 빌드(`make`, CMake, 스크립트)는 컴파일러 래퍼 경유 |
| 워크스페이스로 이미지를 빌드하고 Dockerfile이 소스 복사(`COPY . .`, `COPY src/ /app/src/`, `RUN --mount=type=bind`) | 추적용 복사본으로 이미지 재빌드, 빌드 단계마다 첫 복사 바로 앞에 래퍼 삽입(멀티 스테이지 포함) |
| CodeGraph가 알 수 없는 위치의 코드 | `.codegraph.json`의 `compose.sourcePath` |
| 다른 곳에서 빌드한 프로그램만 실행 | `compose.build`: 서비스 명령 전 컨테이너에서 실행할 명령 |
| 소스 없음(데이터베이스, 프록시) | 그대로 실행 |

- **추적 컨테이너 안의 래퍼**
  - `PATH`의 C/C++ 컴파일러 전부(`gcc`, `g++-12`, `clang++-17`, 크로스 컴파일러, 전체 경로로 준 `CC`/`CXX`, 앞에 붙인 `ccache`)
  - Python 인터프리터, 다른 방식으로 시작한 Python 프로세스(전체 경로, gunicorn, multiprocessing 자식)는 `sitecustomize`로 추적
- **실행 기간**: 실시간 추적, 추적 컨테이너가 모두 끝나거나 **■ 멈추기** 버튼까지
  - `timeoutSeconds` 제한: 처음 추적된 프로그램 기준
  - 이미지 빌드·컨테이너 안 빌드 시간: `startTimeoutSeconds`(600초)
- **추적된 프로그램 없이 끝난 서비스**: 실행 요약에 이유와 `.codegraph.json`에 적을 항목 표시

| 메모 | 적을 항목 |
| --- | --- |
| 워크스페이스를 마운트하지도, 이미지에 복사하지도 않음 | `compose.sourcePath`: 그 컨테이너의 코드 위치 |
| 컨테이너 안에서 아무것도 컴파일하지 않음 | `compose.build`: 빌드 명령, 예: `make -C /app server`(makefile이 `/usr/bin/g++`처럼 전체 경로로 부를 때도 `make CXX=g++ …`) |
| 워크스페이스 Python 코드가 실행되지 않음 | 코드가 다른 곳에 있으면 `compose.sourcePath` |
| 워크스페이스에 Compose 파일이 없음 | `compose.files` |

![각자 Compose 네트워크 안의 두 노드: node-b의 serve 스레드가 node-a의 메시지를 검증하는 동안 node-a의 reader가 응답을 기다림](images/compose-trace.png)

## .codegraph.json

- 용도: 필요할 때만 워크스페이스 루트에 두는 파일, CodeGraph가 스스로 알 수 없는 것만 기록
- 우선순위: 같은 VS Code 설정보다 우선, 명령줄도 같은 파일 사용
- **CodeGraph: .codegraph.json 만들기 / 열기** 명령: 모든 키가 주석 처리되고 감지한 값이 예시로 들어간 시작 파일 생성
- 형식: 주석 가능한 JSON, 에디터의 모든 키 자동 완성·설명

| 키 | 뜻 |
| --- | --- |
| `run.entry` | 실행 대상: `main()`이 있는 C/C++ 파일, Python 스크립트·패키지 |
| `run.target` | makefile/CMake가 그 진입점으로 여러 프로그램을 만들 때의 선택 |
| `run.args`, `run.cwd`, `run.env` | 인자, 실행 폴더(기본: 빌드가 프로그램을 두는 곳), 추가 환경 변수 |
| `run.build`, `run.program` | CodeGraph가 스스로 못 읽는 빌드 명령과 그 결과 프로그램(워크스페이스 기준) |
| `run.buildFlags`, `run.linkFlags` | 추가 컴파일 플래그(`-DDEBUG`), 추가 라이브러리(`-lssl`) |
| `run.timeoutSeconds` | 프로그램 정지 시간(그때까지의 추적 유지), 0 = 종료나 멈추기 버튼까지 |
| `compose.files`, `compose.profiles` | 순서대로 쓸 Compose 파일, 켤 프로필 |
| `compose.services` | 추적 서비스(기본: 워크스페이스 소스가 있는 모든 서비스) |
| `compose.build` | 서비스별: 서비스 명령 전 그 컨테이너에서 실행할 명령 |
| `compose.sourcePath` | 서비스별: 그 컨테이너의 워크스페이스 위치 |
| `compose.env` | 서비스별: 추적 실행에 더할 환경 변수(예: `CXX`) |
| `compose.timeoutSeconds`, `compose.startTimeoutSeconds` | 프로그램 실행 시간(0 = 멈출 때까지), 이미지·컨테이너 안 빌드 시간 |

```jsonc
{
  "run": { "entry": "src/main.cpp", "target": "node-b", "args": ["--verbose"] },
  "compose": {
    "files": ["compose.yaml", "compose.test.yaml"],
    "profiles": ["test"],
    "build": { "gateway": "cmake -B /src/build /src && cmake --build /src/build" },
    "sourcePath": { "worker": "/opt/worker" },
    "env": { "gateway": { "CXX": "g++-12" } }
  }
}
```

## 명령, 단축키, 설정

| | |
| --- | --- |
| `CodeGraph: 회로도 열기` | 워크스페이스 분석 후 회로도 열기(컴파일 검사 포함) |
| `CodeGraph: 회로도에서 보기` | 현재 파일로 이동(탐색기·에디터 우클릭 메뉴, 상태 표시줄) |
| `CodeGraph: 검증 (컴파일 검사)` | 즉시 재검사(툴바 **✓ 검증** 버튼) |
| `CodeGraph: 실행 & 추적` | 빌드, 실행, 재생(툴바 **▶ 실행** 버튼) |
| `CodeGraph: Docker Compose로 실행 & 추적` | 서비스별 컨테이너 추적과 함께 Compose 프로젝트 실행 |
| `CodeGraph: 컨테이너별로 회로도 열기` | 현재 추적의 컨테이너 선택 → 하나씩 회로도로 나란히, 함께 재생 |
| `CodeGraph: 실행 멈추고 추적 보기` | 진행 중인 실행 종료(실시간 막대의 **■ 멈추기** 버튼)와 기록 재생 |
| `CodeGraph: .codegraph.json 만들기 / 열기` | 특이한 환경용 프로젝트 설정 |
| `CodeGraph: 추적 파일 불러오기…` | 명령줄·트레이서가 쓴 추적 파일 열기, 여러 개 선택 시 한 타임라인으로 병합 |
| 블록 클릭 / 더블클릭 | 전선 보기 · 펼치기 또는 소스로 이동 |
| 블록 / 전선 마우스 오버 | 소스 미리보기(현재 색 테마로 문법 색칠): 정의 첫 줄들 · 호출한 줄 |
| `Ctrl`+클릭 (`⌘`+클릭) · `F12` / `Enter` | 코드로 이동: 블록은 정의, 전선은 호출한 줄 |
| `1`…`5` · `/` · `F` · `Esc` | 단계 · 검색 · 화면 맞춤 · 해제 |
| `Space` · `←` `→` | (추적이 있을 때) 재생/일시정지 · 이전/다음 호출 |

- 설정(`codeGraph.*`)
  - 회로도: `defaultLevel`, `layout`, `flow.mode`, `flow.maxParticles`, `showGuessedLinks`, `followCursor`, `exclude`, `maxFiles`, `cpp.includePaths`, `analysis.workers`
  - 컴파일 검사: `verify.mode`(`onOpenAndSave` · `onOpen` · `manual`), `verify.cc`, `verify.cxx`, `verify.python`, `verify.extraFlags`, `verify.useCompileCommands`, `verify.editorDiagnostics`, `verify.timeoutSeconds`
  - 실행 & 추적: `run.entry`, `run.args`, `run.cwd`, `run.env`, `run.buildFlags`, `run.linkFlags`, `run.useBuildSystem`, `run.target`, `run.timeoutSeconds`, `run.maxEvents`, `run.captureValues`
  - Docker Compose: `run.compose.file`, `run.compose.services`, `run.compose.startTimeoutSeconds`, `run.compose.docker`

## 명령줄

```bash
node dist/cli.js path/to/project -o graph.json            # 정적 그래프
node dist/cli.js path/to/project --verify -o graph.json   # + 컴파일 검사, 오류가 있으면 종료 코드 2 (CI)
node dist/cli.js trace path/to/project -o run.json -- --program --args
node dist/cli.js trace path/to/project --target node-b -o run.json   # makefile이 만드는 프로그램 중 하나
node dist/cli.js trace path/to/project --compose [파일…] [--profile P] [--service S] -o run.json
# src/main.cpp · main(): exit 0 · 6 threads · 1657 calls · 15 shared objects · 1008 ms traced
```

- `trace`: 확장과 같은 `<프로젝트>/.codegraph.json` 사용, 명령줄 옵션 우선

## 제한 사항

- **회로도**: 매크로 미전개, 템플릿 미인스턴스화, 가상 함수·콜백은 선언된 대상으로 연결(실제 대상은 추적으로 확인)
- **실행 & 추적**
  - 읽는 빌드: makefile(기본 목표의 `make -n`), CMake, 그 밖은 `run.build` 필요
  - 프로그램 실행: stdin 없음
  - C/C++: 반환값이 아닌 인자 값만 기록
- **Docker Compose**
  - makefile이 컴파일러를 전체 경로(`/usr/bin/g++`)로 부르면 래퍼 우회(`compose.build`에 `make CXX=g++ …`)
  - 워크스페이스 밖 빌드 컨텍스트의 이미지: 재빌드 대상 아님
- **식별자 = 주소**: Python·C 할당기가 해제된 객체의 주소를 재사용하면 긴 경로에서 두 객체 혼동 가능
- **추적 비용**: 워크스페이스 Python 호출마다 약 1µs, C/C++는 그보다 적음, `run.maxEvents` 초과 시 호출 횟수만 기록

- 기여: 언제든 환영, [CONTRIBUTING.md](../CONTRIBUTING.md) 참고
- 라이선스: MIT © 김호 (21HoKim), 서드파티 구성 요소는 [THIRD_PARTY_NOTICES.md](../THIRD_PARTY_NOTICES.md)
