// Kiosk page self-recovery: response.ok handling, bounded reloads, boot-ID
// reloads and camera feed reconnects. Runs the shipped connection.js and the
// real inline script from index.html against a minimal fake DOM.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const connectionSource = readFileSync(new URL('../pi-kiosk/static/connection.js', import.meta.url), 'utf8');
const template = readFileSync(new URL('../pi-kiosk/templates/index.html', import.meta.url), 'utf8');
const inlineScripts = [...template.matchAll(/<script>([\s\S]*?)<\/script>/g)].map(match => match[1]);
assert.equal(inlineScripts.length, 1, 'index.html has one inline kiosk script');

function memoryStorage() {
    const values = new Map();
    return { getItem: key => values.get(key) ?? null, setItem: (key, value) => values.set(key, String(value)) };
}

function fakeElement() {
    const listeners = {};
    const attributes = {};
    return {
        textContent: '', innerHTML: '', value: '', style: {},
        classList: { toggle() {} },
        listeners,
        addEventListener(type, fn) { (listeners[type] ||= []).push(fn); },
        dispatch(type) { (listeners[type] || []).forEach(fn => fn({})); },
        get src() { return attributes.src; },
        set src(value) { attributes.src = String(value); },
        removeAttribute(name) { delete attributes[name]; },
        replaceChildren() {}, focus() {}, select() {}, showModal() {}, close() {}, matches() { return false; },
    };
}

// ---- Unit: monitor -------------------------------------------------------
const unitContext = vm.createContext({});
vm.runInContext(connectionSource, unitContext);
const { KioskConnection } = unitContext;
const backoff = KioskConnection.RELOAD_BACKOFF_MS;
assert.ok(backoff >= 30000 && backoff <= 60000, 'automatic reloads are limited to one per 30-60 s');

{
    let clock = 1_000_000;
    const reloads = [];
    const storage = memoryStorage();
    const monitor = KioskConnection.createMonitor({ now: () => clock, storage, reload: reason => reloads.push(reason) });
    for (const code of [401, 403, 503]) {
        clock += backoff;
        assert.equal(monitor.statusFailed(code).reloading, true, `${code} reloads for a fresh UI cookie`);
    }
    assert.deepEqual([...reloads], ['auth', 'auth', 'auth']);
    const lastReload = clock;
    for (clock = lastReload + 500; clock < lastReload + backoff; clock += 500) {
        assert.equal(monitor.statusFailed(401).reloading, false, 'no tight reload loop within the backoff window');
    }
    assert.equal(reloads.length, 3);
    clock = lastReload + backoff - 1;

    // The backoff survives the reload itself (new page, same tab storage).
    const afterReload = KioskConnection.createMonitor({ now: () => clock, storage, reload: reason => reloads.push(reason) });
    assert.equal(afterReload.statusFailed(503).reloading, false, 'a reloaded page still honours the backoff');
    clock = lastReload + backoff;
    assert.equal(afterReload.statusFailed(503).reloading, true, 'reload is retried once the backoff expires');
    assert.equal(reloads.length, 4);

    // Without storage the in-memory timestamp still bounds reloads.
    let bare = 0;
    const noStorage = KioskConnection.createMonitor({ now: () => clock, reload: () => { bare += 1; } });
    noStorage.statusFailed(401);
    noStorage.statusFailed(401);
    assert.equal(bare, 1);
}

{
    let reloads = 0;
    const monitor = KioskConnection.createMonitor({ now: () => 5_000_000, storage: memoryStorage(), reload: () => { reloads += 1; } });
    for (const failure of [null, 500, 502, 404]) {
        const result = monitor.statusFailed(failure);
        assert.equal(result.failing, true, `${failure} is treated as a failing status`);
        assert.equal(result.reloading, false, `${failure} never reloads (server may be down)`);
    }
    assert.equal(monitor.isFailing(), true);
    assert.equal(monitor.statusOk({ boot_id: 'boot-a' }).reconnectFeed, true, 'feed reconnects when /status recovers');
    assert.equal(monitor.isFailing(), false);
    assert.equal(monitor.statusOk({ boot_id: 'boot-a' }).reconnectFeed, false, 'healthy polls leave the feed alone');
    assert.equal(monitor.bootId(), 'boot-a');
    assert.equal(reloads, 0, 'first boot ID is adopted without reloading');
    assert.equal(monitor.statusOk({ boot_id: 'boot-b' }).reloading, true, 'boot ID change reloads the page');
    assert.equal(reloads, 1);
}

