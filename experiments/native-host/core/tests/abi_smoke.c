/* Exercises the actual linked C ABI, independent of Rust unit tests. */
#include "native_host.h"

#include <assert.h>
#include <pthread.h>
#include <stdio.h>
#include <string.h>
#include <time.h>

_Static_assert(offsetof(NhEvent, generation) == 0, "event generation ABI");
_Static_assert(offsetof(NhEvent, id) == 8, "event id ABI");
_Static_assert(offsetof(NhEvent, kind) == 16, "event kind ABI");
_Static_assert(offsetof(NhEvent, status) == 20, "event status ABI");

typedef struct WrongThreadArgs {
  NhRuntime *runtime;
  uint64_t generation;
} WrongThreadArgs;

static void *wrong_thread(void *context) {
  WrongThreadArgs *args = context;
  uint64_t request = 99;
  assert(nh_submit(args->runtime, args->generation, NULL, 0, 0, &request) ==
         NH_WRONG_THREAD);
  assert(request == 0);
  assert(nh_runtime_destroy(args->runtime) == NH_WRONG_THREAD);
  return NULL;
}

static double monotonic_seconds(void) {
  struct timespec now;
  assert(clock_gettime(CLOCK_MONOTONIC, &now) == 0);
  return (double)now.tv_sec + (double)now.tv_nsec / 1000000000.0;
}

static NhEvent wait_event(NhRuntime *runtime, uint64_t generation) {
  NhEvent event = {0};
  double deadline = monotonic_seconds() + 3.0;
  while (1) {
    uint32_t result = nh_poll(runtime, generation, &event);
    if (result == NH_OK) {
      return event;
    }
    assert(result == NH_EMPTY);
    assert(monotonic_seconds() < deadline);
    struct timespec pause = {.tv_sec = 0, .tv_nsec = 1000000};
    nanosleep(&pause, NULL);
  }
}

int main(void) {
  NhRuntime *runtime = NULL;
  assert(nh_runtime_create(999, 4, &runtime) == NH_SCHEMA_MISMATCH);
  assert(runtime == NULL);
  assert(nh_runtime_create(NH_SCHEMA_VERSION, 4, &runtime) == NH_OK);
  uint64_t generation = nh_runtime_generation(runtime);
  assert(generation != 0);

  WrongThreadArgs args = {runtime, generation};
  pthread_t thread;
  assert(pthread_create(&thread, NULL, wrong_thread, &args) == 0);
  assert(pthread_join(thread, NULL) == 0);

  uint8_t payload[] = {0, 255, 42, 0};
  uint64_t request = 0;
  assert(nh_submit(runtime, generation, payload, sizeof(payload), 0, &request) ==
         NH_OK);
  memset(payload, 11, sizeof(payload));
  NhEvent echo = wait_event(runtime, generation);
  const uint8_t expected[] = {0, 255, 42, 0};
  assert(echo.generation == generation && echo.id == request);
  assert(echo.kind == NH_REQUEST && echo.status == NH_SUCCESS);
  assert(echo.len == sizeof(expected));
  assert(memcmp(echo.data, expected, echo.len) == 0);

  assert(nh_submit(runtime, generation, NULL, 0, NH_MAX_DELAY_MS, &request) ==
         NH_OK);
  assert(nh_cancel(runtime, generation, request) == NH_OK);
  assert(nh_cancel(runtime, generation, request) == NH_ALREADY_SETTLED);
  NhEvent cancelled = wait_event(runtime, generation);
  assert(cancelled.status == NH_CANCELLED && cancelled.data == NULL);
  nh_event_free(&cancelled);
  assert(cancelled.id == 0 && cancelled.len == 0);

  uint64_t subscription = 0;
  assert(nh_subscribe(runtime, generation, &subscription) == NH_OK);
  assert(nh_publish(runtime, generation, subscription, expected,
                    sizeof(expected)) == NH_OK);
  assert(nh_unsubscribe(runtime, generation, subscription) == NH_OK);
  assert(nh_unsubscribe(runtime, generation, subscription) == NH_OK);
  NhEvent empty = {0};
  assert(nh_poll(runtime, generation, &empty) == NH_EMPTY);

#ifdef NH_TEST_HOOKS
  assert(nh_test_submit_error(runtime, generation, (const uint8_t *)"echo: fault",
                              11, 0, &request) == NH_OK);
  NhEvent error = wait_event(runtime, generation);
  assert(error.status == NH_ERROR && error.len == 11);
  nh_event_free(&error);
#endif

  assert(nh_runtime_destroy(runtime) == NH_OK);
  /* Returned bytes remain caller-owned after runtime destruction. */
  assert(memcmp(echo.data, expected, echo.len) == 0);
  nh_event_free(&echo);
  nh_event_free(&echo);

  assert(nh_runtime_create(NH_SCHEMA_VERSION, 1, &runtime) == NH_OK);
  assert(nh_runtime_generation(runtime) > generation);
  assert(nh_submit(runtime, generation, NULL, 0, 0, &request) ==
         NH_STALE_GENERATION);
  assert(nh_runtime_destroy(runtime) == NH_OK);
  puts("PASS C ABI: ownership, worker, cancellation, subscriptions, generations, thread affinity");
  return 0;
}
