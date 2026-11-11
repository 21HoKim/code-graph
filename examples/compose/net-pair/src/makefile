# Two programs from the same sources: node-b listens, node-a connects (see ../compose.yaml).
SRCS = main.cpp config.cpp link.cpp proto.cpp

node-a: $(SRCS)
	mkdir -p ../build
	g++ -o ../build/node-a -DNODE_A $(SRCS) -std=c++17 -Wall -Wextra -lcrypto -pthread

node-b: $(SRCS)
	mkdir -p ../build
	g++ -o ../build/node-b -DNODE_B $(SRCS) -std=c++17 -Wall -Wextra -lcrypto -pthread

all: node-a node-b

.PHONY: all node-a node-b
