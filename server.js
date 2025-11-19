require('dotenv').config();
const AUTH_TOKEN = process.env.AUTH_TOKEN || 'weibo-proxy';
const express = require('express');
const cors = require('cors');
const fs = require('fs-extra');
const path = require('path');
const { chromium } = require('playwright');
const app = express();
const PORT = process.env.PORT || 3000;

// ========================= 工具函数 =========================
function log(...args) {
    console.log(`[${new Date().toISOString()}]`, ...args);
    if (process.stdout.write) process.stdout.write('');
}

function logError(...args) {
    console.error(`[${new Date().toISOString()}]`, ...args);
    if (process.stderr.write) process.stderr.write('');
}

function formatBytes(bytes) {
    return (bytes / 1024 / 1024).toFixed(2) + ' MB';
}

// ========================= 请求队列 =========================
class RequestQueue {
    constructor() {
        this.queue = [];
        this.processing = false;
    }

    async enqueue(operation, operationName = 'unknown') {
        return new Promise((resolve, reject) => {
            const task = { operation, operationName, resolve, reject, timestamp: Date.now() };
            this.queue.push(task);
            log(`[队列] 入队: ${operationName} (队列长度: ${this.queue.length})`);
            this.processQueue();
        });
    }

    async processQueue() {
        if (this.processing || this.queue.length === 0) return;

        this.processing = true;
        const task = this.queue.shift();

        try {
            log(`[队列] 执行: ${task.operationName} (等待: ${Date.now() - task.timestamp}ms)`);
            const result = await task.operation();
            task.resolve(result);
            log(`[队列] 完成: ${task.operationName}`);
        } catch (error) {
            logError(`[队列] 失败: ${task.operationName}`, error.message);
            task.reject(error);
        } finally {
            this.processing = false;
            if (this.queue.length > 0) {
                setImmediate(() => this.processQueue());
            }
        }
    }

    getStatus() {
        return {
            queueLength: this.queue.length,
            processing: this.processing
        };
    }
}

// ========================= 内存监控 =========================
class MemoryMonitor {
    constructor() {
        this.startMonitoring();
    }

    getMemoryInfo() {
        const mem = process.memoryUsage();
        return {
            rss: formatBytes(mem.rss),
            heapTotal: formatBytes(mem.heapTotal),
            heapUsed: formatBytes(mem.heapUsed),
            external: formatBytes(mem.external),
            heapUsedPercent: ((mem.heapUsed / mem.heapTotal) * 100).toFixed(1) + '%',
            timestamp: new Date().toISOString()
        };
    }

    startMonitoring() {
        setInterval(() => {
            const memInfo = this.getMemoryInfo();
            log(`[内存监控] RSS: ${memInfo.rss} | Heap: ${memInfo.heapUsed}/${memInfo.heapTotal} (${memInfo.heapUsedPercent}) | External: ${memInfo.external}`);
            
            // 仅在内存极度紧张时提示，不主动触发GC（避免影响性能）
            const mem = process.memoryUsage();
            if (mem.heapUsed / mem.heapTotal > 0.95) {
                log('[内存监控] ⚠️  内存使用率过高 (>95%)，建议检查内存泄漏');
            }
        }, 60000); // 每分钟
    }
}

// ========================= 浏览器管理器 =========================
class BrowserManager {
    constructor() {
        this.browser = null;
        this.context = null;
    }

    async launch() {
        if (this.browser) return;
        
        log('[浏览器] 启动浏览器进程...');
        this.browser = await chromium.launch({
            headless: true,
            args: [
                '--no-sandbox',
                '--disable-setuid-sandbox',
                '--disable-dev-shm-usage',
                '--disable-gpu',
                '--disable-extensions',
                '--single-process'
            ]
        });
    }

    async createContext(sessionData = null) {
        await this.launch();
        
        log('[浏览器] 创建新上下文...');
        const options = {
            userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
        };
        
        if (sessionData) {
            options.storageState = sessionData;
        }
        
        this.context = await this.browser.newContext(options);
    }

    async close() {
        if (this.context) {
            await this.context.close().catch(() => {});
            this.context = null;
            log('[浏览器] 上下文已关闭');
        }
        
        if (this.browser) {
            await this.browser.close().catch(() => {});
            this.browser = null;
            log('[浏览器] 浏览器进程已关闭');
        }
    }

