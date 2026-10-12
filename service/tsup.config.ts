import { defineConfig } from 'tsup'

export default defineConfig({
  entry: ['src/index.ts'],
  outDir: 'build',
  target: 'es2020',
  format: ['esm'],
  splitting: false,
  sourcemap: true,
  minify: false,
  shims: true,
  dts: false,
  // esbuild 会把 node: 前缀统一剥掉（node:crypto → crypto 仍能解析，因为裸名也是内置模块），
  // 但 node:sqlite 不同：内置 sqlite 只能通过 node: 前缀访问，剥掉后变成 npm 包名 → 启动即 ERR_MODULE_NOT_FOUND。
  // 标为 external 让 esbuild 原样保留 specifier。
  external: ['node:sqlite'],
})
