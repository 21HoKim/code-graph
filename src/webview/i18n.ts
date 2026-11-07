const en = {
  dir: 'Folder', file: 'File', namespace: 'Namespace', class: 'Class', function: 'Function', package: 'Package', module: 'Module',
  files: 'Files', symbols: 'Symbols', circuit: 'Circuit', network: 'Network',
  search: 'Search symbols…  (/)', fit: 'Fit', reanalyze: 'Re-analyze', edges: 'Wires',
  flowAll: 'Flow: all', flowFocus: 'Flow: selection', flowOff: 'Flow: off',
  call: 'calls', spawn: 'thread spawns', instantiate: 'creates', inherit: 'inherits', include: '#include', import: 'imports',
  guesses: 'Show guessed links', analyzing: 'Analyzing workspace…', layingOut: 'Laying out {n} blocks…',
  empty: 'No C, C++ or Python files found in this workspace.',
  incoming: 'Incoming', outgoing: 'Outgoing', contains: 'Contains', openSource: 'Open source', focus: 'Focus',
  expand: 'Expand', collapse: 'Collapse', clearFocus: 'Clear focus', focusOn: 'Focus: {name}',
  params: 'Parameters', returns: 'Returns', sites: 'Call sites', confidence: 'Confidence',
  exact: 'exact', likely: 'likely', guess: 'guess', extends: 'extends',
  statFiles: '{n} files', statFns: '{n} functions', statLinks: '{n} wires', statResolved: '{p}% of calls resolved',
  statLayout: 'layout {ms} ms', truncated: 'Large view: {n} blocks. Pick a coarser level or focus to speed things up.',
  threadEntry: 'thread entry', legend: 'Legend', argsFlow: 'arguments →', returnFlow: '← return value',
  fallback: 'Simplified layout (hierarchical routing failed for this view).',
  fastLayout: 'Large view ({n} blocks, {w} wires): fast layout with simplified wiring. Focus or open a single folder for full circuit routing.',
  tooMany: '{n} blocks is too many for one view. Choose a coarser level or Focus on a block.',
  compact: 'compact wiring',
  fns: '{n} fn', methods: '{n} methods', filesN: '{n} files', lines: '{n} lines',
  hint: 'Click a block to trace its wires · double-click to open/close · drag to pan · wheel to zoom',
  noResults: 'No matches', decl: 'declaration only', fragmentNote: 'Part of a class implemented in this file',
  verify: 'Verify', verifyHint: 'Compile-check the workspace (gcc/clang -fsyntax-only, Python compile)',
  verifying: 'Verifying', building: 'Building', running: 'Running',
  problemsHint: 'errors · affected blocks · unpowered blocks — click for the list',
  noErrors: 'No errors', showProblems: 'Show problems overlay', problems: 'Problems',
  errorsN: '{n} errors', affectedN: '{n} affected', unpoweredN: '{n} unpowered', warningsN: '{n} warnings',
  brokenHere: 'Broken here', impact: 'Impact', impactText: '{n} blocks depend on this break', dependsOn: 'Affected through',
  unpoweredText: 'Only reachable through a broken block — current never arrives here.',
  verifyAgain: 'Verify again', notes: 'Notes', untrusted: 'Workspace is not trusted: compile checks and runs are disabled.',
  checkedWith: 'Checked {c} C/C++ units and {p} Python files in {ms} ms', notVerified: 'Not compile-checked yet — showing problems found by static analysis.',
  syntax: 'parse', compiler: 'compiler', linker: 'linker', python: 'python', incomplete: 'incomplete', editor: 'editor', runtime: 'runtime',
  legendBroken: 'broken', legendAffected: 'affected', legendUnpowered: 'no current',
};
export type Strings = typeof en;