{
    let clock = 9_000_000;
    let reloads = 0;
    const storage = memoryStorage();
    storage.setItem('fw-kiosk-last-auto-reload-at', String(clock - 1000));
    const monitor = KioskConnection.createMonitor({ now: () => clock, storage, reload: () => { reloads += 1; } });
    monitor.statusOk({ boot_id: 'old' });
    const deferred = monitor.statusOk({ boot_id: 'new' });
    assert.equal(deferred.reloading, false, 'restart reload honours the backoff');
    assert.equal(deferred.reconnectFeed, true, 'feed reconnects once while the restart reload is deferred');
    assert.equal(monitor.statusOk({ boot_id: 'new' }).reconnectFeed, false);
    clock += backoff;
    assert.equal(monitor.statusOk({ boot_id: 'new' }).reloading, true, 'deferred restart reload happens after backoff');
    assert.equal(reloads, 1);
}

// ---- Unit: feed ----------------------------------------------------------
{
    let clock = 42;
    const timers = new Map();
    let nextTimer = 1;
    const img = fakeElement();
    const feed = KioskConnection.createFeed({
        img, url: '/feed', now: () => clock,
        setTimeout: (fn, ms) => { const id = nextTimer++; timers.set(id, { fn, ms }); return id; },
        clearTimeout: id => timers.delete(id),
    });
    const fire = predicate => {
        const [id, timer] = [...timers].find(([, t]) => predicate(t));
        timers.delete(id);
        timer.fn();
    };
    feed.connect();
    assert.equal(img.src, '/feed?ts=42', 'feed uses a cache-busting URL');
    img.dispatch('load');
    assert.equal(timers.size, 0, 'first frame clears the stall timer');
    const delays = [];
    for (let i = 0; i < 8; i++) {
        clock += 1;
        img.dispatch('error');
        img.dispatch('error');
        assert.equal(timers.size, 1, 'one pending reconnect at a time');
        const [[, pending]] = [...timers];
        delays.push(pending.ms);
        assert.equal(img.style.visibility, 'hidden', 'a broken stream does not keep showing its last frame');
        fire(() => true);
        assert.equal(img.src, `/feed?ts=${clock}`);
        timers.clear();
    }
    assert.deepEqual(delays, [1000, 2000, 4000, 8000, 16000, 30000, 30000, 30000], 'reconnect backoff is capped');
    img.dispatch('load');
    assert.equal(img.style.visibility, '');
    assert.equal(feed.retryDelayMs(), 1000, 'a delivered frame resets the backoff');

    feed.connect();
    fire(t => t.ms === 10000);
    assert.equal(timers.size, 1, 'a stream that never delivers a frame is treated as stalled');
    timers.clear();

    feed.disconnect();
    assert.equal(img.src, undefined, 'disconnect drops the stream');
    assert.equal(img.style.visibility, 'hidden');
    img.dispatch('error');
    assert.equal(timers.size, 0, 'errors after disconnect do not reconnect');
}

// ---- Integration: real inline script from index.html ---------------------
function kioskPage({ storage = memoryStorage(), reply = () => ({ ok: true, status: 200, body: {} }) } = {}) {
    const elements = new Map();
    const requests = [];
    const reloads = [];
    let statusReply = reply;
    const flush = async () => { for (let i = 0; i < 20; i++) await new Promise(resolve => setImmediate(resolve)); };
    const context = vm.createContext({
        console, AbortController, Option: function Option() {},
        HTMLElement: function HTMLElement() {},
        setTimeout: (fn, ms) => { const timer = setTimeout(fn, ms); timer.unref(); return timer; },
        clearTimeout, setInterval: () => 0,
        location: { reload: () => reloads.push('reload') },
        document: {
            body: fakeElement(),
            activeElement: null,
            getElementById: id => { if (!elements.has(id)) elements.set(id, fakeElement()); return elements.get(id); },
            querySelector: selector => { if (!elements.has(selector)) elements.set(selector, fakeElement()); return elements.get(selector); },
            addEventListener() {},
        },
        fetch: async (url, init = {}) => {
            requests.push({ url, method: init.method || 'GET' });
            if (url === '/status') {
                const reply = statusReply();
                if (reply instanceof Error) throw reply;
                return { ok: reply.ok, status: reply.status, json: async () => reply.body };
            }
            return { ok: true, status: 200, json: async () => ({ success: true }) };
        },
    });
    context.window = { sessionStorage: storage };
    vm.runInContext(connectionSource, context);
    vm.runInContext(inlineScripts[0], context);
    return {
        context, requests, reloads, flush,
        el: id => elements.get(id),
        reply(fn) { statusReply = fn; },
        async poll() { await vm.runInContext('fetchStatus()', context); await flush(); },
    };
}

