# 前端镜像：vite 构建 → nginx 托管
#
# 构建上下文是仓库根目录（compose 里 context: .）。
# API 请求由 nginx 反代到后端容器，见 docker/nginx.conf。

# ---------- 构建阶段 ----------
FROM node:24-slim AS build

WORKDIR /app

RUN npm i -g pnpm@11

# .env.production 是**入库的**（根 .env 被 gitignore，CI/Docker 里没有它）：
# 缺了 VITE_GLOB_API_URL，构建产物里的请求前缀就是 undefined，
# 前端会打到 /session 而不是 /api/session → 404 → 跳 /500（本地踩过的坑）
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml .npmrc .env.production ./

RUN pnpm install --frozen-lockfile

COPY . .

# 用 build 而不是 build-only：顺带跑一遍 vue-tsc，类型错误不该进镜像
RUN pnpm build

# ---------- 运行阶段 ----------
FROM nginx:alpine

COPY docker/nginx.conf /etc/nginx/conf.d/default.conf
COPY --from=build /app/dist /usr/share/nginx/html

EXPOSE 80

CMD ["nginx", "-g", "daemon off;"]
