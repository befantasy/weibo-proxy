require('dotenv').config();
const AUTH_TOKEN = process.env.AUTH_TOKEN || 'weibo-proxy';
const express = require('express');
const cors = require('cors');
const fs = require('fs-extra');
const path = require('path');
const { chromium } = require('playwright');
const app = express();
const PORT = process.env.PORT || 3000;

function logWithFlush(...args) {
    console.log(...args);
    if (process.stdout.write) process.stdout.write('');
}

function logErrorWithFlush(...args) {
    console.error(...args);
    if (process.stderr.write) process.stderr.write('');
}

// ====== 常量 ======
const DATA_DIR = path.join(__dirname, 'data');
const SESSION_FILE = path.join(DATA_DIR, 'session.json');
fs.ensureDirSync(DATA_DIR);

// ========================= 请求队列管理器 =========================
class RequestQueue {
    constructor() {
        this.queue = [];
        this.processing = false;
        this.currentOperation = null;
    }

    enqueue(operation, operationName = 'unknown') {
        return new Promise((resolve, reject) => {
            const task = {
                operation,
                operationName,
                resolve,
                reject,
                timestamp: Date.now()
            };
            this.queue.push(task);
            logWithFlush(`[队列] 任务入队: ${operationName} (队列长度: ${this.queue.length})`);
            // 启动处理（如果未在运行）
            this.processQueue().catch(err => {
                // processQueue 内部错误不应该导致未处理 rejection 泄出
                logErrorWithFlush('[队列] 处理循环错误:', err && err.message ? err.message : err);
            });
        });
    }

    async processQueue() {
        if (this.processing) return;
        this.processing = true;
        try {
            while (this.queue.length > 0) {
                const task = this.queue.shift();
                this.currentOperation = task.operationName;
                const waitMs = Date.now() - task.timestamp;
                logWithFlush(`[队列] 开始执行: ${task.operationName} (等待: ${waitMs}ms, 剩余: ${this.queue.length})`);
                try {
                    const result = await task.operation();
                    task.resolve(result);
                    logWithFlush(`[队列] 执行成功: ${task.operationName}`);
                } catch (err) {
                    // 不让单个任务的失败中断队列
                    try { task.reject(err); } catch(e){}
                    logErrorWithFlush(`[队列] 执行失败: ${task.operationName}`, err && err.message ? err.message : err);
                } finally {
                    this.currentOperation = null;
                }
            }
        } finally {
            this.processing = false;
        }
    }

    getStatus() {
        return {
            queueLength: this.queue.length,
            processing: this.processing,
            currentOperation: this.currentOperation
        };
    }
}

const requestQueue = new RequestQueue();

// ========================= 浏览器资源管理器 =========================
class BrowserManager {
    constructor() {
        this.browser = null;
        this.context = null;
        this.loginPage = null; // 当前用于扫码登录的 page
        this.lastActivity = Date.now();
        this.idleTimeout = 5 * 60 * 1000; // 5 分钟
        this.cleanupInterval = null;
        this.autoSaveInterval = null;
        this.isInitializing = false;
        this.lastCleanupRun = Date.now();
    }

    async init() {
        // 防止并发初始化
        if (this.isInitializing) {
            logWithFlush('[浏览器] 初始化中，等待完成...');
            while (this.isInitializing) {
                await new Promise(r => setTimeout(r, 100));
            }
            return { browser: this.browser, context: this.context };
        }

        if (this.browser && this.context) {
            this.updateActivity();
            return { browser: this.browser, context: this.context };
        }

        this.isInitializing = true;
        try {
            if (!this.browser) {
                logWithFlush('[浏览器] 启动浏览器进程...');
                this.browser = await chromium.launch({
                    headless: true,
                    args: [
                        '--no-sandbox',
                        '--disable-setuid-sandbox',
                        '--disable-dev-shm-usage',
                        '--disable-gpu',
                        '--disable-extensions',
                        '--disable-infobars',
                        '--no-zygote',
                    ],
                });
            }

            if (this.context && !this.browser.isConnected()) {
                await this.context.close().catch(() => {});
                this.context = null;
            }

            if (!this.context) {
                logWithFlush('[浏览器] 创建浏览器上下文...');
                const sessionData = await this._safeLoadSession();
                const contextOptions = {
                    userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
                };
                if (sessionData) {
                    contextOptions.storageState = sessionData;
                }
                this.context = await this.browser.newContext(contextOptions);
            }

            this.updateActivity();
            this.startCleanupTimer();
            this.startAutoSaveTimer();
            return { browser: this.browser, context: this.context };
        } finally {
            this.isInitializing = false;
        }
    }