    async withBrowser(callback, needsSession = true) {
        let sessionData = null;
        
        if (needsSession) {
            sessionData = await loadSession();
        }
        
        try {
            await this.createContext(sessionData);
            const result = await callback(this.context);
            return result;
        } finally {
            await this.close();
        }
    }
}

const browserManager = new BrowserManager();
const requestQueue = new RequestQueue();
const memoryMonitor = new MemoryMonitor();

// ========================= 配置 =========================
app.use(cors());
app.use(express.json({ limit: '50kb' }));
app.use(express.static('public'));

function authenticateToken(req, res, next) {
    const authHeader = req.headers['authorization'];
    const token = authHeader && authHeader.split(' ')[1];
    if (!token || token !== AUTH_TOKEN) {
        return res.status(401).json({ error: '未经授权' });
    }
    next();
}

app.use('/api', authenticateToken);

const DATA_DIR = path.join(__dirname, 'data');
const SESSION_FILE = path.join(DATA_DIR, 'session.json');
fs.ensureDirSync(DATA_DIR);

// ========================= 会话管理 =========================
async function loadSession() {
    try {
        if (await fs.pathExists(SESSION_FILE)) {
            return await fs.readJson(SESSION_FILE);
        }
    } catch (error) {
        log('[会话] 加载失败:', error.message);
    }
    return null;
}

async function saveSession(context) {
    try {
        const sessionData = await context.storageState();
        await fs.writeJson(SESSION_FILE, sessionData);
        log('[会话] 已保存');
    } catch (error) {
        logError('[会话] 保存失败:', error.message);
    }
}

// ========================= 核心功能 =========================
async function checkLoginStatus() {
    return await browserManager.withBrowser(async (context) => {
        const page = await context.newPage();
        try {
            await page.goto('https://weibo.com', { 
                waitUntil: 'domcontentloaded', 
                timeout: 20000 
            });
            
            await page.waitForSelector(
                'textarea[placeholder="有什么新鲜事想分享给大家？"]', 
                { timeout: 10000 }
            );
            
            await saveSession(context);
            log('[登录检查] ✅ 已登录');
            return true;
        } catch {
            log('[登录检查] ❌ 未登录');
            return false;
        } finally {
            await page.close();
        }
    });
}

async function getQRCode() {
    return await browserManager.withBrowser(async (context) => {
        const page = await context.newPage();
        try {
            await page.goto(
                'https://passport.weibo.com/sso/signin?entry=miniblog&source=miniblog',
                { waitUntil: 'domcontentloaded', timeout: 20000 }
            );
            
            await page.waitForSelector('img[src*="qr.weibo.cn"]', { timeout: 10000 });
            const qrCodeUrl = await page.getAttribute('img[src*="qr.weibo.cn"]', 'src');
            
            if (!qrCodeUrl) throw new Error('未找到二维码');
            
            log('[二维码] ✅ 获取成功');
            return qrCodeUrl;
        } finally {
            await page.close();
        }
    }, false);
}

async function checkScanStatus() {
    return await browserManager.withBrowser(async (context) => {
        const page = await context.newPage();
        try {
            await page.goto(
                'https://passport.weibo.com/sso/signin?entry=miniblog&source=miniblog',
                { waitUntil: 'domcontentloaded', timeout: 20000 }
            );
            
            const currentUrl = page.url();
            if (currentUrl.includes('weibo.com') && !currentUrl.includes('passport')) {
                await saveSession(context);
                log('[扫码] ✅ 登录成功');
                return { status: 'success', message: '登录成功' };
            }

            const errorText = await page.$eval('.txt_red', el => el.textContent).catch(() => null);
            if (errorText) {
                return { status: 'error', message: errorText };
            }

            const expired = await page.$('text=二维码已失效').catch(() => null);
            if (expired) {
                return { status: 'error', message: '二维码已过期' };
            }

            const statusTexts = await page.$$eval('.txt', els => 
                els.map(el => el.textContent)
            ).catch(() => []);
            
            const isScanned = statusTexts.some(text => 
                text.includes('扫描成功') || text.includes('请确认')
            );
            
            return {
                status: 'waiting',
                message: isScanned ? '请在手机上确认' : '等待扫码'
            };
        } finally {
            await page.close();
        }
    }, false);
}

