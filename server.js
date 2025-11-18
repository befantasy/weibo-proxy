require('dotenv').config();
const AUTH_TOKEN = process.env.AUTH_TOKEN || 'weibo-proxy';
const express = require('express');
const cors = require('cors');
const fs = require('fs-extra');
const path = require('path');
const { chromium } = require('playwright');
const { exec } = require('child_process'); // 引入用于执行 ps 命令的模块
const app = express();
const PORT = process.env.PORT || 3000;

// ========================= 日志与工具函数 =========================

function logWithFlush(...args) {
    const timestamp = new Date().toISOString().split('T')[1].split('.')[0];
    console.log(`[${timestamp}]`, ...args);
}

function logErrorWithFlush(...args) {
    const timestamp = new Date().toISOString().split('T')[1].split('.')[0];
    console.error(`[${timestamp}]`, ...args);
}

// ========================= 增强版真实内存监控 (每60秒) =========================
setInterval(() => {
    // 1. 获取 Node.js 自身内存 (RSS: 驻留集大小，即物理内存)
    const nodeMem = process.memoryUsage();
    const nodeRssMB = (nodeMem.rss / 1024 / 1024).toFixed(2);

    // 2. 通过 Linux ps 命令获取 Chromium 进程组的内存
    // Render/Docker 容器中 process.memoryUsage 无法统计子进程内存
    exec('ps -A -o rss,args', (error, stdout, stderr) => {
        if (error) {
            logErrorWithFlush('[监控] 无法执行 ps 命令:', error.message);
            return;
        }

        let chromeTotalKB = 0;
        let chromeProcessCount = 0;
        
        const lines = stdout.split('\n');
        lines.forEach(line => {
            // 过滤包含 chrome 或 playwright 的进程，但排除 grep 和当前命令
            if ((line.includes('chrome') || line.includes('chromium')) && !line.includes('grep')) {
                const parts = line.trim().split(/\s+/);
                // parts[0] 是 RSS (单位 KB)
                const rss = parseInt(parts[0], 10);
                if (!isNaN(rss)) {
                    chromeTotalKB += rss;
                    chromeProcessCount++;
                }
            }
        });

        const chromeTotalMB = (chromeTotalKB / 1024).toFixed(2);
        // 计算总内存占用 (Node主进程 + Chromium子进程)
        const totalUsageMB = (parseFloat(nodeRssMB) + parseFloat(chromeTotalMB)).toFixed(2);

        const statusIcon = browserManager.browser ? '🟢' : '⚫';
        const browserState = browserManager.browser ? '运行中' : '已停止';
        
        // 打印综合报告
        logWithFlush(
            `[内存监控] 总占用: ${totalUsageMB}MB | ` +
            `Node: ${nodeRssMB}MB | ` +
            `Chromium: ${chromeTotalMB}MB (${chromeProcessCount}个进程) | ` +
            `状态: ${statusIcon}${browserState}`
        );
        
        // ⚠️ 预警：Render 免费版限制 512MB，超过 450MB 非常危险
        if (totalUsageMB > 450) {
            logErrorWithFlush(`[⚠️高危预警] 内存即将耗尽 (${totalUsageMB}MB/512MB)，请注意 SIGTERM 风险`);
        }
    });
}, 60000); // 每 60 秒执行一次

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
                    '--disable-dev-shm-usage', // 关键：解决 Docker/Render 内存不足崩溃
                    '--disable-gpu',
                    '--no-first-run',
                    '--no-zygote',
                    '--renderer-process-limit=1', // 关键：严格限制渲染进程数
                    '--disable-extensions',
                    '--disable-audio-output',
                    '--disable-gl-drawing-for-tests',
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
        if (this.processing) return; 
        if (this.queue.length === 0) return;

        this.processing = true;

        try {
            // 1. 任务开始前：确保浏览器启动 (按需启动)
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
                    // 每个任务结束后保存 Session
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

            // 2. 任务结束后：立即销毁浏览器 (用完即焚)
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

// 中间件：鉴权
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
    const page = await browserManager.context.newPage();
    try {
        logWithFlush('[业务] 访问微博主页验证登录...');
        await page.goto('https://weibo.com', { waitUntil: 'domcontentloaded', timeout: 15000 });
        
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
    await browserManager.closeLoginPage();
    
    const page = await browserManager.context.newPage();
    browserManager.loginPage = page; 

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
        
        const btnSelector = 'button:has-text("发送"):not([disabled])';
        await page.waitForSelector(btnSelector, { timeout: 5000 });

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

app.post('/api/logout', async (req, res) => {
    try {
        await requestQueue.enqueue(async () => {
            logWithFlush('[API] 退出登录');
            if (await fs.pathExists(SESSION_FILE)) {
                await fs.remove(SESSION_FILE);
            }
            browserManager.setLoggedIn(false);
        }, 'logout');
        res.json({ success: true });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

app.get('/health', (req, res) => {
    res.json({
        status: 'ok',
        timestamp: new Date().toISOString(),
        queue: requestQueue.getStatus(),
        isLoggedIn: browserManager.isLoggedIn
    });
});

// ========================= 启动与关闭 =========================

async function gracefulShutdown(signal) {
    logWithFlush(`[关闭] 收到 ${signal}，正在停止服务...`);
    
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
    logWithFlush(`[启动] 内存保护模式: 开启 (按需启动/销毁浏览器)`);
});
