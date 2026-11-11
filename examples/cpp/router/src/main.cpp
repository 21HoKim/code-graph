#include <chrono>
#include <csignal>
#include <memory>
#include <thread>

#include "net/router.h"
#include "util/log.h"

static net::Router* g_router = nullptr;

static void onSignal(int) {
  if (g_router) g_router->stop();
}

int main(int argc, char** argv) {
  util::setLevel(argc > 1 ? 2 : 1);
  net::Router router(4);
  g_router = &router;
  std::signal(SIGINT, onSignal);
  router.addInterface(std::make_unique<net::EthInterface>("eth0"));
  router.addInterface(std::make_unique<net::LoopbackInterface>());
  router.start();
  std::this_thread::sleep_for(std::chrono::seconds(1));
  router.stop();
  return 0;
}
