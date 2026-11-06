#ifndef NATIVE_HOST_EMBEDDING_H
#define NATIVE_HOST_EMBEDDING_H

#include <stddef.h>
#include <stdint.h>

#if defined(NH_PRODUCTION_ARTIFACT) && NH_PRODUCTION_ARTIFACT && defined(NH_DEV_UPDATES) && NH_DEV_UPDATES
#error "Development update ingress is forbidden in production artifacts"
#endif

#ifdef __cplusplus
extern "C" {
#endif

typedef struct NHHost NHHost;
typedef void (*NHCommitCallback)(void *context, const char *snapshot_json);
/* Request is borrowed for this call. Return a malloc-allocated UTF-8 JSON
 * object {"result":null} or {"error":{"code":"...","message":"..."}}.
 * The host always frees the returned allocation, including malformed errors.
 * Success acknowledges submission only, not asynchronous browser completion.
 * Do not call dispatch, pump or destroy on this host inside either callback:
 * enqueue native delegate events onto a later owner/UI-thread turn instead.
 */
typedef char *(*NHCommandCallback)(void *context, const char *command_json);
#define NH_HOST_OPTIONS_VERSION 1
typedef struct NHHostOptions {
  uint32_t version;
  size_t size;
  NHCommitCallback commit_callback;
  void *commit_context;
  NHCommandCallback command_callback;
  void *command_context;
  /* Copied during creation; map from supported primitive to command arrays,
   * e.g. {"TextInput":["focus","blur","clear"]}. NULL means {}.
   * Unknown types/commands, duplicate entries or capabilities without a
   * command callback reject creation before application bundle evaluation.
   */
  const char *command_capabilities_json;
  /* Optional size-gated extension. NULL disables the real platform AppState
   * service. iOS: active/inactive/background. Android: active/background for
   * the selected single Activity. Copied before bundle evaluation. */
  const char *initial_app_state;
} NHHostOptions;
#define NH_HOST_OPTIONS_V1_SIZE offsetof(NHHostOptions, initial_app_state)

/* All functions except string_free must run on the creating thread. The bundle
 * executes during create; commit callbacks can therefore occur before it
 * returns. Callback strings are borrowed only for the duration of the callback.
 */
NHHost *nh_host_create(
    const char *bundle_path,
    double width,
    double height,
    const char *platform,
    NHCommitCallback callback,
    void *context);
/* Options/callbacks are installed before the application bundle executes.
 * version must be NH_HOST_OPTIONS_VERSION and size >= NH_HOST_OPTIONS_V1_SIZE.
 * The AppState tail field is read only when size >= sizeof(NHHostOptions).
 * Existing nh_host_create remains equivalent to empty command capabilities.
 */
NHHost *nh_host_create_with_options(
    const char *bundle_path,
    double width,
    double height,
    const char *platform,
    const NHHostOptions *options);
/* Owned JSON response: caller releases with nh_host_string_free. Request is
 * {id,method,params}; response is {id,result} or {id,error:{code,message}}.
 * runtime.eval is compiled only when NH_TEST_HOOKS is enabled. */
char *nh_host_dispatch(NHHost *host, const char *request_json);
char *nh_host_pump(NHHost *host);
/* Owner-thread native lifecycle ingress. Does not run JS or pump callbacks.
 * generation must match this host; caller must never pass a destroyed host.
 * Returns owned {id:null,result:{changed,sequence}} or error JSON, freed with
 * nh_host_string_free. Duplicate states publish no event. Native adapters must
 * detach observers and invalidate queued updates before host destruction. */
char *nh_host_app_state_update(NHHost *host, uint64_t generation, const char *state);
void nh_host_destroy(NHHost *host);
void nh_host_string_free(char *value);
/* Thread-local error from a failed create/destroy; borrowed until next API
 * call. */
const char *nh_host_last_error(void);

#if defined(NH_DEV_UPDATES) && NH_DEV_UPDATES
/* Development-only owner-thread ingress. Independent of NH_TEST_HOOKS.
 * All buffers are borrowed for the call; enqueue copies accepted payloads.
 * Returned JSON is owned and freed with nh_host_string_free. No function may
 * be entered during another host task or native callback. Revision strings
 * are 1..64 ASCII letters/digits/._-; zero-terminate fixed arrays.
 * open binds once to the exact initial bundle bytes and this host generation.
 * enqueue performs validation only; drain prepares/evaluates at most one patch
 * in a separate owner-thread task, without pumping timers/services. Successful
 * evaluation must return {status:'applied'}, then microtasks/mount must succeed.
 * Failed preparation leaves live application state unchanged. Execution failure
 * requires destruction/full reload; status and destroy remain available.
 */
#define NH_DEV_UPDATES_VERSION 1
#define NH_DEV_PATCH_MAX_BYTES (4 * 1024 * 1024)
typedef struct NHDevSessionV1 {
  uint32_t version;
  size_t size;
  uint64_t generation;
  uint8_t session_id[16];
  char initial_revision[65];
  uint8_t initial_bundle_sha256[32];
} NHDevSessionV1;
typedef struct NHDevPatchV1 {
  uint32_t version;
  size_t size;
  uint64_t generation;
  uint8_t session_id[16];
  uint64_t sequence;
  char base_revision[65];
  char target_revision[65];
  uint8_t payload_sha256[32];
  const uint8_t *payload;
  size_t payload_length;
} NHDevPatchV1;
char *nh_host_dev_open(NHHost *host, const NHDevSessionV1 *session);
char *nh_host_dev_enqueue(NHHost *host, const NHDevPatchV1 *patch);
char *nh_host_dev_drain(NHHost *host);
char *nh_host_dev_status(NHHost *host);
#endif

#ifdef __cplusplus
}
#endif
#endif
