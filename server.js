require('dotenv').config();
const AUTH_TOKEN = process.env.AUTH_TOKEN || 'weibo-proxy';
const express = require('express');
const cors = require('cors');
const fs = require('fs-extra');
const path = require('path');
const { chromium } = require('playwright');
const os = require('os'); // 引入OS模块用于监控
const app = express();
const PORT = process.env.PORT || 3000;

// ========================= 日志与监控 =========================

function logWithFlush(...args) {
    const timestamp = new Date().toISOString().split('T')[1].split('.')[0];
    console.log(`[${timestamp}]`, ...args);
}

function logErrorWithFlush(...args) {
    const timestamp = new Date().toISOString().split('T')[1].split('.')[0];
    console.error(`[${timestamp}]`, ...args);
}

// 后台内存监控（仅在控制台显示，不在接口返回）
setInterval(() => {
    const mem = process.memoryUsage();
    const freeMemOS = os.freemem() / 1024 / 1024;
    const totalMemOS = os.totalmem() / 1024 / 1024;
    
    // 这里的 RSS 是 Node 进程的总物理内存占用
    // 在 Render 容器中，如果 RSS 接近 512MB 就会被杀
    const rssMB = (mem.rss / 1024 / 1024).toFixed(2);
    const heapUsedMB = (mem.heapUsed / 1024 / 1024).toFixed(2);
    
    logWithFlush(`[系统监控] Node内存: RSS=${rssMB}MB Heap=${heapUsedMB}MB | 浏览器: ${browserManager.browser ? '🟢运行中' : '⚫已停止'} | 队列: ${requestQueue.queue.length}`);
}, 15000); // 每15秒打印一次

// ========================= 浏览器资源管理器 =========================
class BrowserManager {
    constructor() {
        this.browser = null;
        this.context = null;
        this.loginPage = null;
        this.isLoggedIn = false;
        this.isInitializing = false;
    }

    // 初始化浏览器（如果已存在则直接返回）
    async init() {
        if (this.browser && this.context) {
            return;
        }

        // 防止并发初始化
        if (this.isInitializing) {
            logWithFlush('[浏览器] 等待初始化完成...');
            while (this.isInitializing) {
                await new Promise(resolve => setTimeout(resolve, 100));
                if (this.browser) return;
            }
        }

        this.isInitializing = true;
        try {
            logWithFlush('[浏览器] 🚀 启动 Chromium...');
            this.browser = await chromium.launch({
                headless: true,
                args: [
                    '--no-sandbox',
                    '--disable-setuid-sandbox',
                    '--disable-dev-shm-usage', // 关键：解决容器内存不足
                    '--disable-gpu',
                    '--no-first-run',
                    '--no-zygote',
                    '--renderer-process-limit=1', // 关键：限制渲染进程数量
                    '--single-process', // ⚠️ 激进模式：单进程运行（最省内存，但可能不稳定，如果报错请去掉此行）
                    '--disable-extensions',
                    '--disable-audio-output',
                ]
            });

            await this.createContext();
            logWithFlush('[浏览器] 启动完成');
        } catch (e) {
            logErrorWithFlush('[浏览器] 启动失败:', e);
            await this.cleanup(true);
            throw e;
        } finally {
            this.isInitializing = false;
        }
    }

    async createContext() {
        const sessionData = await loadSession();
        const contextOptions = {
            userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
            viewport: { width: 1280, height: 720 },
            deviceScaleFactor: 1,
        };
        
        if (sessionData) {
            contextOptions.storageState = sessionData;
            this.isLoggedIn = true; // 假设加载了session就是登录了，后续会验证
        }

        this.context = await this.browser.newContext(contextOptions);
    }

    async closeLoginPage() {
        if (this.loginPage && !this.loginPage.isClosed()) {
            await this.loginPage.close().catch(() => {});
            this.loginPage = null;
        }
    }

    // 彻底清理资源
    async cleanup(force = false) {
        try {
            if (this.context) {
                await this.context.close().catch(() => {});
                this.context = null;
            }
            if (this.browser) {
                logWithFlush('[浏览器] 🛑 关闭浏览器进程以释放内存');
                await this.browser.close().catch(() => {});
                this.browser = null;
            }
            this.loginPage = null;
            
            // 强制 Node 垃圾回收（如果环境支持）
            if (global.gc) {
                global.gc();
                logWithFlush('[系统] 手动触发垃圾回收');
            }
        } catch (e) {
            logErrorWithFlush('[浏览器] 清理异常:', e.message);
        }
    }

