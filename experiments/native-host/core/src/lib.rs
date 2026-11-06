//! Bounded native services with explicit ownership and a polling C ABI.
//!
//! This crate never stores JS values or calls into a VM. One worker per runtime
//! completes asynchronous requests; only the embedding runtime thread may poll.

use std::collections::{BTreeMap, HashSet, VecDeque};
use std::panic::{catch_unwind, AssertUnwindSafe};
use std::ptr;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Condvar, Mutex, MutexGuard};
use std::thread::{self, JoinHandle, ThreadId};
use std::time::{Duration, Instant};

pub const SCHEMA_VERSION: u32 = 1;
pub const MAX_CAPACITY: usize = 1024;
pub const MAX_PAYLOAD: usize = 1024 * 1024;
pub const MAX_TOTAL_PAYLOAD: usize = 16 * MAX_PAYLOAD;
pub const MAX_DELAY_MS: u32 = 60_000;

pub const OK: u32 = 0;
pub const INVALID_ARGUMENT: u32 = 1;
pub const SCHEMA_MISMATCH: u32 = 2;
pub const WRONG_THREAD: u32 = 3;
pub const STALE_GENERATION: u32 = 4;
pub const CAPACITY: u32 = 5;
pub const NOT_FOUND: u32 = 6;
pub const ALREADY_SETTLED: u32 = 7;
pub const EMPTY: u32 = 8;
pub const SHUTDOWN: u32 = 9;
pub const INTERNAL: u32 = 10;

pub const REQUEST: u32 = 1;
pub const MESSAGE: u32 = 2;
pub const SUCCESS: u32 = 0;
pub const ERROR: u32 = 1;
pub const CANCELLED: u32 = 2;

static NEXT_ID: AtomicU64 = AtomicU64::new(1);

fn fresh_id() -> Result<u64, u32> {
    NEXT_ID
        .fetch_update(Ordering::Relaxed, Ordering::Relaxed, |n| n.checked_add(1))
        .map_err(|_| INTERNAL)
}

struct Pending {
    bytes: Arc<[u8]>,
    due: Instant,
    status: u32,
}

enum RequestState {
    Pending(Pending),
    Terminal,
}

struct Event {
    id: u64,
    kind: u32,
    status: u32,
    bytes: Arc<[u8]>,
}

struct State {
    live: bool,
    capacity: usize,
    requests: BTreeMap<u64, RequestState>,
    events: VecDeque<Event>,
    subscriptions: HashSet<u64>,
    queued_messages: usize,
    payload_bytes: usize,
}

struct Shared {
    generation: u64,
    state: Mutex<State>,
    changed: Condvar,
}

