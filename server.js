require('dotenv').config();
const AUTH_TOKEN = process.env.AUTH_TOKEN || 'weibo-proxy';
// ========================= Cloudflare KV 配置 =========================
const CF_ACCOUNT_ID = process.env.CLOUDFLARE_ACCOUNT_ID;
const CF_NAMESPACE_ID = process.env.CLOUDFLARE_NAMESPACE_ID;
const CF_API_TOKEN = process.env.CLOUDFLARE_API_TOKEN;
const CF_SESSION_KEY = 'weibo-session';
const USE_CLOUDFLARE_KV = CF_ACCOUNT_ID && CF_NAMESPACE_ID && CF_API_TOKEN;

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

// ========================= Cloudflare KV 操作函数 =========================
async function saveSessionToCloudflare(sessionData) {
    if (!USE_CLOUDFLARE_KV) return false;
    
    try {
        const url = `https://api.cloudflare.com/client/v4/accounts/${CF_ACCOUNT_ID}/storage/kv/namespaces/${CF_NAMESPACE_ID}/values/${CF_SESSION_KEY}`;
        const response = await fetch(url, {
            method: 'PUT',
            headers: {
                'Authorization': `Bearer ${CF_API_TOKEN}`,
                'Content-Type': 'application/json'
            },
            body: JSON.stringify(sessionData)
        });
        
        if (response.ok) {
            logWithFlush('[Cloudflare KV] 会话已保存到云端');
            return true;
        } else {
            const error = await response.text();
            logErrorWithFlush('[Cloudflare KV] 保存失败:', error);
            return false;
        }
    } catch (error) {
        logErrorWithFlush('[Cloudflare KV] 保存异常:', error.message);
        return false;
    }
}

async function loadSessionFromCloudflare() {
    if (!USE_CLOUDFLARE_KV) return null;
    
    try {
        const url = `https://api.cloudflare.com/client/v4/accounts/${CF_ACCOUNT_ID}/storage/kv/namespaces/${CF_NAMESPACE_ID}/values/${CF_SESSION_KEY}`;
        const response = await fetch(url, {
            method: 'GET',
            headers: {
                'Authorization': `Bearer ${CF_API_TOKEN}`
            }
        });
        
        if (response.ok) {
            const sessionData = await response.json();
            logWithFlush('[Cloudflare KV] 会话已从云端加载');
            return sessionData;
        } else if (response.status === 404) {
            logWithFlush('[Cloudflare KV] 云端无会话数据');
            return null;
        } else {
            const error = await response.text();
            logErrorWithFlush('[Cloudflare KV] 加载失败:', error);
            return null;
        }
    } catch (error) {
        logErrorWithFlush('[Cloudflare KV] 加载异常:', error.message);
        return null;
    }
}

async function deleteSessionFromCloudflare() {
    if (!USE_CLOUDFLARE_KV) return false;
    
    try {
        const url = `https://api.cloudflare.com/client/v4/accounts/${CF_ACCOUNT_ID}/storage/kv/namespaces/${CF_NAMESPACE_ID}/values/${CF_SESSION_KEY}`;
        const response = await fetch(url, {
            method: 'DELETE',
            headers: {
                'Authorization': `Bearer ${CF_API_TOKEN}`
            }
        });
        
        if (response.ok) {
            logWithFlush('[Cloudflare KV] 会话已从云端删除');
            return true;
        } else {
            const error = await response.text();
            logErrorWithFlush('[Cloudflare KV] 删除失败:', error);
            return false;
        }
    } catch (error) {
        logErrorWithFlush('[Cloudflare KV] 删除异常:', error.message);
        return false;
    }
}

