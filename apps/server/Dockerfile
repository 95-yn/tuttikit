# 多阶段：先 build deps 再 copy 代码，让 node_modules 单独成层、改源码不破坏缓存
FROM node:20-alpine AS deps
WORKDIR /app

# 1. 装 corepack（带 pnpm）。alpine 上默认没有
RUN corepack enable

# 2. 只 copy 依赖清单 + 安装；改业务代码不会触发 pnpm install
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY apps/server/package.json ./apps/server/
COPY apps/web/package.json ./apps/web/

# 只装 server 一个包，避免拉 web 的 deps（next/react 等几百 MB）
RUN pnpm install --frozen-lockfile --filter @tuttikit/server

# ─────────────────────────────────────────────
FROM node:20-alpine AS runtime
WORKDIR /app

# 系统依赖：tesseract.js 自带 wasm 不需要原生 tesseract，但 alpine 缺 libc6-compat 时挂
RUN apk add --no-cache libc6-compat

# 从 deps 阶段拷贝 node_modules（含 .pnpm 软链）
COPY --from=deps /app/node_modules ./node_modules
COPY --from=deps /app/apps/server/node_modules ./apps/server/node_modules

# 业务代码
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY apps/server ./apps/server

WORKDIR /app/apps/server

# data 目录是会话/trace/上传的持久化位置，docker-compose 会挂 volume
RUN mkdir -p data && chown -R node:node data
USER node

ENV NODE_ENV=production
EXPOSE 3001

# tsx 直接跑 .ts，省去 build 步骤
CMD ["npx", "tsx", "src/server.ts"]

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD wget --quiet --tries=1 --spider http://localhost:3001/health || exit 1
