# @tuttiai/server

## 0.3.0

### Minor Changes

- Add `/studio/*` static serving, `/studio/events` SSE stream, `/graph` endpoint, `/sessions` and `/sessions/:id/turns` endpoints

## 0.2.0

### Minor Changes

- Add GET /sessions/:id/interrupts, GET /interrupts/pending, POST /interrupts/:id/approve, POST /interrupts/:id/deny endpoints; broadcast interrupt:requested WebSocket event
