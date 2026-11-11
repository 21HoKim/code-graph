import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { before, describe, it } from 'node:test';
import { AnalysisSession, walk } from '../src/core/analyze';
import type { CodeGraph, Entity, Relation } from '../src/core/model';
import { ParsePool } from '../src/core/pool';

const ROOT = path.resolve(__dirname, '..');
const WASM = path.join(ROOT, 'dist', 'wasm');
const WORKER = path.join(ROOT, 'dist', 'parseWorker.js');

async function analyze(dir: string, workers = 0): Promise<CodeGraph> {
  const pool = new ParsePool(WASM, WORKER, workers);
  const session = new AnalysisSession(dir, pool);
  const g = await session.analyze(walk(dir).files);
  pool.dispose();
  return g;
}

function rel(g: CodeGraph, kind: string, from: string, to: string): Relation | undefined {
  return g.relations.find((r) => r.kind === kind && r.from === from && r.to === to);
}

describe('C++ router sample', () => {
  let g: CodeGraph;
  before(async () => {
    g = await analyze(path.join(ROOT, 'samples', 'cpp-router'), 2);
  });

  it('merges header declarations with out-of-line definitions', () => {
    const start = g.entities.find((e) => e.id === 'cc:net::Router::start');
    assert.ok(start, 'Router::start exists');
    assert.equal(start.def?.file, 'src/net/router.cpp');
    assert.equal(start.decl?.file, 'include/net/router.h');
    assert.equal(start.parent, 'cc:net::Router');
    assert.equal(start.sub, 'method');
  });

  it('detects std::thread and vector<thread>::emplace_back spawns', () => {
    assert.ok(rel(g, 'spawn', 'cc:net::Router::start', 'cc:net::Router::rxLoop'));
    assert.ok(rel(g, 'spawn', 'cc:net::Router::start', 'cc:net::Router::txLoop'));
    const rx = g.entities.find((e) => e.id === 'cc:net::Router::rxLoop')!;
    assert.ok(rx.flags?.includes('threadEntry'));
  });

  it('infers container element types for member calls', () => {
    // ifaces_[port]->send(pkt) with std::vector<std::unique_ptr<Interface>> ifaces_
    assert.ok(rel(g, 'call', 'cc:net::Router::route', 'cc:net::Interface::send'));
    // table_.lookup(...) through a field of type RouteTable
    assert.ok(rel(g, 'call', 'cc:net::Router::route', 'cc:net::RouteTable::lookup'));
  });

  it('records inheritance, includes and object creation', () => {
    assert.ok(rel(g, 'inherit', 'cc:net::EthInterface', 'cc:net::Interface'));
    assert.ok(rel(g, 'include', 'f:src/main.cpp', 'f:include/net/router.h'));
    assert.ok(rel(g, 'instantiate', 'cc:main', 'cc:net::Router'));
    assert.ok(rel(g, 'instantiate', 'cc:main', 'cc:net::EthInterface'));
  });

  it('links C++ to C through extern "C" headers', () => {
    const r = rel(g, 'call', 'cc:net::Packet::checksum', 'cc:crc32');
    assert.ok(r, 'checksum -> crc32');
    assert.equal(g.entities.find((e) => e.id === 'cc:crc32')?.lang, 'c');
  });

  it('keeps internal-linkage functions file-local', () => {
    assert.ok(g.entities.some((e) => e.id === 'cc:build_table@src/crc/crc32.c'));
    const r = rel(g, 'call', 'cc:util::log', 'cc:util::(anonymous)::writeLine@src/util/log.cpp');
    assert.equal(r?.conf, 'exact');
  });

  it('stores argument expressions as the data on the wire', () => {
    const r = rel(g, 'call', 'cc:net::Router::txLoop', 'cc:net::PacketQueue::pop');
    assert.deepEqual(r?.sites?.[0]?.args, ['pkt', '100']);
  });
});

