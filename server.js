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

app.use(cors());
app.use(express.json({ limit: '50kb' }));
app.use('/api', (req, res, next) => {
    if (req.method !== 'GET' && req.get('Content-Type')?.includes('application/json') && req.body === undefined) {
        return res.status(400).json({ error: '请求体JSON格式错误' });
    }
    next();
});

app.use('/api', (req, res, next) => {
    if (req.path === '/post') {
        logWithFlush('请求方法:', req.method);
        logWithFlush('请求路径:', req.path);
        logWithFlush('请求类型:', req.get('Content-Type'));
        logWithFlush('请求内容:', req.body);
    } else {
        logWithFlush('请求路径:', req.path);
    }
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

// 🔥 优化的浏览器资源管理器
class BrowserManager {
    constructor() {
        this.browser = null;
        this.context = null;
        this.lastActivity = Date.now();
        this.idleTimeout = 10 * 60 * 1000; // 10分钟无活动则关闭
        this.cleanupInterval = null;
        this.autoSaveInterval = null;
    }

    async init() {
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
        this.startAutoSave(); // 🔥 启动自动保存
        return { browser: this.browser, context: this.context };
    }

    updateActivity() {
        this.lastActivity = Date.now();
    }

    // 🔥 新增：在清理前先保存会话
    async cleanupWithSave() {
        if (this.context && isLoggedIn) {
            logWithFlush('[清理] 保存会话后再关闭上下文...');
            try {
                const sessionData = await this.context.storageState();
                await fs.writeJson(SESSION_FILE, sessionData);
                logWithFlush('[清理] 会话已保存');
            } catch (error) {
                logErrorWithFlush('[清理] 保存会话失败:', error.message);
            }
        }
        
        if (this.context) {
            await this.context.close().catch(() => {});
            this.context = null;
            logWithFlush('[清理] 浏览器上下文已关闭');
        }
    }

    startCleanupTimer() {
        if (this.cleanupInterval) return;
        
        this.cleanupInterval = setInterval(async () => {
            const idleTime = Date.now() - this.lastActivity;
            if (idleTime > this.idleTimeout && this.context) {
                logWithFlush('[清理] 检测到长时间无活动，准备关闭浏览器上下文');
                await this.cleanupWithSave(); // 🔥 使用新的清理方法
            }
        }, 60000); // 每分钟检查一次
    }

    // 🔥 新增：自动保存定时器（只在上下文存在时保存）
    startAutoSave() {
        if (this.autoSaveInterval) return;
        
        this.autoSaveInterval = setInterval(async () => {
            // 🔥 关键修复：检查上下文是否存在且有效
            if (this.context && isLoggedIn) {
                try {
                    logWithFlush('[定期保存] 自动保存登录会话...');
                    const sessionData = await this.context.storageState();
                    await fs.writeJson(SESSION_FILE, sessionData);
                    logWithFlush('[定期保存] 会话保存成功');
                } catch (error) {
                    // 如果上下文已关闭，仅记录一次警告
                    if (error.message.includes('closed')) {
                        logWithFlush('[定期保存] 上下文已关闭，跳过本次保存');
                    } else {
                        logErrorWithFlush('[定期保存] 保存失败:', error.message);
                    }
                }
            } else {
                logWithFlush('[定期保存] 无活动会话，跳过保存');
            }
        }, 5 * 60 * 1000); // 每5分钟
    }

    async cleanup(closeBrowser = true) {
        // 🔥 先清理定时器
        if (this.cleanupInterval) {
            clearInterval(this.cleanupInterval);
            this.cleanupInterval = null;
        }
        if (this.autoSaveInterval) {
            clearInterval(this.autoSaveInterval);
            this.autoSaveInterval = null;
        }

        // 🔥 再清理浏览器资源
        await this.cleanupWithSave();
        
        if (closeBrowser && this.browser) {
            await this.browser.close().catch(() => {});
            this.browser = null;
            logWithFlush('[清理] 浏览器进程已关闭');
        }
    }

    // 🔥 新增：手动保存会话的方法
    async saveSession() {
        if (this.context && isLoggedIn) {
            try {
                const sessionData = await this.context.storageState();
                await fs.writeJson(SESSION_FILE, sessionData);
                logWithFlush('[会话] 会话已保存');
                return true;
            } catch (error) {
                logErrorWithFlush('[会话] 保存会话失败:', error.message);
                return false;
            }
        }
        return false;
    }
}

const browserManager = new BrowserManager();

async function initBrowser() {
    const { browser: br, context: ctx } = await browserManager.init();
    browser = br;
    context = ctx;
}

// 🔥 简化的 saveSession，委托给 BrowserManager
async function saveSession() {
    return await browserManager.saveSession();
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
                return true;
            } catch {
                isLoggedIn = false;
                logWithFlush('[登录检查] ❌ 用户未登录');
                return false;
            }
        } catch (error) {
            lastError = error;
            logErrorWithFlush(`[登录检查] 登录状态检查失败 (尝试 ${i + 1}):`, error.message);
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
            logErrorWithFlush(`[二维码] 获取二维码失败 (尝试 ${i + 1}):`, error.message);
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
            await saveSession(); // 🔥 登录成功立即保存
            logWithFlush('[扫码状态] ✅ 用户扫码登录成功！');
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
        logErrorWithFlush('[扫码状态] 检查扫码状态失败:', error.message);
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
            logWithFlush(`[发送微博] 开始发送微博 (尝试 ${i + 1}/${maxRetries})`);
            
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
                logWithFlush('[发送微博] ✅ 微博发送成功!');
                return {
                    success: true, message: '微博发送成功',
                    weiboId: result.data?.idstr, content: result.data?.text_raw || content,
                };
            } else {
                throw new Error(`微博接口返回失败: ${result.msg || '未知错误'}`);
            }
        } catch (error) {
            lastError = error;
            logErrorWithFlush(`[发送微博] 发送微博失败 (尝试 ${i + 1}):`, error.message);
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

// API路由
app.get('/api/status', async (req, res) => {
    try {
        logWithFlush('[API] 收到登录状态检查请求');
        const loginStatus = await checkLoginStatus();
        res.json({ isLoggedIn: loginStatus });
    } catch (error) {
        logErrorWithFlush('[API] 状态检查 API 错误:', error);
        res.status(500).json({ error: error.message });
    }
});

app.get('/api/qrcode', async (req, res) => {
    try {
        logWithFlush('[API] 收到获取二维码请求');
        const qrCodeUrl = await getQRCode();
        res.json({ qrCodeUrl });
    } catch (error) {
        logErrorWithFlush('[API] 二维码 API 错误:', error);
        res.status(500).json({ error: error.message });
    }
});

app.get('/api/scan-status', async (req, res) => {
    try {
        const status = await checkScanStatus();
        res.json(status);
    } catch (error) {
        logErrorWithFlush('[API] 扫码状态 API 错误:', error);
        res.status(500).json({ error: error.message });
    }
});

app.post('/api/post', async (req, res) => {
    try {
        logWithFlush('[API] ========== 收到发送微博请求 ==========');
        const { content } = req.body;
        if (!content || typeof content !== 'string' || content.length > 2000) {
            return res.status(400).json({ error: '内容无效或过长' });
        }
        
        const result = await postWeibo(content);
        res.json(result);
    } catch (error) {
        logErrorWithFlush('[API] ❌ 发送微博 API 错误:', error.message);
        res.status(500).json({ error: error.message });
    }
});

app.post('/api/logout', async (req, res) => {
    try {
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
        res.json({ success: true, message: '退出登录成功' });
    } catch (error) {
        logErrorWithFlush('[API] 退出登录 API 错误:', error);
        res.status(500).json({ error: error.message });
    }
});

app.get('/health', (req, res) => {
    const healthInfo = { 
        status: 'ok', 
        timestamp: new Date().toISOString(),
        isLoggedIn: isLoggedIn,
        browserStatus: browser ? 'running' : 'stopped',
        contextStatus: context ? 'active' : 'closed',
        lastActivity: new Date(lastActivityTime).toISOString()
    };
    res.json(healthInfo);
});

app.use((err, req, res, next) => {
    logErrorWithFlush('[错误处理] 错误详情:', err.message);
    if (err instanceof SyntaxError && err.status === 400 && 'body' in err) {
        return res.status(400).json({ error: '请求体JSON格式错误' });
    }
    res.status(500).json({ error: '服务器内部错误' });
});

// 🔥 优化的关闭处理
async function gracefulShutdown(signal) {
    logWithFlush(`[关闭] 收到 ${signal} 信号，正在优雅关闭...`);
    try {
        // 🔥 关键：先保存会话
        if (isLoggedIn && context) {
            logWithFlush('[关闭] 保存登录会话...');
            await saveSession();
        }
        
        await browserManager.cleanup(true);
        logWithFlush('[关闭] 资源清理完成');
    } catch (error) {
        logErrorWithFlush('[关闭] 清理资源时出错:', error);
    }
    process.exit(0);
}

process.on('SIGINT', () => gracefulShutdown('SIGINT'));
process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));

process.on('unhandledRejection', (reason) => {
    logErrorWithFlush('[Promise拒绝] 未处理的 Promise 拒绝:', reason);
});

app.listen(PORT, () => {
    logWithFlush(`[启动] 🚀 服务器运行在端口 ${PORT}`);
    logWithFlush(`[启动] 🌐 访问地址: http://localhost:${PORT}`);
    logWithFlush(`[启动] ❤️ 健康检查: http://localhost:${PORT}/health`);
});