// ========================= 内存监控 =========================
function logMemoryUsage(context = '') {
    const memUsage = process.memoryUsage();
    const formatMB = (bytes) => Math.round(bytes / 1024 / 1024);
    
    logWithFlush(
        `[内存监控${context ? ' - ' + context : ''}] ` +
        `堆使用: ${formatMB(memUsage.heapUsed)}MB / ${formatMB(memUsage.heapTotal)}MB | ` +
        `RSS: ${formatMB(memUsage.rss)}MB | ` +
        `外部: ${formatMB(memUsage.external)}MB`
    );
    
    // 内存告警
    const heapUsedMB = formatMB(memUsage.heapUsed);
    const rssMB = formatMB(memUsage.rss);
    
    if (rssMB > 400) {
        logErrorWithFlush(`⚠️ [内存告警] RSS内存使用过高: ${rssMB}MB (>400MB)`);
    } else if (rssMB > 350) {
        logWithFlush(`⚠️ [内存警告] RSS内存接近限制: ${rssMB}MB`);
    }
    
    if (heapUsedMB > 300) {
        logErrorWithFlush(`⚠️ [内存告警] 堆内存使用过高: ${heapUsedMB}MB (>300MB)`);
    }
}

function performGC(context = '') {
    if (typeof global.gc === 'function') {
        try {
            const before = process.memoryUsage();
            const beforeHeap = Math.round(before.heapUsed / 1024 / 1024);
            
            logWithFlush(`[GC${context ? ' - ' + context : ''}] 执行垃圾回收...`);
            global.gc();
            
            const after = process.memoryUsage();
            const afterHeap = Math.round(after.heapUsed / 1024 / 1024);
            const freed = beforeHeap - afterHeap;
            
            logWithFlush(`[GC${context ? ' - ' + context : ''}] 完成 - 释放: ${freed}MB (${beforeHeap}MB -> ${afterHeap}MB)`);
        } catch (error) {
            logErrorWithFlush(`[GC${context ? ' - ' + context : ''}] 执行失败:`, error.message);
        }
    } else {
        logWithFlush(`[GC${context ? ' - ' + context : ''}] 跳过 - GC 未启用`);
    }
}

// ========================= 请求队列管理器 =========================
class RequestQueue {
    constructor() {
        this.queue = [];
        this.processing = false;
        this.currentOperation = null;
    }

