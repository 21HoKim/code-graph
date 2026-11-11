// Every way a C++ program starts a thread or a task that CodeGraph recognises, however std:: is spelled.
#include <future>
#include <thread>
#include <vector>
#include <pthread.h>

using namespace std;                                   // thread below means std::thread

void work() {}
int load(int n) { return n; }
namespace jobs { void sweep() {} }
void* legacy(void*) { return nullptr; }

class Server {
public:
  Server() : rx_(&Server::rxLoop, this) {}             // a thread member started by the constructor
  ~Server() { rx_.join(); tx_.join(); for (auto& w : workers_) w.join(); }
  void start() {
    thread(&Server::heartbeat, this).detach();         // a temporary, unqualified (using namespace std)
    for (int i = 0; i < 2; i++) workers_.emplace_back(&Server::handle, this, i);  // into a vector of threads
  }
  void rxLoop() {}
  void txLoop() {}
  void heartbeat() {}
  void handle(int id) { (void)id; }
private:
  thread rx_;
  thread tx_{&Server::txLoop, this};                   // default member initializer
  vector<thread> workers_;
};

int main() {
  std::thread a(work);                                  // read by C++ as a variable, not a function declaration
  std::thread b{work};                                  // braces
  auto c = std::thread(work);
  {
    using std::thread;                                  // a using-declaration in a block
    thread d(jobs::sweep);
    d.join();
  }
  using Worker = std::thread;                           // an alias
  Worker e(work);
  auto r = std::async(std::launch::async, load, 3);     // a task, with a launch policy
  pthread_t p;
  pthread_create(&p, nullptr, legacy, nullptr);         // the C API from C++
  Server s;
  s.start();
  a.join(); b.join(); c.join(); e.join();
  pthread_join(p, nullptr);
  return r.get() == 3 ? 0 : 1;
}