const unauthorized = () => ({ ok: false, status: 401, body: { error: 'Unauthorized' } });
const healthy = bootId => () => ({ ok: true, status: 200, body: { state: 'IDLE', message: 'Step toward camera', boot_id: bootId, health: { sync_online: true } } });

{
    // Page loaded with a stale or missing UI cookie: the first poll is a 401.
    const page = kioskPage({ reply: unauthorized });
    await page.flush();
    const feed = page.el('cameraFeed');
    assert.equal(page.el('statusText').textContent, 'Kiosk reconnecting…', 'a 401 is an error, not idle status data');
    assert.equal(page.el('syncChip').textContent, '', 'auth error JSON is never parsed as health ("Sync disabled")');
    assert.equal(feed.src, undefined, 'the frozen frame is dropped while status is failing');
    assert.equal(page.reloads.length, 1, '401 reloads the page for a fresh UI cookie');
    assert.ok(page.requests.some(r => r.url === '/health'), 'reload waits for the server to answer');

    await page.poll();
    page.reply(() => ({ ok: false, status: 503, body: { error: 'Kiosk UI authentication is not configured' } }));
    await page.poll();
    assert.equal(page.reloads.length, 1, 'repeated auth failures do not reload in a tight loop');
    assert.equal(page.el('statusText').textContent, 'Kiosk reconnecting…');
}

{
    const page = kioskPage({ reply: healthy('boot-1') });
    await page.flush();
    assert.equal(page.el('statusText').textContent, 'Step toward camera');
    const feed = page.el('cameraFeed');
    const firstSrc = feed.src;
    assert.match(firstSrc, /^\/feed\?ts=\d+$/, 'page connects the feed with a cache-busting URL');

    page.reply(() => new TypeError('NetworkError when attempting to fetch resource.'));
    await page.poll();
    assert.equal(page.el('statusText').textContent, 'Kiosk reconnecting…', 'service down shows reconnecting');
    assert.equal(page.reloads.length, 0, 'never reload while the server is unreachable');

    page.reply(() => ({ ok: false, status: 500, body: '<html>' }));
    await page.poll();
    assert.equal(page.reloads.length, 0);

    await new Promise(resolve => setTimeout(resolve, 2));
    page.reply(healthy('boot-1'));
    await page.poll();
    assert.equal(page.el('statusText').textContent, 'Step toward camera');
    assert.match(feed.src, /^\/feed\?ts=\d+$/);
    assert.notEqual(feed.src, firstSrc, 'feed reconnects when /status recovers');

    vm.runInContext('setAdminVisible(true)', page.context);
    page.reply(healthy('boot-2'));
    await page.poll();
    assert.equal(page.reloads.length, 1, 'boot ID change reloads the page');
    const lockIndex = page.requests.findIndex(r => r.url === '/supervisor/lock' && r.method === 'POST');
    assert.ok(lockIndex >= 0, 'an unlocked supervisor session is locked before reloading');
}

{
    // Reloading inside the backoff window (same tab storage) does not reload again.
    const storage = memoryStorage();
    const first = kioskPage({ storage, reply: unauthorized });
    await first.flush();
    assert.equal(first.reloads.length, 1);
    const second = kioskPage({ storage, reply: unauthorized });
    await second.flush();
    await second.poll();
    assert.equal(second.reloads.length, 0, 'backoff persists across the reload itself');
}

console.log('Kiosk page recovers from service restarts and auth failures with bounded reloads.');