    async enqueue(operation, operationName = 'unknown') {
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
            
            this.processQueue();
        });
    }

    async processQueue() {
        if (this.processing || this.queue.length === 0) {
            return;
        }

        this.processing = true;
        const task = this.queue.shift();
        this.currentOperation = task.operationName;

        try {
            logWithFlush(`[队列] 开始执行: ${task.operationName} (等待时间: ${Date.now() - task.timestamp}ms)`);
            logMemoryUsage(`执行前 - ${task.operationName}`);
            
            const result = await task.operation();
            task.resolve(result);
            
            logWithFlush(`[队列] 执行成功: ${task.operationName}`);
            logMemoryUsage(`执行后 - ${task.operationName}`);
            
            // 每次操作后主动进行垃圾回收
            performGC(task.operationName);
            
        } catch (error) {
            logErrorWithFlush(`[队列] 执行失败: ${task.operationName}`, error.message);
            task.reject(error);
        } finally {
            this.currentOperation = null;
            this.processing = false;
            
            if (this.queue.length > 0) {
                logWithFlush(`[队列] 继续处理队列 (剩余: ${this.queue.length})`);
                setImmediate(() => this.processQueue());
            }
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
        this.lastActivity = Date.now();
        this.idleTimeout = 2 * 60 * 1000; // 2分钟空闲后关闭
        this.cleanupInterval = null;
        this.isInitializing = false;
    }

    async init() {
        // 防止并发初始化
        if (this.isInitializing) {
            logWithFlush('[浏览器] 正在初始化中，等待完成...');
            while (this.isInitializing) {
                await new Promise(resolve => setTimeout(resolve, 100));
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
                logWithFlush('[浏览器] 启动浏览器...');
                this.browser = await chromium.launch({
                    headless: true,
                    args: [
                        '--no-sandbox',
                        '--disable-setuid-sandbox',
                        '--disable-dev-shm-usage',
                        '--disable-web-security',
                        '--disable-gpu',
                        '--disable-extensions',
                        '--disable-background-timer-throttling',
                        '--disable-backgrounding-occluded-windows',
                        '--disable-renderer-backgrounding',
                        '--max_old_space_size=256',
                        '--disable-features=Translate,BackForwardCache,VizDisplayCompositor',
                        '--js-flags=--max-old-space-size=256',
                    ]
                });
                logWithFlush('[浏览器] 浏览器启动成功');
            }

            if (this.context && this.browser.isConnected()) {
                logWithFlush('[浏览器] 使用现有上下文');
                this.updateActivity();
                this.startCleanupTimer();
                return { browser: this.browser, context: this.context };
            }

            // 清理旧上下文
            if (this.context) {
                await this.context.close().catch(() => {});
                this.context = null;
            }

            logWithFlush('[浏览器] 创建浏览器上下文...');
            const sessionData = await loadSession();
            const contextOptions = {
                userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
            };
            if (sessionData) {
                contextOptions.storageState = sessionData;
                logWithFlush('[浏览器] 加载已保存的会话');
            }
            this.context = await this.browser.newContext(contextOptions);
            logWithFlush('[浏览器] 上下文创建成功');

            this.updateActivity();
            this.startCleanupTimer();
            
            return { browser: this.browser, context: this.context };
        } finally {
            this.isInitializing = false;
        }
    }

    updateActivity() {
        this.lastActivity = Date.now();
    }

    async cleanupContext() {
        if (this.context) {
            logWithFlush('[清理] 关闭浏览器上下文...');
            await this.context.close().catch(() => {});
            this.context = null;
            logWithFlush('[清理] 浏览器上下文已关闭');
        }
    }

    async cleanupBrowser() {
        if (this.browser) {
            logWithFlush('[清理] 关闭浏览器进程...');
            await this.browser.close().catch(() => {});
            this.browser = null;
            logWithFlush('[清理] 浏览器进程已关闭');
        }
    }

    startCleanupTimer() {
        if (this.cleanupInterval) return;
        
        this.cleanupInterval = setInterval(async () => {
            const idleTime = Date.now() - this.lastActivity;
            
            // 如果有任务在处理，不清理
            if (requestQueue.processing) {
                return;
            }

            // 定期记录内存状态
            logMemoryUsage('定期检查');

            // 空闲时关闭浏览器和上下文以释放内存
            if (idleTime > this.idleTimeout && (this.context || this.browser)) {
                logWithFlush(`[清理] 检测到空闲 ${Math.round(idleTime/1000)}s，关闭浏览器释放内存`);
                await this.cleanup(true);
                
                // 手动触发垃圾回收
                performGC('空闲清理');
                logMemoryUsage('清理后');
            }
        }, 30000); // 每30秒检查一次
    }

    async cleanup(closeBrowser = true) {
        if (this.cleanupInterval && closeBrowser) {
            clearInterval(this.cleanupInterval);
            this.cleanupInterval = null;
        }

        await this.cleanupContext();
        
        if (closeBrowser) {
            await this.cleanupBrowser();
        }
    }

    async saveSessionNow() {
        if (this.context && isLoggedIn) {
            try {
                const sessionData = await this.context.storageState();
                
                // 优先保存到 Cloudflare KV
                if (USE_CLOUDFLARE_KV) {
                    await saveSessionToCloudflare(sessionData);
                } else {
                    // 回退到本地文件
                    await fs.writeJson(SESSION_FILE, sessionData);
                    logWithFlush('[会话] 会话已保存');
                }
                return true;
            } catch (error) {
                if (!error.message.includes('closed')) {
                    logErrorWithFlush('[会话] 保存失败:', error.message);
                }
                return false;
            }
        }
        return false;
    }
}

const browserManager = new BrowserManager();