describe('Python pipeline sample', () => {
  let g: CodeGraph;
  before(async () => {
    g = await analyze(path.join(ROOT, 'samples', 'py-pipeline'));
  });
  const id = (p: string) => `py:${p}`;

  it('resolves classes re-exported from a package __init__', () => {
    assert.ok(rel(g, 'instantiate', id('main.py:main'), id('pipeline/runner.py:Runner')));
    assert.ok(rel(g, 'call', id('main.py:main'), id('pipeline/runner.py:Runner.start')));
  });

  it('detects threading.Thread targets and executor.submit', () => {
    assert.ok(rel(g, 'spawn', id('pipeline/runner.py:Runner.start'), id('pipeline/runner.py:Runner._pump')));
    assert.ok(rel(g, 'spawn', id('pipeline/runner.py:Runner.start'), id('pipeline/runner.py:Runner._dispatch')));
    assert.ok(rel(g, 'spawn', id('pipeline/runner.py:Runner._dispatch'), id('pipeline/runner.py:process_frame')));
  });

  it('types self attributes and resolves super()', () => {
    assert.ok(rel(g, 'call', id('pipeline/runner.py:Runner._collect'), id('pipeline/stages.py:Aggregator.add')));
    assert.ok(rel(g, 'call', id('pipeline/sources.py:SensorSource.__init__'), id('pipeline/sources.py:Source.__init__')));
    assert.ok(rel(g, 'inherit', id('pipeline/sources.py:SensorSource'), id('pipeline/sources.py:Source')));
  });

  it('attributes module-level code to the module', () => {
    assert.ok(rel(g, 'call', 'py:mod:main.py', id('main.py:main')));
  });

  it('resolves module attribute calls through imports', () => {
    assert.ok(rel(g, 'call', id('pipeline/runner.py:process_frame'), id('pipeline/stages.py:decode')));
    assert.ok(rel(g, 'import', 'f:pipeline/runner.py', 'f:pipeline/stages.py'));
  });
});

describe('C ring buffer sample', () => {
  it('detects pthread_create thread entries', async () => {
    const g = await analyze(path.join(ROOT, 'samples', 'c-ringbuf'));
    assert.ok(rel(g, 'spawn', 'cc:main', 'cc:producer@main.c'));
    assert.ok(rel(g, 'spawn', 'cc:main', 'cc:consumer@main.c'));
    assert.ok(rel(g, 'call', 'cc:producer@main.c', 'cc:rb_put'));
  });
});

