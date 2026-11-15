export type Project = { id: string; title: string; currentVersionId: string | null; createdAt: string; updatedAt: string };
export type Message = { id: string; projectId: string; role: 'user' | 'assistant'; content: string; runId: string | null; createdAt: string };
export type Version = { id: string; projectId: string; runId: string | null; parentId: string | null; number: number; html: string; summary: string; createdAt: string };
export type Run = { id: string; projectId: string; requestId: string; baseVersionId: string | null; prompt: string; status: 'running' | 'complete' | 'failed'; step: string; error: string | null; createdAt: string; updatedAt: string };
export type ProjectDetail = { project: Project; messages: Message[]; versions: Version[]; runs: Run[]; appState: Record<string, unknown> };
export type ModelStatus = { configured: boolean; model: string | null; deployment?: 'local' | 'server' };