// ========================= 应用配置 =========================
app.use(cors());
app.use(express.json({ limit: '50kb' }));
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
    const token = authHeader && authHeader.split(' ')[1];
    if (!token || token !== AUTH_TOKEN) {
        return res.status(401).json({ error: '未经授权：Token 无效或缺失' });
    }
    next();
}

app.use('/api', authenticateToken);

const DATA_DIR = path.join(__dirname, 'data');
const SESSION_FILE = path.join(DATA_DIR, 'session.json');
fs.ensureDirSync(DATA_DIR);

let browser = null;
let context = null;
let loginPage = null;
let isLoggedIn = false;
let lastActivityTime = Date.now();

// ========================= 核心功能函数 =========================
async function initBrowser() {
    const { browser: br, context: ctx } = await browserManager.init();
    browser = br;
    context = ctx;
}

async function loadSession() {
    try {
        // 优先从 Cloudflare KV 加载
        if (USE_CLOUDFLARE_KV) {
            const sessionData = await loadSessionFromCloudflare();
            if (sessionData) {
                return sessionData;
            }
        }
        
        // 回退到本地文件
        if (await fs.pathExists(SESSION_FILE)) {
            const sessionData = await fs.readJson(SESSION_FILE);
            logWithFlush('[会话] 会话文件已加载');
            return sessionData;
        }
    } catch (error) {
        logWithFlush('[会话] 加载会话失败:', error.message);
    }
    return null;
}

async function checkLoginStatus() {
    const maxRetries = 2;
    let lastError;
    
    for (let i = 0; i < maxRetries; i++) {
        let page = null;
        try {
            logWithFlush(`[登录检查] 检查登录状态 (尝试 ${i + 1}/${maxRetries})`);
            await initBrowser();
            browserManager.updateActivity();
            
            page = await context.newPage();
            await page.goto('https://weibo.com', { waitUntil: 'domcontentloaded', timeout: 20000 });
            
            try {
                await page.waitForSelector('textarea[placeholder="有什么新鲜事想分享给大家？"]', { timeout: 10000 });
                const wasLoggedIn = isLoggedIn;
                isLoggedIn = true;
                lastActivityTime = Date.now();
                logWithFlush('[登录检查] ✅ 用户已登录');
                // 只在登录状态改变时保存会话（从未登录变为已登录）
                if (!wasLoggedIn) {
                    await browserManager.saveSessionNow();
                }
                return true;
            } catch {
                isLoggedIn = false;
                logWithFlush('[登录检查] ❌ 用户未登录');
                return false;
            }
        } catch (error) {
            lastError = error;
            logErrorWithFlush(`[登录检查] 失败 (尝试 ${i + 1}):`, error.message);
            if (i < maxRetries - 1) {
                await new Promise(resolve => setTimeout(resolve, 2000));
            }
        } finally {
            if (page) {
                await page.close().catch(() => {});
            }
        }
    }
    
    isLoggedIn = false;
    throw lastError || new Error('检查登录状态失败');
}

