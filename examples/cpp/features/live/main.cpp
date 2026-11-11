// Runs until you press Stop: workers handling requests, something to watch in the live view.
#include <atomic>
#include <chrono>
#include <thread>
#include <vector>

std::atomic<long> handled{0};

int parse(long i) { return static_cast<int>(i % 7); }
void store(long i) { handled += i; std::this_thread::sleep_for(std::chrono::microseconds(300)); }
void handle(long i) { store(parse(i)); }

void serve(int id) {
  for (long i = 0;; i++) {
    handle(i + id);
    if (i % 100 == 0) std::this_thread::sleep_for(std::chrono::milliseconds(20));
  }
}

void flush() { for (;;) { store(-1); std::this_thread::sleep_for(std::chrono::milliseconds(200)); } }

int main() {
  std::vector<std::thread> pool;
  for (int i = 0; i < 3; i++) pool.emplace_back(serve, i);
  std::thread f(flush);
  f.join();
}
