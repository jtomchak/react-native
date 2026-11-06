import Foundation
import SQLite3

struct AnalyticsConfiguration {
    var enabled = true
    var origin: URL?
    var destinations = ["recording"]
    var maxEvents = 10_000
    var maxBytes = 8_388_608
    var retentionSeconds = 604_800
    static func parse(_ object: [String: Any]) throws -> AnalyticsConfiguration {
        guard Set(object.keys) == ["enabled", "origin", "destinations", "maxEvents", "maxBytes", "retentionSeconds"],
              let enabled = AnalyticsSchema.boolean(object["enabled"]),
              let destinations = object["destinations"] as? [String], (1...8).contains(destinations.count), Set(destinations).count == destinations.count,
              destinations.allSatisfy(AnalyticsSchema.token),
              let events = AnalyticsSchema.integer(object["maxEvents"], 1...10_000),
              let bytes = AnalyticsSchema.integer(object["maxBytes"], 4096...8_388_608),
              let retention = AnalyticsSchema.integer(object["retentionSeconds"], 1...604_800) else { throw AnalyticsSchema.invalid() }
        var result = AnalyticsConfiguration(); result.enabled = enabled; result.destinations = destinations
        result.maxEvents = events; result.maxBytes = bytes; result.retentionSeconds = retention
        if let raw = object["origin"] as? String { guard let origin = HostConfiguration.validOrigin(raw) else { throw AnalyticsSchema.invalid() }; result.origin = origin }
        else if !(object["origin"] is NSNull) { throw AnalyticsSchema.invalid() }
        return result
    }
}

enum AnalyticsSchema {
    static let categories = Set(["lifecycle", "navigation", "bridge", "interaction", "custom"])
    static func invalid() -> HostFailure { HostFailure("INVALID_REQUEST", "Invalid analytics schema") }
    static func token(_ value: String) -> Bool { value.range(of: "^[A-Za-z0-9_.:-]{1,64}$", options: .regularExpression) != nil }
    static func name(_ value: String) -> Bool { value.range(of: "^[a-z][a-z0-9_.]{0,63}$", options: .regularExpression) != nil }
    static func boolean(_ value: Any?) -> Bool? { guard let number = value as? NSNumber, CFGetTypeID(number) == CFBooleanGetTypeID() else { return nil }; return number.boolValue }
    static func integer(_ value: Any?, _ range: ClosedRange<Int>) -> Int? {
        guard let number = value as? NSNumber, CFGetTypeID(number) != CFBooleanGetTypeID(), number.doubleValue.isFinite,
              number.doubleValue.rounded() == number.doubleValue, number.doubleValue >= Double(range.lowerBound), number.doubleValue <= Double(range.upperBound) else { return nil }
        return number.intValue
    }
    static func properties(_ properties: [String: Any], maximum: Int = 12) throws -> [String: Any] {
        guard properties.count <= maximum else { throw invalid() }
        let enums: [String: Set<String>] = ["screen": ["overview", "compose", "library", "hosted", "unknown"], "kind": ["button", "link", "input", "select", "form", "other"], "outcome": ["ok", "error", "cancelled", "unavailable"], "state": ["started", "foreground", "background", "selected", "committed", "failed", "disposed"], "presentation": ["push", "replace", "modal", "pop", "web"]]
        for (key, value) in properties {
            if ["action", "control", "tab", "code"].contains(key) { guard let text = value as? String, token(text) else { throw invalid() } }
            else if let choices = enums[key] { guard let text = value as? String, choices.contains(text) else { throw invalid() } }
            else if key == "durationMs" { guard integer(value, 0...600_000) != nil else { throw invalid() } }
            else if key == "count" { guard integer(value, 0...1_000_000_000) != nil else { throw invalid() } }
            else { throw invalid() }
        }
        return properties
    }
    static func screen(_ path: String) -> String {
        let route = String(path.split(separator: "?", maxSplits: 1, omittingEmptySubsequences: false).first ?? "")
        switch route { case "/": return "overview"; case "/compose/": return "compose"; case "/library/": return "library"; default: return route.hasPrefix("/hosted/") ? "hosted" : "unknown" }
    }
    static func sample(_ id: String) -> Int { var hash: UInt32 = 2_166_136_261; for byte in id.utf8 { hash = (hash ^ UInt32(byte)) &* 16_777_619 }; return Int(hash % 10_000) }
    static func encode(_ object: Any) throws -> Data { try JSONSerialization.data(withJSONObject: object, options: [.sortedKeys]) }
}

