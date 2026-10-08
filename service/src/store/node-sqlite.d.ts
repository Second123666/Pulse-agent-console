/**
 * node:sqlite 的精简类型声明。
 *
 * 背景：`node:sqlite` 是 Node 24 内置模块（无需 npm 依赖），但本项目使用的
 * @types/node@18 早于该模块，未附带类型。此处只声明本项目实际用到的 API，
 * 避免为此引入额外的类型包。
 */
declare module 'node:sqlite' {
  export interface StatementResult {
    changes: number | bigint
    lastInsertRowid: number | bigint
  }

  export class StatementSync {
    run(...params: any[]): StatementResult
    get(...params: any[]): any
    all(...params: any[]): any[]
  }

  export class DatabaseSync {
    constructor(path: string)
    exec(sql: string): void
    prepare(sql: string): StatementSync
    close(): void
  }
}
