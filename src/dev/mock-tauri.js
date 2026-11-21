/* 浏览器预览用的 Tauri API mock。
 *
 * 只在 `pnpm dev:web`（vite --mode preview）下通过 vite.config.js 的 alias 生效，
 * 正常 `pnpm tauri dev` 不会加载本文件。
 *
 * URL 参数：
 *   ?window=config|translate|recognize|screenshot|updater   要预览的窗口（默认 config）
 *   ?os=Windows_NT|Darwin|Linux                             模拟的系统（默认 Windows_NT）
 */

const params = new URLSearchParams(globalThis.location ? globalThis.location.search : '');
export const previewWindowLabel = params.get('window') || 'config';
const simulatedOs = params.get('os') || 'Windows_NT';

// ---------------------------------------------------------------- 事件总线
const eventListeners = new Map();

export async function listen(event, handler) {
    const set = eventListeners.get(event) || new Set();
    set.add(handler);
    eventListeners.set(event, set);
    return () => set.delete(handler);
}

export async function emit(event, payload) {
    const set = eventListeners.get(event);
    if (set) {
        for (const handler of set) {
            try {
                handler({ event, payload });
            } catch (error) {
                console.warn('[mock] listener error', error);
            }
        }
    }
}

// ---------------------------------------------------------------- 配置存储
const STORE_KEY = 'pot-preview:store';

function readStore() {
    try {
        return JSON.parse(globalThis.localStorage?.getItem(STORE_KEY) || '{}');
    } catch (error) {
        return {};
    }
}

function writeStore(data) {
    try {
        globalThis.localStorage?.setItem(STORE_KEY, JSON.stringify(data));
    } catch (error) {
        // 隐私模式下 localStorage 不可写，忽略即可
    }
}

export class Store {
    constructor(_path) {}

    async get(key) {
        const data = readStore();
        return Object.prototype.hasOwnProperty.call(data, key) ? data[key] : null;
    }

    async set(key, value) {
        const data = readStore();
        data[key] = value;
        writeStore(data);
    }

    async has(key) {
        return Object.prototype.hasOwnProperty.call(readStore(), key);
    }

    async delete(key) {
        const data = readStore();
        delete data[key];
        writeStore(data);
    }

    async clear() {
        writeStore({});
    }

    async keys() {
        return Object.keys(readStore());
    }

    async values() {
        return Object.values(readStore());
    }

    async entries() {
        return Object.entries(readStore());
    }

    async save() {}
    async load() {}
    async reset() {}
    async close() {}
}

// ---------------------------------------------------------------- HTTP
export const ResponseType = { JSON: 1, Text: 2, Binary: 3 };

function bodyToInit(body, headers) {
    if (!body) {
        return undefined;
    }
    const type = body.type || body.__type;
    const payload = body.payload;
    if (type === 'json' || type === 'Json') {
        headers['Content-Type'] = headers['Content-Type'] || 'application/json';
        return JSON.stringify(payload);
    }
    if (type === 'form' || type === 'Form') {
        const form = new URLSearchParams();
        Object.entries(payload || {}).forEach(([key, value]) => form.append(key, value));
        headers['Content-Type'] = headers['Content-Type'] || 'application/x-www-form-urlencoded';
        return form.toString();
    }
    return typeof payload === 'string' ? payload : new Uint8Array(payload || []);
}

export async function fetch(url, options = {}) {
    const { method = 'GET', headers = {}, query, body, timeout = 30, responseType = 1 } = options;

    let target = url;
    if (query) {
        const search = new URLSearchParams();
        Object.entries(query).forEach(([key, value]) => search.append(key, value));
        target += (target.includes('?') ? '&' : '?') + search.toString();
    }

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeout * 1000);
    const requestHeaders = { ...headers };
    const init = {
        method,
        headers: requestHeaders,
        body: bodyToInit(body, requestHeaders),
        signal: controller.signal,
        redirect: 'follow',
    };

    try {
        const response = await globalThis.fetch(target, init);
        let data;
        if (responseType === 2) {
            data = await response.text();
        } else if (responseType === 3) {
            data = Array.from(new Uint8Array(await response.arrayBuffer()));
        } else {
            data = await response.json().catch(() => ({}));
        }
        return { ok: response.ok, status: response.status, data, headers: {} };
    } catch (error) {
        throw new Error(`[mock] 请求失败：${target}（浏览器预览受 CORS 限制）\n${error}`);
    } finally {
        clearTimeout(timer);
    }
}

