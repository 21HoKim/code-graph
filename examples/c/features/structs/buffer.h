#ifndef BUFFER_H
#define BUFFER_H
typedef struct buffer buffer_t;                          /* another name for struct buffer */
struct buffer { char data[64]; int len; };
void buf_init(buffer_t *b);
int buf_len(const buffer_t *b);
#endif