impl Shared {
    fn lock(&self) -> MutexGuard<'_, State> {
        self.state.lock().unwrap_or_else(|e| e.into_inner())
    }

    fn checked(&self, generation: u64) -> Result<MutexGuard<'_, State>, u32> {
        if generation != self.generation {
            return Err(STALE_GENERATION);
        }
        let state = self.lock();
        if !state.live {
            return Err(SHUTDOWN);
        }
        Ok(state)
    }

    fn submit(
        &self,
        generation: u64,
        bytes: Arc<[u8]>,
        delay_ms: u32,
        status: u32,
    ) -> Result<u64, u32> {
        if bytes.len() > MAX_PAYLOAD || delay_ms > MAX_DELAY_MS {
            return Err(INVALID_ARGUMENT);
        }
        let mut state = self.checked(generation)?;
        // Every accepted request reserves a terminal-event slot. Subscription
        // traffic cannot consume that reservation and strand a live promise.
        if state.requests.len() + state.queued_messages >= state.capacity
            || state.payload_bytes + bytes.len() > MAX_TOTAL_PAYLOAD
        {
            return Err(CAPACITY);
        }
        let id = fresh_id()?;
        state.payload_bytes += bytes.len();
        state.requests.insert(
            id,
            RequestState::Pending(Pending {
                bytes,
                due: Instant::now() + Duration::from_millis(delay_ms.into()),
                status,
            }),
        );
        self.changed.notify_one();
        Ok(id)
    }

    fn cancel(&self, generation: u64, id: u64) -> Result<(), u32> {
        let mut state = self.checked(generation)?;
        match state.requests.get(&id) {
            None => return Err(NOT_FOUND),
            Some(RequestState::Terminal) => return Err(ALREADY_SETTLED),
            Some(RequestState::Pending(_)) => {}
        }
        if let Some(RequestState::Pending(pending)) =
            state.requests.insert(id, RequestState::Terminal)
        {
            state.payload_bytes -= pending.bytes.len();
        }
        state.events.push_back(Event {
            id,
            kind: REQUEST,
            status: CANCELLED,
            bytes: Arc::from([]),
        });
        self.changed.notify_one();
        Ok(())
    }

    fn complete(state: &mut State, id: u64) -> Result<(), u32> {
        if !state.live {
            return Err(SHUTDOWN);
        }
        match state.requests.get(&id) {
            None => return Err(NOT_FOUND),
            Some(RequestState::Terminal) => return Err(ALREADY_SETTLED),
            Some(RequestState::Pending(_)) => {}
        }
        if let Some(RequestState::Pending(pending)) =
            state.requests.insert(id, RequestState::Terminal)
        {
            state.events.push_back(Event {
                id,
                kind: REQUEST,
                status: pending.status,
                bytes: pending.bytes,
            });
        }
        Ok(())
    }

    fn poll(&self, generation: u64) -> Result<Event, u32> {
        let mut state = self.checked(generation)?;
        let event = state.events.pop_front().ok_or(EMPTY)?;
        state.payload_bytes -= event.bytes.len();
        if event.kind == REQUEST {
            state.requests.remove(&event.id);
        } else {
            state.queued_messages -= 1;
        }
        Ok(event)
    }

    fn subscribe(&self, generation: u64) -> Result<u64, u32> {
        let mut state = self.checked(generation)?;
        if state.subscriptions.len() >= state.capacity {
            return Err(CAPACITY);
        }
        let id = fresh_id()?;
        state.subscriptions.insert(id);
        Ok(id)
    }

    fn publish(&self, generation: u64, id: u64, bytes: Arc<[u8]>) -> Result<(), u32> {
        if bytes.len() > MAX_PAYLOAD {
            return Err(INVALID_ARGUMENT);
        }
        let mut state = self.checked(generation)?;
        if !state.subscriptions.contains(&id) {
            return Err(NOT_FOUND);
        }
        if state.requests.len() + state.queued_messages >= state.capacity
            || state.payload_bytes + bytes.len() > MAX_TOTAL_PAYLOAD
        {
            return Err(CAPACITY);
        }
        state.payload_bytes += bytes.len();
        state.queued_messages += 1;
        state.events.push_back(Event {
            id,
            kind: MESSAGE,
            status: SUCCESS,
            bytes,
        });
        Ok(())
    }

    fn unsubscribe(&self, generation: u64, id: u64) -> Result<(), u32> {
        let mut state = self.checked(generation)?;
        state.subscriptions.remove(&id);
        let mut dropped_bytes = 0;
        let mut dropped_messages = 0;
        state.events.retain(|event| {
            if event.kind == MESSAGE && event.id == id {
                dropped_bytes += event.bytes.len();
                dropped_messages += 1;
                false
            } else {
                true
            }
        });
        state.payload_bytes -= dropped_bytes;
        state.queued_messages -= dropped_messages;
        Ok(())
    }

    fn shutdown(&self) {
        let mut state = self.lock();
        state.live = false;
        state.requests.clear();
        state.events.clear();
        state.subscriptions.clear();
        state.queued_messages = 0;
        state.payload_bytes = 0;
        self.changed.notify_one();
    }

    fn worker(self: Arc<Self>) {
        let mut state = self.lock();
        loop {
            if !state.live {
                return;
            }
            let now = Instant::now();
            let due: Vec<u64> = state
                .requests
                .iter()
                .filter_map(|(&id, request)| match request {
                    RequestState::Pending(pending) if pending.due <= now => Some(id),
                    _ => None,
                })
                .collect();
            for id in due {
                // The worker and cancellation share this terminal-state lock.
                let _ = Self::complete(&mut state, id);
            }
            let next = state
                .requests
                .values()
                .filter_map(|request| match request {
                    RequestState::Pending(pending) => Some(pending.due),
                    RequestState::Terminal => None,
                })
                .min();
            state = if let Some(next) = next {
                self.changed
                    .wait_timeout(state, next.saturating_duration_since(Instant::now()))
                    .unwrap_or_else(|e| e.into_inner())
                    .0
            } else {
                self.changed.wait(state).unwrap_or_else(|e| e.into_inner())
            };
        }
    }
}

/// Opaque C runtime. Only its creation thread may use the public ABI.
pub struct NhRuntime {
    owner: ThreadId,
    shared: Arc<Shared>,
    worker: Option<JoinHandle<()>>,
}