export const Body = {
    json: (payload) => ({ type: 'Json', payload }),
    text: (payload) => ({ type: 'Text', payload }),
    form: (payload) => ({ type: 'Form', payload }),
    bytes: (payload) => ({ type: 'Bytes', payload }),
};

export const http = { fetch, Body, ResponseType };

// ---------------------------------------------------------------- invoke
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export async function invoke(command, args = {}) {
    switch (command) {
        case 'font_list':
            return ['sans-serif', 'serif', 'monospace', 'Microsoft YaHei', 'Segoe UI'];
        case 'get_text':
            return '';
        case 'run_binary':
            console.info('[mock] run_binary', args);
            return { stdout: '', stderr: '', status: 0 };
        case 'proxy_test': {
            // 浏览器里没有代理分流的概念，这里只用真实请求验证可达性，方便看结果样式
            const started = performance.now();
            try {
                const response = await globalThis.fetch(args.url, { method: 'GET', mode: 'cors' });
                const ms = Math.round(performance.now() - started);
                return {
                    verdict: 'bypass',
                    direct_status: response.status,
                    direct_ms: ms,
                    direct_detail: '',
                    routed_status: response.status,
                    routed_ms: ms,
                    routed_detail: '',
                };
            } catch (error) {
                const ms = Math.round(performance.now() - started);
                return {
                    verdict: 'unreachable',
                    direct_status: null,
                    direct_ms: ms,
                    direct_detail: String(error),
                    routed_status: null,
                    routed_ms: ms,
                    routed_detail: '浏览器预览受 CORS 限制，真实的代理判定需要运行 Tauri 版本',
                };
            }
        }
        case 'apply_proxy_settings':
        case 'set_proxy':
        case 'unset_proxy':
            return true;
        case 'lang_detect':
            return 'en';
        case 'install_plugin':
            return 0;
        case 'updater_window':
        case 'update_tray':
        case 'reload_store':
        case 'open_devtools':
        case 'register_shortcut_by_frontend':
        case 'webdav':
        case 'local':
            return null;
        default:
            console.info('[mock] invoke', command, args);
            return null;
    }
}

// ---------------------------------------------------------------- 窗口 / 系统
export class LogicalSize {
    constructor(width, height) {
        this.width = width;
        this.height = height;
    }
}

export class PhysicalSize {
    constructor(width, height) {
        this.width = width;
        this.height = height;
    }
}

export class LogicalPosition {
    constructor(x, y) {
        this.x = x;
        this.y = y;
    }
}

export class PhysicalPosition {
    constructor(x, y) {
        this.x = x;
        this.y = y;
    }
}

export const appWindow = {
    label: previewWindowLabel,
    async close() {},
    async show() {},
    async hide() {},
    async setFocus() {},
    async setAlwaysOnTop() {},
    async setResizable() {},
    async setSize() {},
    async setPosition() {},
    async maximize() {},
    async unmaximize() {},
    async minimize() {},
    async isMaximized() {
        return false;
    },
    async outerSize() {
        return { width: 800, height: 560 };
    },
    async outerPosition() {
        return { x: 0, y: 0 };
    },
    async scaleFactor() {
        return 1;
    },
    async listen() {
        return () => {};
    },
    async onCloseRequested() {
        return () => {};
    },
};

export async function currentMonitor() {
    return { size: { width: 1920, height: 1080 }, position: { x: 0, y: 0 }, scaleFactor: 1 };
}

export const type = async () => simulatedOs;
export const arch = async () => 'x86_64';
export const version = async () => '10.0.22631';
export const getVersion = async () => '3.0.7';

export const BaseDirectory = {
    Audio: 1,
    Cache: 2,
    Config: 3,
    Data: 4,
    LocalData: 5,
    Document: 6,
    Download: 7,
    Picture: 8,
    Public: 9,
    Video: 10,
    Resource: 11,
    Temp: 12,
    AppConfig: 13,
    AppData: 14,
    AppLocalData: 15,
    AppCache: 16,
    AppLog: 17,
    Desktop: 18,
    Executable: 19,
    Font: 20,
    Home: 21,
    Runtime: 22,
    Template: 23,
};