const ko: Strings = {
  dir: '폴더', file: '파일', namespace: '네임스페이스', class: '클래스', function: '함수', package: '패키지', module: '모듈',
  files: '파일 기준', symbols: '심볼 기준', circuit: '회로', network: '네트워크',
  search: '심볼 검색…  (/)', fit: '맞춤', reanalyze: '다시 분석', edges: '전선',
  flowAll: '흐름: 전체', flowFocus: '흐름: 선택만', flowOff: '흐름: 끔',
  call: '호출', spawn: '스레드 생성', instantiate: '객체 생성', inherit: '상속', include: '#include', import: 'import',
  guesses: '추정 연결 표시', analyzing: '워크스페이스 분석 중…', layingOut: '블록 {n}개 배치 중…',
  empty: '이 워크스페이스에서 C, C++, Python 파일을 찾지 못했어요.',
  incoming: '들어오는 선', outgoing: '나가는 선', contains: '포함', openSource: '소스 열기', focus: '집중 보기',
  expand: '펼치기', collapse: '접기', clearFocus: '집중 해제', focusOn: '집중: {name}',
  params: '매개변수', returns: '반환', sites: '호출 위치', confidence: '신뢰도',
  exact: '확정', likely: '유력', guess: '추정', extends: '상속',
  statFiles: '파일 {n}', statFns: '함수 {n}', statLinks: '전선 {n}', statResolved: '호출 {p}% 해석',
  statLayout: '배치 {ms}ms', truncated: '블록이 {n}개라 무거워요. 더 높은 추상화 단계나 집중 보기를 써 보세요.',
  threadEntry: '스레드 진입점', legend: '범례', argsFlow: '인자 →', returnFlow: '← 반환값',
  fallback: '간략 배치로 표시 중 (이 뷰는 계층 라우팅에 실패했어요).',
  fastLayout: '큰 뷰예요(블록 {n}개, 전선 {w}개). 빠른 배치와 간략 배선으로 그렸어요. 집중 보기나 폴더 하나만 펼치면 회로 배선으로 보여요.',
  tooMany: '블록 {n}개는 한 화면에 그리기엔 너무 많아요. 더 높은 단계를 고르거나 블록에 집중해 보세요.',
  compact: '간략 배선',
  fns: '함수 {n}', methods: '메서드 {n}', filesN: '파일 {n}', lines: '{n}줄',
  hint: '블록 클릭: 전선 추적 · 더블클릭: 펼치기/접기 · 드래그: 이동 · 휠: 확대/축소',
  noResults: '결과 없음', decl: '선언만 있음', fragmentNote: '이 파일에서 구현된 클래스의 일부',
  verify: '검증', verifyHint: '워크스페이스 컴파일 검사 (gcc/clang -fsyntax-only, Python compile)',
  verifying: '검증 중', building: '빌드 중', running: '실행 중',
  problemsHint: '오류 · 영향받는 블록 · 전류가 끊긴 블록 — 클릭하면 목록',
  noErrors: '오류 없음', showProblems: '문제 표시(빨강/주황/회색)', problems: '문제',
  errorsN: '오류 {n}', affectedN: '영향 {n}', unpoweredN: '전류 끊김 {n}', warningsN: '경고 {n}',
  brokenHere: '여기서 끊김', impact: '영향 범위', impactText: '이 끊김에 의존하는 블록 {n}개', dependsOn: '영향 경로',
  unpoweredText: '끊긴 블록을 거쳐야만 닿는 곳이라 전류가 오지 않아요.',
  verifyAgain: '다시 검증', notes: '참고', untrusted: '신뢰하지 않는 워크스페이스라 컴파일 검사와 실행이 꺼져 있어요.',
  checkedWith: 'C/C++ {c}개 단위, Python {p}개 파일 검사 ({ms}ms)', notVerified: '아직 컴파일 검사 전이라 정적 분석으로 찾은 문제만 보여요.',
  syntax: '파싱', compiler: '컴파일러', linker: '링커', python: 'python', incomplete: '미구현', editor: '에디터', runtime: '런타임',
  legendBroken: '끊김', legendAffected: '영향', legendUnpowered: '전류 없음',
};

let dict: Strings = en;

export function setLang(lang: string | undefined): void {
  dict = lang?.toLowerCase().startsWith('ko') ? ko : en;
}

export function t(key: keyof Strings, vars?: Record<string, string | number>): string {
  let s = dict[key] ?? en[key] ?? key;
  if (vars) for (const [k, v] of Object.entries(vars)) s = s.replace(`{${k}}`, String(v));
  return s;
}
