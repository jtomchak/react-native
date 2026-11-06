use super::*;
use std::sync::{Barrier, Weak};

fn new_runtime(capacity: usize) -> NhRuntime {
    NhRuntime::create(SCHEMA_VERSION, capacity).unwrap()
}

fn submit(runtime: &NhRuntime, bytes: &[u8], delay_ms: u32) -> u64 {
    runtime
        .shared
        .submit(
            runtime.shared.generation,
            Arc::from(bytes),
            delay_ms,
            SUCCESS,
        )
        .unwrap()
}

fn wait_event(runtime: &NhRuntime) -> Event {
    let deadline = Instant::now() + Duration::from_secs(3);
    loop {
        match runtime.shared.poll(runtime.shared.generation) {
            Ok(event) => return event,
            Err(EMPTY) if Instant::now() < deadline => thread::yield_now(),
            _ => panic!("worker did not deliver an event before deadline"),
        }
    }
}

fn pending_bytes(runtime: &NhRuntime, id: u64) -> Weak<[u8]> {
    let state = runtime.shared.lock();
    match &state.requests[&id] {
        RequestState::Pending(pending) => Arc::downgrade(&pending.bytes),
        RequestState::Terminal => panic!("expected pending request"),
    }
}

#[test]
fn real_worker_completes_binary_echo_without_owner_execution() {
    let runtime = new_runtime(4);
    let id = submit(&runtime, &[0, 255, 42, 0], 0);
    let event = wait_event(&runtime);
    assert_eq!(event.id, id);
    assert_eq!(event.kind, REQUEST);
    assert_eq!(event.status, SUCCESS);
    assert_eq!(&*event.bytes, &[0, 255, 42, 0]);
    assert_eq!(runtime.shared.lock().payload_bytes, 0);
}

#[test]
fn cancellation_before_deadline_releases_payload_and_settles_once() {
    let runtime = new_runtime(1);
    let id = submit(&runtime, b"owned resource", MAX_DELAY_MS);
    let weak = pending_bytes(&runtime, id);
    assert!(weak.upgrade().is_some());
    assert_eq!(runtime.shared.cancel(runtime.shared.generation, id), Ok(()));
    assert!(weak.upgrade().is_none());
    assert_eq!(
        runtime.shared.cancel(runtime.shared.generation, id),
        Err(ALREADY_SETTLED)
    );
    assert_eq!(
        Shared::complete(&mut runtime.shared.lock(), id),
        Err(ALREADY_SETTLED)
    );
    let event = wait_event(&runtime);
    assert_eq!(event.status, CANCELLED);
    assert!(event.bytes.is_empty());
    assert_eq!(
        runtime.shared.cancel(runtime.shared.generation, id),
        Err(NOT_FOUND)
    );
    assert_eq!(
        runtime.shared.poll(runtime.shared.generation).err(),
        Some(EMPTY)
    );
}

#[test]
fn completion_winner_is_not_replaced_by_later_cancellation() {
    let runtime = new_runtime(1);
    let id = submit(&runtime, b"success", MAX_DELAY_MS);
    assert_eq!(Shared::complete(&mut runtime.shared.lock(), id), Ok(()));
    assert_eq!(
        runtime.shared.cancel(runtime.shared.generation, id),
        Err(ALREADY_SETTLED)
    );
    let event = wait_event(&runtime);
    assert_eq!(event.status, SUCCESS);
    assert_eq!(&*event.bytes, b"success");
}

