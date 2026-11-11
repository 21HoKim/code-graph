# CodeGraph

**C, C++, Python 코드를 살아 있는 회로도로 봅니다.** 폴더·클래스·함수는 블록, 호출과 스레드는 전선이에요.
깨진 곳은 빨갛게 보이고, 실행하면 스레드마다 자기 경로가 실제 값을 싣고 빛나요.

[English](README.md) · [사용 설명서](docs/GUIDE.ko.md) · [GitHub](https://github.com/21HoKim/code-graph)

![액티비티 바의 CodeGraph를 눌러 회로도를 열면 호출을 따라 전류가 흐름](docs/images/start.gif)

## 사용법

1. C, C++, Python 코드가 있는 폴더를 열고 왼쪽 액티비티 바의 **CodeGraph**를 누릅니다.
2. **회로도 열기**: 프로젝트가 블록과 전선으로 보여요. 블록을 누르면 전선에 무엇이 흐르는지 보이고,
   더블클릭하면 펼쳐져요. `1`–`5`로 단계를 바꾸고 `/`로 검색합니다.
3. **▶ 실행 & 추적**: 빌드하고 실행해요. 실행되는 동안 스레드마다 지금 있는 블록이 빛나고 호출이 전선을 따라
   실시간으로 흘러요. 끝나거나 **■ 멈추기**를 누르면 값까지 담아 재생하고, 크래시가 나면 각 스레드가 어디 있었는지 보여요.
4. **Docker Compose로 실행 & 추적**: 상대 노드가 있어야 돌아가는 프로그램용이에요. 모든 컨테이너를 한 타임라인에서
   볼 수 있어요.

필요한 것: 코드를 실행·검사하려면 `gcc`/`clang` 또는 Python 3.8+, 컨테이너는 Docker(Compose v2)가 필요해요.
회로도만 볼 때는 아무것도 필요 없어요.

## 예시

### make나 CMake로 빌드하는 C++ 프로그램

**▶ 실행**을 누르면 makefile/CMake가 빌드하는 그대로(정의, include·라이브러리 플래그, 실행 위치) 빌드해요.
`main.cpp` 하나로 프로그램을 여러 개 만들면 어느 걸 실행할지 물어봐요.

![C++ 라우터 실행 & 추적: rx·tx 스레드가 자기 블록을 밝히고 아래 스레드 레인이 재생됨](docs/images/run.gif)

### Python

스크립트(또는 `__main__.py`가 있는 패키지)를 열고 **▶ 실행**을 누르세요. 스레드, 스레드 풀, asyncio 태스크가
각자 레인을 가지고, 인자·반환 값과 예외가 함께 기록돼요.

![Python 파이프라인: 펌프 스레드, 디스패처, 풀 워커와 전선 위의 값](docs/images/trace-python.png)

### 네트워크로 통신하는 두 프로그램

Compose 파일은 그대로 두면 돼요. 코드를 마운트하든 Dockerfile로 이미지에 복사하든, 내 코드가 들어 있는 서비스는
모두 추적하고 워크스페이스는 건드리지 않아요.

```yaml
# compose.yaml
services:
  server:
    build: .                          # Dockerfile: COPY . /app, RUN make server
    command: ["./server"]
  client:
    image: gcc:13
    volumes: ["./:/app"]              # 마운트하고 시작할 때 빌드해도 돼요
    working_dir: /app
    command: sh -c "make client && ./client server:7000"
    depends_on: [server]
```

**Docker Compose로 실행 & 추적**을 누르면 두 컨테이너를 실시간으로 따라가요. **■ 멈추기**로 실행을 끝내면, 한 노드가
보낸 요청을 다른 노드의 핸들러가 받는 장면까지 재생돼요. VS Code를 컨테이너마다 붙일 필요 없이, 한 번 실행으로
모든 컨테이너를 원하는 만큼 추적해요.

![두 컨테이너를 실시간으로 따라가다가 멈추고, 한 일을 재생](docs/images/live.gif)

오른쪽에는 컨테이너마다 카드가 떠서 실행 중인지, 초당 호출 수, 활동 그래프를 보여 줘요. 카드를 누르면 실시간이든
재생이든 그 컨테이너의 코드와 스레드만 보여요. 회로 아래에는 스레드마다 호출 스택을 그린 레인이 실행을 따라 흘러가고(끌어서
지난 시점을 볼 수 있어요), 스레드를 누르면 그 스레드만 따라가요.

**⧉ 컨테이너별로 보기**를 누르면 고른 컨테이너마다 회로도가 하나씩 나란히 열려요. 함께 재생되고, 각 회로도에는 그
컨테이너에서 실행된 것만 보여요.

![node-b와 node-a를 나란히: 같은 순간 node-b의 Server와 node-a의 Client가 빛남](docs/images/per-container.png)

### 어디가 깨졌는지

회로도를 열 때와 저장할 때마다 컴파일 검사를 해요. 컴파일 안 되는 곳은 빨강, 그걸 호출하는 곳은 주황, 거기를
거쳐야만 닿는 블록은 전류가 끊겨요.

![깨진 C++: calibrate는 컴파일 안 됨(빨강), read와 main이 영향받음(주황)](docs/images/problems.png)

## 환경이 특이하다면 `.codegraph.json`에 적어 주세요

CodeGraph는 makefile, CMake, Dockerfile, Compose 파일을 스스로 읽어요. 그래도 빌드 스크립트, 다른 데서 빌드한
프로그램만 실행하는 컨테이너, 예상 밖의 위치에 있는 코드처럼 스스로 알 수 없는 경우가 있어요. 그럴 땐 무엇을 못
찾았는지 알려 주고 워크스페이스 루트에 **`.codegraph.json`**을 만들자고 해요. **CodeGraph: .codegraph.json 만들기 /
열기** 명령으로 직접 만들어도 돼요. 빠진 것만 적으면 되고, 에디터가 모든 키를 자동 완성하고 설명해 줘요.

```jsonc
{
  "run": {
    "build": "./build.sh",               // CodeGraph가 스스로 못 읽는 빌드와…
    "program": "out/app",                // …그 빌드가 만드는 프로그램
    "args": ["--port", "7000"]
  },
  "compose": {
    "files": ["deploy/compose.yaml", "deploy/compose.test.yaml"],
    "services": ["server", "client"],                // 추적할 서비스
    "build": { "server": "make -C /app server" },    // 다른 데서 빌드한 프로그램만 실행하는 이미지
    "sourcePath": { "client": "/srv/client" }        // 그 컨테이너 안에서 코드가 있는 곳
  }
}
```

![명령 팔레트에서 .codegraph.json 만들기: 모든 키가 주석으로 들어 있고 에디터가 키마다 설명을 보여 줌](docs/images/config.gif)

[사용 설명서](docs/GUIDE.ko.md): 모든 기능·설정·`.codegraph.json` 키, 명령줄, 제한 사항.