    updateActivity() {
        this.lastActivity = Date.now();
    }

    async _safeLoadSession() {
        try {
            if (await fs.pathExists(SESSION_FILE)) {
                const sessionData = await fs.readJson(SESSION_FILE);
                logWithFlush('[会话] 会话已加载');
                return sessionData;
            }
        } catch (error) {
            logErrorWithFlush('[会话] 加载会话失败:', error && error.message ? error.message : error);
        }
        return null;
    }

    async newPage() {
        await this.init();
        if (!this.context) throw new Error('Browser context not available');
        this.updateActivity();
        const page = await this.context.newPage();
        return page;
    }

    isContextAlive() {
        return !!(this.context && this.browser && this.browser.isConnected());
    }

    async cleanupContext() {
        if (this.loginPage && !this.loginPage.isClosed()) {
            try { await this.loginPage.close(); } catch (e){}
            this.loginPage = null;
        }
        if (this.context) {
            logWithFlush('[清理] 关闭浏览器上下文...');
            await this.context.close().catch(() => {});
            this.context = null;
            logWithFlush('[清理] 浏览器上下文已关闭');
        }
    }

    startCleanupTimer() {
        if (this.cleanupInterval) return;
        this.cleanupInterval = setInterval(async () => {
            try {
                // 防止 resume 导致的突发触发：如果上次运行时间间隔超过 10 分钟，视为 resume，跳过这次清理
                const now = Date.now();
                if (now - this.lastCleanupRun > 10 * 60 * 1000) {
                    logWithFlush('[清理] 检测到可能的 resume，跳过本次清理以避免误杀上下文');
                    this.lastCleanupRun = now;
                    return;
                }
                this.lastCleanupRun = now;

                const idleTime = Date.now() - this.lastActivity;
                if (idleTime > this.idleTimeout && this.context && !requestQueue.processing) {
                    logWithFlush('[清理] 长时间无活动，关闭浏览器上下文');
                    await this.cleanupContext();
                }
            } catch (err) {
                logErrorWithFlush('[清理] 定时器错误:', err && err.message ? err.message : err);
            }
        }, 60 * 1000);
    }

    startAutoSaveTimer() {
        if (this.autoSaveInterval) return;
        this.autoSaveInterval = setInterval(async () => {
            try {
                await this.saveSessionNow();
            } catch (e) {
                logErrorWithFlush('[会话] 自动保存失败:', e && e.message ? e.message : e);
            }
        }, 60 * 1000); // 每分钟尝试自动保存（仅在登录且 context 存在时）
    }

    async cleanup(closeBrowser = true) {
        if (this.cleanupInterval) {
            clearInterval(this.cleanupInterval);
            this.cleanupInterval = null;
        }
        if (this.autoSaveInterval) {
            clearInterval(this.autoSaveInterval);
            this.autoSaveInterval = null;
        }

        await this.cleanupContext();

        if (closeBrowser && this.browser) {
            await this.browser.close().catch(() => {});
            this.browser = null;
            logWithFlush('[清理] 浏览器进程已关闭');
        }
    }

    // 保证在 context 存活且已登录时才保存
    async saveSessionNow() {
        try {
            if (!this.isContextAlive()) {
                return false;
            }
            // 由外部决定是否 shouldSave（比如 isLoggedIn）
            const sessionData = await this.context.storageState();
            if (sessionData) {
                await fs.writeJson(SESSION_FILE, sessionData, { spaces: 2 });
                logWithFlush('[会话] 会话已保存');
                return true;
            }
        } catch (error) {
            if (!error || !String(error.message).includes('closed')) {
                logErrorWithFlush('[会话] 立即保存失败:', error && error.message ? error.message : error);
            }
            return false;
        }
        return false;
    }
}

const browserManager = new BrowserManager();

// ========================= 应用配置 =========================
app.use(cors());
app.use(express.json({ limit: '100kb' })); // 增大一点儿限制

