# C++ · threads

Thread starts are ⚡ dashed wires, found through `using namespace std;`, `using std::thread;`, aliases and every
way of writing the construction.

- [ ] `main` ⚡ `work` (`T t(f)`, `T t{f}`, `= std::thread(f)`, alias `Worker`; `std::jthread` is read the same way),
      ⚡ `jobs::sweep`, ⚡ `load` (`std::async`), ⚡ `legacy` (`pthread_create`)
- [ ] `Server::Server` ⚡ `rxLoop` (initializer list); class `Server` ⚡ `txLoop` (default member initializer)
- [ ] `Server::start` ⚡ `heartbeat` (temporary under `using namespace std`) and ⚡ `handle` (`emplace_back`)
- [ ] **Run & Trace**: each lane branches off the thread that started it; the details of a thread say which
      function started it
