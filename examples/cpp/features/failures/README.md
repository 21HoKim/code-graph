# C++ · failures

Press **▶ Run & Trace**. The program ends with an uncaught exception on purpose.

- [ ] `parse` turns red: `std::invalid_argument: empty field`, in the `worker` thread
- [ ] The run summary shows where every thread was at that moment (`waiter` sleeping)
