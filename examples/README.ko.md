# 예제

[English](README.md) · [가이드](../docs/GUIDE.ko.md)

지원하는 모든 언어로 CodeGraph의 모든 기능을 써 볼 수 있는 작은 프로그램들이에요. 폴더 하나를 VS Code로 열고(개발 빌드는
`code --extensionDevelopmentPath=<저장소> examples/cpp/features/threads`) 그 폴더 README의 확인표를 따라가 보세요.
테스트도 같은 예제로 돌아가서(`test/examples.test.ts`, `test/analyzer.test.ts`, `test/trace.test.ts` …), README에 적힌
것이 곧 CodeGraph가 하는 일이에요.

```
examples/
├─ c/          C99 / C11, pthreads
├─ cpp/        C++17
├─ python/     Python 3.9+
└─ compose/    Docker Compose로 여러 컨테이너
```

## 기능 — 기능마다 작은 폴더 하나

언어마다 같은 이름의 기능 폴더가 있어서 같은 기능을 언어끼리 비교할 수 있어요.

| 폴더 | 보여 주는 것 | 필요한 것 |
| --- | --- | --- |
| `<언어>/features/calls` | 호출이 전선이 되는 방식: 파일 사이, 네임스페이스·모듈·import, 메서드, 상속, 오버로드, 객체 생성, 실행해야 보이는 호출 | — |
| `<언어>/features/threads` | 스레드·태스크를 시작하는 모든 방법(⚡ 전선). API를 어떻게 쓰거나 가져와도 | — |
| `<언어>/features/classes` (C는 `structs`) | 클래스 패널: 멤버, 가족, 객체가 사는 곳, 멤버를 읽고 쓰는 곳 | — |
| `<언어>/features/returns` | `return`·`await`·`yield from` 안의 호출, 람다·중첩 함수의 return | — |
| `<언어>/features/trace` | **실행 & 추적**: 스레드 레인, 값, 스레드끼리 공유하는 객체, 실행해야 드러나는 전선 | 컴파일러 / Python |
| `<언어>/features/failures` | 크래시나 잡히지 않은 예외: 그 함수가 빨개지고 모든 스레드의 스택이 남음 | 컴파일러 / Python |
| `<언어>/features/live` | **■ 멈추기**까지 계속 실행: 실시간 보기, 실시간 레인, 스레드 하나 따라가기 | 컴파일러 / Python |
| `<언어>/features/problems` | 일부러 깨 둔 코드: 컴파일 오류, 그 영향, 전류가 안 가는 코드 | 컴파일러 / Python |

## 프로그램 — 실제 코드처럼 보이는 수백 줄짜리

| 폴더 | 언어 | 무엇인지 | 잘 보이는 것 |
| --- | --- | --- | --- |
| `c/ringbuf` | C | 링 버퍼를 사이에 둔 생산자·소비자 스레드 | 스레드끼리 공유하는 객체, `pthread_create` |
| `cpp/router` | C++ | 패킷 라우터: 인터페이스, 라우팅 표, rx·tx 스레드, CMake | 네임스페이스, 클래스, `vector<thread>`, CMake 빌드, C++에서 부르는 C 파일 |
| `python/pipeline` | Python | 센서 파이프라인: 펌프 스레드, 디스패처, 워커 풀(`compose.yaml`도 있음) | 패키지, 재내보내기, 실행기, 전선 위의 값 |
| `compose/net-pair` | C++ | 두 컨테이너의 클라이언트와 서버, makefile로 빌드. `compose.yaml`은 소스를 마운트, `compose.image.yaml`은 Dockerfile로 복사 | **Docker Compose로 실행 & 추적**, 컨테이너 카드, 컨테이너별 보기 |

이 프로그램들은 [README](../README.ko.md)의 그림과 데모 페이지(`npm run demo`)에도 나와요.