struct AnalyticsPolicy {
    let object: [String: Any]
    let revision: Int
    let expires: Int
    let enabled: Bool
    let categories: Set<String>
    let names: Set<String>
    let properties: [String: Any]
    let sample: Int
    let lookback: Int
    let destinations: [String]
    static func parse(_ object: [String: Any], allowed: [String], now: Int, allowExpired: Bool = false) throws -> AnalyticsPolicy {
        guard Set(object.keys) == ["schemaVersion", "revision", "expiresAtMs", "enabled", "categories", "names", "properties", "sampleBasisPoints", "lookbackSeconds", "destinations"],
              AnalyticsSchema.integer(object["schemaVersion"], 1...1) == 1,
              let revision = AnalyticsSchema.integer(object["revision"], 1...2_147_483_647),
              let expires = AnalyticsSchema.integer(object["expiresAtMs"], 1...Int.max), expires <= now + 86_400_000, allowExpired || expires > now,
              let enabled = AnalyticsSchema.boolean(object["enabled"]),
              let categories = object["categories"] as? [String], categories.count <= 5, Set(categories).count == categories.count, Set(categories).isSubset(of: AnalyticsSchema.categories),
              let names = object["names"] as? [String], names.count <= 32, Set(names).count == names.count, names.allSatisfy({ $0 == "*" || AnalyticsSchema.name($0) }),
              let properties = object["properties"] as? [String: Any],
              let sample = AnalyticsSchema.integer(object["sampleBasisPoints"], 0...10_000),
              let lookback = AnalyticsSchema.integer(object["lookbackSeconds"], 0...604_800),
              let destinations = object["destinations"] as? [String], destinations.count <= 8, Set(destinations).count == destinations.count, Set(destinations).isSubset(of: Set(allowed)) else { throw AnalyticsSchema.invalid() }
        return AnalyticsPolicy(object: object, revision: revision, expires: expires, enabled: enabled, categories: Set(categories), names: Set(names), properties: try AnalyticsSchema.properties(properties, maximum: 8), sample: sample, lookback: lookback, destinations: destinations)
    }
    func sameSelectors(_ other: AnalyticsPolicy) -> Bool {
        var lhs = object, rhs = other.object; lhs.removeValue(forKey: "expiresAtMs"); rhs.removeValue(forKey: "expiresAtMs")
        return NSDictionary(dictionary: lhs).isEqual(to: rhs)
    }
    func matches(_ event: [String: Any], now: Int) -> Bool {
        guard enabled, expires > now, let time = event["timeMs"] as? Int, time >= now - lookback * 1000, time <= now,
              let category = event["category"] as? String, categories.contains(category), let name = event["name"] as? String, names.contains("*") || names.contains(name),
              let id = event["id"] as? String, AnalyticsSchema.sample(id) < sample, let props = event["properties"] as? [String: Any] else { return false }
        return properties.allSatisfy { key, value in guard let actual = props[key] else { return false }; return NSDictionary(dictionary: [key: actual]).isEqual(to: [key: value]) }
    }
}

// This delegate bounds response bytes while receiving them, rather than after an
// unbounded URLSession data task has already buffered an untrusted response.
private final class AnalyticsHTTP: NSObject, URLSessionDataDelegate, URLSessionTaskDelegate {
    private var body = Data()
    private var failure: HostFailure?
    private var callback: ((Result<Data, HostFailure>) -> Void)?
    private var session: URLSession!
    static func send(_ request: URLRequest, completion: @escaping (Result<Data, HostFailure>) -> Void) {
        let delegate = AnalyticsHTTP(); delegate.callback = completion
        let config = URLSessionConfiguration.ephemeral; config.timeoutIntervalForRequest = 5; config.timeoutIntervalForResource = 6
        config.httpCookieStorage = nil; config.urlCredentialStorage = nil; config.urlCache = nil
        delegate.session = URLSession(configuration: config, delegate: delegate, delegateQueue: nil)
        delegate.session.dataTask(with: request).resume()
    }
    func urlSession(_ session: URLSession, task: URLSessionTask, willPerformHTTPRedirection response: HTTPURLResponse, newRequest request: URLRequest, completionHandler: @escaping (URLRequest?) -> Void) { completionHandler(nil) }
    func urlSession(_ session: URLSession, dataTask: URLSessionDataTask, didReceive response: URLResponse, completionHandler: @escaping (URLSession.ResponseDisposition) -> Void) {
        guard let response = response as? HTTPURLResponse, (200..<300).contains(response.statusCode), response.expectedContentLength <= 65_536 else { failure = HostFailure("IO_ERROR", "Analytics endpoint refused the request"); completionHandler(.cancel); return }
        completionHandler(.allow)
    }
    func urlSession(_ session: URLSession, dataTask: URLSessionDataTask, didReceive data: Data) {
        guard body.count + data.count <= 65_536 else { failure = HostFailure("QUOTA_EXCEEDED", "Analytics response too large"); dataTask.cancel(); return }; body.append(data)
    }
    func urlSession(_ session: URLSession, task: URLSessionTask, didCompleteWithError error: Error?) {
        let callback = callback; self.callback = nil
        callback?(failure.map { .failure($0) } ?? (error == nil ? .success(body) : .failure(HostFailure("IO_ERROR", "Analytics network unavailable"))))
        session.finishTasksAndInvalidate()
    }
}