describe('threads started through every spelling of the API (every language)', () => {
  const project = (files: Record<string, string[]>): string => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-spawn-'));
    for (const [name, lines] of Object.entries(files)) {
      fs.mkdirSync(path.dirname(path.join(dir, name)), { recursive: true });
      fs.writeFileSync(path.join(dir, name), lines.join('\n'));
    }
    return dir;
  };
  const spawn = (g: CodeGraph, from: string, to: string) => rel(g, 'spawn', from, to);

  it('C++: temporaries, `T t(f)`, `T t{f}`, `using` and aliases, member initializers', async () => {
    const g = await analyze(
      project({
        'server.h': ['#pragma once', '#include <thread>', 'class Server {', 'public:', '  void init(); void acceptLoop(); void heartbeat(); void handle(int s);', '};'],
        'server.cpp': [
          '#include "server.h"',
          'using namespace std;',
          'void Server::init() {',
          '  thread(&Server::heartbeat, this).detach();',
          '  thread(&Server::acceptLoop, this).detach();',
          '}',
          'void Server::acceptLoop() { int s = 0; thread(&Server::handle, this, std::move(s)).detach(); }',
          'void Server::heartbeat() {}',
          'void Server::handle(int s) {}',
        ],
        'forms.cpp': [
          '#include <thread>',
          '#include <future>',
          'void w() {}',
          'int load(int n) { return n; }',
          'namespace ns { void job() {} }',
          'void g1() { std::thread t(w); t.join(); }',
          'void g2() { std::thread t{w}; t.join(); }',
          'void g3() { auto t = std::thread(w); t.join(); }',
          'void g4() { using namespace std; thread t(ns::job); t.join(); }',
          'void g5() { using std::thread; thread t{w}; t.join(); }',
          'void g6() { using Worker = std::thread; Worker t(w); t.join(); }',
          'void g7() { auto r = std::async(std::launch::async, load, 3); }',
          'void g8() { using ns::job; std::jthread t(job); }',
          'namespace b = boost;',
          'void g9() { b::thread t(w); t.join(); }',
        ],
        'pool.cpp': [
          '#include <thread>',
          '#include <vector>',
          'class Pool {',
          '  std::thread rx_;',
          '  std::thread tx_{&Pool::txLoop, this};',
          '  std::vector<std::jthread> workers_;',
          'public:',
          '  Pool() : rx_(&Pool::rxLoop, this) { workers_.emplace_back(&Pool::work, this); }',
          '  void rxLoop() {} void txLoop() {} void work() {}',
          '};',
        ],
      }),
    );
    for (const to of ['heartbeat', 'acceptLoop']) assert.ok(spawn(g, 'cc:Server::init', 'cc:Server::' + to), `thread(&Server::${to}, this) under using namespace std`);
    assert.ok(spawn(g, 'cc:Server::acceptLoop', 'cc:Server::handle'), 'with extra arguments');
    for (const g_ of ['g1', 'g2', 'g3', 'g5', 'g6', 'g9']) assert.equal(spawn(g, 'cc:' + g_, 'cc:w')?.conf, 'exact', g_);
    assert.ok(spawn(g, 'cc:g4', 'cc:ns::job'), 'using namespace std inside the function');
    assert.ok(spawn(g, 'cc:g7', 'cc:load'), 'std::async with a launch policy');
    assert.ok(spawn(g, 'cc:g8', 'cc:ns::job'), 'the function named through `using ns::job;`');
    assert.equal(spawn(g, 'cc:g1', 'cc:w')?.via, 'std::thread');
    assert.ok(spawn(g, 'cc:Pool::Pool', 'cc:Pool::rxLoop'), 'constructor initializer of a thread member');
    assert.ok(spawn(g, 'cc:Pool', 'cc:Pool::txLoop'), 'default member initializer: runs in every constructor');
    assert.ok(spawn(g, 'cc:Pool::Pool', 'cc:Pool::work'), 'emplace_back into a vector of jthread');
  });

  it('C++: a bare `thread` is std::thread when an included header says `using namespace std;`, a guess otherwise', async () => {
    const files = (header: string[]) => ({
      'common.h': ['#pragma once', '#include <thread>', ...header],
      'run.cpp': ['#include "common.h"', 'void k() {}', 'void start() { thread t(k); t.join(); }'],
    });
    assert.equal(spawn(await analyze(project(files(['using namespace std;']))), 'cc:start', 'cc:k')?.conf, 'exact');
    assert.equal(spawn(await analyze(project(files([]))), 'cc:start', 'cc:k')?.conf, 'guess');
    const own = await analyze(project({ ...files([]), 'thread.cpp': ['struct thread { thread(void (*f)()); };'] }));
    assert.equal(spawn(own, 'cc:start', 'cc:k'), undefined, 'the workspace has its own `thread`');
    const c = await analyze(project({ 'a.c': ['void thread(int x) {}', 'void use(void) { thread(1); }'] }));
    assert.ok(rel(c, 'call', 'cc:use', 'cc:thread'), 'C: a function named thread is just a function');
  });

  it('C++: workspace names through `using ns::f;`, namespace aliases, block `using namespace` and headers', async () => {
    const g = await analyze(
      project({
        'util.h': [
          '#pragma once',
          'namespace lib { namespace net { void send(int x); class Widget { public: Widget(int); void run(); }; } }',
          'namespace other { void send(int x); }',
          'using namespace lib;',
        ],
        'util.cpp': ['#include "util.h"', 'namespace lib { namespace net { void send(int x) {} Widget::Widget(int) {} void Widget::run() {} } }', 'namespace other { void send(int x) {} }'],
        'use.cpp': [
          '#include "util.h"',
          'namespace ln = lib::net;',
          'using lib::net::Widget;',
          'void a() { ln::send(1); }',
          'void b() { using lib::net::send; send(2); }',
          'void c() { using namespace lib::net; send(3); }',
          'void d(int n) { Widget w(n); w.run(); }',
          'void e() { net::send(5); }',
          'void f() { auto p = new ln::Widget(6); p->run(); }',
        ],
      }),
    );
    const send = 'cc:lib::net::send';
    assert.equal(rel(g, 'call', 'cc:a', send)?.conf, 'exact', 'namespace alias');
    assert.equal(rel(g, 'call', 'cc:b', send)?.conf, 'exact', 'using-declaration in the function');
    assert.equal(rel(g, 'call', 'cc:c', send)?.conf, 'exact', 'using-directive in the function');
    assert.equal(rel(g, 'call', 'cc:e', send)?.conf, 'exact', "the header's using namespace lib");
    assert.equal(rel(g, 'instantiate', 'cc:d', 'cc:lib::net::Widget')?.conf, 'exact', '`Widget w(n);` through `using lib::net::Widget;`');
    assert.ok(rel(g, 'call', 'cc:d', 'cc:lib::net::Widget::run'));
    assert.equal(rel(g, 'instantiate', 'cc:f', 'cc:lib::net::Widget')?.conf, 'exact');
    assert.ok(rel(g, 'call', 'cc:f', 'cc:lib::net::Widget::run'));
    assert.equal(rel(g, 'call', 'cc:b', 'cc:other::send'), undefined);
  });

  it('Python: threading and asyncio under any import name', async () => {
    const g = await analyze(
      project({
        'app.py': [
          'import threading',
          'import threading as th',
          'from threading import Thread',
          'from threading import Thread as T',
          'from concurrent.futures import ThreadPoolExecutor',
          'import asyncio as aio',
          'from asyncio import create_task as spawn_task',
          'def w1(): pass',
          'def w2(): pass',
          'def w3(): pass',
          'def w4(): pass',
          'def w5(): pass',
          'async def c1(): pass',
          'async def c2(): pass',
          'def start():',
          '    threading.Thread(target=w1).start()',
          '    th.Thread(target=w2).start()',
          '    Thread(target=w3).start()',
          '    T(target=w4).start()',
          '    with ThreadPoolExecutor() as ex:',
          '        ex.submit(w5)',
          'async def main():',
          '    aio.create_task(c1())',
          '    spawn_task(c2())',
        ],
      }),
    );
    for (const w of ['w1', 'w2', 'w3', 'w4', 'w5']) assert.ok(spawn(g, 'py:app.py:start', 'py:app.py:' + w), w);
    for (const c of ['c1', 'c2']) assert.ok(spawn(g, 'py:app.py:main', 'py:app.py:' + c), c);
    assert.equal(spawn(g, 'py:app.py:start', 'py:app.py:w2')?.via, 'threading.Thread', 'th.Thread named by its module');
  });
});