impl NhRuntime {
    fn create(schema: u32, capacity: usize) -> Result<Self, u32> {
        if schema != SCHEMA_VERSION {
            return Err(SCHEMA_MISMATCH);
        }
        if capacity == 0 || capacity > MAX_CAPACITY {
            return Err(INVALID_ARGUMENT);
        }
        let shared = Arc::new(Shared {
            generation: fresh_id()?,
            state: Mutex::new(State {
                live: true,
                capacity,
                requests: BTreeMap::new(),
                events: VecDeque::new(),
                subscriptions: HashSet::new(),
                queued_messages: 0,
                payload_bytes: 0,
            }),
            changed: Condvar::new(),
        });
        let worker_shared = Arc::clone(&shared);
        let worker = thread::Builder::new()
            .name("native-host-service".into())
            .spawn(move || worker_shared.worker())
            .map_err(|_| INTERNAL)?;
        Ok(Self {
            owner: thread::current().id(),
            shared,
            worker: Some(worker),
        })
    }

    fn check_owner(&self) -> Result<(), u32> {
        if self.owner != thread::current().id() {
            return Err(WRONG_THREAD);
        }
        Ok(())
    }
}

impl Drop for NhRuntime {
    fn drop(&mut self) {
        self.shared.shutdown();
        if let Some(worker) = self.worker.take() {
            // Shutdown wakes the condition variable; no configured delay is
            // waited out and the worker never waits for the owner thread.
            let _ = worker.join();
        }
    }
}

#[repr(C)]
pub struct NhEvent {
    pub generation: u64,
    pub id: u64,
    pub kind: u32,
    pub status: u32,
    pub data: *mut u8,
    pub len: usize,
}

impl Default for NhEvent {
    fn default() -> Self {
        Self {
            generation: 0,
            id: 0,
            kind: 0,
            status: 0,
            data: ptr::null_mut(),
            len: 0,
        }
    }
}

#[repr(C)]
#[derive(Default)]
pub struct NhStats {
    pub generation: u64,
    pub pending_requests: usize,
    pub queued_events: usize,
    pub subscriptions: usize,
    pub retained_bytes: usize,
}

fn boundary(f: impl FnOnce() -> Result<(), u32>) -> u32 {
    match catch_unwind(AssertUnwindSafe(f)) {
        Ok(Ok(())) => OK,
        Ok(Err(code)) => code,
        Err(_) => INTERNAL,
    }
}

unsafe fn runtime<'a>(value: *const NhRuntime) -> Result<&'a NhRuntime, u32> {
    let runtime = value.as_ref().ok_or(INVALID_ARGUMENT)?;
    runtime.check_owner()?;
    Ok(runtime)
}

unsafe fn copied_payload(bytes: *const u8, len: usize) -> Result<Arc<[u8]>, u32> {
    if len > MAX_PAYLOAD || (len != 0 && bytes.is_null()) {
        return Err(INVALID_ARGUMENT);
    }
    if len == 0 {
        return Ok(Arc::from([]));
    }
    Ok(Arc::from(std::slice::from_raw_parts(bytes, len)))
}

/// # Safety
/// `out` is writable storage for one pointer and is not concurrently accessed.
#[no_mangle]
pub unsafe extern "C" fn nh_runtime_create(
    schema_version: u32,
    capacity: u32,
    out: *mut *mut NhRuntime,
) -> u32 {
    boundary(|| {
        let out = out.as_mut().ok_or(INVALID_ARGUMENT)?;
        *out = ptr::null_mut();
        *out = Box::into_raw(Box::new(NhRuntime::create(
            schema_version,
            capacity as usize,
        )?));
        Ok(())
    })
}

/// # Safety
/// Runtime must be NULL or a live pointer obtained from `nh_runtime_create`.
#[no_mangle]
pub unsafe extern "C" fn nh_runtime_generation(value: *const NhRuntime) -> u64 {
    catch_unwind(AssertUnwindSafe(|| {
        runtime(value).map_or(0, |r| r.shared.generation)
    }))
    .unwrap_or(0)
}

/// # Safety
/// Runtime is a live exclusively owned pointer; no calls may race destruction.
#[no_mangle]
pub unsafe extern "C" fn nh_runtime_destroy(value: *mut NhRuntime) -> u32 {
    boundary(|| {
        runtime(value)?;
        drop(Box::from_raw(value));
        Ok(())
    })
}

/// # Safety
/// Runtime is live and out is writable, disjoint storage for a stats snapshot.
#[no_mangle]
pub unsafe extern "C" fn nh_runtime_stats(
    value: *mut NhRuntime,
    generation: u64,
    out: *mut NhStats,
) -> u32 {
    boundary(|| {
        let out = out.as_mut().ok_or(INVALID_ARGUMENT)?;
        *out = NhStats::default();
        let runtime = runtime(value)?;
        let state = runtime.shared.checked(generation)?;
        *out = NhStats {
            generation,
            pending_requests: state
                .requests
                .values()
                .filter(|r| matches!(r, RequestState::Pending(_)))
                .count(),
            queued_events: state.events.len(),
            subscriptions: state.subscriptions.len(),
            retained_bytes: state.payload_bytes,
        };
        Ok(())
    })
}