app.use('/api', (req, res, next) => {
    if (req.method !== 'GET' && req.get('Content-Type')?.includes('application/json') && req.body === undefined) {
        return res.status(400).json({ error: '请求体JSON格式错误' });
    }
    next();
});

app.use('/api', (req, res, next) => {
    const queueStatus = requestQueue.getStatus();
    logWithFlush(`[请求] ${req.method} ${req.path} (队列: ${queueStatus.queueLength}, 处理中: ${queueStatus.currentOperation || '无'})`);
    next();
});

app.use(express.static('public'));

function authenticateToken(req, res, next) {
    const authHeader = req.headers['authorization'];
    let token = null;
    if (authHeader) {
        const parts = authHeader.split(' ');
        token = parts.length > 1 ? parts[1] : parts[0];
    }
    if (!token || token !== AUTH_TOKEN) {
        return res.status(401).json({ error: '未经授权：Token 无效或缺失' });
    }
    next();
}

app.use('/api', authenticateToken);

// 全局登录状态（由登录检查更新）
let isLoggedIn = false;
let lastActivityTime = Date.now();

// ========================= 核心功能函数 =========================
async function checkLoginStatus() {
    // 只用较少重试，避免长时间阻塞
    const maxRetries = 2;
    let lastError = null;

    for (let i = 0; i < maxRetries; i++) {
        let page = null;
        try {
            logWithFlush(`[登录检查] 尝试 ${i + 1}/${maxRetries}`);
            page = await browserManager.newPage();
            browserManager.updateActivity();

            // 更鲁棒的选择器：尝试多种可能的发布框存在方式
            await page.goto('https://weibo.com', { waitUntil: 'domcontentloaded', timeout: 25000 });
            // 等待几种可能的编辑框或用户头像等指示登录的元素
            const loginSelectors = [
                'textarea[placeholder*="想分享"]',
                'textarea[placeholder*="有什么新鲜事"]',
                'div[role="textbox"]', // 有时是 div
                'a[title="登录"]', // 如果看到登录链接，说明未登录
                'div.personal_info' // 示例回退
            ];
            let found = false;
            for (const sel of loginSelectors) {
                try {
                    const handle = await page.$(sel);
                    if (handle) {
                        // 如果是登陆链接，说明未登录
                        const text = await handle.textContent().catch(()=>'');
                        if (/登录|Sign in/i.test(text)) {
                            found = false;
                            break;
                        }
                        // 发现可能的发布框，判定为已登录
                        found = true;
                        break;
                    }
                } catch (e) {}
            }

            if (found) {
                isLoggedIn = true;
                lastActivityTime = Date.now();
                logWithFlush('[登录检查] ✅ 用户已登录');
                // 保存一次 session（若可用）
                await browserManager.saveSessionNow();
                await page.close().catch(()=>{});
                return true;
            } else {
                isLoggedIn = false;
                logWithFlush('[登录检查] ❌ 用户未登录');
                await page.close().catch(()=>{});
                return false;
            }
        } catch (error) {
            lastError = error;
            logErrorWithFlush(`[登录检查] 失败 (尝试 ${i + 1}):`, error && error.message ? error.message : error);
            if (page) {
                try { await page.close(); } catch(e){}
            }
            if (i < maxRetries - 1) {
                await new Promise(r => setTimeout(r, 1500));
            }
        }
    }

    isLoggedIn = false;
    throw lastError || new Error('检查登录状态失败');
}

