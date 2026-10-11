import { mkdirSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { DatabaseSync } from 'node:sqlite'

let db: DatabaseSync | undefined

/**
 * 建表语句：全部使用 IF NOT EXISTS，可重复执行（幂等迁移）。
 * 注意：所有涉及用户数据的表都必须带 user_id，多租户隔离在查询层强制。
 */
const SCHEMA = `
CREATE TABLE IF NOT EXISTS users (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  username      TEXT    NOT NULL UNIQUE,
  password_hash TEXT    NOT NULL,
  salt          TEXT    NOT NULL,
  role          TEXT    NOT NULL DEFAULT 'user',
  created_at    INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS conversations (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  uuid       INTEGER NOT NULL,
  user_id    INTEGER NOT NULL,
  title      TEXT    NOT NULL DEFAULT '',
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  UNIQUE(user_id, uuid)
);
CREATE INDEX IF NOT EXISTS idx_conversations_user ON conversations(user_id);

CREATE TABLE IF NOT EXISTS messages (
  id               INTEGER PRIMARY KEY AUTOINCREMENT,
  conversation_id  INTEGER NOT NULL,
  role             TEXT    NOT NULL,
  content          TEXT    NOT NULL DEFAULT '',
  agent_steps_json TEXT,
  meta_json        TEXT,
  created_at       INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_messages_conversation ON messages(conversation_id);

CREATE TABLE IF NOT EXISTS memory (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id         INTEGER NOT NULL,
  conversation_id INTEGER NOT NULL,
  summary         TEXT    NOT NULL,
  embedding       BLOB,
  message_count   INTEGER NOT NULL DEFAULT 0,
  created_at      INTEGER NOT NULL,
  UNIQUE(user_id, conversation_id)
);
CREATE INDEX IF NOT EXISTS idx_memory_user ON memory(user_id);

CREATE TABLE IF NOT EXISTS usage (
  id                INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id           INTEGER NOT NULL,
  conversation_uuid INTEGER,
  model             TEXT    NOT NULL DEFAULT '',
  prompt_tokens     INTEGER NOT NULL DEFAULT 0,
  completion_tokens INTEGER NOT NULL DEFAULT 0,
  duration_ms       INTEGER NOT NULL DEFAULT 0,
  created_at        INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_usage_user ON usage(user_id, created_at);

CREATE TABLE IF NOT EXISTS knowledge_docs (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id    INTEGER NOT NULL,
  doc_id     TEXT    NOT NULL,
  name       TEXT    NOT NULL,
  chunks     INTEGER NOT NULL DEFAULT 0,
  chars      INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  UNIQUE(user_id, doc_id)
);
CREATE INDEX IF NOT EXISTS idx_knowledge_user ON knowledge_docs(user_id);
`

/**
 * 打开数据库（进程内单例）。
 *
 * 路径优先级：环境变量 AGENT_DB_PATH > service/data/agent.db。
 * **惰性读取**：测试可在首次调用前设置 AGENT_DB_PATH=:memory: 获得独立内存库。
 */
export function getDb(): DatabaseSync {
  if (db)
    return db

  const path = process.env.AGENT_DB_PATH?.trim() || resolve(process.cwd(), 'data/agent.db')

  // :memory: 是内存库，不落盘
  if (path !== ':memory:')
    mkdirSync(dirname(path), { recursive: true })

  db = new DatabaseSync(path)
  db.exec(SCHEMA)
  return db
}

/** 关闭连接并清除单例（测试收尾用；正常运行无需调用） */
export function closeDb(): void {
  db?.close()
  db = undefined
}
