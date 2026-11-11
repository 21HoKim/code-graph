#ifndef SENSOR_H
#define SENSOR_H
struct sensor { int raw; int offset; };
int sensor_read(struct sensor *s);
void log_flush(void);
#endif