describe('where a class\'s objects live', () => {
  it('finds members, parameters and returns by scope, even partly qualified, and keeps same names apart', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-usage-'));
    fs.writeFileSync(
      path.join(dir, 'shop.hpp'),
      [
        'namespace shop {',
        'namespace billing {',
        'class Address { public: int zip; };',
        'class Note { public: int id; };',
        'class Customer { public: Note note; Address address; };',
        'class Order { public: billing::Customer customer; };',
        '}',
        'namespace shipping {',
        'class Address { public: int zip; };',
        'class Customer { public: Address address; };',
        '}',
        '}',
        'struct Store { void take(const shop::billing::Order& o); shop::billing::Customer make(); ::shop::shipping::Customer other; };',
      ].join('\n'),
    );
    const g = await analyze(dir);
    const { typeUsages } = await import('../src/webview/usage');
    const cls = (q: string) => g.entities.find((e) => e.kind === 'class' && e.qname === q)!;
    const holders = (q: string) => typeUsages(g, cls(q)).holders.map((u) => `${g.entities.find((e) => e.id === u.id)!.qname}.${u.name}`).sort();
    assert.deepEqual(holders('shop::billing::Customer'), ['shop::billing::Order.customer'], 'written as billing::Customer inside shop::billing::Order');
    assert.deepEqual(holders('shop::billing::Address'), ['shop::billing::Customer.address'], 'not shipping::Customer, whose Address is shipping::Address');
    assert.deepEqual(holders('shop::shipping::Address'), ['shop::shipping::Customer.address']);
    assert.deepEqual(holders('shop::shipping::Customer'), ['Store.other'], '::shop::shipping::Customer, fully qualified from the global scope');
    const u = typeUsages(g, cls('shop::billing::Order'));
    assert.deepEqual(u.takers.map((t) => t.name), ['o']);
    assert.deepEqual(typeUsages(g, cls('shop::billing::Customer')).givers.map((t) => t.type), ['shop::billing::Customer']);
  });

  it('C: the same struct name in two files is the one of the file (or its headers) that writes it', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-usage-c-'));
    fs.writeFileSync(path.join(dir, 'buf.h'), ['typedef struct buffer buffer_t;', 'struct pool { buffer_t* free; };', 'void buf_init(buffer_t* b);'].join('\n'));
    fs.writeFileSync(path.join(dir, 'buf.c'), ['#include "buf.h"', 'struct buffer { int len; };', 'struct cache { struct buffer* head; };', 'void buf_init(buffer_t* b) { b->len = 0; }'].join('\n'));
    fs.writeFileSync(path.join(dir, 'net.c'), ['struct buffer { char data[64]; };', 'struct conn { struct buffer in; };'].join('\n'));
    fs.writeFileSync(path.join(dir, 'anon.c'), ['typedef struct { int x; } point_t;', 'struct shape { point_t origin; };'].join('\n'));
    const g = await analyze(dir);
    const { typeUsages } = await import('../src/webview/usage');
    const buffers = g.entities.filter((e) => e.kind === 'class' && e.name === 'buffer');
    assert.equal(buffers.length, 2);
    const inFile = (f: string) => buffers.find((b) => b.def?.file === f)!;
    const names = (e: Entity) => typeUsages(g, e).holders.map((u) => `${g.entities.find((x) => x.id === u.id)!.name}.${u.name}`).sort();
    assert.deepEqual(names(inFile('buf.c')), ['cache.head', 'pool.free'], 'pool is in buf.h, written as the typedef buffer_t declared there');
    assert.deepEqual(names(inFile('net.c')), ['conn.in']);
    assert.deepEqual(typeUsages(g, inFile('buf.c')).takers.map((t) => t.name), ['b'], 'buffer_t* b');
    const point = g.entities.find((e) => e.kind === 'class' && e.name === 'point_t')!;
    assert.deepEqual(names(point), ['shape.origin'], 'an anonymous struct named by its typedef');
  });

  it('C++: a `using` or `typedef` name for a class counts as the class', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-usage-alias-'));
    fs.writeFileSync(path.join(dir, 'net.hpp'), ['namespace net {', 'struct Packet { int len; };', 'using Frame = Packet;', 'typedef Packet Datagram;', 'using FramePtr = Packet*;', '}'].join('\n'));
    fs.writeFileSync(path.join(dir, 'link.hpp'), ['#include "net.hpp"', 'struct Link { net::Frame last; net::Datagram first; void send(const net::Frame& f); };'].join('\n'));
    const g = await analyze(dir);
    const { typeUsages } = await import('../src/webview/usage');
    const pkt = g.entities.find((e) => e.kind === 'class' && e.qname === 'net::Packet')!;
    assert.deepEqual(pkt.aliases?.sort(), ['Datagram', 'Frame'], 'not FramePtr, a pointer');
    const u = typeUsages(g, pkt);
    assert.deepEqual(u.holders.map((h) => h.name).sort(), ['first', 'last']);
    assert.deepEqual(u.takers.map((t) => t.name), ['f']);
  });

  it('Python: the same class name in two modules is the one the file imports', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-usage-py-'));
    fs.mkdirSync(path.join(dir, 'app'));
    fs.writeFileSync(path.join(dir, 'app', '__init__.py'), 'from .models import User\n');
    fs.writeFileSync(path.join(dir, 'app', 'models.py'), ['class User:', '    pass', 'class Config:', '    pass'].join('\n'));
    fs.writeFileSync(path.join(dir, 'app', 'legacy.py'), ['class Config:', '    pass'].join('\n'));
    fs.writeFileSync(
      path.join(dir, 'app', 'service.py'),
      [
        'from typing import TYPE_CHECKING, Optional',
        'from .models import Config',
        'from . import legacy as old',
        'from .legacy import Config as LegacyConfig',
        'from app import User',
        'if TYPE_CHECKING:',
        '    from .models import Config as Settings',
        'class Service:',
        '    def __init__(self, cfg: Config, prev: "LegacyConfig", back: old.Config, opt: Optional[Settings] = None):',
        '        self.cfg: Config | None = cfg',
        '        self.users: list[User] = []',
        '    def legacy(self) -> "old.Config":',
        '        return old.Config()',
      ].join('\n'),
    );
    const g = await analyze(dir);
    const { typeUsages } = await import('../src/webview/usage');
    const cls = (file: string, name: string) => g.entities.find((e) => e.kind === 'class' && e.name === name && e.def?.file === file)!;
    const modern = typeUsages(g, cls('app/models.py', 'Config'));
    const old = typeUsages(g, cls('app/legacy.py', 'Config'));
    assert.deepEqual(modern.takers.map((t) => t.name), ['cfg'], 'Config from .models');
    assert.deepEqual(modern.holders.map((h) => h.name), ['cfg'], 'self.cfg: Config | None');
    assert.deepEqual(old.takers.map((t) => t.name), ['prev'], '"LegacyConfig" (string annotation, imported under another name)');
    assert.deepEqual(old.givers.map((t) => t.type), ['"old.Config"'], 'a module imported under another name');
    const users = typeUsages(g, cls('app/models.py', 'User'));
    assert.deepEqual(users.holders.map((h) => h.name), ['users'], 'list[User], re-exported by the package');
    // each parameter on its own: which file's Config it names
    const { TypeIndex, writerOf } = await import('../src/webview/usage');
    const index = new TypeIndex(g);
    const svc = g.entities.find((e) => e.qname.endsWith('Service.__init__'))!;
    const fileOf = (type: string) => [...index.classesIn(type, writerOf(svc))].map((id) => g.entities.find((e) => e.id === id)!.def!.file);
    assert.deepEqual(
      Object.fromEntries((svc.params ?? []).filter((p) => p.type).map((p) => [p.name, fileOf(p.type!)])),
      { cfg: ['app/models.py'], prev: ['app/legacy.py'], back: ['app/legacy.py'], opt: ['app/models.py'] },
      'opt: Optional[Settings] comes from an import under `if TYPE_CHECKING:`',
    );
  });
});