export async function readDir() {
    return [];
}
export async function exists() {
    return false;
}
export async function readTextFile() {
    return '{}';
}
export async function readBinaryFile() {
    return new Uint8Array();
}
export async function removeDir() {}
export async function writeTextFile() {}

export const appConfigDir = async () => '/preview/config';
export const appCacheDir = async () => '/preview/cache';
export const appLogDir = async () => '/preview/logs';
export const join = async (...parts) => parts.join('/');

export const open = async (target) => {
    // shell.open(url) 与 dialog.open(options) 共用同一个导出：
    // 字符串当作 URL 打开，对象当作文件选择框（预览模式下直接返回 null）。
    if (typeof target === 'string') {
        globalThis.open?.(target, '_blank');
        return;
    }
    console.info('[mock] dialog.open', target);
    return null;
};
export const save = async (options) => {
    console.info('[mock] dialog.save', options);
    return null;
};
export const convertFileSrc = (path) => path;

export const writeText = async (text) => {
    try {
        await globalThis.navigator?.clipboard?.writeText(text);
    } catch (error) {
        console.info('[mock] clipboard.writeText', text);
    }
};

export const sendNotification = async (options) => {
    console.info('[mock] notification', options);
};

export const isRegistered = async () => false;
export const register = async () => {};
export const unregister = async () => {};

export const checkUpdate = async () => ({ shouldUpdate: false, manifest: null });
export const installUpdate = async () => {};
export const relaunch = async () => {};

export const info = console.info;
export const warn = console.warn;
export const error = console.error;
export const debug = console.debug;

// 预览用的历史记录假数据（仅 mock 生效）
const now = Date.now();
const MOCK_HISTORY = [
    {
        id: 4,
        text: 'The quick brown fox jumps over the lazy dog, and then it keeps running through the forest until the sun goes down behind the mountains, leaving a long shadow across the valley.',
        result: '敏捷的棕色狐狸跳过了懒狗，然后它继续穿过森林奔跑，直到太阳落到山后，在山谷里留下一道长长的影子。',
        source: 'en',
        target: 'zh_cn',
        service: 'plugin.cn.hymt2.translate',
        timestamp: now - 45 * 1000,
    },
    {
        id: 3,
        text: 'Hello',
        result: '你好',
        source: 'en',
        target: 'zh_cn',
        service: 'bing',
        timestamp: now - 6 * 60 * 1000,
    },
    {
        id: 2,
        text: '摘要：本文提出了一种面向异构算力集群的任务调度方法，通过引入分层的资源画像与动态权重分配，在保证尾延迟的同时把集群整体吞吐提升了 18.6%。实验在 512 卡规模的测试床完成。',
        result: 'Abstract: This paper proposes a task scheduling method for heterogeneous computing clusters, which improves overall throughput by 18.6% while keeping tail latency bounded by introducing hierarchical resource profiling and dynamic weight allocation. Experiments were conducted on a 512-GPU testbed.',
        source: 'zh_cn',
        target: 'en',
        service: 'plugin.cn.hymt2.translate',
        timestamp: now - 3 * 60 * 60 * 1000,
    },
    {
        id: 1,
        text: 'load balancer',
        result: '负载均衡器',
        source: 'en',
        target: 'zh_cn',
        service: 'deepl',
        timestamp: now - 30 * 60 * 60 * 1000,
    },
];

export default class Database {
    static async load() {
        return new Database();
    }
    async execute() {
        return { rowsAffected: 0, lastInsertId: 0 };
    }
    async select(sql) {
        // 历史面板/历史记录页需要真实数据才能看到效果
        if (/from\s+history/i.test(String(sql || ''))) {
            if (globalThis.__POT_MOCK_HISTORY_FAIL) {
                throw new Error('mock: history db unavailable');
            }
            return MOCK_HISTORY;
        }
        return [];
    }
    async close() {}
}

export async function watch() {
    return () => {};
}

export const enable = async () => {};
export const disable = async () => {};
export const isEnabled = async () => false;