async function getQRCode() {
    const maxRetries = 2;
    let lastError = null;

    for (let i = 0; i < maxRetries; i++) {
        try {
            logWithFlush(`[二维码] 尝试 ${i + 1}/${maxRetries}`);
            const page = await browserManager.newPage();
            browserManager.updateActivity();

            // 关闭旧的 loginPage（由 manager 管理）
            if (browserManager.loginPage && !browserManager.loginPage.isClosed()) {
                try { await browserManager.loginPage.close(); } catch (e) {}
                browserManager.loginPage = null;
            }

            const url = 'https://passport.weibo.com/sso/signin?entry=miniblog&source=miniblog';
            const loginPage = await browserManager.context.newPage();
            browserManager.loginPage = loginPage;

            await loginPage.goto(url, { waitUntil: 'domcontentloaded', timeout: 25000 });
            // 多种可能的二维码 selector（更鲁棒）
            const qrSelectors = [
                'img[src*="qr.weibo.cn"]',
                'img[src*="qrcode"]',
                'img[class*="qr"]'
            ];
            let qrCodeUrl = null;
            for (const sel of qrSelectors) {
                try {
                    const el = await loginPage.$(sel);
                    if (el) {
                        qrCodeUrl = await el.getAttribute('src').catch(()=>null);
                        if (qrCodeUrl) break;
                    }
                } catch (e) {}
            }

            if (qrCodeUrl) {
                logWithFlush('[二维码] ✅ 成功获取二维码');
                return qrCodeUrl;
            } else {
                throw new Error('未找到二维码元素');
            }
        } catch (error) {
            lastError = error;
            logErrorWithFlush(`[二维码] 失败 (尝试 ${i + 1}):`, error && error.message ? error.message : error);
            if (i < maxRetries - 1) {
                await new Promise(r => setTimeout(r, 2000));
            }
        }
    }

    throw lastError || new Error('获取二维码失败');
}

async function checkScanStatus() {
    try {
        if (isLoggedIn) {
            return { status: 'success', message: '登录成功（已缓存）' };
        }

        const page = browserManager.loginPage;
        if (!page || page.isClosed()) {
            return { status: 'waiting', message: '页面已关闭或不存在，可能需要重新获取二维码' };
        }

        browserManager.updateActivity();
        try {
            await page.waitForLoadState('domcontentloaded', { timeout: 3000 }).catch(()=>{});
        } catch (e) {}

        let currentUrl = '';
        try {
            currentUrl = await page.url();
        } catch (e) {
            // page 可能已被关闭或转移
            logErrorWithFlush('[扫码状态] 读取 URL 失败:', e && e.message ? e.message : e);
            return { status: 'waiting', message: '页面未就绪，稍后重试' };
        }

        if (currentUrl.includes('weibo.com') && !currentUrl.includes('passport')) {
            isLoggedIn = true;
            lastActivityTime = Date.now();
            logWithFlush('[扫码状态] ✅ 用户扫码登录成功！');
            await browserManager.saveSessionNow();
            try { await page.close(); } catch(e){}
            browserManager.loginPage = null;
            return { status: 'success', message: '登录成功' };
        }

        // 检查错误区、过期文字等
        try {
            const errorElement = await page.$('.txt_red').catch(()=>null);
            if (errorElement) {
                const errorText = await errorElement.textContent().catch(()=>'');
                return { status: 'error', message: errorText || '二维码登录错误' };
            }
            const expiredElement = await page.$('text=二维码已失效').catch(()=>null);
            if (expiredElement) {
                try { await page.close(); } catch(e){}
                browserManager.loginPage = null;
                return { status: 'error', message: '二维码已过期，请刷新' };
            }

            const statusElements = await page.$$('.txt').catch(()=>[]);
            let statusMessage = '等待扫码';
            for (const element of statusElements) {
                const text = await element.textContent().catch(()=>'');
                if (text.includes('扫描成功') || text.includes('请确认')) {
                    statusMessage = '扫描成功，请在手机上确认登录';
                    break;
                }
            }
            return { status: 'waiting', message: statusMessage };
        } catch (err) {
            logErrorWithFlush('[扫码状态] 解析失败:', err && err.message ? err.message : err);
            return { status: 'waiting', message: '检查状态失败，稍后重试' };
        }
    } catch (error) {
        logErrorWithFlush('[扫码状态] 失败:', error && error.message ? error.message : error);
        return { status: 'error', message: '检查状态失败: ' + (error && error.message ? error.message : error) };
    }
}

