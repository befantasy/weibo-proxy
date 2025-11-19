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
            const result = await task.operation();
            task.resolve(result);
            logWithFlush(`[队列] 执行成功: ${task.operationName}`);
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
        this.idleTimeout = 10 * 60 * 1000;
        this.cleanupInterval = null;
        this.autoSaveInterval = null;
        this.isInitializing = false; // 防止重复初始化
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
                        '--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage',
                        '--disable-web-security', '--disable-gpu', '--disable-extensions',
                        '--disable-background-timer-throttling',
                        '--disable-backgrounding-occluded-windows',
                        '--disable-renderer-backgrounding',
                        '--max_old_space_size=256',
                        '--disable-features=Translate,BackForwardCache,VizDisplayCompositor',
                    ]
                });
            }

            if (this.context && !this.browser.isConnected()) {
                await this.context.close().catch(() => {});
                this.context = null;
            }

            if (!this.context) {
                logWithFlush('[浏览器] 创建浏览器上下文...');
                const sessionData = await loadSession();
                const contextOptions = {
                    userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
                };
                if (sessionData) {
                    contextOptions.storageState = sessionData;
                }
                this.context = await this.browser.newContext(contextOptions);
            }

            this.updateActivity();
            this.startCleanupTimer();
            this.startAutoSave();
            
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

    startCleanupTimer() {
        if (this.cleanupInterval) return;
        
        this.cleanupInterval = setInterval(async () => {
            const idleTime = Date.now() - this.lastActivity;
            // 如果有任务在处理，不清理
            if (idleTime > this.idleTimeout && this.context && !requestQueue.processing) {
                logWithFlush('[清理] 检测到长时间无活动，关闭浏览器上下文');
                await this.cleanupContext();
            }
        }, 60000);
    }

    startAutoSave() {
        if (this.autoSaveInterval) return;
        
        this.autoSaveInterval = setInterval(async () => {
            // 只在没有任务处理时保存
            if (this.context && isLoggedIn && !requestQueue.processing) {
                try {
                    logWithFlush('[定期保存] 自动保存登录会话...');
                    const sessionData = await this.context.storageState();
                    await fs.writeJson(SESSION_FILE, sessionData);
                    logWithFlush('[定期保存] 会话保存成功');
                } catch (error) {
                    if (!error.message.includes('closed')) {
                        logErrorWithFlush('[定期保存] 保存失败:', error.message);
                    }
                }
            }
        }, 3 * 60 * 1000);
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

    async saveSessionNow() {
        if (this.context && isLoggedIn) {
            try {
                const sessionData = await this.context.storageState();
                await fs.writeJson(SESSION_FILE, sessionData);
                logWithFlush('[会话] 会话已立即保存');
                return true;
            } catch (error) {
                if (!error.message.includes('closed')) {
                    logErrorWithFlush('[会话] 立即保存失败:', error.message);
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
        if (await fs.pathExists(SESSION_FILE)) {
            const sessionData = await fs.readJson(SESSION_FILE);
            logWithFlush('[会话] 会话已加载');
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
                isLoggedIn = true;
                lastActivityTime = Date.now();
                logWithFlush('[登录检查] ✅ 用户已登录');
                await browserManager.saveSessionNow();
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
            return { status: 'waiting', message: '页面已关闭，正在确认登录状态...' };
        }

        browserManager.updateActivity();
        await loginPage.waitForLoadState('domcontentloaded', { timeout: 5000 }).catch(() => {});
        const currentUrl = loginPage.url();
        
        if (currentUrl.includes('weibo.com') && !currentUrl.includes('passport')) {
            isLoggedIn = true;
            lastActivityTime = Date.now();
            logWithFlush('[扫码状态] ✅ 用户扫码登录成功！');
            await browserManager.saveSessionNow();
            await loginPage.close();
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
            await loginPage.close();
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
            await loginPage.close();
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
            
            if (!isLoggedIn) throw new Error('用户未登录');
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
                await browserManager.saveSessionNow();
                return {
                    success: true, message: '微博发送成功',
                    weiboId: result.data?.idstr, content: result.data?.text_raw || content,
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
            if (await fs.pathExists(SESSION_FILE)) {
                await fs.remove(SESSION_FILE);
            }
            isLoggedIn = false;
            
            if (loginPage && !loginPage.isClosed()) {
                await loginPage.close();
                loginPage = null;
            }

            await browserManager.cleanup(false);
        }, 'logout');
        
        res.json({ success: true, message: '退出登录成功' });
    } catch (error) {
        logErrorWithFlush('[API] 退出登录错误:', error);
        res.status(500).json({ error: error.message });
    }
});

app.get('/health', (req, res) => {
    const queueStatus = requestQueue.getStatus();
    const healthInfo = { 
        status: 'ok', 
        timestamp: new Date().toISOString(),
        isLoggedIn: isLoggedIn,
        browserStatus: browser ? 'running' : 'stopped',
        contextStatus: context ? 'active' : 'closed',
        lastActivity: new Date(lastActivityTime).toISOString(),
        queue: queueStatus
    };
    res.json(healthInfo);
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
});