async function postWeibo(content) {
    return await browserManager.withBrowser(async (context) => {
        const page = await context.newPage();
        try {
            await page.goto('https://weibo.com', { 
                waitUntil: 'domcontentloaded', 
                timeout: 20000 
            });
            
            await page.waitForSelector(
                'textarea[placeholder="有什么新鲜事想分享给大家？"]',
                { timeout: 10000 }
            );
            
            await page.fill(
                'textarea[placeholder="有什么新鲜事想分享给大家？"]',
                content
            );
            
            await page.waitForSelector(
                'button:has-text("发送"):not([disabled])',
                { timeout: 10000 }
            );

            const [response] = await Promise.all([
                page.waitForResponse(
                    res => res.url().includes('/ajax/statuses/update') && res.status() === 200,
                    { timeout: 15000 }
                ),
                page.click('button:has-text("发送")')
            ]);

            const result = await response.json();
            
            if (result.ok !== 1) {
                throw new Error(result.msg || '发送失败');
            }

            await saveSession(context);
            log('[发送微博] ✅ 成功');
            
            return {
                success: true,
                message: '发送成功',
                weiboId: result.data?.idstr,
                content: result.data?.text_raw || content
            };
        } finally {
            await page.close();
        }
    });
}

// ========================= API 路由（使用队列） =========================
app.get('/api/status', async (req, res) => {
    try {
        const isLoggedIn = await requestQueue.enqueue(
            () => checkLoginStatus(),
            'checkLoginStatus'
        );
        res.json({ isLoggedIn });
    } catch (error) {
        logError('[API] 状态检查失败:', error.message);
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
        logError('[API] 二维码获取失败:', error.message);
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
        logError('[API] 扫码状态检查失败:', error.message);
        res.status(500).json({ error: error.message });
    }
});

app.post('/api/post', async (req, res) => {
    try {
        const { content } = req.body;
        
        if (!content || typeof content !== 'string') {
            return res.status(400).json({ error: '内容无效' });
        }
        
        if (content.length > 2000) {
            return res.status(400).json({ error: '内容过长' });
        }
        
        const result = await requestQueue.enqueue(
            () => postWeibo(content),
            'postWeibo'
        );
        res.json(result);
    } catch (error) {
        logError('[API] 发送失败:', error.message);
        res.status(500).json({ error: error.message });
    }
});

app.post('/api/logout', async (req, res) => {
    try {
        await requestQueue.enqueue(async () => {
            if (await fs.pathExists(SESSION_FILE)) {
                await fs.remove(SESSION_FILE);
            }
            log('[API] 退出登录成功');
        }, 'logout');
        
        res.json({ success: true, message: '退出成功' });
    } catch (error) {
        logError('[API] 退出失败:', error.message);
        res.status(500).json({ error: error.message });
    }
});

app.get('/health', (req, res) => {
    const memInfo = memoryMonitor.getMemoryInfo();
    const queueStatus = requestQueue.getStatus();
    res.json({
        status: 'ok',
        timestamp: new Date().toISOString(),
        memory: memInfo,
        queue: queueStatus,
        browserStatus: browserManager.browser ? 'running' : 'stopped'
    });
});

// ========================= 错误处理 =========================
app.use((err, req, res, next) => {
    logError('[错误]:', err.message);
    res.status(500).json({ error: '服务器错误' });
});

// ========================= 优雅关闭 =========================
async function gracefulShutdown(signal) {
    log(`[关闭] 收到 ${signal} 信号`);
    
    // 等待队列清空（最多30秒）
    const maxWait = 30000;
    const startTime = Date.now();
    while (requestQueue.processing && (Date.now() - startTime) < maxWait) {
        log('[关闭] 等待队列完成...');
        await new Promise(resolve => setTimeout(resolve, 1000));
    }
    
    await browserManager.close();
    process.exit(0);
}

process.on('SIGINT', () => gracefulShutdown('SIGINT'));
process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
process.on('unhandledRejection', (reason) => {
    logError('[Promise拒绝]:', reason);
});

// ========================= 启动服务 =========================
app.listen(PORT, () => {
    log(`[启动] 🚀 服务运行在端口 ${PORT}`);
    log(`[启动] 🌐 访问: http://localhost:${PORT}`);
    log(`[启动] ❤️  健康检查: http://localhost:${PORT}/health`);
    log(`[启动] 📊 内存监控: 每分钟记录一次`);
    log(`[启动] ♻️  浏览器策略: 按需启动，用完即退`);
    log(`[启动] 🔄 请求队列: 已启用，防止并发冲突`);
});