async function getQRCode() {
    const maxRetries = 2;
    let lastError;
    
    for (let i = 0; i < maxRetries; i++) {
        try {
            logWithFlush(`[二维码] 获取二维码 (尝试 ${i + 1}/${maxRetries})`);
            await initBrowser();
            browserManager.updateActivity();
            
            if (loginPage && !loginPage.isClosed()) {
                await loginPage.close();
            }
            
            loginPage = await context.newPage();
            await loginPage.goto('https://passport.weibo.com/sso/signin?entry=miniblog&source=miniblog', {
                waitUntil: 'domcontentloaded', timeout: 20000
            });
            
            await loginPage.waitForSelector('img[src*="qr.weibo.cn"]', { timeout: 10000 });
            const qrCodeUrl = await loginPage.getAttribute('img[src*="qr.weibo.cn"]', 'src');
            
            if (qrCodeUrl) {
                logWithFlush('[二维码] ✅ 二维码获取成功');
                return qrCodeUrl;
            } else {
                throw new Error('未找到二维码');
            }
        } catch (error) {
            lastError = error;
            logErrorWithFlush(`[二维码] 失败 (尝试 ${i + 1}):`, error.message);
            if (loginPage && !loginPage.isClosed()) {
                await loginPage.close().catch(() => {});
                loginPage = null;
            }
            if (i < maxRetries - 1) {
                await new Promise(resolve => setTimeout(resolve, 2000));
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

        if (!loginPage || loginPage.isClosed()) {
            return { status: 'waiting', message: '页面已关闭，请刷新二维码' };
        }

        browserManager.updateActivity();
        await loginPage.waitForLoadState('domcontentloaded', { timeout: 5000 }).catch(() => {});
        const currentUrl = loginPage.url();
        
        if (currentUrl.includes('weibo.com') && !currentUrl.includes('passport')) {
            isLoggedIn = true;
            lastActivityTime = Date.now();
            logWithFlush('[扫码状态] ✅ 用户扫码登录成功！');
            await browserManager.saveSessionNow();
            await loginPage.close().catch(() => {});
            loginPage = null;
            return { status: 'success', message: '登录成功' };
        }

        const errorElement = await loginPage.$('.txt_red').catch(() => null);
        if (errorElement) {
            const errorText = await errorElement.textContent();
            return { status: 'error', message: errorText };
        }

        const expiredElement = await loginPage.$('text=二维码已失效').catch(() => null);
        if (expiredElement) {
            await loginPage.close().catch(() => {});
            loginPage = null;
            return { status: 'error', message: '二维码已过期，请刷新' };
        }

        const statusElements = await loginPage.$$('.txt').catch(() => []);
        let statusMessage = '等待扫码';
        for (const element of statusElements) {
            const text = await element.textContent().catch(() => '');
            if (text.includes('扫描成功') || text.includes('请确认')) {
                statusMessage = '扫描成功，请在手机上确认登录';
                break;
            }
        }
        return { status: 'waiting', message: statusMessage };
    } catch (error) {
        logErrorWithFlush('[扫码状态] 失败:', error.message);
        if (loginPage && !loginPage.isClosed()) {
            await loginPage.close().catch(() => {});
            loginPage = null;
        }
        return { status: 'error', message: '检查状态失败: ' + error.message };
    }
}

async function postWeibo(content) {
    const maxRetries = 2;
    let lastError;
    
    for (let i = 0; i < maxRetries; i++) {
        let page = null;
        try {
            logWithFlush(`[发送微博] 开始发送 (尝试 ${i + 1}/${maxRetries})`);
            
            // 如果未登录，先尝试检查登录状态（可能从 Cloudflare KV 恢复了会话）
            if (!isLoggedIn) {
                logWithFlush('[发送微博] 检测到未登录状态，尝试恢复会话...');
                await checkLoginStatus();
                if (!isLoggedIn) {
                    throw new Error('用户未登录');
                }
            }
            
            await initBrowser();
            browserManager.updateActivity();
            
            page = await context.newPage();
            await page.goto('https://weibo.com', { waitUntil: 'domcontentloaded', timeout: 20000 });
            await page.waitForSelector('textarea[placeholder="有什么新鲜事想分享给大家？"]', { timeout: 10000 });
            await page.fill('textarea[placeholder="有什么新鲜事想分享给大家？"]', content);
            await page.waitForSelector('button:has-text("发送"):not([disabled])', { timeout: 10000 });

            const [response] = await Promise.all([
                page.waitForResponse(res => res.url().includes('/ajax/statuses/update') && res.status() === 200, { timeout: 15000 }),
                page.click('button:has-text("发送")'),
            ]);

            const result = await response.json();
            if (result.ok === 1) {
                lastActivityTime = Date.now();
                logWithFlush('[发送微博] ✅ 发送成功!');
                // 发送成功后保存会话
                await browserManager.saveSessionNow();
                return {
                    success: true, 
                    message: '微博发送成功',
                    weiboId: result.data?.idstr, 
                    content: result.data?.text_raw || content,
                };
            } else {
                throw new Error(`接口返回失败: ${result.msg || '未知错误'}`);
            }
        } catch (error) {
            lastError = error;
            logErrorWithFlush(`[发送微博] 失败 (尝试 ${i + 1}):`, error.message);
            if (i < maxRetries - 1) {
                await new Promise(resolve => setTimeout(resolve, 3000));
            }
        } finally {
            if (page) {
                await page.close().catch(() => {});
            }
        }
    }
    
    throw lastError || new Error('发送微博失败');
}

// ========================= API 路由（使用队列） =========================
app.get('/api/status', async (req, res) => {
    try {
        const loginStatus = await requestQueue.enqueue(
            () => checkLoginStatus(),
            'checkLoginStatus'
        );
        res.json({ isLoggedIn: loginStatus });
    } catch (error) {
        logErrorWithFlush('[API] 状态检查错误:', error);
        res.status(500).json({ error: error.message });
    }
});

app.get('/api/qrcode', async (req, res) => {
    try {
        const qrCodeUrl = await requestQueue.enqueue(
            () => getQRCode(),
            'getQRCode'
        );
        res.json({ qrCodeUrl });
    } catch (error) {
        logErrorWithFlush('[API] 二维码错误:', error);
        res.status(500).json({ error: error.message });
    }
});

app.get('/api/scan-status', async (req, res) => {
    try {
        const status = await requestQueue.enqueue(
            () => checkScanStatus(),
            'checkScanStatus'
        );
        res.json(status);
    } catch (error) {
        logErrorWithFlush('[API] 扫码状态错误:', error);
        res.status(500).json({ error: error.message });
    }
});

app.post('/api/post', async (req, res) => {
    try {
        const { content } = req.body;
        if (!content || typeof content !== 'string' || content.length > 2000) {
            return res.status(400).json({ error: '内容无效或过长' });
        }
        
        const result = await requestQueue.enqueue(
            () => postWeibo(content),
            'postWeibo'
        );
        res.json(result);
    } catch (error) {
        logErrorWithFlush('[API] 发送微博错误:', error.message);
        res.status(500).json({ error: error.message });
    }
});

app.post('/api/logout', async (req, res) => {
    try {
        await requestQueue.enqueue(async () => {
            logWithFlush('[API] 收到退出登录请求');
            
            // 删除 Cloudflare KV 中的会话
            if (USE_CLOUDFLARE_KV) {
                await deleteSessionFromCloudflare();
            }
            
            // 删除本地会话文件
            if (await fs.pathExists(SESSION_FILE)) {
                await fs.remove(SESSION_FILE);
            }
            
            isLoggedIn = false;
            
            if (loginPage && !loginPage.isClosed()) {
                await loginPage.close().catch(() => {});
                loginPage = null;
            }

            // 退出登录时完全关闭浏览器
            await browserManager.cleanup(true);
        }, 'logout');
        
        res.json({ success: true, message: '退出登录成功' });
    } catch (error) {
        logErrorWithFlush('[API] 退出登录错误:', error);
        res.status(500).json({ error: error.message });
    }
});

app.get('/health', (req, res) => {
    const queueStatus = requestQueue.getStatus();
    const memUsage = process.memoryUsage();
    const healthInfo = { 
        status: 'ok', 
        timestamp: new Date().toISOString(),
        isLoggedIn: isLoggedIn,
        browserStatus: browser ? 'running' : 'stopped',
        contextStatus: context ? 'active' : 'closed',
        lastActivity: new Date(lastActivityTime).toISOString(),
        storage: USE_CLOUDFLARE_KV ? 'Cloudflare KV' : 'Local File',
        queue: queueStatus,
        memory: {
            heapUsed: `${Math.round(memUsage.heapUsed / 1024 / 1024)}MB`,
            heapTotal: `${Math.round(memUsage.heapTotal / 1024 / 1024)}MB`,
            rss: `${Math.round(memUsage.rss / 1024 / 1024)}MB`,
            external: `${Math.round(memUsage.external / 1024 / 1024)}MB`
        },
        gc: {
            available: typeof global.gc === 'function'
        }
    };
    
    // 同时在日志中输出
    logMemoryUsage('健康检查');
    
    res.json(healthInfo);
});

// 添加测试端点用于验证内存监控
app.get('/api/test-memory', authenticateToken, (req, res) => {
    logWithFlush('[测试] 手动触发内存监控和GC测试');
    logMemoryUsage('测试 - GC前');
    performGC('手动测试');
    setTimeout(() => {
        logMemoryUsage('测试 - GC后');
        res.json({ 
            success: true, 
            message: '内存监控测试完成，请查看日志',
            gcAvailable: typeof global.gc === 'function'
        });
    }, 100);
});

app.use((err, req, res, next) => {
    logErrorWithFlush('[错误处理]:', err.message);
    if (err instanceof SyntaxError && err.status === 400 && 'body' in err) {
        return res.status(400).json({ error: '请求体JSON格式错误' });
    }
    res.status(500).json({ error: '服务器内部错误' });
});

// ========================= 优雅关闭 =========================
async function gracefulShutdown(signal) {
    logWithFlush(`[关闭] 收到 ${signal} 信号`);
    
    // 等待队列清空（最多等待30秒）
    const maxWait = 30000;
    const startTime = Date.now();
    while (requestQueue.processing && (Date.now() - startTime) < maxWait) {
        logWithFlush(`[关闭] 等待队列完成: ${requestQueue.getStatus().currentOperation}`);
        await new Promise(resolve => setTimeout(resolve, 1000));
    }
    
    try {
        await browserManager.cleanup(true);
        logWithFlush('[关闭] 资源清理完成');
    } catch (error) {
        logErrorWithFlush('[关闭] 清理错误:', error.message);
    }
    process.exit(0);
}

process.on('SIGINT', () => gracefulShutdown('SIGINT'));
process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));