describe('where members are read and written', () => {
  const sites = async (g: CodeGraph) => {
    const { MemberIndex } = await import('../src/webview/members');
    const mi = new MemberIndex(g);
    const q = (id: string) => g.entities.find((e) => e.id === id)!.qname;
    // "Class.member" → ["R fn", "W fn"]
    return (cls: string, member: string) => {
      const c = g.entities.find((e) => e.kind === 'class' && e.qname === cls)!;
      return (mi.of(c.id).get(member) ?? []).map((s) => `${s.write ? 'W' : 'R'} ${q(s.fn)}`).sort();
    };
  };

  it('C++: chains through member types, this->, bare members, base classes; reads and writes', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-members-'));
    fs.writeFileSync(
      path.join(dir, 'cfg.hpp'),
      [
        'namespace app {',
        'struct Peer { int port; };',
        'struct Link { Peer peer; int retries; };',
        'struct Settings { Link link; };',
        'struct Base { int id; };',
        'class Client : public Base {',
        ' public:',
        '  explicit Client(const Settings& s) : cfg_(s), sent_(0) {}',
        '  void connect();',
        '  int count() const { return sent_; }',
        ' private:',
        '  Settings cfg_;',
        '  int sent_;',
        '};',
        '}',
      ].join('\n'),
    );
    fs.writeFileSync(
      path.join(dir, 'client.cpp'),
      [
        '#include "cfg.hpp"',
        'namespace app {',
        'void Client::connect() {',
        '  int port = cfg_.link.peer.port;',
        '  this->cfg_.link.retries = 3;',
        '  sent_++;',
        '  id = port;',
        '}',
        'void tune(Settings& s, Link* l) {',
        '  s.link.peer.port = 8080;',
        '  int* r = &l->retries;',
        '  (void)r;',
        '}',
        'int shadow() { int sent_ = 1; return sent_; }',
        '}',
      ].join('\n'),
    );
    const at = await sites(await analyze(dir));
    assert.deepEqual(at('app::Peer', 'port'), ['R app::Client::connect', 'W app::tune'], 'cfg_.link.peer.port, s.link.peer.port = …');
    assert.deepEqual(at('app::Link', 'retries'), ['W app::Client::connect', 'W app::tune'], 'this->…retries = 3, &l->retries');
    assert.deepEqual(at('app::Settings', 'link'), ['R app::Client::connect', 'R app::tune'], 'on the way to the member');
    assert.deepEqual(at('app::Client', 'sent_'), ['R app::Client::count', 'W app::Client::Client', 'W app::Client::connect'], 'bare name in a method, ++, the constructor\'s initializer list; not the local in shadow()');
    assert.deepEqual(at('app::Base', 'id'), ['W app::Client::connect'], 'a member of the base class');
  });

  it('C: struct members through typed parameters', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-members-c-'));
    fs.writeFileSync(path.join(dir, 'buf.c'), ['struct buffer { int len; char* data; };', 'void reset(struct buffer* b) { b->len = 0; }', 'int size(const struct buffer* b) { return b->len; }'].join('\n'));
    const at = await sites(await analyze(dir));
    assert.deepEqual(at('buffer', 'len'), ['R size', 'W reset']);
  });

  it('Python: self and typed parameters, through attribute types (also taken from a typed parameter)', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-members-py-'));
    fs.writeFileSync(
      path.join(dir, 'svc.py'),
      [
        'class Peer:',
        '    def __init__(self, port: int):',
        '        self.port = port',
        'class Settings:',
        '    def __init__(self):',
        '        self.peer = Peer(1)',
        'class Client:',
        '    def __init__(self, cfg: Settings):',
        '        self.cfg = cfg',
        '        self.sent = 0',
        '    def connect(self):',
        '        self.sent += 1',
        '        return self.cfg.peer.port',
        'def tune(s: Settings):',
        '    s.peer.port = 8080',
      ].join('\n'),
    );
    const at = await sites(await analyze(dir));
    assert.deepEqual(at('svc.Peer', 'port'), ['R svc.Client.connect', 'W svc.Peer.__init__', 'W svc.tune']);
    assert.deepEqual(at('svc.Client', 'sent'), ['W svc.Client.__init__', 'W svc.Client.connect']);
    assert.deepEqual(at('svc.Client', 'cfg'), ['R svc.Client.connect', 'W svc.Client.__init__']);
  });
});