    async saveSessionNow() {
        if (this.context && this.browser && this.browser.isConnected()) {
            try {
                const sessionData = await this.context.storageState();
                await fs.writeJson(SESSION_FILE, sessionData);
                logWithFlush('[会话] Session 已保存到磁盘');
                return true;
            } catch (error) {
                // 忽略关闭时的错误
                if (!error.message.includes('closed') && !error.message.includes('Target')) {
                    logErrorWithFlush('[会话] 保存失败:', error.message);
                }
            }
        }
        return false;
    }

    setLoggedIn(status) {
        this.isLoggedIn = status;
    }
}

const browserManager = new BrowserManager();

// ========================= 请求队列管理器 (核心控制器) =========================
class RequestQueue {
    constructor() {
        this.queue = [];
        this.processing = false;
        this.currentOperation = null;
    }

    async enqueue(operation, operationName = 'unknown') {
        return new Promise((resolve, reject) => {
            this.queue.push({
                operation,
                operationName,
                resolve,
                reject,
                timestamp: Date.now()
            });
            logWithFlush(`[队列] 任务入队: ${operationName} (当前排队: ${this.queue.length})`);
            this.processQueue();
        });
    }

    async processQueue() {
        if (this.processing) return; // 已经在跑了，不重复触发
        if (this.queue.length === 0) return;

        this.processing = true;

        try {
            // 1. 在处理任务前，确保浏览器是活着的
            // 这是"按需启动"的关键
            await browserManager.init();

            while (this.queue.length > 0) {
                const task = this.queue.shift();
                this.currentOperation = task.operationName;

                try {
                    logWithFlush(`[队列] 执行任务: ${task.operationName}`);
                    const result = await task.operation();
                    task.resolve(result);
                    logWithFlush(`[队列] 任务完成: ${task.operationName}`);
                } catch (error) {
                    logErrorWithFlush(`[队列] 任务失败: ${task.operationName}`, error.message);
                    task.reject(error);
                } finally {
                    // 每个任务结束后，尝试保存一次 Session，防止崩溃丢失
                    if (browserManager.isLoggedIn) {
                        await browserManager.saveSessionNow();
                    }
                }
            }
        } catch (error) {
            logErrorWithFlush('[队列] 致命错误:', error);
        } finally {
            this.currentOperation = null;
            this.processing = false;

            // 2. 队列空了，立即销毁浏览器！
            // 这是解决 512MB 内存限制的核心策略
            if (this.queue.length === 0) {
                logWithFlush('[队列] 队列已空，立即执行资源回收...');
                await browserManager.cleanup(true);
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

// ========================= 应用配置 =========================
app.use(cors());
app.use(express.json({ limit: '50kb' }));

// 中间件：简单鉴权
function authenticateToken(req, res, next) {
    const authHeader = req.headers['authorization'];
    const token = authHeader && authHeader.split(' ')[1];
    if (!token || token !== AUTH_TOKEN) {
        return res.status(401).json({ error: '未经授权：Token 无效' });
    }
    next();
}

const DATA_DIR = path.join(__dirname, 'data');
const SESSION_FILE = path.join(DATA_DIR, 'session.json');
fs.ensureDirSync(DATA_DIR);

// ========================= 核心功能函数 =========================

async function loadSession() {
    try {
        if (await fs.pathExists(SESSION_FILE)) {
            return await fs.readJson(SESSION_FILE);
        }
    } catch (error) {
        logErrorWithFlush('[会话] 读取失败:', error.message);
    }
    return null;
}

async function checkLoginStatus() {
    // 注意：此处不需要再调用 browserManager.init()，队列逻辑已保证 Browser 存在
    const page = await browserManager.context.newPage();
    try {
        logWithFlush('[业务] 访问微博主页验证登录...');
        await page.goto('https://weibo.com', { waitUntil: 'domcontentloaded', timeout: 15000 });
        
        // 检查特定元素
        try {
            await page.waitForSelector('textarea[placeholder*="新鲜事"]', { timeout: 8000 });
            browserManager.setLoggedIn(true);
            logWithFlush('[业务] ✅ 登录有效');
            return true;
        } catch {
            browserManager.setLoggedIn(false);
            logWithFlush('[业务] ❌ 未登录');
            return false;
        }
    } finally {
        await page.close().catch(() => {});
    }
}

async function getQRCode() {
    // 确保旧的登录页关闭
    await browserManager.closeLoginPage();
    
    const page = await browserManager.context.newPage();
    browserManager.loginPage = page; // 保存引用以便后续查询状态

    await page.goto('https://passport.weibo.com/sso/signin?entry=miniblog&source=miniblog', {
        waitUntil: 'domcontentloaded', timeout: 15000
    });
    
    try {
        await page.waitForSelector('img[src*="qr.weibo.cn"]', { timeout: 8000 });
        const qrCodeUrl = await page.getAttribute('img[src*="qr.weibo.cn"]', 'src');
        logWithFlush('[业务]二维码获取成功');
        return qrCodeUrl;
    } catch (e) {
        await page.close();
        browserManager.loginPage = null;
        throw new Error('未找到二维码，请重试');
    }
}

async function checkScanStatus() {
    if (browserManager.isLoggedIn) {
        return { status: 'success', message: '已登录' };
    }
    
    if (!browserManager.loginPage || browserManager.loginPage.isClosed()) {
        return { status: 'waiting', message: '二维码页面已失效，请重新获取' };
    }

    const page = browserManager.loginPage;
    const currentUrl = page.url();

    if (currentUrl.includes('weibo.com') && !currentUrl.includes('passport')) {
        browserManager.setLoggedIn(true);
        await browserManager.closeLoginPage();
        return { status: 'success', message: '登录成功' };
    }

    // 简单的文本检测
    const bodyText = await page.evaluate(() => document.body.innerText);
    if (bodyText.includes('扫描成功') || bodyText.includes('请确认')) {
        return { status: 'waiting', message: '扫描成功，请在手机确认' };
    }
    if (bodyText.includes('二维码已失效')) {
        await browserManager.closeLoginPage();
        return { status: 'error', message: '二维码已失效' };
    }

    return { status: 'waiting', message: '等待扫码...' };
}

async function postWeibo(content) {
    if (!browserManager.isLoggedIn) throw new Error('未登录，无法发送');
    
    const page = await browserManager.context.newPage();
    try {
        logWithFlush('[业务] 准备发送微博...');
        await page.goto('https://weibo.com', { waitUntil: 'domcontentloaded' });
        
        const inputSelector = 'textarea[placeholder*="新鲜事"]';
        await page.waitForSelector(inputSelector, { timeout: 10000 });
        await page.fill(inputSelector, content);
        
        // 等待发送按钮变为可用
        const btnSelector = 'button:has-text("发送"):not([disabled])';
        await page.waitForSelector(btnSelector, { timeout: 5000 });

        // 监听网络请求确认成功
        const [response] = await Promise.all([
            page.waitForResponse(res => res.url().includes('/ajax/statuses/update') && res.status() === 200, { timeout: 10000 }),
            page.click(btnSelector)
        ]);

        const result = await response.json();
        if (result.ok === 1) {
            logWithFlush('[业务] ✅ 微博发送成功');
            return { success: true, id: result.data?.idstr };
        } else {
            throw new Error(result.msg || '发送接口返回错误');
        }
    } finally {
        await page.close().catch(() => {});
    }
}

// ========================= API 路由 =========================

app.use('/api', authenticateToken);

app.get('/api/status', async (req, res) => {
    try {
        const status = await requestQueue.enqueue(() => checkLoginStatus(), 'checkStatus');
        res.json({ isLoggedIn: status });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

app.get('/api/qrcode', async (req, res) => {
    try {
        const url = await requestQueue.enqueue(() => getQRCode(), 'getQR');
        res.json({ qrCodeUrl: url });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

app.get('/api/scan-status', async (req, res) => {
    try {
        // 扫码状态检查比较特殊，如果页面没了，可能不需要启动整个浏览器流程
        // 但为了统一管理，我们还是放入队列，依赖浏览器的 Context 状态
        const result = await requestQueue.enqueue(() => checkScanStatus(), 'checkScan');
        res.json(result);
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

app.post('/api/post', async (req, res) => {
    try {
        const { content } = req.body;
        if (!content) return res.status(400).json({ error: '内容不能为空' });
        
        const result = await requestQueue.enqueue(() => postWeibo(content), 'postWeibo');
        res.json(result);
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

// Health Check - 仅返回简单状态，不包含内存数据
app.get('/health', (req, res) => {
    res.json({
        status: 'ok',
        timestamp: new Date().toISOString(),
        queueLength: requestQueue.queue.length,
        processing: requestQueue.processing,
        isLoggedIn: browserManager.isLoggedIn
    });
});

// ========================= 启动与关闭 =========================

async function gracefulShutdown(signal) {
    logWithFlush(`[关闭] 收到 ${signal}，正在停止服务...`);
    
    // 等待当前任务完成
    if (requestQueue.processing) {
        logWithFlush('[关闭] 等待当前任务结束...');
        await new Promise(resolve => setTimeout(resolve, 3000));
    }

    await browserManager.cleanup(true);
    process.exit(0);
}

process.on('SIGINT', () => gracefulShutdown('SIGINT'));
process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));

app.listen(PORT, () => {
    logWithFlush(`[启动] 服务器运行在端口 ${PORT}`);
    logWithFlush(`[启动] 内存保护模式: 开启 (空闲时自动销毁浏览器)`);
});