process.on('unhandledRejection', (reason) => {
    logErrorWithFlush('[Promise拒绝]:', reason);
});

app.listen(PORT, () => {
    logWithFlush(`[启动] 🚀 服务器运行在端口 ${PORT}`);
    logWithFlush(`[启动] 🌐 访问: http://localhost:${PORT}`);
    logWithFlush(`[启动] ❤️ 健康检查: http://localhost:${PORT}/health`);
    logWithFlush(`[启动] 🔄 请求队列已启用，自动处理并发冲突`);
    logWithFlush(`[启动] 💾 内存优化模式：空闲2分钟后自动关闭浏览器`);
    
    // 显示存储模式
    if (USE_CLOUDFLARE_KV) {
        logWithFlush(`[启动] ☁️ 会话存储: Cloudflare KV (云端持久化)`);
    } else {
        logWithFlush(`[启动] 📁 会话存储: 本地文件 (容器重启后丢失)`);
        logWithFlush(`[启动] ⚠️ 提示: 配置 Cloudflare KV 环境变量以启用云端持久化`);
    }
    
    // 检查 GC 是否可用
    const gcAvailable = typeof global.gc === 'function';
    logWithFlush(`[启动] 🧹 垃圾回收 GC: ${gcAvailable ? '✅ 已启用 (每次操作后自动清理)' : '❌ 未启用 (需要 --expose-gc 参数)'}`);
    
    if (!gcAvailable) {
        logWithFlush(`[启动] ⚠️ 提示: 请在启动命令中添加 --expose-gc 参数以启用手动垃圾回收`);
    }
    
    // 启动时记录初始内存状态
    setTimeout(() => {
        logMemoryUsage('启动完成');
    }, 1000);
});
