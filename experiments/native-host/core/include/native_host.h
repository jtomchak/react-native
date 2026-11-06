#ifndef NATIVE_HOST_CORE_H
#define NATIVE_HOST_CORE_H

#include <stddef.h>
#include <stdint.h>

#ifdef __cplusplus
extern "C" {
#endif

#define NH_SCHEMA_VERSION 1u
#define NH_MAX_CAPACITY 1024u
#define NH_MAX_PAYLOAD (1024u * 1024u)
#define NH_MAX_TOTAL_PAYLOAD (16u * NH_MAX_PAYLOAD)
#define NH_MAX_DELAY_MS 60000u

typedef struct NhRuntime NhRuntime;

enum NhStatus {
  NH_OK = 0,
  NH_INVALID_ARGUMENT = 1,
  NH_SCHEMA_MISMATCH = 2,
  NH_WRONG_THREAD = 3,
  NH_STALE_GENERATION = 4,
  NH_CAPACITY = 5,
  NH_NOT_FOUND = 6,
  NH_ALREADY_SETTLED = 7,
  NH_EMPTY = 8,
  NH_SHUTDOWN = 9,
  NH_INTERNAL = 10
};

enum NhEventKind { NH_REQUEST = 1, NH_MESSAGE = 2 };
enum NhEventStatus { NH_SUCCESS = 0, NH_ERROR = 1, NH_CANCELLED = 2 };

/* An owning event. Do not copy ownership. Call nh_event_free exactly once,
 * even after a runtime is destroyed. Empty payloads use NULL and length zero.
 * request IDs and subscription IDs are globally unique within this process. */
typedef struct NhEvent {
  uint64_t generation;
  uint64_t id;
  uint32_t kind;
  uint32_t status;
  uint8_t *data;
  size_t len;
} NhEvent;

typedef struct NhStats {
  uint64_t generation;
  size_t pending_requests;
  size_t queued_events;
  size_t subscriptions;
  size_t retained_bytes;
} NhStats;

/* All runtime operations (including destroy) are confined to the thread that
 * creates the runtime. A wrong-thread call returns NH_WRONG_THREAD, never enters
 * the service. Pointers must remain valid for the call; destroy is not concurrent
 * with any other operation. Invalid/freed pointers are caller errors. No native
 * callbacks enter JS; the embedding runtime polls from its own executor.
 * Capacity covers requests until their terminal event is polled, plus queued
 * subscription messages. Subscriptions have their own limit of capacity.
 * Retained pending/result/message bytes are also bounded by NH_MAX_TOTAL_PAYLOAD.
 * Creation clears *out on error. No runtime is created on schema mismatch. */
uint32_t nh_runtime_create(uint32_t schema_version, uint32_t capacity,
                           NhRuntime **out);
/* Returns zero for NULL or wrong-thread access. */
uint64_t nh_runtime_generation(const NhRuntime *runtime);
uint32_t nh_runtime_destroy(NhRuntime *runtime);
/* Atomic snapshot. Pending excludes terminal results already queued for poll;
 * retained_bytes excludes event bytes already returned to the caller. */
uint32_t nh_runtime_stats(NhRuntime *runtime, uint64_t generation, NhStats *out);

/* Copies bytes before returning. Completion is asynchronous, no later than the
 * worker can process the requested delay. NULL bytes is valid only when len=0.
 * delay is bounded by NH_MAX_DELAY_MS. *out_id is cleared on error. */
uint32_t nh_submit(NhRuntime *runtime, uint64_t generation, const uint8_t *bytes,
                   size_t len, uint32_t delay_ms, uint64_t *out_id);
/* First terminal transition wins. Winning cancel produces NH_CANCELLED.
 * Already queued completion yields NH_ALREADY_SETTLED; consumed/unknown IDs
 * yield NH_NOT_FOUND. No additional event is produced by a losing cancel. */
uint32_t nh_cancel(NhRuntime *runtime, uint64_t generation, uint64_t id);

/* out must point to storage not already owning an event. It is zeroed on error
 * and on NH_EMPTY. Every NH_OK result is an owning event, even if len=0. */
uint32_t nh_poll(NhRuntime *runtime, uint64_t generation, NhEvent *out);
/* Frees event bytes, then zeros all fields. NULL and an already-zero event are
 * accepted. May run after runtime destruction or on another thread. */
void nh_event_free(NhEvent *event);

uint32_t nh_subscribe(NhRuntime *runtime, uint64_t generation, uint64_t *out_id);
uint32_t nh_publish(NhRuntime *runtime, uint64_t generation, uint64_t id,
                    const uint8_t *bytes, size_t len);
/* Idempotent for unknown IDs. Drops queued messages, including their payloads.
 * Events already returned by nh_poll are delivered and remain caller-owned. */
uint32_t nh_unsubscribe(NhRuntime *runtime, uint64_t generation, uint64_t id);

#ifdef NH_TEST_HOOKS
/* Only exported by Cargo feature test-hooks. Produces NH_ERROR, carrying the
 * provided diagnostic bytes. Never enabled by default in shipping builds. */
uint32_t nh_test_submit_error(NhRuntime *runtime, uint64_t generation,
                              const uint8_t *bytes, size_t len,
                              uint32_t delay_ms, uint64_t *out_id);
#endif

#ifdef __cplusplus
}
#endif
#endif