unsafe fn submit_ffi(
    value: *mut NhRuntime,
    generation: u64,
    bytes: *const u8,
    len: usize,
    delay_ms: u32,
    out_id: *mut u64,
    status: u32,
) -> u32 {
    boundary(|| {
        let out_id = out_id.as_mut().ok_or(INVALID_ARGUMENT)?;
        *out_id = 0;
        let runtime = runtime(value)?;
        let bytes = copied_payload(bytes, len)?;
        *out_id = runtime.shared.submit(generation, bytes, delay_ms, status)?;
        Ok(())
    })
}

/// # Safety
/// Runtime is live; bytes is readable for len; out_id is writable and disjoint.
#[no_mangle]
pub unsafe extern "C" fn nh_submit(
    value: *mut NhRuntime,
    generation: u64,
    bytes: *const u8,
    len: usize,
    delay_ms: u32,
    out_id: *mut u64,
) -> u32 {
    submit_ffi(value, generation, bytes, len, delay_ms, out_id, SUCCESS)
}

/// # Safety
/// Same pointer requirements as `nh_submit`.
#[cfg(feature = "test-hooks")]
#[no_mangle]
pub unsafe extern "C" fn nh_test_submit_error(
    value: *mut NhRuntime,
    generation: u64,
    bytes: *const u8,
    len: usize,
    delay_ms: u32,
    out_id: *mut u64,
) -> u32 {
    submit_ffi(value, generation, bytes, len, delay_ms, out_id, ERROR)
}

/// # Safety
/// Runtime must be live and called from its owner thread.
#[no_mangle]
pub unsafe extern "C" fn nh_cancel(value: *mut NhRuntime, generation: u64, id: u64) -> u32 {
    boundary(|| runtime(value)?.shared.cancel(generation, id))
}

/// # Safety
/// Runtime is live; out is writable, disjoint storage not owning an event.
#[no_mangle]
pub unsafe extern "C" fn nh_poll(value: *mut NhRuntime, generation: u64, out: *mut NhEvent) -> u32 {
    boundary(|| {
        let out = out.as_mut().ok_or(INVALID_ARGUMENT)?;
        *out = NhEvent::default();
        let runtime = runtime(value)?;
        let event = runtime.shared.poll(generation)?;
        let bytes = event.bytes.to_vec().into_boxed_slice();
        out.generation = generation;
        out.id = event.id;
        out.kind = event.kind;
        out.status = event.status;
        out.len = bytes.len();
        if !bytes.is_empty() {
            out.data = Box::into_raw(bytes).cast::<u8>();
        }
        Ok(())
    })
}

/// # Safety
/// Event is NULL, zeroed, or owns the unmodified buffer returned by nh_poll.
/// Ownership cannot have been copied; no concurrent readers/writers are allowed.
#[no_mangle]
pub unsafe extern "C" fn nh_event_free(event: *mut NhEvent) {
    let _ = catch_unwind(AssertUnwindSafe(|| {
        if let Some(event) = event.as_mut() {
            if !event.data.is_null() {
                drop(Box::from_raw(ptr::slice_from_raw_parts_mut(
                    event.data, event.len,
                )));
            }
            *event = NhEvent::default();
        }
    }));
}

/// # Safety
/// Runtime is live and out_id is writable, disjoint storage.
#[no_mangle]
pub unsafe extern "C" fn nh_subscribe(
    value: *mut NhRuntime,
    generation: u64,
    out_id: *mut u64,
) -> u32 {
    boundary(|| {
        let out_id = out_id.as_mut().ok_or(INVALID_ARGUMENT)?;
        *out_id = 0;
        *out_id = runtime(value)?.shared.subscribe(generation)?;
        Ok(())
    })
}

/// # Safety
/// Runtime is live and bytes is readable for len bytes, or NULL when len is zero.
#[no_mangle]
pub unsafe extern "C" fn nh_publish(
    value: *mut NhRuntime,
    generation: u64,
    id: u64,
    bytes: *const u8,
    len: usize,
) -> u32 {
    boundary(|| {
        let runtime = runtime(value)?;
        runtime
            .shared
            .publish(generation, id, copied_payload(bytes, len)?)
    })
}

/// # Safety
/// Runtime must be live and called from its owner thread.
#[no_mangle]
pub unsafe extern "C" fn nh_unsubscribe(value: *mut NhRuntime, generation: u64, id: u64) -> u32 {
    boundary(|| runtime(value)?.shared.unsubscribe(generation, id))
}

#[cfg(test)]
mod tests;