async function postWeibo(content) {
    const maxRetries = 2;
    let lastError = null;

    for (let i = 0; i < maxRetries; i++) {
        let page = null;
        try {
            logWithFlush(`[发送微博] 尝试 ${i + 1}/${maxRetries}`);
            if (!isLoggedIn) throw new Error('用户未登录');

            page = await browserManager.newPage();
            browserManager.updateActivity();

            await page.goto('https://weibo.com', { waitUntil: 'domcontentloaded', timeout: 25000 });

            // 更鲁棒地寻找编辑框，尝试多种 selector
            const fillSelectors = [
                'textarea[placeholder*="想分享"]',
                'textarea[placeholder*="有什么新鲜事"]',
                'div[role="textbox"]'
            ];
            let filled = false;
            for (const sel of fillSelectors) {
                try {
                    const el = await page.$(sel);
                    if (el) {
                        // 若是 contenteditable 的 div，使用 evaluate 设置 innerText
                        const tag = await el.evaluate((e) => e.tagName.toLowerCase());
                        if (tag === 'div') {
                            await el.focus();
                            await el.evaluate((el, text) => { el.innerText = text; }, content);
                        } else {
                            await el.fill(content);
                        }
                        filled = true;
                        break;
                    }
                } catch (e) {}
            }
            if (!filled) {
                throw new Error('未找到编辑框，可能未登录或页面结构变化');
            }

            // 等待发送按钮
            // 先尝试常见的文字或 aria label
            const buttonSelectors = [
                'button:has-text("发送"):not([disabled])',
                'button:has-text("发布"):not([disabled])',
                'button[aria-label="发送"]',
                'button[class*="send"]'
            ];

            let clicked = false;
            for (const sel of buttonSelectors) {
                try {
                    const btn = await page.$(sel);
                    if (btn) {
                        const [response] = await Promise.all([
                            page.waitForResponse(res => res.url().includes('/ajax/statuses/update') && [200,201].includes(res.status()), { timeout: 15000 }).catch(()=>null),
                            btn.click().catch(()=>null),
                        ]);
                        // 如果 response 存在并且 ok，认为成功
                        if (response) {
                            const json = await response.json().catch(()=>null);
                            if (json && (json.ok === 1 || json.result === 1 || json.code === 200)) {
                                lastActivityTime = Date.now();
                                logWithFlush('[发送微博] ✅ 发送成功!');
                                await browserManager.saveSessionNow();
                                return {
                                    success: true,
                                    message: '微博发送成功',
                                    weiboId: json.data?.idstr,
                                    content: json.data?.text_raw || content
                                };
                            } else {
                                // 有响应，但返回不一定是 ok
                                lastError = new Error(`接口返回失败: ${json && json.msg ? json.msg : JSON.stringify(json)}`);
                            }
                        } else {
                            // 没有捕获到 response，也认为这次点击可能触发了发送（但不确定）
                            // 继续尝试其它按钮或重试
                            lastError = new Error('点击发送按钮未捕获到更新请求');
                        }
                        clicked = true;
                        break;
                    }
                } catch (e) {}
            }

            if (!clicked) {
                throw new Error('找不到发送按钮');
            }

            // 如果到这里仍未返回成功，则抛出之前收集的错误
            throw lastError || new Error('发送微博失败（未知原因）');
        } catch (error) {
            lastError = error;
            logErrorWithFlush(`[发送微博] 失败 (尝试 ${i + 1}):`, error && error.message ? error.message : error);
            if (page) {
                try { await page.close(); } catch(e){}
            }
            if (i < maxRetries - 1) {
                await new Promise(r => setTimeout(r, 2500));
            }
        }
    }

    throw lastError || new Error('发送微博失败');
}

// ========================= API 路由（使用队列） =========================
app.get('/api/status', async (req, res) => {
    try {
        const loginStatus = await requestQueue.enqueue(() => checkLoginStatus(), 'checkLoginStatus');
        res.json({ isLoggedIn: loginStatus });
    } catch (error) {
        logErrorWithFlush('[API] 状态检查错误:', error && error.message ? error.message : error);
        res.status(500).json({ error: error && error.message ? error.message : String(error) });
    }
});

app.get('/api/qrcode', async (req, res) => {
    try {
        const qrCodeUrl = await requestQueue.enqueue(() => getQRCode(), 'getQRCode');
        res.json({ qrCodeUrl });
    } catch (error) {
        logErrorWithFlush('[API] 二维码错误:', error && error.message ? error.message : error);
        res.status(500).json({ error: error && error.message ? error.message : String(error) });
    }
});

app.get('/api/scan-status', async (req, res) => {
    try {
        const status = await requestQueue.enqueue(() => checkScanStatus(), 'checkScanStatus');
        res.json(status);
    } catch (error) {
        logErrorWithFlush('[API] 扫码状态错误:', error && error.message ? error.message : error);
        res.status(500).json({ error: error && error.message ? error.message : String(error) });
    }
});