#[test]
fn concurrent_cancel_and_completion_have_exactly_one_winner() {
    let runtime = new_runtime(1);
    for _ in 0..100 {
        let id = submit(&runtime, b"race", MAX_DELAY_MS);
        let gate = Arc::new(Barrier::new(3));
        let cancel_shared = Arc::clone(&runtime.shared);
        let cancel_gate = Arc::clone(&gate);
        let cancel = thread::spawn(move || {
            cancel_gate.wait();
            cancel_shared.cancel(cancel_shared.generation, id)
        });
        let complete_shared = Arc::clone(&runtime.shared);
        let complete_gate = Arc::clone(&gate);
        let complete = thread::spawn(move || {
            complete_gate.wait();
            Shared::complete(&mut complete_shared.lock(), id)
        });
        gate.wait();
        let cancel_result = cancel.join().unwrap();
        let completion_result = complete.join().unwrap();
        assert_eq!(
            usize::from(cancel_result.is_ok()) + usize::from(completion_result.is_ok()),
            1
        );
        let event = wait_event(&runtime);
        assert_eq!(
            event.status,
            if cancel_result.is_ok() {
                CANCELLED
            } else {
                SUCCESS
            }
        );
        assert_eq!(
            runtime.shared.poll(runtime.shared.generation).err(),
            Some(EMPTY)
        );
    }
}

#[test]
fn real_worker_races_with_cancellation_without_duplicate_events() {
    let runtime = new_runtime(1);
    for _ in 0..100 {
        let id = submit(&runtime, b"worker race", 0);
        let cancelled = runtime.shared.cancel(runtime.shared.generation, id);
        assert!(cancelled.is_ok() || cancelled == Err(ALREADY_SETTLED));
        let event = wait_event(&runtime);
        assert_eq!(
            event.status,
            if cancelled.is_ok() {
                CANCELLED
            } else {
                SUCCESS
            }
        );
        assert_eq!(
            runtime.shared.poll(runtime.shared.generation).err(),
            Some(EMPTY)
        );
    }
}

#[test]
fn pending_shutdown_releases_captures_and_wakes_worker() {
    let runtime = new_runtime(1);
    let id = submit(&runtime, b"release me", MAX_DELAY_MS);
    let weak = pending_bytes(&runtime, id);
    let shared = Arc::clone(&runtime.shared);
    let started = Instant::now();
    drop(runtime);
    assert!(
        started.elapsed() < Duration::from_secs(3),
        "shutdown waited for service delay"
    );
    assert!(weak.upgrade().is_none());
    assert_eq!(Shared::complete(&mut shared.lock(), id), Err(SHUTDOWN));
    assert_eq!(shared.poll(shared.generation).err(), Some(SHUTDOWN));
    assert_eq!(shared.lock().payload_bytes, 0);
}

#[test]
fn shutdown_drops_queued_success_and_subscription_payloads() {
    let runtime = new_runtime(3);
    let id = submit(&runtime, b"result", MAX_DELAY_MS);
    let weak_result = pending_bytes(&runtime, id);
    Shared::complete(&mut runtime.shared.lock(), id).unwrap();
    let subscription = runtime.shared.subscribe(runtime.shared.generation).unwrap();
    let bytes: Arc<[u8]> = Arc::from(&b"message"[..]);
    let weak_message = Arc::downgrade(&bytes);
    runtime
        .shared
        .publish(runtime.shared.generation, subscription, bytes)
        .unwrap();
    drop(runtime);
    assert!(weak_result.upgrade().is_none());
    assert!(weak_message.upgrade().is_none());
}

#[test]
fn new_runtime_rejects_old_generation_and_old_ids() {
    let first = new_runtime(1);
    let old_generation = first.shared.generation;
    let old_id = submit(&first, b"old", MAX_DELAY_MS);
    drop(first);
    let second = new_runtime(1);
    assert!(second.shared.generation > old_generation);
    assert_eq!(
        second.shared.cancel(old_generation, old_id),
        Err(STALE_GENERATION)
    );
    assert_eq!(
        second.shared.cancel(second.shared.generation, old_id),
        Err(NOT_FOUND)
    );
    assert_eq!(
        second
            .shared
            .submit(old_generation, Arc::from([]), 0, SUCCESS),
        Err(STALE_GENERATION)
    );
    assert_eq!(
        second.shared.poll(old_generation).err(),
        Some(STALE_GENERATION)
    );
}