describe('return statements (every language)', () => {
  // One rule for every extractor: a call inside a `return` is a call of the function, and a function's returns
  // are its own — those of a lambda, nested function or local class inside it are not.
  let g: CodeGraph;
  before(async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-returns-'));
    fs.writeFileSync(
      path.join(dir, 'a.cpp'),
      [
        'int g() { return 1; }', // 1
        'int h() { return 2; }', // 2
        'struct B { int b() { return 3; } };', // 3
        'B make() { return B(); }', // 4
        'int f() { return g(); }', // 5
        'int pick(bool ok) { return ok ? g() : h(); }', // 6
        'int chain() { return make().b(); }', // 7
        'void run() {', // 8
        '  auto k = [] { return g(); };', // 9
        '  struct Local { int m() { return h(); } };', // 10
        '  k();', // 11
        '}', // 12
        'int twice(int x) {', // 13
        '  if (x < 0) return -1;', // 14
        '  return', // 15
        '    g();', // 16
        '}', // 17
      ].join('\n'),
    );
    fs.writeFileSync(path.join(dir, 'b.c'), ['static int cg(void) { return 1; }', 'int cf(void) { return cg(); }', 'int ct(int ok) { return ok ? cg() : cf(); }'].join('\n'));
    fs.writeFileSync(
      path.join(dir, 'p.py'),
      [
        'def pg(): return 1', // 1
        'def ph(): return 2', // 2
        'def pf(): return pg()', // 3
        'def pt(ok): return pg() if ok else ph()', // 4
        'async def pa(): return 1', // 5
        'async def pw(): return await pa()', // 6
        'def gen(): yield 1', // 7
        'def pgen(): yield from gen()', // 8
        'def outer():', // 9
        '    def inner():', // 10
        '        return pg()', // 11
        '    k = lambda: ph()', // 12
        '    inner()', // 13
      ].join('\n'),
    );
    g = await analyze(dir);
  });
  const fn = (q: string) => g.entities.find((e) => e.kind === 'function' && (e.qname === q || e.qname.endsWith('.' + q)))!;

  it('C++: a call in a return is a call of the function', () => {
    assert.ok(rel(g, 'call', 'cc:f', 'cc:g'), 'return g();');
    assert.ok(rel(g, 'call', 'cc:pick', 'cc:g') && rel(g, 'call', 'cc:pick', 'cc:h'), 'return ok ? g() : h();');
    assert.ok(rel(g, 'call', 'cc:chain', 'cc:make') && rel(g, 'call', 'cc:chain', 'cc:B::b'), 'return make().b();');
    assert.ok(rel(g, 'call', 'cc:twice', 'cc:g'), 'a return spread over two lines');
  });

  it('C++: returns of lambdas and local classes stay theirs', () => {
    assert.deepEqual(fn('run').rets, [], 'a void function with a lambda and a local class returns nothing itself');
    assert.deepEqual(fn('twice').rets, [14, 15]);
    assert.deepEqual(fn('f').rets, [5]);
  });

  it('C: a call in a return is a call of the function', () => {
    assert.ok(g.relations.some((r) => r.kind === 'call' && r.from === 'cc:cf' && r.to.startsWith('cc:cg')));
    assert.ok(g.relations.some((r) => r.kind === 'call' && r.from === 'cc:ct' && r.to === 'cc:cf'));
    assert.deepEqual(fn('ct').rets, [3]);
  });

  it('Python: calls in return, await and yield from; nested functions and lambdas return for themselves', () => {
    const id = (n: string) => `py:p.py:${n}`;
    assert.ok(rel(g, 'call', id('pf'), id('pg')));
    assert.ok(rel(g, 'call', id('pt'), id('pg')) && rel(g, 'call', id('pt'), id('ph')));
    assert.ok(rel(g, 'call', id('pw'), id('pa')), 'return await pa()');
    assert.ok(rel(g, 'call', id('pgen'), id('gen')), 'yield from gen()');
    assert.deepEqual(fn('outer').rets, [], 'the return in inner() and the lambda are not outer()\'s');
    assert.deepEqual(fn('inner').rets, [11]);
    assert.deepEqual(fn('pgen').rets, [8]);
  });
});

