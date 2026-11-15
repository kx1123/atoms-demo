import { DatabaseSync } from 'node:sqlite';
import { randomUUID } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import type { Project, ProjectDetail, Run, Version, Message } from './types';

export class AppError extends Error {
  constructor(message: string, public status = 400) { super(message); this.name = 'AppError'; }
}
// Hot reload can retain Store instances created by a previous module evaluation.
export function isAppError(error: unknown): error is AppError {
  return error instanceof Error && error.name === 'AppError' && typeof (error as AppError).status === 'number';
}
export class Store {
  db: DatabaseSync;
  constructor(path: string) {
    if (path !== ':memory:') mkdirSync(dirname(resolve(path)), { recursive: true });
    this.db = new DatabaseSync(path);
    this.db.exec(`PRAGMA foreign_keys=ON; PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000;
      CREATE TABLE IF NOT EXISTS projects (id TEXT PRIMARY KEY, owner TEXT NOT NULL, title TEXT NOT NULL, currentVersionId TEXT, createdAt TEXT NOT NULL, updatedAt TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS messages (id TEXT PRIMARY KEY, projectId TEXT NOT NULL REFERENCES projects(id), role TEXT NOT NULL, content TEXT NOT NULL, runId TEXT, createdAt TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS versions (id TEXT PRIMARY KEY, projectId TEXT NOT NULL REFERENCES projects(id), runId TEXT, parentId TEXT, number INTEGER NOT NULL, html TEXT NOT NULL, summary TEXT NOT NULL, createdAt TEXT NOT NULL, UNIQUE(projectId,number));
      CREATE TABLE IF NOT EXISTS runs (id TEXT PRIMARY KEY, projectId TEXT NOT NULL REFERENCES projects(id), requestId TEXT NOT NULL, baseVersionId TEXT, prompt TEXT NOT NULL, status TEXT NOT NULL, step TEXT NOT NULL, error TEXT, createdAt TEXT NOT NULL, updatedAt TEXT NOT NULL, UNIQUE(projectId,requestId));
      CREATE UNIQUE INDEX IF NOT EXISTS one_active_run ON runs(projectId) WHERE status='running';
      CREATE TABLE IF NOT EXISTS app_state (projectId TEXT PRIMARY KEY REFERENCES projects(id), value TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS project_owner ON projects(owner);
      CREATE TABLE IF NOT EXISTS run_clients (runId TEXT PRIMARY KEY REFERENCES runs(id), clientHash TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS run_client_hash ON run_clients(clientHash);
    `);
    this.db.prepare("UPDATE runs SET status='failed',step='运行中断',error='服务已重启，请重新发送需求。',updatedAt=? WHERE status='running'").run(new Date().toISOString());
  }
  transaction<T>(fn: () => T): T {
    this.db.exec('BEGIN IMMEDIATE');
    try { const result = fn(); this.db.exec('COMMIT'); return result; }
    catch (error) { this.db.exec('ROLLBACK'); throw error; }
  }
  list(owner: string): Project[] {
    return this.db.prepare('SELECT id,title,currentVersionId,createdAt,updatedAt FROM projects WHERE owner=? ORDER BY updatedAt DESC').all(owner) as Project[];
  }
  project(owner: string, id: string): Project {
    const row = this.db.prepare('SELECT id,title,currentVersionId,createdAt,updatedAt FROM projects WHERE id=? AND owner=?').get(id, owner) as Project | undefined;
    if (!row) throw new AppError('项目不存在或当前会话无权访问。', 404);
    return row;
  }
  create(owner: string, title: string): Project {
    if (this.list(owner).length >= 100) throw new AppError('本地项目数量已达到 100 个。');
    const id = randomUUID(), now = new Date().toISOString();
    this.db.prepare('INSERT INTO projects VALUES (?,?,?,NULL,?,?)').run(id, owner, title.slice(0, 60), now, now);
    return this.project(owner, id);
  }
  message(projectId: string, role: string, content: string, runId: string | null = null) {
    this.db.prepare('INSERT INTO messages VALUES (?,?,?,?,?,?)').run(randomUUID(), projectId, role, content, runId, new Date().toISOString());
  }
  detail(owner: string, id: string): ProjectDetail {
    const project = this.project(owner, id);
    const state = this.db.prepare('SELECT value FROM app_state WHERE projectId=?').get(id) as { value: string } | undefined;
    return {
      project,
      messages: this.db.prepare('SELECT * FROM messages WHERE projectId=? ORDER BY rowid').all(id) as Message[],
      versions: this.db.prepare('SELECT * FROM versions WHERE projectId=? ORDER BY number DESC').all(id) as Version[],
      runs: this.db.prepare('SELECT * FROM runs WHERE projectId=? ORDER BY rowid DESC').all(id) as Run[],
      appState: state ? JSON.parse(state.value) : {},
    };
  }
  begin(owner: string, projectId: string, requestId: string, prompt: string, baseVersionId: string | null, clientHash = ''): { run: Run; reused: boolean } {
    return this.transaction(() => {
      const project = this.project(owner, projectId);
      const old = this.db.prepare('SELECT * FROM runs WHERE projectId=? AND requestId=?').get(projectId, requestId) as Run | undefined;
      if (old) return { run: old, reused: true };
      if (this.db.prepare("SELECT id FROM runs WHERE projectId=? AND status='running'").get(projectId)) throw new AppError('当前项目正在生成，请等待完成。', 409);
      if (project.currentVersionId !== baseVersionId) throw new AppError('项目版本已经变化，请刷新后重试。', 409);
      const limit = Number(process.env.MODEL_DAILY_LIMIT || 30);
      const day = new Date().toISOString().slice(0, 10);
      const usage = this.db.prepare('SELECT COUNT(*) AS count FROM runs r JOIN projects p ON p.id=r.projectId WHERE p.owner=? AND r.createdAt>=?').get(owner, day) as { count: number };
      if (usage.count >= limit) throw new AppError('今日模型调用次数已达上限。', 429);
      const globalUsage = this.db.prepare('SELECT COUNT(*) AS count FROM runs WHERE createdAt>=?').get(day) as { count: number };
      if (globalUsage.count >= Number(process.env.MODEL_GLOBAL_DAILY_LIMIT || 50)) throw new AppError('今日演示生成总次数已达上限，请明天再试。', 429);
      const active = this.db.prepare("SELECT COUNT(*) AS count FROM runs WHERE status='running'").get() as { count: number };
      if (active.count >= Number(process.env.MODEL_MAX_CONCURRENT || 2)) throw new AppError('当前生成任务较多，请稍后再试。', 429);
      if (clientHash) {
        const ipUsage = this.db.prepare('SELECT COUNT(*) AS count FROM run_clients c JOIN runs r ON r.id=c.runId WHERE c.clientHash=? AND r.createdAt>=?').get(clientHash, day) as { count: number };
        if (ipUsage.count >= Number(process.env.MODEL_IP_DAILY_LIMIT || 20)) throw new AppError('当前网络今日生成次数已达上限，请明天再试。', 429);
      }
      const id = randomUUID(), now = new Date().toISOString();
      this.db.prepare("INSERT INTO runs VALUES (?,?,?,?,?,'running','准备上下文',NULL,?,?)").run(id, projectId, requestId, baseVersionId, prompt, now, now);
      if (clientHash) this.db.prepare('INSERT INTO run_clients VALUES (?,?)').run(id, clientHash);
      this.message(projectId, 'user', prompt, id);
      return { run: this.run(owner, projectId, id), reused: false };
    });
  }
  run(owner: string, projectId: string, id: string): Run {
    this.project(owner, projectId);
    const row = this.db.prepare('SELECT * FROM runs WHERE id=? AND projectId=?').get(id, projectId) as Run | undefined;
    if (!row) throw new AppError('运行不存在。', 404);
    return row;
  }
  step(id: string, step: string) {
    this.db.prepare("UPDATE runs SET step=?,updatedAt=? WHERE id=? AND status='running'").run(step, new Date().toISOString(), id);
  }
  fail(id: string, error: string) {
    this.db.prepare("UPDATE runs SET status='failed',step='生成失败',error=?,updatedAt=? WHERE id=? AND status='running'").run(error, new Date().toISOString(), id);
  }
  saveVersion(projectId: string, html: string, summary: string, runId: string | null, parentId: string | null): Version {
    const id = randomUUID(), now = new Date().toISOString();
    const { count } = this.db.prepare('SELECT COUNT(*) AS count FROM versions WHERE projectId=?').get(projectId) as { count: number };
    const number = count + 1;
    this.db.prepare('INSERT INTO versions VALUES (?,?,?,?,?,?,?,?)').run(id, projectId, runId, parentId, number, html, summary, now);
    this.db.prepare('UPDATE projects SET currentVersionId=?,updatedAt=? WHERE id=?').run(id, now, projectId);
    return { id, projectId, runId, parentId, number, html, summary, createdAt: now };
  }
  finish(owner: string, projectId: string, runId: string, html: string, summary: string) {
    return this.transaction(() => {
      const project = this.project(owner, projectId), run = this.run(owner, projectId, runId);
      if (run.status !== 'running' || project.currentVersionId !== run.baseVersionId) throw new AppError('基准版本已变化，本次结果未覆盖当前版本。', 409);
      const version = this.saveVersion(projectId, html, summary, runId, run.baseVersionId);
      this.message(projectId, 'assistant', summary, runId);
      this.db.prepare("UPDATE runs SET status='complete',step='静态检查通过',updatedAt=? WHERE id=?").run(new Date().toISOString(), runId);
      return version;
    });
  }
  restore(owner: string, projectId: string, versionId: string) {
    return this.transaction(() => {
      const detail = this.detail(owner, projectId);
      if (detail.runs.some(r => r.status === 'running')) throw new AppError('生成中无法恢复版本。', 409);
      const old = detail.versions.find(v => v.id === versionId);
      if (!old) throw new AppError('版本不存在。', 404);
      const version = this.saveVersion(projectId, old.html, `恢复至版本 ${old.number}：${old.summary}`, null, detail.project.currentVersionId);
      this.message(projectId, 'assistant', `已恢复至版本 ${old.number}，保存为版本 ${version.number}。原有历史已保留。`);
      return version;
    });
  }
  state(owner: string, projectId: string, value: Record<string, unknown>) {
    this.project(owner, projectId);
    const serialized = JSON.stringify(value);
    if (serialized.length > 100_000) throw new AppError('应用保存的数据超过 100 KB 限制。');
    this.db.prepare('INSERT INTO app_state VALUES (?,?) ON CONFLICT(projectId) DO UPDATE SET value=excluded.value').run(projectId, serialized);
  }
}

const globalStore = globalThis as unknown as { atomsStore?: Store };
export function getStore() {
  return globalStore.atomsStore ??= new Store(process.env.ATOMS_DB_PATH || './data/atoms.sqlite');
}
