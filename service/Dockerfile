# 后端镜像：多阶段构建
#
# 构建上下文必须是 service/（compose 里 context: ./service）——
# 后端是自包含的独立包，不需要仓库根目录的任何东西。
#
# Node 24 是硬要求：存储层用的是内置 node:sqlite（Node 22.5+ 才有，且早期版本还要
# --experimental-sqlite 开关）。本机与 CI 都在 24.x 上验证过。

# ---------- 构建阶段：装依赖 + tsup 打包 ----------
FROM node:24-slim AS build

WORKDIR /app

RUN npm i -g pnpm@11

# 先只拷依赖清单：依赖没变时这一层走缓存，改业务代码不会重新装依赖
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml .npmrc ./

# service/.npmrc 里的 store-dir 是 Windows 沙箱规避（D:/test/.pnpm-store），
# Linux 上必须显式覆盖，否则 pnpm 会按那个路径去建 store
RUN pnpm install --frozen-lockfile --store-dir /pnpm-store

COPY . .

RUN pnpm build

# ---------- 运行阶段：只带生产依赖 + 打包产物 ----------
FROM node:24-slim AS runtime

ENV NODE_ENV=production

WORKDIR /app

RUN npm i -g pnpm@11

COPY package.json pnpm-lock.yaml pnpm-workspace.yaml .npmrc ./
# esno 是 dependencies（不是 devDependencies），所以 --prod 之后 pnpm ingest 仍可用
RUN pnpm install --frozen-lockfile --prod --store-dir /pnpm-store

COPY --from=build /app/build ./build

# 保留源码：ingest 脚本（esno src/rag/ingest.ts）直接跑 TS 源码
COPY tsconfig.json ./
COPY src ./src
COPY knowledge ./knowledge

# SQLite 落库目录；compose 里挂卷持久化（不挂就是容器内的临时数据）
RUN mkdir -p /app/data

EXPOSE 3002

# 镜像里没有 curl/wget，健康检查用 Node 内置 fetch。
# /session 是 POST 且不需要鉴权，正好适合做探活。
HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:3002/session',{method:'POST'}).then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "build/index.mjs"]