describe('robustness & incremental updates', () => {
  it('survives syntax errors and only re-parses changed files', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-test-'));
    fs.writeFileSync(path.join(dir, 'a.py'), 'def f(:\n    return g(\n\ndef g():\n    pass\n');
    fs.writeFileSync(path.join(dir, 'b.cpp'), 'int h() { return 1 +; }\nint k() { return h(); }\n');
    const pool = new ParsePool(WASM, WORKER, 0);
    let parsed = 0;
    const orig = pool.parse.bind(pool);
    pool.parse = async (jobs, p) => {
      parsed += jobs.length;
      return orig(jobs, p);
    };
    const session = new AnalysisSession(dir, pool);
    const g1 = await session.analyze(walk(dir).files);
    assert.equal(parsed, 2);
    assert.ok(g1.entities.some((e) => e.name === 'k'));
    assert.ok(rel(g1, 'call', 'cc:k', 'cc:h'));
    // touch one file
    fs.writeFileSync(path.join(dir, 'b.cpp'), 'int h() { return 1; }\nint k() { return h() + h(); }\nint m() { return k(); }\n');
    const g2 = await session.analyze(walk(dir).files);
    assert.equal(parsed, 3, 'only the changed file is parsed again');
    assert.ok(rel(g2, 'call', 'cc:m', 'cc:k'));
    pool.dispose();
  });
});
