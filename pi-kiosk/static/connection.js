// Kiosk self-recovery. Firefox opens the page once at desktop login, but the
// kiosk service restarts often (Restart=always, watchdog, crashes, updates).
// The page must recover on its own: reload for a fresh UI cookie or new code,
// and reconnect a dead camera stream instead of freezing on its last frame.
(function (root) {
    // At most one automatic reload per window, so an unrecoverable
    // misconfiguration (e.g. KIOSK_UI_KEY missing) cannot cause a reload loop.
    const RELOAD_BACKOFF_MS = 45000;
    const RELOAD_STORAGE_KEY = "fw-kiosk-last-auto-reload-at";
    // /status answers these when the UI auth cookie is missing, stale or cannot
    // be issued. Reloading "/" is the only way to pick up a fresh cookie.
    const AUTH_RELOAD_STATUSES = [401, 403, 503];
    // A scan result (e.g. "Welcome, <name>") is only held for a few seconds;
    // a restart reload must not blank it out mid-display.
    const SCAN_RESULT_STATES = ["CLOCKED_IN", "ALREADY_CLOCKED", "NOT_RECOGNIZED", "WAITING_FOR_BLINK"];
    const FEED_RETRY_BASE_MS = 1000;
    const FEED_RETRY_MAX_MS = 30000;
    const FEED_FIRST_FRAME_TIMEOUT_MS = 10000;

    function createMonitor(options) {
        const now = options.now || (() => Date.now());
        const reload = options.reload;
        const storage = options.storage || null;
        const reloadBackoffMs = options.reloadBackoffMs ?? RELOAD_BACKOFF_MS;
        // Monotonic time since this page loaded (performance.now()). It does
        // not depend on storage or the wall clock, so a page never reloads
        // itself again within the backoff even when sessionStorage is blocked.
        const pageAge = options.pageAge || (() => root.performance.now());
        let memoryLastReloadAt = null;
        let bootId = null;
        let pendingBootId = null;
        let failing = false;

        function lastReloadAt() {
            try {
                const stored = storage ? Number(storage.getItem(RELOAD_STORAGE_KEY)) : NaN;
                if (Number.isFinite(stored) && stored > 0) return stored;
            } catch (error) { /* storage unavailable: fall back to memory */ }
            return memoryLastReloadAt;
        }

        function rememberReload(at) {
            memoryLastReloadAt = at;
            try {
                if (storage) storage.setItem(RELOAD_STORAGE_KEY, String(at));
            } catch (error) { /* storage unavailable: memory still bounds this page */ }
        }

        // Returns true when a reload was started, false when backoff deferred it.
        function requestReload(reason) {
            if (pageAge() < reloadBackoffMs) return false;
            const at = now();
            const last = lastReloadAt();
            // A clock that moved backwards must not block recovery forever.
            if (last !== null && at >= last && at - last < reloadBackoffMs) return false;
            rememberReload(at);
            reload(reason);
            return true;
        }

        // Non-OK HTTP status (httpStatus) or network/timeout failure (null).
        function statusFailed(httpStatus) {
            failing = true;
            const reloading = AUTH_RELOAD_STATUSES.includes(httpStatus) && requestReload("auth");
            return { failing: true, reloading };
        }

        // Successful /status payload.
        function statusOk(data) {
            const recovered = failing;
            failing = false;
            const reportedBootId = data && typeof data.boot_id === "string" && data.boot_id ? data.boot_id : null;
            if (reportedBootId && bootId === null) bootId = reportedBootId;
            if (reportedBootId && reportedBootId !== bootId) {
                // The kiosk service restarted: reload to drop stale state and
                // pick up new UI code. If backoff defers it, keep retrying on
                // later polls and reconnect the feed once in the meantime.
                const showingResult = SCAN_RESULT_STATES.includes(data.state);
                if (!showingResult && requestReload("restart")) return { failing: false, reloading: true, reconnectFeed: false };
                const firstSeen = pendingBootId !== reportedBootId;
                pendingBootId = reportedBootId;
                return { failing: false, reloading: false, reconnectFeed: recovered || firstSeen };
            }
            return { failing: false, reloading: false, reconnectFeed: recovered };
        }

        return {
            statusFailed,
            statusOk,
            requestReload,
            isFailing: () => failing,
            bootId: () => bootId,
        };
    }

    // Reconnects an MJPEG <img> with a cache-busting URL and capped backoff.
    function createFeed(options) {
        const img = options.img;
        const baseUrl = options.url || "/feed";
        const now = options.now || (() => Date.now());
        const schedule = options.setTimeout || ((fn, ms) => root.setTimeout(fn, ms));
        const cancel = options.clearTimeout || (id => root.clearTimeout(id));
        const firstFrameTimeoutMs = options.firstFrameTimeoutMs ?? FEED_FIRST_FRAME_TIMEOUT_MS;
        let connected = false;
        let failures = 0;
        let retryTimer = null;
        let stallTimer = null;

        function clearTimers() {
            if (retryTimer !== null) cancel(retryTimer);
            if (stallTimer !== null) cancel(stallTimer);
            retryTimer = null;
            stallTimer = null;
        }

        function connect() {
            clearTimers();
            connected = true;
            img.src = `${baseUrl}?ts=${now()}`;
            // No frame at all within the timeout means the stream stalled.
            stallTimer = schedule(() => { stallTimer = null; retry(); }, firstFrameTimeoutMs);
        }

        function retry() {
            if (!connected || retryTimer !== null) return;
            if (stallTimer !== null) { cancel(stallTimer); stallTimer = null; }
            const delay = Math.min(FEED_RETRY_BASE_MS * 2 ** failures, FEED_RETRY_MAX_MS);
            failures += 1;
            img.style.visibility = "hidden";
            retryTimer = schedule(() => { retryTimer = null; connect(); }, delay);
        }

        // Drop the stream and hide the last frame (it may show the previous worker).
        function disconnect() {
            clearTimers();
            connected = false;
            img.style.visibility = "hidden";
            img.removeAttribute("src");
        }

        img.addEventListener("load", () => {
            if (!connected) return;
            failures = 0;
            if (stallTimer !== null) { cancel(stallTimer); stallTimer = null; }
            img.style.visibility = "";
        });
        img.addEventListener("error", () => retry());

        return {
            connect,
            disconnect,
            retry,
            isConnected: () => connected,
            retryDelayMs: () => Math.min(FEED_RETRY_BASE_MS * 2 ** failures, FEED_RETRY_MAX_MS),
        };
    }

    root.KioskConnection = {
        createMonitor,
        createFeed,
        RELOAD_BACKOFF_MS,
        AUTH_RELOAD_STATUSES,
        FEED_RETRY_MAX_MS,
    };
})(globalThis);
