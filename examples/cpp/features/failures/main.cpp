// An uncaught exception in a worker thread: the function turns red with the exception's type and message.
#include <chrono>
#include <stdexcept>
#include <thread>
#include <vector>

int parse(const char* s) {
  if (!s || !*s) throw std::invalid_argument("empty field");
  return *s - '0';
}

void worker(std::vector<const char*> fields) {
  int sum = 0;
  for (auto f : fields) sum += parse(f);
  (void)sum;
}

void waiter() { std::this_thread::sleep_for(std::chrono::milliseconds(200)); }

int main() {
  std::thread w(waiter);
  std::thread t(worker, std::vector<const char*>{"1", "2", ""});
  t.join();
  w.join();
}
