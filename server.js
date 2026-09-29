require('dotenv').config();
const AUTH_TOKEN = process.env.AUTH_TOKEN || 'weibo-proxy';

// ========================= Cloudflare KV 配置 =========================
const CF_ACCOUNT_ID = process.env.CLOUDFLARE_ACCOUNT_ID;
const CF_NAMESPACE_ID = process.env.CLOUDFLARE_NAMESPACE_ID;
const CF_API_TOKEN = process.env.CLOUDFLARE_API_TOKEN;
const CF_SESSION_KEY = 'weibo-session';

// 严格过滤掉默认模板占位符，避免在未配置时产生误判
const USE_CLOUDFLARE_KV = Boolean(
    CF_ACCOUNT_ID &&
    CF_NAMESPACE_ID &&
    CF_API_TOKEN &&
    !CF_ACCOUNT_ID.includes('your_') &&
    !CF_NAMESPACE_ID.includes('your_') &&
    !CF_API_TOKEN.includes('your_')
);

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
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), 8000); // 8秒超时，防止挂起请求队列
        
        const response = await fetch(url, {
            method: 'PUT',
            headers: {
                'Authorization': `Bearer ${CF_API_TOKEN}`,
                'Content-Type': 'application/json'
            },
            body: JSON.stringify(sessionData),
            signal: controller.signal
        });
        clearTimeout(timeoutId);
        
        if (response.ok) {
            logWithFlush('[Cloudflare KV] ✅ 会话已同步保存到云端');
            return true;
        } else {
            const error = await response.text();
            logErrorWithFlush('[Cloudflare KV] ❌ 保存失败:', response.status, error);
            return false;
        }
    } catch (error) {
        logErrorWithFlush('[Cloudflare KV] ❌ 保存异常:', error.message);
        return false;
    }
}

async function loadSessionFromCloudflare() {
    if (!USE_CLOUDFLARE_KV) return null;
    
    try {
        const url = `https://api.cloudflare.com/client/v4/accounts/${CF_ACCOUNT_ID}/storage/kv/namespaces/${CF_NAMESPACE_ID}/values/${CF_SESSION_KEY}`;
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), 8000);
        
        const response = await fetch(url, {
            method: 'GET',
            headers: {
                'Authorization': `Bearer ${CF_API_TOKEN}`
            },
            signal: controller.signal
        });
        clearTimeout(timeoutId);
        
        if (response.ok) {
            const sessionData = await response.json();
            logWithFlush('[Cloudflare KV] ✅ 会话已从云端加载');
            return sessionData;
        } else if (response.status === 404) {
            logWithFlush('[Cloudflare KV] 云端无会话数据 (404)');
            return null;
        } else {
            const error = await response.text();
            logErrorWithFlush('[Cloudflare KV] ❌ 加载失败:', response.status, error);
            return null;
        }
    } catch (error) {
        logErrorWithFlush('[Cloudflare KV] ❌ 加载异常:', error.message);
        return null;
    }
}

async function deleteSessionFromCloudflare() {
    if (!USE_CLOUDFLARE_KV) return false;
    
    try {
        const url = `https://api.cloudflare.com/client/v4/accounts/${CF_ACCOUNT_ID}/storage/kv/namespaces/${CF_NAMESPACE_ID}/values/${CF_SESSION_KEY}`;
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), 8000);
        
        const response = await fetch(url, {
            method: 'DELETE',
            headers: {
                'Authorization': `Bearer ${CF_API_TOKEN}`
            },
            signal: controller.signal
        });
        clearTimeout(timeoutId);
        
        if (response.ok) {
            logWithFlush('[Cloudflare KV] ✅ 会话已从云端删除');
            return true;
        } else {
            const error = await response.text();
            logErrorWithFlush('[Cloudflare KV] ❌ 删除失败:', response.status, error);
            return false;
        }
    } catch (error) {
        logErrorWithFlush('[Cloudflare KV] ❌ 删除异常:', error.message);
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
    
    const heapUsedMB = formatMB(memUsage.heapUsed);
    const rssMB = formatMB(memUsage.rss);
    
    if (rssMB > 420) {
        logErrorWithFlush(`⚠️ [内存告警] RSS内存使用过高: ${rssMB}MB (>420MB，接近Render 512MB上限)`);
    } else if (rssMB > 350) {
        logWithFlush(`⚠️ [内存警告] RSS内存接近限制: ${rssMB}MB`);
    }
    
    if (heapUsedMB > 140) {
        logErrorWithFlush(`⚠️ [内存告警] 堆内存使用过高: ${heapUsedMB}MB (>140MB)`);
    }
}