#[test]
fn capacity_reserves_terminal_delivery_even_under_subscription_pressure() {
    let runtime = new_runtime(2);
    let subscription = runtime.shared.subscribe(runtime.shared.generation).unwrap();
    let id = submit(&runtime, b"pending", MAX_DELAY_MS);
    runtime
        .shared
        .publish(
            runtime.shared.generation,
            subscription,
            Arc::from(&b"event"[..]),
        )
        .unwrap();
    assert_eq!(
        runtime
            .shared
            .publish(runtime.shared.generation, subscription, Arc::from([])),
        Err(CAPACITY)
    );
    assert_eq!(
        runtime
            .shared
            .submit(runtime.shared.generation, Arc::from([]), 0, SUCCESS),
        Err(CAPACITY)
    );
    runtime
        .shared
        .cancel(runtime.shared.generation, id)
        .unwrap();
    let first = wait_event(&runtime);
    let second = wait_event(&runtime);
    assert_eq!(first.kind, MESSAGE);
    assert_eq!(second.status, CANCELLED);
    assert_eq!(runtime.shared.lock().payload_bytes, 0);
}

#[test]
fn terminal_result_retains_capacity_until_consumed() {
    let runtime = new_runtime(1);
    let id = submit(&runtime, b"result", MAX_DELAY_MS);
    Shared::complete(&mut runtime.shared.lock(), id).unwrap();
    assert_eq!(
        runtime
            .shared
            .submit(runtime.shared.generation, Arc::from([]), 0, SUCCESS),
        Err(CAPACITY)
    );
    wait_event(&runtime);
    submit(&runtime, b"next", 0);
    assert_eq!(&*wait_event(&runtime).bytes, b"next");
}

#[test]
fn byte_budget_is_bounded_independently_of_request_count() {
    let runtime = new_runtime(32);
    for _ in 0..16 {
        submit(&runtime, &vec![0; MAX_PAYLOAD], MAX_DELAY_MS);
    }
    assert_eq!(runtime.shared.lock().payload_bytes, MAX_TOTAL_PAYLOAD);
    assert_eq!(
        runtime
            .shared
            .submit(runtime.shared.generation, Arc::from(&b"x"[..]), 0, SUCCESS),
        Err(CAPACITY)
    );
}

#[test]
fn unsubscribe_drops_only_its_queued_events_and_is_idempotent() {
    let runtime = new_runtime(4);
    let a = runtime.shared.subscribe(runtime.shared.generation).unwrap();
    let b = runtime.shared.subscribe(runtime.shared.generation).unwrap();
    let bytes: Arc<[u8]> = Arc::from(&b"drop"[..]);
    let weak = Arc::downgrade(&bytes);
    runtime
        .shared
        .publish(runtime.shared.generation, a, bytes)
        .unwrap();
    runtime
        .shared
        .publish(runtime.shared.generation, b, Arc::from(&b"keep"[..]))
        .unwrap();
    runtime
        .shared
        .unsubscribe(runtime.shared.generation, a)
        .unwrap();
    runtime
        .shared
        .unsubscribe(runtime.shared.generation, a)
        .unwrap();
    assert!(weak.upgrade().is_none());
    assert_eq!(
        runtime
            .shared
            .publish(runtime.shared.generation, a, Arc::from([])),
        Err(NOT_FOUND)
    );
    let event = wait_event(&runtime);
    assert_eq!(event.id, b);
    assert_eq!(&*event.bytes, b"keep");
    assert_eq!(
        runtime.shared.poll(runtime.shared.generation).err(),
        Some(EMPTY)
    );
}

#[test]
fn caller_can_reenter_after_poll_without_a_registry_lock() {
    let runtime = new_runtime(1);
    submit(&runtime, b"first", 0);
    let first = wait_event(&runtime);
    let callback = || {
        let subscription = runtime.shared.subscribe(runtime.shared.generation).unwrap();
        runtime
            .shared
            .publish(
                runtime.shared.generation,
                subscription,
                Arc::clone(&first.bytes),
            )
            .unwrap();
        wait_event(&runtime)
    };
    let event = callback();
    assert_eq!(&*event.bytes, b"first");
}