app.post('/api/post', async (req, res) => {
    try {
        const { content } = req.body;
        if (!content || typeof content !== 'string' || content.length > 2000) {
            return res.status(400).json({ error: '内容无效或过长' });
        }
        const result = await requestQueue.enqueue(() => postWeibo(content), 'postWeibo');
        res.json(result);
    } catch (error) {
        logErrorWithFlush('[API] 发送微博错误:', error && error.message ? error.message : error);
        res.status(500).json({ error: error && error.message ? error.message : String(error) });
    }
});

app.post('/api/logout', async (req, res) => {
    try {
        await requestQueue.enqueue(async () => {
            logWithFlush('[API] 收到退出登录请求');
            try {
                if (await fs.pathExists(SESSION_FILE)) {
                    await fs.remove(SESSION_FILE);
                }
            } catch (e) { logErrorWithFlush('[API] 删除会话文件失败:', e && e.message ? e.message : e); }

            isLoggedIn = false;

            if (browserManager.loginPage && !browserManager.loginPage.isClosed()) {
                try { await browserManager.loginPage.close(); } catch (e) {}
                browserManager.loginPage = null;
            }

            await browserManager.cleanup(false);
        }, 'logout');
        res.json({ success: true, message: '退出登录成功' });
    } catch (error) {
        logErrorWithFlush('[API] 退出登录错误:', error && error.message ? error.message : error);
        res.status(500).json({ error: error && error.message ? error.message : String(error) });
    }
});

app.get('/health', (req, res) => {
    const queueStatus = requestQueue.getStatus();
    const healthInfo = {
        status: 'ok',
        timestamp: new Date().toISOString(),
        isLoggedIn: isLoggedIn,
        browserStatus: browserManager.browser ? 'running' : 'stopped',
        contextStatus: browserManager.context ? 'active' : 'closed',
        lastActivity: new Date(lastActivityTime).toISOString(),
        queue: queueStatus
    };
    res.json(healthInfo);
});

app.use((err, req, res, next) => {
    logErrorWithFlush('[错误处理]:', err && err.message ? err.message : err);
    if (err instanceof SyntaxError && err.status === 400 && 'body' in err) {
        return res.status(400).json({ error: '请求体JSON格式错误' });
    }
    res.status(500).json({ error: '服务器内部错误' });
});

// ========================= 优雅关闭 =========================
let shuttingDown = false;
async function gracefulShutdown(signal) {
    if (shuttingDown) return;
    shuttingDown = true;
    logWithFlush(`[关闭] 收到 ${signal} 信号，开始优雅关闭...`);

    // 等待队列完成（最多等待 15 秒）
    const maxWait = 15000;
    const startTime = Date.now();
    while (requestQueue.processing && (Date.now() - startTime) < maxWait) {
        logWithFlush(`[关闭] 等待队列完成: ${requestQueue.getStatus().currentOperation}`);
        await new Promise(resolve => setTimeout(resolve, 500));
    }

    try {
        await browserManager.cleanup(true);
        logWithFlush('[关闭] 资源清理完成');
    } catch (error) {
        logErrorWithFlush('[关闭] 清理错误:', error && error.message ? error.message : error);
    }

    // 强制退出
    process.exit(0);
}

process.on('SIGINT', () => gracefulShutdown('SIGINT'));
process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));

process.on('unhandledRejection', (reason) => {
    logErrorWithFlush('[Promise拒绝]:', reason && reason.message ? reason.message : reason);
    // 不立即退出，交由上面的处理器和队列处理。若严重，则会在 catches 中被处理。
});
process.on('uncaughtException', (err) => {
    logErrorWithFlush('[未捕获异常]:', err && err.message ? err.message : err);
    // 尽量清理后退出
    gracefulShutdown('uncaughtException');
});

app.listen(PORT, () => {
    logWithFlush(`[启动] 🚀 服务器运行在端口 ${PORT}`);
    logWithFlush(`[启动] 🌐 访问: http://localhost:${PORT}`);
    logWithFlush(`[启动] ❤️ 健康检查: http://localhost:${PORT}/health`);
    logWithFlush(`[启动] 🔄 请求队列已启用，自动处理并发冲突`);
});