final class NativeAnalytics {
    private static let processSession = UUID().uuidString.lowercased()
    private let queue = DispatchQueue(label: "dev.spahost.analytics", qos: .utility)
    private let admission = NSLock()
    private var pending = 0
    private var admissionDrops = 0
    private var db: OpaquePointer?
    private let root: URL
    let configuration: AnalyticsConfiguration
    private var installID = ""
    private var policy: AnalyticsPolicy?
    private var revisionFloor = 0
    private var networkBusy = false
    private var foregroundActive = false
    private var active: Bool { admission.lock(); defer { admission.unlock() }; return foregroundActive }
    private var scheduled = false
    private var nextAttempt: Int = 0
    private var failures = 0
    private var networkDeadline = 0
    private var lastScreen: String?
    init(root: URL, configuration: AnalyticsConfiguration) { self.root = root; self.configuration = configuration }
    deinit { if let db { sqlite3_close(db) } }
    static func now() -> Int { Int(Date().timeIntervalSince1970 * 1000) }
    private func admit() -> Bool {
        admission.lock(); defer { admission.unlock() }
        guard pending < 128 else { admissionDrops += 1; return false }; pending += 1; return true
    }
    private func releaseAdmission() { admission.lock(); pending -= 1; admission.unlock() }
    private func busy() -> HostFailure { HostFailure("BUSY", "Analytics admission is full") }
    private func execute(_ sql: String) throws { guard sqlite3_exec(db, sql, nil, nil, nil) == SQLITE_OK else { throw HostFailure("IO_ERROR", "Analytics journal unavailable") } }
    private func statement(_ sql: String, _ values: [Any] = []) throws -> OpaquePointer {
        var raw: OpaquePointer?; guard sqlite3_prepare_v2(db, sql, -1, &raw, nil) == SQLITE_OK, let raw else { throw HostFailure("IO_ERROR", "Analytics query unavailable") }
        let transient = unsafeBitCast(-1, to: sqlite3_destructor_type.self)
        for (index, value) in values.enumerated() {
            if let value = value as? Int { sqlite3_bind_int64(raw, Int32(index + 1), sqlite3_int64(value)) }
            else if let value = value as? String { _ = value.withCString { sqlite3_bind_text(raw, Int32(index + 1), $0, -1, transient) } }
            else { sqlite3_finalize(raw); throw AnalyticsSchema.invalid() }
        }
        return raw
    }
    private func rows(_ sql: String, _ values: [Any] = []) throws -> [[String: Any]] {
        let stmt = try statement(sql, values); defer { sqlite3_finalize(stmt) }; var result: [[String: Any]] = []
        while true {
            let code = sqlite3_step(stmt); if code == SQLITE_DONE { break }; guard code == SQLITE_ROW else { throw HostFailure("IO_ERROR", "Analytics query failed") }
            var row: [String: Any] = [:]
            for index in 0..<sqlite3_column_count(stmt) {
                let name = String(cString: sqlite3_column_name(stmt, index))
                if sqlite3_column_type(stmt, index) == SQLITE_INTEGER { row[name] = Int(sqlite3_column_int64(stmt, index)) }
                else if let text = sqlite3_column_text(stmt, index) { row[name] = String(cString: text) }
            }
            result.append(row)
        }
        return result
    }
    private func write(_ sql: String, _ values: [Any] = []) throws {
        let stmt = try statement(sql, values); defer { sqlite3_finalize(stmt) }; guard sqlite3_step(stmt) == SQLITE_DONE else { throw HostFailure("IO_ERROR", "Analytics write failed") }
    }
    private func meta(_ key: String) throws -> String? { try rows("SELECT value FROM metadata WHERE key=?", [key]).first?["value"] as? String }
    private func putMeta(_ key: String, _ value: String) throws { try write("INSERT OR REPLACE INTO metadata(key,value) VALUES(?,?)", [key, value]) }
    private func open() throws {
        guard db == nil else { return }
        try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
        var resourceValues = URLResourceValues(); resourceValues.isExcludedFromBackup = true
        var backupExcludedRoot = root; try backupExcludedRoot.setResourceValues(resourceValues)
        var connection: OpaquePointer?
        guard sqlite3_open(root.appendingPathComponent("analytics.sqlite").path, &connection) == SQLITE_OK else { if let connection { sqlite3_close(connection) }; throw HostFailure("IO_ERROR", "Analytics journal unavailable") }
        db = connection
        sqlite3_busy_timeout(db, 2000)
        do {
            try execute("PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA foreign_keys=ON; CREATE TABLE IF NOT EXISTS metadata(key TEXT PRIMARY KEY,value TEXT NOT NULL); CREATE TABLE IF NOT EXISTS events(seq INTEGER PRIMARY KEY AUTOINCREMENT,id TEXT UNIQUE NOT NULL,time INTEGER NOT NULL,body TEXT NOT NULL,bytes INTEGER NOT NULL); CREATE TABLE IF NOT EXISTS receipts(event TEXT NOT NULL REFERENCES events(id) ON DELETE CASCADE,destination TEXT NOT NULL,PRIMARY KEY(event,destination));")
            if let stored = try meta("install"), UUID(uuidString: stored) != nil { installID = stored }
            else { installID = UUID().uuidString.lowercased(); try putMeta("install", installID) }
            // A policy is authoritative only for the independently configured
            // collector origin. Do not carry A's cached grants/floor to B.
            // A local-only launch must preserve the last binding for a later
            // explicitly configured launch rather than erase its rollback floor.
            if let origin = configuration.origin {
                var parts = URLComponents(url: origin, resolvingAgainstBaseURL: false)!
                parts.scheme = parts.scheme?.lowercased(); parts.host = parts.host?.lowercased(); parts.path = ""
                if parts.port == (parts.scheme == "https" ? 443 : 80) { parts.port = nil }
                let binding = parts.url!.absoluteString
                if try meta("policyOrigin") != binding {
                    try transaction { try putMeta("policyOrigin", binding); try write("DELETE FROM metadata WHERE key IN ('policy','revision')") }
                    policy = nil; revisionFloor = 0
                }
            }
            revisionFloor = Int(try meta("revision") ?? "0") ?? 0
            if let raw = try meta("policy"), let data = raw.data(using: .utf8), let object = try JSONSerialization.jsonObject(with: data) as? [String: Any] { policy = try? AnalyticsPolicy.parse(object, allowed: configuration.destinations, now: Self.now(), allowExpired: true) }
        } catch { sqlite3_close(db); db = nil; throw error }
    }
    private func transaction(_ work: () throws -> Void) throws { try execute("BEGIN IMMEDIATE"); do { try work(); try execute("COMMIT") } catch { try? execute("ROLLBACK"); throw error } }
    private func trim(now: Int) throws {
        try write("DELETE FROM events WHERE time<?", [now - configuration.retentionSeconds * 1000])
        var stats = try rows("SELECT COUNT(*) AS count,COALESCE(SUM(bytes),0) AS bytes FROM events").first ?? [:]
        while (stats["count"] as? Int ?? 0) > configuration.maxEvents || (stats["bytes"] as? Int ?? 0) > configuration.maxBytes {
            try execute("DELETE FROM events WHERE seq=(SELECT MIN(seq) FROM events)")
            let drops = (Int(try meta("dropped") ?? "0") ?? 0) + 1; try putMeta("dropped", String(drops))
            stats = try rows("SELECT COUNT(*) AS count,COALESCE(SUM(bytes),0) AS bytes FROM events").first ?? [:]
        }
    }
    private func append(category: String, name: String, properties: [String: Any], source: String, time: Int, id: String) throws {
        guard AnalyticsSchema.categories.contains(category), AnalyticsSchema.name(name), ["native", "web"].contains(source) else { throw AnalyticsSchema.invalid() }
        _ = try AnalyticsSchema.properties(properties)
        try open()
        let event: [String: Any] = ["schemaVersion": 1, "id": id, "installId": installID, "sessionId": Self.processSession, "timeMs": time, "platform": "ios", "source": source, "category": category, "name": name, "properties": properties]
        let data = try AnalyticsSchema.encode(event); guard data.count <= 4096, let body = String(data: data, encoding: .utf8) else { throw AnalyticsSchema.invalid() }
        try transaction { try write("INSERT INTO events(id,time,body,bytes) VALUES(?,?,?,?)", [id, time, body, data.count]); try trim(now: Self.now()) }
        schedule()
    }
    func record(category: String, name: String, properties: [String: Any] = [:], source: String = "native", completion: ((Result<Any, HostFailure>) -> Void)? = nil) {
        guard configuration.enabled else { completion?(.success(["recorded": false])); return }
        do { guard AnalyticsSchema.categories.contains(category), AnalyticsSchema.name(name), ["native", "web"].contains(source) else { throw AnalyticsSchema.invalid() }; _ = try AnalyticsSchema.properties(properties) }
        catch { completion?(.failure(AnalyticsSchema.invalid())); return }
        guard admit() else { completion?(.failure(busy())); return }
        let time = Self.now(), id = UUID().uuidString.lowercased()
        queue.async { [self] in
            defer { releaseAdmission() }
            let result: Result<Any, HostFailure>
            do { try append(category: category, name: name, properties: properties, source: source, time: time, id: id); result = .success(["recorded": true]) }
            catch let error as HostFailure { result = .failure(error) } catch { result = .failure(HostFailure("IO_ERROR", "Analytics journal unavailable")) }
            if let completion { DispatchQueue.main.async { completion(result) } }
        }
    }
    func screen(_ path: String, tab: String, surface: String = "legacy") {
        // Dedup identity is ephemeral. Export only redacted semantic screen/tab;
        // separate hosted IDs and same-route native surfaces remain real visits.
        let screen = AnalyticsSchema.screen(path), key = surface + ":" + tab + ":" + path
        guard configuration.enabled, admit() else { return }
        let time = Self.now(), id = UUID().uuidString.lowercased()
        queue.async { [self] in
            defer { releaseAdmission() }; guard lastScreen != key else { return }
            do { try append(category: "navigation", name: "navigation.screen", properties: ["screen": screen, "tab": tab], source: "native", time: time, id: id); lastScreen = key } catch { }
        }
    }
    func foreground(_ foreground: Bool) {
        admission.lock(); let changed = foregroundActive != foreground; foregroundActive = foreground; admission.unlock()
        guard changed else { return }
        record(category: "lifecycle", name: foreground ? "app.foreground" : "app.background", properties: ["state": foreground ? "foreground" : "background"])
    }
    private func schedule(delay: TimeInterval = 5) {
        guard active, configuration.origin != nil, !scheduled else { return }; scheduled = true
        queue.asyncAfter(deadline: .now() + delay) { [weak self] in guard let self else { return }; self.scheduled = false; guard self.active else { return }; self.beginFlush(automatic: true) { _ in }; self.schedule(delay: 30) }
    }
    func status(_ completion: @escaping (Result<Any, HostFailure>) -> Void) {
        guard admit() else { completion(.failure(busy())); return }
        queue.async { [self] in
            defer { releaseAdmission() }
            let result: Result<Any, HostFailure>
            do { try open(); try trim(now: Self.now()); let stats = try rows("SELECT COUNT(*) AS count,COALESCE(SUM(bytes),0) AS bytes FROM events").first ?? [:]; let delivered = try rows("SELECT COUNT(*) AS count FROM receipts").first?["count"] as? Int ?? 0
                admission.lock(); let lost = admissionDrops; admission.unlock()
                result = .success(["enabled": configuration.enabled, "configured": configuration.origin != nil, "count": stats["count"] ?? 0, "bytes": stats["bytes"] ?? 0, "dropped": (Int(try meta("dropped") ?? "0") ?? 0) + lost, "acknowledged": delivered, "policyRevision": revisionFloor, "policyExpiresAtMs": policy?.expires as Any? ?? NSNull(), "uploading": networkBusy])
            } catch { result = .failure(HostFailure("IO_ERROR", "Analytics journal unavailable")) }
            DispatchQueue.main.async { completion(result) }
        }
    }
    func flush(_ completion: @escaping (Result<Any, HostFailure>) -> Void) {
        guard admit() else { completion(.failure(busy())); return }
        queue.async { [self] in beginFlush(automatic: false) { result in self.releaseAdmission(); completion(result) } }
    }
    private func beginFlush(automatic: Bool, completion: @escaping (Result<Any, HostFailure>) -> Void) {
        func done(_ result: Result<Any, HostFailure>) { DispatchQueue.main.async { completion(result) } }
        guard configuration.enabled, let origin = configuration.origin else { done(.failure(HostFailure("UNAVAILABLE", "Analytics upload is not configured"))); return }
        guard !networkBusy else { done(.failure(HostFailure("BUSY", "Analytics upload is already running"))); return }
        guard Self.now() >= nextAttempt else { done(.failure(HostFailure("BUSY", "Analytics retry is backing off"))); return }
        do { try open(); try trim(now: Self.now()) } catch { done(.failure(HostFailure("IO_ERROR", "Analytics journal unavailable"))); return }
        networkBusy = true; networkDeadline = Self.now() + 25_000
        var request = URLRequest(url: origin.appendingPathComponent("api/analytics/policy/")); request.httpMethod = "GET"; request.setValue("application/json", forHTTPHeaderField: "Accept")
        AnalyticsHTTP.send(request) { [weak self] response in self?.queue.async { [weak self] in
            guard let self else { return }
            do {
                switch response {
                case .success(let data): guard let object = try JSONSerialization.jsonObject(with: data) as? [String: Any] else { throw AnalyticsSchema.invalid() }; try self.acceptPolicy(object)
                case .failure(let failure): guard let cached = self.policy, cached.expires > Self.now() else { throw failure }
                }
                guard let policy = self.policy, policy.expires > Self.now() else { throw HostFailure("UNAVAILABLE", "Analytics policy expired") }
                self.upload(policy: policy, destinations: policy.destinations, index: 0, batches: 0, accepted: 0) { result in self.finishFlush(result, done: done) }
            } catch let failure as HostFailure { self.finishFlush(.failure(failure), done: done) } catch { self.finishFlush(.failure(AnalyticsSchema.invalid()), done: done) }
        } }
    }
    private func finishFlush(_ result: Result<Any, HostFailure>, done: (Result<Any, HostFailure>) -> Void) {
        networkBusy = false
        if case .failure = result { failures = min(6, failures + 1); nextAttempt = Self.now() + min(60_000, 1000 * (1 << failures)) }
        else { failures = 0; nextAttempt = 0 }
        done(result)
    }
    private func acceptPolicy(_ object: [String: Any]) throws {
        let next = try AnalyticsPolicy.parse(object, allowed: configuration.destinations, now: Self.now())
        guard next.revision >= revisionFloor, next.revision != revisionFloor || policy?.sameSelectors(next) == true || revisionFloor == 0 else { throw AnalyticsSchema.invalid() }
        let data = try AnalyticsSchema.encode(object), raw = String(data: data, encoding: .utf8)!
        try transaction { try putMeta("policy", raw); try putMeta("revision", String(next.revision)) }
        policy = next; revisionFloor = next.revision
    }
    private func batch(_ policy: AnalyticsPolicy, destination: String, now: Int) throws -> [[String: Any]] {
        guard policy.enabled, policy.expires > now else { return [] }
        // Scan at most the configured bounded journal; excluded events remain for
        // later policy revisions instead of being discarded by this selection.
        let stored = try rows("SELECT e.body FROM events e WHERE NOT EXISTS(SELECT 1 FROM receipts r WHERE r.event=e.id AND r.destination=?) ORDER BY e.seq", [destination])
        var selected: [[String: Any]] = [], bytes = 0
        for row in stored {
            guard let body = row["body"] as? String, let data = body.data(using: .utf8), let event = try JSONSerialization.jsonObject(with: data) as? [String: Any], policy.matches(event, now: now) else { continue }
            if selected.count == 100 || bytes + data.count > 250_000 { break }; selected.append(event); bytes += data.count
        }
        return selected
    }
    private func acknowledge(_ ids: [String], requested: Set<String>, destination: String) throws {
        guard ids.count <= 100, Set(ids).count == ids.count, Set(ids).isSubset(of: requested) else { throw AnalyticsSchema.invalid() }
        try transaction { for id in ids { try write("INSERT OR IGNORE INTO receipts(event,destination) SELECT id,? FROM events WHERE id=?", [destination, id]) } }
    }
    private func upload(policy: AnalyticsPolicy, destinations: [String], index: Int, batches: Int, accepted: Int, completion: @escaping (Result<Any, HostFailure>) -> Void) {
        guard let origin = configuration.origin else { completion(.failure(HostFailure("UNAVAILABLE", "Analytics upload unavailable"))); return }
        guard policy.expires > Self.now() else { completion(.failure(HostFailure("UNAVAILABLE", "Analytics policy expired"))); return }
        guard index < destinations.count, batches < 8, Self.now() + 6000 < networkDeadline else { completion(.success(["accepted": accepted, "policyRevision": policy.revision])); return }
        do {
            let destination = destinations[index], events = try batch(policy, destination: destination, now: Self.now())
            if events.isEmpty { upload(policy: policy, destinations: destinations, index: index + 1, batches: batches, accepted: accepted, completion: completion); return }
            let object: [String: Any] = ["schemaVersion": 1, "destination": destination, "policyRevision": policy.revision, "events": events]
            let data = try AnalyticsSchema.encode(object); guard data.count <= 262_144 else { throw AnalyticsSchema.invalid() }
            var request = URLRequest(url: origin.appendingPathComponent("api/analytics/batch/")); request.httpMethod = "POST"; request.httpBody = data; request.setValue("application/json", forHTTPHeaderField: "Content-Type")
            let requested = Set(events.compactMap { $0["id"] as? String })
            AnalyticsHTTP.send(request) { [weak self] response in self?.queue.async { [weak self] in
                guard let self else { return }
                do {
                    let data = try response.get()
                    guard let object = try JSONSerialization.jsonObject(with: data) as? [String: Any], Set(object.keys) == ["schemaVersion", "accepted"], AnalyticsSchema.integer(object["schemaVersion"], 1...1) == 1, let ids = object["accepted"] as? [String] else { throw AnalyticsSchema.invalid() }
                    try self.acknowledge(ids, requested: requested, destination: destination)
                    // Partial ACK moves on rather than retrying the same missing
                    // IDs in a tight loop. Later flushes retry them with stable IDs.
                    self.upload(policy: policy, destinations: destinations, index: ids.count == events.count ? index : index + 1, batches: batches + 1, accepted: accepted + ids.count, completion: completion)
                } catch let failure as HostFailure { completion(.failure(failure)) } catch { completion(.failure(AnalyticsSchema.invalid())) }
            } }
        } catch let failure as HostFailure { completion(.failure(failure)) } catch { completion(.failure(AnalyticsSchema.invalid())) }
    }
    #if DEBUG
    func holdWriterForTesting(entered: @escaping () -> Void, until gate: DispatchSemaphore) {
        guard admit() else { return }
        queue.async { [self] in defer { releaseAdmission() }; DispatchQueue.main.async(execute: entered); gate.wait() }
    }
    func inspectForTesting(_ completion: @escaping ([[String: Any]]) -> Void) { guard admit() else { completion([]); return }; queue.async { [self] in defer { releaseAdmission() }; let values: [[String: Any]] = (try? { try open(); return try rows("SELECT body FROM events ORDER BY seq").compactMap { row -> [String: Any]? in guard let text = row["body"] as? String, let data = text.data(using: .utf8) else { return nil }; return try JSONSerialization.jsonObject(with: data) as? [String: Any] } }()) ?? []; DispatchQueue.main.async { completion(values) } } }
    func policyForTesting(_ object: [String: Any], destination: String, acknowledge ids: [String] = [], completion: @escaping (Result<[[String: Any]], HostFailure>) -> Void) {
        guard admit() else { completion(.failure(busy())); return }
        queue.async { [self] in defer { releaseAdmission() }; let result: Result<[[String: Any]], HostFailure>; do { try open(); try trim(now: Self.now()); try acceptPolicy(object); let events = try batch(policy!, destination: destination, now: Self.now()); if !ids.isEmpty { try acknowledge(ids, requested: Set(events.compactMap { $0["id"] as? String }), destination: destination) }; result = .success(events) } catch let failure as HostFailure { result = .failure(failure) } catch { result = .failure(AnalyticsSchema.invalid()) }; DispatchQueue.main.async { completion(result) } }
    }
    #endif
}