#[test]
fn invalid_configuration_rejected_without_worker() {
    assert_eq!(NhRuntime::create(0, 1).err(), Some(SCHEMA_MISMATCH));
    assert_eq!(
        NhRuntime::create(SCHEMA_VERSION, 0).err(),
        Some(INVALID_ARGUMENT)
    );
    assert_eq!(
        NhRuntime::create(SCHEMA_VERSION, MAX_CAPACITY + 1).err(),
        Some(INVALID_ARGUMENT)
    );
    let runtime = new_runtime(1);
    assert_eq!(
        runtime.shared.submit(
            runtime.shared.generation,
            Arc::from([]),
            MAX_DELAY_MS + 1,
            SUCCESS
        ),
        Err(INVALID_ARGUMENT)
    );
    assert_eq!(
        runtime.shared.submit(
            runtime.shared.generation,
            Arc::from(vec![0; MAX_PAYLOAD + 1]),
            0,
            SUCCESS
        ),
        Err(INVALID_ARGUMENT)
    );
}

#[test]
fn ffi_copies_input_and_event_survives_runtime_destruction() {
    unsafe {
        let mut runtime = ptr::null_mut();
        assert_eq!(nh_runtime_create(SCHEMA_VERSION, 1, &mut runtime), OK);
        let generation = nh_runtime_generation(runtime);
        let mut source = [0, 255, 7];
        let mut id = 0;
        assert_eq!(
            nh_submit(
                runtime,
                generation,
                source.as_ptr(),
                source.len(),
                0,
                &mut id
            ),
            OK
        );
        source.fill(44);
        let mut event = NhEvent::default();
        let deadline = Instant::now() + Duration::from_secs(3);
        loop {
            let code = nh_poll(runtime, generation, &mut event);
            if code == OK {
                break;
            }
            assert_eq!(code, EMPTY);
            assert!(Instant::now() < deadline);
            thread::yield_now();
        }
        assert_eq!(event.id, id);
        assert_eq!(event.generation, generation);
        assert_eq!(nh_runtime_destroy(runtime), OK);
        assert_eq!(
            std::slice::from_raw_parts(event.data, event.len),
            &[0, 255, 7]
        );
        nh_event_free(&mut event);
        assert!(event.data.is_null());
        assert_eq!(event.id, 0);
        nh_event_free(&mut event);
    }
}

#[test]
fn ffi_wrong_thread_does_not_mutate_or_destroy_runtime() {
    unsafe {
        let mut runtime = ptr::null_mut();
        assert_eq!(nh_runtime_create(SCHEMA_VERSION, 1, &mut runtime), OK);
        let generation = nh_runtime_generation(runtime);
        let address = runtime as usize;
        thread::spawn(move || {
            let runtime = address as *mut NhRuntime;
            let mut id = 99;
            assert_eq!(
                nh_submit(runtime, generation, ptr::null(), 0, 0, &mut id),
                WRONG_THREAD
            );
            assert_eq!(id, 0);
            assert_eq!(nh_runtime_generation(runtime), 0);
            assert_eq!(nh_runtime_destroy(runtime), WRONG_THREAD);
        })
        .join()
        .unwrap();
        assert_eq!(nh_runtime_generation(runtime), generation);
        assert_eq!(nh_runtime_destroy(runtime), OK);
    }
}

#[test]
fn ffi_errors_zero_outputs_and_reject_invalid_ranges() {
    unsafe {
        let mut runtime = ptr::null_mut();
        assert_eq!(nh_runtime_create(0, 1, &mut runtime), SCHEMA_MISMATCH);
        assert!(runtime.is_null());
        assert_eq!(nh_runtime_create(SCHEMA_VERSION, 1, &mut runtime), OK);
        let generation = nh_runtime_generation(runtime);
        let mut id = 99;
        assert_eq!(
            nh_submit(runtime, generation, ptr::null(), 1, 0, &mut id),
            INVALID_ARGUMENT
        );
        assert_eq!(id, 0);
        assert_eq!(
            nh_submit(
                runtime,
                generation,
                ptr::null(),
                MAX_PAYLOAD + 1,
                0,
                &mut id
            ),
            INVALID_ARGUMENT
        );
        assert_eq!(
            nh_submit(runtime, generation + 1, ptr::null(), 0, 0, &mut id),
            STALE_GENERATION
        );
        let mut event = NhEvent {
            id: 42,
            ..NhEvent::default()
        };
        assert_eq!(nh_poll(runtime, generation, &mut event), EMPTY);
        assert_eq!(event.id, 0);
        assert_eq!(
            nh_poll(runtime, generation, ptr::null_mut()),
            INVALID_ARGUMENT
        );
        assert_eq!(nh_runtime_destroy(runtime), OK);
        assert_eq!(nh_runtime_destroy(ptr::null_mut()), INVALID_ARGUMENT);
        nh_event_free(ptr::null_mut());
    }
}

