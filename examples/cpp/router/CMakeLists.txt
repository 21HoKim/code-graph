cmake_minimum_required(VERSION 3.16)
project(mini_router CXX C)
set(CMAKE_CXX_STANDARD 17)
add_executable(router src/main.cpp src/net/router.cpp src/net/queue.cpp src/net/route_table.cpp
               src/net/interface.cpp src/net/packet.cpp src/util/log.cpp src/crc/crc32.c)
target_include_directories(router PRIVATE include src)
target_link_libraries(router PRIVATE pthread)
