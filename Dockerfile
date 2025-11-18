# 使用Playwright官方镜像，包含预装的浏览器和依赖
FROM mcr.microsoft.com/playwright:v1.52.0-jammy

# 设置工作目录
WORKDIR /app

# 复制package.json和package-lock.json（如果存在）
COPY package.json ./

# 设置npm镜像源（可选，用于加速安装）
RUN npm config set registry https://registry.npmmirror.com

# 生成package-lock.json（如果不存在）并安装依赖
RUN npm install --omit=dev && \
    rm -rf /tmp/* /var/tmp/* /root/.npm && \
    # 清理 apt 缓存
    apt-get clean && \
    rm -rf /var/lib/apt/lists/*

# 复制源代码
COPY . .

# 创建数据目录并设置权限
RUN mkdir -p /app/data && \
    chown -R pwuser:pwuser /app/data

# 切换到非root用户（Playwright官方镜像提供的用户）
USER pwuser

# 暴露端口
EXPOSE 3000

# 设置内存限制环境变量
ENV NODE_OPTIONS="--max-old-space-size=256"

# 启动应用
CMD ["node", "server.js"]