#[test]
fn boundary_contains_rust_panics() {
    assert_eq!(boundary(|| panic!("contained test panic")), INTERNAL);
}

#[test]
fn ffi_stats_tracks_pending_then_terminal_then_drained_resources() {
    unsafe {
        let mut runtime = ptr::null_mut();
        assert_eq!(nh_runtime_create(SCHEMA_VERSION, 2, &mut runtime), OK);
        let generation = nh_runtime_generation(runtime);
        let mut id = 0;
        assert_eq!(
            nh_submit(
                runtime,
                generation,
                b"owned".as_ptr(),
                5,
                MAX_DELAY_MS,
                &mut id
            ),
            OK
        );
        let mut subscription = 0;
        assert_eq!(nh_subscribe(runtime, generation, &mut subscription), OK);
        let mut stats = NhStats::default();
        assert_eq!(nh_runtime_stats(runtime, generation, &mut stats), OK);
        assert_eq!(
            (
                stats.pending_requests,
                stats.queued_events,
                stats.subscriptions,
                stats.retained_bytes
            ),
            (1, 0, 1, 5)
        );
        assert_eq!(nh_cancel(runtime, generation, id), OK);
        assert_eq!(nh_runtime_stats(runtime, generation, &mut stats), OK);
        assert_eq!(
            (
                stats.pending_requests,
                stats.queued_events,
                stats.retained_bytes
            ),
            (0, 1, 0)
        );
        let mut event = NhEvent::default();
        assert_eq!(nh_poll(runtime, generation, &mut event), OK);
        nh_event_free(&mut event);
        assert_eq!(nh_unsubscribe(runtime, generation, subscription), OK);
        assert_eq!(nh_runtime_stats(runtime, generation, &mut stats), OK);
        assert_eq!(
            (
                stats.pending_requests,
                stats.queued_events,
                stats.subscriptions,
                stats.retained_bytes
            ),
            (0, 0, 0, 0)
        );
        assert_eq!(
            nh_runtime_stats(runtime, generation + 1, &mut stats),
            STALE_GENERATION
        );
        assert_eq!(stats.generation, 0);
        assert_eq!(nh_runtime_destroy(runtime), OK);
    }
}

#[test]
fn error_completion_releases_owned_buffer_after_consumption() {
    let runtime = new_runtime(1);
    let bytes: Arc<[u8]> = Arc::from(&b"echo: injected error"[..]);
    let weak = Arc::downgrade(&bytes);
    runtime
        .shared
        .submit(runtime.shared.generation, bytes, 0, ERROR)
        .unwrap();
    let event = wait_event(&runtime);
    assert_eq!(event.status, ERROR);
    assert!(weak.upgrade().is_some());
    drop(event);
    assert!(weak.upgrade().is_none());
}

#[cfg(feature = "test-hooks")]
#[test]
fn test_only_error_ffi_delivers_typed_error() {
    unsafe {
        let mut runtime = ptr::null_mut();
        assert_eq!(nh_runtime_create(SCHEMA_VERSION, 1, &mut runtime), OK);
        let generation = nh_runtime_generation(runtime);
        let mut id = 0;
        assert_eq!(
            nh_test_submit_error(runtime, generation, b"error".as_ptr(), 5, 0, &mut id),
            OK
        );
        let event = wait_event(&*runtime);
        assert_eq!(event.status, ERROR);
        assert_eq!(event.id, id);
        assert_eq!(nh_runtime_destroy(runtime), OK);
    }
}