function performGC(context = '') {
    if (typeof global.gc === 'function') {
        try {
            const before = process.memoryUsage();
            const beforeHeap = Math.round(before.heapUsed / 1024 / 1024);
            
            global.gc();
            
            const after = process.memoryUsage();
            const afterHeap = Math.round(after.heapUsed / 1024 / 1024);
            const freed = beforeHeap - afterHeap;
            
            logWithFlush(`[GC${context ? ' - ' + context : ''}] 完成 - 释放: ${freed}MB (${beforeHeap}MB -> ${afterHeap}MB)`);
        } catch (error) {
            logErrorWithFlush(`[GC${context ? ' - ' + context : ''}] 执行失败:`, error.message);
        }
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
        this.idleTimeout = 2 * 60 * 1000; // 2分钟空闲后关闭浏览器释放内存
        this.cleanupInterval = null;
        this.isInitializing = false;
    }

    async init() {
        if (this.isInitializing) {
            logWithFlush('[浏览器] 正在初始化中，等待完成...');
            while (this.isInitializing) {
                await new Promise(resolve => setTimeout(resolve, 100));
            }
            return { browser: this.browser, context: this.context };
        }

        if (this.browser && this.browser.isConnected() && this.context) {
            this.updateActivity();
            return { browser: this.browser, context: this.context };
        }

        this.isInitializing = true;
        try {
            if (!this.browser || !this.browser.isConnected()) {
                logWithFlush('[浏览器] 启动浏览器 (Render 低内存模式)...');
                this.browser = await chromium.launch({
                    headless: true,
                    args: [
                        '--no-sandbox',
                        '--disable-setuid-sandbox',
                        '--disable-dev-shm-usage',
                        '--disable-gpu',
                        '--disable-extensions',
                        '--no-zygote',
                        '--single-process', // 在极低内存容器下减少进程分裂
                        '--disable-background-timer-throttling',
                        '--disable-backgrounding-occluded-windows',
                        '--disable-renderer-backgrounding',
                        '--renderer-process-limit=1',
                        '--max_old_space_size=128',
                        '--js-flags=--max-old-space-size=128',
                        '--disable-features=Translate,BackForwardCache,VizDisplayCompositor'
                    ]
                });
                logWithFlush('[浏览器] 浏览器启动成功');
            }

            if (this.context) {
                await this.context.close().catch(() => {});
                this.context = null;
            }

            logWithFlush('[浏览器] 创建浏览器上下文...');
            const sessionData = await loadSession();
            const contextOptions = {
                userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
                locale: 'zh-CN',
                timezoneId: 'Asia/Shanghai'
            };
            if (sessionData) {
                contextOptions.storageState = sessionData;
                logWithFlush('[浏览器] 已加载持久化会话数据');
            }
            this.context = await this.browser.newContext(contextOptions);

            // 路由拦截：屏蔽消耗内存和流量的静态资源（保留微博二维码）
            await this.context.route('**/*', (route) => {
                const url = route.request().url();
                const type = route.request().resourceType();
                if (url.includes('qr.weibo.cn')) {
                    return route.continue();
                }
                if (['image', 'media', 'font'].includes(type)) {
                    return route.abort();
                }
                return route.continue();
            });

            logWithFlush('[浏览器] 上下文创建成功 (已启用资源过滤)');
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
            // 在关闭上下文前，如果处于登录状态，保存最新凭据实现自动续期
            if (isLoggedIn) {
                await this.saveSessionNow().catch(() => {});
            }
            await this.context.close().catch(() => {});
            this.context = null;
            context = null; // 同步清空外部引用
            logWithFlush('[清理] 浏览器上下文已关闭');
        }
    }

    async cleanupBrowser() {
        if (this.browser) {
            logWithFlush('[清理] 关闭浏览器进程...');
            await this.browser.close().catch(() => {});
            this.browser = null;
            browser = null; // 同步清空外部引用
            logWithFlush('[清理] 浏览器进程已关闭');
        }
    }

    startCleanupTimer() {
        if (this.cleanupInterval) return;
        
        this.cleanupInterval = setInterval(async () => {
            const idleTime = Date.now() - this.lastActivity;
            
            if (requestQueue.processing) {
                return;
            }

            logMemoryUsage('定期检查');

            if (idleTime > this.idleTimeout && (this.context || this.browser)) {
                logWithFlush(`[清理] 检测到空闲 ${Math.round(idleTime/1000)}s，关闭浏览器释放内存`);
                await this.cleanup(true);
                performGC('空闲清理');
                logMemoryUsage('清理后');
            }
        }, 30000);
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

    async saveSessionNow(forceCloudflare = false) {
        if (!this.context) return false;
        try {
            const sessionData = await this.context.storageState();
            if (!sessionData || !sessionData.cookies) {
                return false;
            }

            // 1. 优先保证本地文件写入（快速持久化，无配额限制）
            try {
                await fs.ensureDir(DATA_DIR);
                await fs.writeJson(SESSION_FILE, sessionData);
                logWithFlush('[会话] ✅ 本地会话文件已保存');
            } catch (fsErr) {
                logErrorWithFlush('[会话] 本地文件写入警告:', fsErr.message);
            }
            
            // 2. Cloudflare KV 节流同步（非关键操作每小时最多同步1次，防配额耗尽）
            if (USE_CLOUDFLARE_KV) {
                const now = Date.now();
                const timeSinceLastSync = now - lastKvSyncTime;

                if (forceCloudflare || timeSinceLastSync >= KV_MIN_SYNC_INTERVAL) {
                    const reason = forceCloudflare ? '关键操作强制同步' : `周期续期同步 (距上次 ${Math.round(timeSinceLastSync / 60000)} 分钟)`;
                    logWithFlush(`[Cloudflare KV] 准备写入云端 (${reason})...`);
                    const success = await saveSessionToCloudflare(sessionData);
                    if (success) {
                        lastKvSyncTime = now;
                    }
                } else {
                    const remainingMin = Math.round((KV_MIN_SYNC_INTERVAL - timeSinceLastSync) / 60000);
                    logWithFlush(`[Cloudflare KV] ⏳ 触发节流保护：距上次同步不足 1 小时 (还剩 ${remainingMin} 分钟)，跳过本次云端写入`);
                }
            }
            return true;
        } catch (error) {
            if (!error.message.includes('closed')) {
                logErrorWithFlush('[会话] 保存失败:', error.message);
            }
            return false;
        }
    }
}

const browserManager = new BrowserManager();

// ========================= 应用配置 =========================
app.use(cors());
app.use(express.json({ limit: '50kb' }));

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

// Cloudflare KV 同步节流控制：限制非关键操作同步频率（默认 1 小时）
let lastKvSyncTime = 0;
const KV_MIN_SYNC_INTERVAL = 60 * 60 * 1000;

// ========================= 核心功能函数 =========================
async function initBrowser() {
    const { browser: br, context: ctx } = await browserManager.init();
    browser = br;
    context = ctx;
}

// 登录会话加载（优先云端，回退本地）
async function loadSession() {
    try {
        if (USE_CLOUDFLARE_KV) {
            const sessionData = await loadSessionFromCloudflare();
            if (sessionData && sessionData.cookies && sessionData.cookies.length > 0) {
                lastKvSyncTime = Date.now(); // 记录本次从云端拉取时间
                await fs.writeJson(SESSION_FILE, sessionData).catch(() => {});
                return sessionData;
            }
        }
        
        if (await fs.pathExists(SESSION_FILE)) {
            const sessionData = await fs.readJson(SESSION_FILE);
            if (sessionData && sessionData.cookies && sessionData.cookies.length > 0) {
                logWithFlush('[会话] ✅ 本地会话文件已加载');
                return sessionData;
            }
        }
    } catch (error) {
        logWithFlush('[会话] ❌ 加载会话失败:', error.message);
    }
    return null;
}

// 检查登录状态：采用轻量化接口优先，彻底避免在 0.1 CPU 上渲染整个 SPA 导致超时或 OOM
async function checkLoginStatus() {
    logWithFlush('[登录检查] 开始检查登录状态...');
    try {
        await initBrowser();
        browserManager.updateActivity();
        
        // 1. 快速检查上下文中是否存在核心凭据 SUB Cookie
        const cookies = await context.cookies(['https://weibo.com']);
        const sub = cookies.find(c => c.name === 'SUB' && c.value);
        if (!sub) {
            isLoggedIn = false;
            logWithFlush('[登录检查] ❌ 上下文中无 SUB Cookie，判定未登录');
            return false;
        }

        // 检查 SUB 是否已过期
        if (sub.expires && sub.expires > 0 && sub.expires * 1000 < Date.now()) {
            isLoggedIn = false;
            logWithFlush('[登录检查] ❌ SUB Cookie 已过期，判定未登录');
            return false;
        }

        // 2. 超轻量 API 校验：直接调用接口验证，耗时仅 ~200ms，内存几乎为 0
        try {
            const res = await context.request.get('https://weibo.com/ajax/profile/info', {
                timeout: 10000,
                headers: {
                    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
                    'Referer': 'https://weibo.com/'
                }
            });

            if (res.ok()) {
                const data = await res.json().catch(() => null);
                if (data && (data.ok === 1 || data.data?.user?.id)) {
                    isLoggedIn = true;
                    lastActivityTime = Date.now();
                    logWithFlush(`[登录检查] ✅ 轻量接口校验成功！用户已登录 (UID: ${data.data?.user?.id || '已知'})`);
                    // 每次验证成功均更新持久化存储，保证 Cookie 滑动续期
                    await browserManager.saveSessionNow();
                    return true;
                } else if (data && data.ok === 0 && (data.message === 'not login' || data.login === 1)) {
                    isLoggedIn = false;
                    logWithFlush('[登录检查] ❌ 接口明确返回未登录状态');
                    return false;
                }
            }
        } catch (apiErr) {
            logWithFlush('[登录检查] 轻量接口校验异常，回退至页面探测:', apiErr.message);
        }

        // 3. 页面回退检测：当轻量接口受阻时，安全开启页面检测
        let page = null;
        try {
            page = await context.newPage();
            await page.goto('https://weibo.com', { waitUntil: 'domcontentloaded', timeout: 25000 });

            const finalUrl = page.url();
            if (finalUrl.includes('passport.weibo.com') || finalUrl.includes('login.php') || finalUrl.includes('newlogin')) {
                isLoggedIn = false;
                logWithFlush('[登录检查] ❌ 页面被重定向至登录页');
                return false;
            }

            // 多元素组合匹配（支持各种改版、动态占位符、头像与导航栏）
            const loggedInElement = await page.waitForSelector(
                'textarea[placeholder*="新鲜事"], textarea[placeholder*="分享"], textarea.Form_input, [contenteditable="true"], [class*="woo-avatar"], [class*="gn_name"], a[href*="/u/"]',
                { timeout: 12000 }
            ).catch(() => null);

            if (loggedInElement) {
                isLoggedIn = true;
                lastActivityTime = Date.now();
                logWithFlush('[登录检查] ✅ 页面回退探测成功！用户已登录');
                await browserManager.saveSessionNow();
                return true;
            }

            const loginBtn = await page.$('a:has-text("立即登录"), a:has-text("登录")').catch(() => null);
            if (loginBtn) {
                isLoggedIn = false;
                logWithFlush('[登录检查] ❌ 检测到登录按钮，用户未登录');
                return false;
            }

            logWithFlush('[登录检查] ⚠️ 页面状态不明确，保持现有登录状态:', isLoggedIn);
            return isLoggedIn;
        } finally {
            if (page) {
                await page.close().catch(() => {});
            }
        }
    } catch (error) {
        logErrorWithFlush('[登录检查] 检查异常:', error.message);
        return isLoggedIn; // 遇网络抖动不轻易强制置否
    }
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
                await loginPage.close().catch(() => {});
            }
            
            loginPage = await context.newPage();
            await loginPage.goto('https://passport.weibo.com/sso/signin?entry=miniblog&source=miniblog', {
                waitUntil: 'domcontentloaded', timeout: 25000
            });
            
            await loginPage.waitForSelector('img[src*="qr.weibo.cn"]', { timeout: 15000 });
            const qrCodeUrl = await loginPage.getAttribute('img[src*="qr.weibo.cn"]', 'src');
            
            if (qrCodeUrl) {
                logWithFlush('[二维码] ✅ 二维码获取成功');
                return qrCodeUrl;
            } else {
                throw new Error('未找到二维码图片元素');
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
        const currentUrl = loginPage.url();
        
        // 关键修复：检查上下文是否已收到 SUB 核心 Cookie
        const cookies = await context.cookies(['https://weibo.com']);
        const hasSub = cookies.some(c => c.name === 'SUB' && c.value);

        // 必须在 weibo.com 域，且不处于 SSO 换票据阶段，且已获得 SUB Cookie，才认定登录完成
        if (hasSub && currentUrl.includes('weibo.com') && !currentUrl.includes('passport') && !currentUrl.includes('sso/login')) {
            isLoggedIn = true;
            lastActivityTime = Date.now();
            logWithFlush('[扫码状态] ✅ 用户扫码登录成功，检测到有效凭证！');

            // 等待 1 秒确保所有关联 Cookie 写入完毕
            await loginPage.waitForTimeout(1000).catch(() => {});
            await browserManager.saveSessionNow(true); // 扫码登录为关键操作，强制同步云端
            
            await loginPage.close().catch(() => {});
            loginPage = null;
            return { status: 'success', message: '登录成功' };
        }

        // 正在登录跳转换取票据中
        if (currentUrl.includes('sso/login') || currentUrl.includes('crossdomain')) {
            return { status: 'waiting', message: '正在完成登录验证，请稍候...' };
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
            await page.goto('https://weibo.com', { waitUntil: 'domcontentloaded', timeout: 25000 });
            
            // 兼容多种动态占位符
            const textareaSelector = 'textarea[placeholder*="新鲜事"], textarea[placeholder*="分享"], textarea.Form_input, textarea';
            await page.waitForSelector(textareaSelector, { timeout: 15000 });
            await page.fill(textareaSelector, content);
            
            const submitBtnSelector = 'button:has-text("发送"):not([disabled]), button[title*="发送"]:not([disabled])';
            await page.waitForSelector(submitBtnSelector, { timeout: 15000 });

            // 不再限定 res.status() === 200，以便在接口返回 400 等状态时能立即捕获微博后端的真实错误（如违规词、频控）
            const [response] = await Promise.all([
                page.waitForResponse(res => res.url().includes('/ajax/statuses/update'), { timeout: 20000 }),
                page.click(submitBtnSelector),
            ]);

            const result = await response.json();
            if (result.ok === 1) {
                lastActivityTime = Date.now();
                logWithFlush('[发送微博] ✅ 发送成功!');
                await browserManager.saveSessionNow(true); // 发送微博成功为关键操作，强制同步云端
                return {
                    success: true, 
                    message: '微博发送成功',
                    weiboId: result.data?.idstr, 
                    content: result.data?.text_raw || content,
                };
            } else {
                throw new Error(`接口返回失败: ${result.msg || result.message || '未知错误'}`);
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

// ========================= API 路由 =========================
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
            
            if (USE_CLOUDFLARE_KV) {
                await deleteSessionFromCloudflare();
            }
            
            if (await fs.pathExists(SESSION_FILE)) {
                await fs.remove(SESSION_FILE);
            }
            
            isLoggedIn = false;
            
            if (loginPage && !loginPage.isClosed()) {
                await loginPage.close().catch(() => {});
                loginPage = null;
            }

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
        browserStatus: browserManager.browser ? 'running' : 'stopped',
        contextStatus: browserManager.context ? 'active' : 'closed',
        lastActivity: new Date(lastActivityTime).toISOString(),
        storage: USE_CLOUDFLARE_KV ? 'Cloudflare KV (云端双写)' : 'Local File (本地暂存)',
        queue: queueStatus,
        memory: {
            heapUsed: `${Math.round(memUsage.heapUsed / 1024 / 1024)}MB`,
            heapTotal: `${Math.round(memUsage.heapTotal / 1024 / 1024)}MB`,
            rss: `${Math.round(memUsage.rss / 1024 / 1024)}MB`
        },
        gc: {
            available: typeof global.gc === 'function'
        }
    };
    
    res.json(healthInfo);
});

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

// ========================= 启动与优雅关闭 =========================
// 服务启动预热恢复会话（解决 Render 冷启动后登录状态重置为 false 的问题）
async function warmUpSession() {
    logWithFlush('[启动预热] 正在从持久化存储恢复会话...');
    try {
        const sessionData = await loadSession();
        if (sessionData) {
            await initBrowser();
            const status = await checkLoginStatus();
            logWithFlush(`[启动预热] 会话恢复完成: ${status ? '✅ 成功恢复登录态' : '❌ 会话已失效，需要重新扫码'}`);
        } else {
            logWithFlush('[启动预热] 未检测到持久化会话记录');
        }
    } catch (err) {
        logErrorWithFlush('[启动预热] 恢复异常:', err.message);
    }
}

async function gracefulShutdown(signal) {
    logWithFlush(`[关闭] 收到 ${signal} 信号（Render 可能正在休眠或重新部署）`);
    
    const maxWait = 10000;
    const startTime = Date.now();
    while (requestQueue.processing && (Date.now() - startTime) < maxWait) {
        logWithFlush(`[关闭] 等待队列完成: ${requestQueue.getStatus().currentOperation}`);
        await new Promise(resolve => setTimeout(resolve, 500));
    }
    
    try {
        if (isLoggedIn) {
            logWithFlush('[关闭] 正在同步保存最新会话至持久化存储 (关键操作强制同步)...');
            await browserManager.saveSessionNow(true);
        }
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

// 监听 0.0.0.0 以适配 Render 容器网络环境
app.listen(PORT, '0.0.0.0', () => {
    logWithFlush(`[启动] 🚀 服务器运行在端口 ${PORT}`);
    logWithFlush(`[启动] 🌐 访问地址: http://0.0.0.0:${PORT}`);
    logWithFlush(`[启动] ❤️ 健康检查: http://0.0.0.0:${PORT}/health`);
    logWithFlush(`[启动] 🔄 请求队列已启用，自动处理并发冲突`);
    logWithFlush(`[启动] 💾 Render 低内存优化模式：空闲2分钟后自动释放浏览器`);
    
    if (USE_CLOUDFLARE_KV) {
        logWithFlush(`[启动] ☁️ 会话存储: Cloudflare KV (云端双写持久化，适配 Render 免费版)`);
    } else {
        logWithFlush(`[启动] 📁 会话存储: 本地文件 (⚠️ 警告: Render 免费版重启后将丢失，请在 Render 后台配置 Cloudflare KV)`);
    }
    
    const gcAvailable = typeof global.gc === 'function';
    logWithFlush(`[启动] 🧹 垃圾回收 GC: ${gcAvailable ? '✅ 已启用' : '❌ 未启用 (需要 --expose-gc 参数)'}`);
    
    // 异步执行启动预热，不阻塞端口监听
    warmUpSession();
});
