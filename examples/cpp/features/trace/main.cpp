// Run & Trace: threads, values, one queue shared by two threads, virtual dispatch and a callback seen at run time.
#include <condition_variable>
#include <cstdio>
#include <functional>
#include <mutex>
#include <queue>
#include <string>
#include <thread>

class Sink {
public:
  virtual ~Sink() = default;
  virtual void put(const std::string& line) = 0;
};
class Console : public Sink {
public:
  void put(const std::string& line) override { if (line.size() > 100) std::puts(line.c_str()); }
};

class Queue {
public:
  void push(int v) { { std::lock_guard<std::mutex> l(mu_); q_.push(v); } cv_.notify_one(); }
  int pop() {
    std::unique_lock<std::mutex> l(mu_);
    cv_.wait(l, [this] { return !q_.empty(); });
    int v = q_.front();
    q_.pop();
    return v;
  }
private:
  std::mutex mu_;
  std::condition_variable cv_;
  std::queue<int> q_;
};

void produce(Queue& q, int n) { for (int i = 0; i < n; i++) q.push(i); q.push(-1); }

void consume(Queue& q, Sink& out, const std::function<void(int)>& onItem) {
  for (int v; (v = q.pop()) >= 0;) {
    onItem(v);
    out.put("item " + std::to_string(v));
  }
}

void count(int v) { (void)v; }

int main() {
  Queue q;
  Console console;
  std::thread p(produce, std::ref(q), 20);
  std::thread c(consume, std::ref(q), std::ref(console), count);
  p.join();
  c.join();
  return 0;
}
