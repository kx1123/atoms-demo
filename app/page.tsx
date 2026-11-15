'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ArrowUp, ArrowUpRight, Check, CheckCheck, ChevronDown, ChevronRight, CircleHelp, Code2, Download, Eye, FileCode2, FolderOpen, History, LayoutGrid, LoaderCircle, Maximize2, Monitor, Plus, RotateCcw, Settings2, ShieldCheck, Smartphone, Sparkles, TriangleAlert, X, Zap } from 'lucide-react';
import type { ModelStatus, Project, ProjectDetail, Run } from '@/lib/types';
import { previewDocument } from '@/lib/preview';

async function api<T>(path: string, body?: unknown): Promise<T> {
  const response = await fetch(`/api/${path}`, body === undefined ? { cache: 'no-store' } : { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  const data = await response.json();
  if (!response.ok) throw new Error(data.error || '请求失败，请重试。');
  return data as T;
}
const suggestions = [
  { icon: LayoutGrid, label: '个人任务看板', prompt: '做一个精致的个人任务看板，可以新增任务、设置优先级，并在待办、进行中和已完成之间切换。' },
  { icon: FileCode2, label: '产品发布页面', prompt: '做一个独立开发者的产品发布页，包含产品介绍、功能卡片、价格方案和可交互的常见问题。风格简洁，有设计感。' },
  { icon: Zap, label: '番茄专注计时', prompt: '做一个番茄专注计时器，可以开始、暂停、重置，切换专注和休息时长，并记录完成的专注次数。' },
];
function Logo({ small = false }: { small?: boolean }) { return <span className={`brand-mark ${small ? 'small' : ''}`} aria-hidden="true"><span /><span /><span /></span>; }
function time(value: string) { return new Date(value).toLocaleString('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' }); }

export default function Workbench() {
  const [projects, setProjects] = useState<Project[]>([]);
  const [detail, setDetail] = useState<ProjectDetail | null>(null);
  const [status, setStatus] = useState<ModelStatus>({ configured: false, model: null });
  const [booting, setBooting] = useState(true);
  const [busy, setBusy] = useState(false);
  const [prompt, setPrompt] = useState('');
  const [activeRun, setActiveRun] = useState<Run | null>(null);
  const [tab, setTab] = useState<'preview' | 'code'>('preview');
  const [mobile, setMobile] = useState(false);
  const [historyOpen, setHistoryOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [helpOpen, setHelpOpen] = useState(false);
  const [selectedVersionId, setSelectedVersionId] = useState<string | null>(null);
  const [previewStatus, setPreviewStatus] = useState<'loading' | 'ready' | 'error'>('loading');
  const [previewError, setPreviewError] = useState('');
  const [saveStatus, setSaveStatus] = useState('已保存');
  const [toast, setToast] = useState('');
  const [refreshKey, setRefreshKey] = useState(0);
  const [expanded, setExpanded] = useState(false);
  const frame = useRef<HTMLIFrameElement>(null);
  const chat = useRef<HTMLDivElement>(null);
  const promptRef = useRef<HTMLTextAreaElement>(null);
  const stateQueue = useRef<Promise<unknown>>(Promise.resolve());
  const stateSequence = useRef(0);
  const liveState = useRef<{ projectId: string; value: Record<string, unknown> } | null>(null);
  const selectionSequence = useRef(0);
  const retryRequest = useRef<{ projectId: string; prompt: string; baseVersionId: string | null; requestId: string } | null>(null);
  const projectId = detail?.project.id;
  const current = detail?.versions.find(v => v.id === detail.project.currentVersionId);
  const version = detail?.versions.find(v => v.id === (selectedVersionId || detail.project.currentVersionId));
  const historical = Boolean(version && current && version.id !== current.id);
  const generating = activeRun?.status === 'running';
  const deployed = status.deployment === 'server';
  const channel = useMemo(() => `preview-${version?.id || 'empty'}-${refreshKey}`, [version?.id, refreshKey]);
  // State is an initial snapshot. Subsequent iframe writes do not recreate the document.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const srcDoc = useMemo(() => version ? previewDocument(version.html, channel, liveState.current && liveState.current.projectId === projectId ? liveState.current.value : detail?.appState || {}) : '', [version?.id, channel]);

  const refreshProjects = useCallback(async () => setProjects(await api<Project[]>('projects')), []);
  const showDetail = useCallback((data: ProjectDetail) => {
    liveState.current = { projectId: data.project.id, value: data.appState };
    setDetail(data); setActiveRun(data.runs[0] || null);
    setSelectedVersionId(null); setPreviewError(''); setPreviewStatus('loading'); setSaveStatus('已保存');
    window.history.replaceState(null, '', `/?project=${data.project.id}`);
  }, []);

  useEffect(() => {
    let mounted = true;
    (async () => {
      try {
        // Initialize the cookie before parallel reads so both requests share one session.
        const model = await api<ModelStatus>('status');
        const list = await api<Project[]>('projects');
        if (!mounted) return;
        setStatus(model); setProjects(list);
        const id = new URLSearchParams(window.location.search).get('project');
        if (id) {
          const data = await api<ProjectDetail>(`projects/${encodeURIComponent(id)}`);
          if (mounted) showDetail(data);
        }
      } catch (error) { if (mounted) setToast((error as Error).message); }
      finally { if (mounted) setBooting(false); }
    })();
    return () => { mounted = false; };
  }, [showDetail]);

  useEffect(() => {
    if (!toast) return;
    const timer = setTimeout(() => setToast(''), 6500);
    return () => clearTimeout(timer);
  }, [toast]);

  useEffect(() => {
    if (!historyOpen && !settingsOpen && !helpOpen) return;
    const previous = document.activeElement as HTMLElement | null;
    const dialog = document.querySelector<HTMLElement>('[role="dialog"]');
    const focusable = () => Array.from(dialog?.querySelectorAll<HTMLElement>('button:not(:disabled),a[href],input,textarea,[tabindex="0"]') || []);
    focusable()[0]?.focus();
    const keydown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') { setHistoryOpen(false); setSettingsOpen(false); setHelpOpen(false); }
      if (event.key === 'Tab') {
        const items = focusable(), first = items[0], last = items.at(-1);
        if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus(); }
        else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus(); }
      }
    };
    document.addEventListener('keydown', keydown);
    return () => { document.removeEventListener('keydown', keydown); previous?.focus(); };
  }, [historyOpen, settingsOpen, helpOpen]);

  useEffect(() => {
    if (!projectId || !version) return;
    setPreviewStatus('loading'); setPreviewError('');
    const receive = (event: MessageEvent) => {
      const message = event.data;
      if (event.source !== frame.current?.contentWindow || !message || message.channel !== 'atoms-preview' || message.token !== channel) return;
      if (message.type === 'ready') setPreviewStatus(s => s === 'error' ? s : 'ready');
      if (message.type === 'error') { setPreviewStatus('error'); setPreviewError(String(message.message).slice(0, 1500)); }
      if (message.type === 'state' && message.value && typeof message.value === 'object' && !Array.isArray(message.value) && !historical) {
        if (JSON.stringify(message.value).length > 100_000) return;
        liveState.current = { projectId, value: message.value };
        const sequence = ++stateSequence.current;
        setSaveStatus('保存中…');
        stateQueue.current = stateQueue.current.catch(() => {}).then(() => api(`projects/${projectId}/state`, { value: message.value })).then(() => {
          if (sequence === stateSequence.current) setSaveStatus('已保存');
        }).catch(error => { setSaveStatus('保存失败'); setToast((error as Error).message); });
      }
    };
    window.addEventListener('message', receive);
    return () => window.removeEventListener('message', receive);
  }, [projectId, version?.id, channel, historical]);

  useEffect(() => {
    if (!activeRun || activeRun.status !== 'running' || !projectId) return;
    let alive = true;
    const id = projectId;
    const source = new EventSource(`/api/projects/${id}/runs/${activeRun.id}/events`);
    const update = async (run: Run) => {
      if (!alive) return;
      setActiveRun(run);
      if (run.status !== 'running') {
        source.close();
        if (run.error) setToast(run.error);
        try {
          const data = await api<ProjectDetail>(`projects/${id}`);
          if (alive) { setDetail(data); setSelectedVersionId(null); await refreshProjects(); }
        } catch (error) { if (alive) setToast((error as Error).message); }
      }
    };
    source.addEventListener('run', event => { void update(JSON.parse((event as MessageEvent).data)); });
    source.onerror = () => { void api<Run>(`projects/${id}/runs/${activeRun.id}`).then(update).catch(() => { if (alive) setToast('进度连接已断开，正在尝试重新连接…'); }); };
    return () => { alive = false; source.close(); };
    // Resubscribe only when changing runs, not on each step event.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeRun?.id, projectId, refreshProjects]);

  useEffect(() => { if (generating && chat.current) chat.current.scrollTop = chat.current.scrollHeight; }, [activeRun?.step, detail?.messages.length, generating]);
  useEffect(() => { if (chat.current && !generating) chat.current.scrollTop = 0; }, [projectId]);

  async function openProject(id: string) {
    const selection = ++selectionSequence.current;
    setBusy(true);
    try { const data = await api<ProjectDetail>(`projects/${id}`); if (selection === selectionSequence.current) { showDetail(data); setPrompt(''); } }
    catch (error) { setToast((error as Error).message); }
    finally { if (selection === selectionSequence.current) setBusy(false); }
  }
  function home() {
    selectionSequence.current++;
    setDetail(null); setActiveRun(null); setPrompt(''); setSelectedVersionId(null); setBusy(false); setExpanded(false);
    window.history.replaceState(null, '', '/');
  }
  async function createExample() {
    setBusy(true);
    try { const data = await api<ProjectDetail>('projects', { title: '今天，专注一点', example: true }); showDetail(data); setPrompt(''); await refreshProjects(); }
    catch (error) { setToast((error as Error).message); }
    finally { setBusy(false); }
  }
  async function submit(override?: string) {
    const text = (override || prompt).trim();
    if (!text || busy || generating || historical) return;
    if (!status.configured) { setSettingsOpen(true); return; }
    setBusy(true);
    try {
      let data = detail;
      if (!data) { data = await api<ProjectDetail>('projects', { title: text.slice(0, 24) }); showDetail(data); }
      const previous = retryRequest.current;
      const baseVersionId = data.project.currentVersionId;
      const requestId = previous?.projectId === data.project.id && previous.prompt === text && previous.baseVersionId === baseVersionId ? previous.requestId : crypto.randomUUID();
      retryRequest.current = { projectId: data.project.id, prompt: text, baseVersionId, requestId };
      const run = await api<Run>(`projects/${data.project.id}/runs`, { prompt: text, requestId, baseVersionId });
      retryRequest.current = null;
      const updated = await api<ProjectDetail>(`projects/${data.project.id}`);
      setDetail(updated); setActiveRun(run); setPrompt(''); setSelectedVersionId(null); setTab('preview'); await refreshProjects();
    } catch (error) { setToast((error as Error).message); }
    finally { setBusy(false); }
  }
  async function restore(versionId: string) {
    if (!detail) return;
    setBusy(true);
    try { const data = await api<ProjectDetail>(`projects/${detail.project.id}/restore`, { versionId }); showDetail(data); setHistoryOpen(false); setToast('版本已恢复，原有历史已保留。'); await refreshProjects(); }
    catch (error) { setToast((error as Error).message); }
    finally { setBusy(false); }
  }
  async function refreshPreview() {
    if (!projectId) return;
    try { await stateQueue.current; const data = await api<ProjectDetail>(`projects/${projectId}`); setDetail(data); setRefreshKey(k => k + 1); }
    catch (error) { setToast((error as Error).message); }
  }
  function download() {
    if (!version) return;
    const portable = previewDocument(version.html, 'standalone', liveState.current && liveState.current.projectId === projectId ? liveState.current.value : detail?.appState || {}).replace("const send=(type,payload)=>parent.postMessage({channel:'atoms-preview',token,type,...payload},'*')", "const send=()=>{}");
    const url = URL.createObjectURL(new Blob([portable], { type: 'text/html;charset=utf-8' }));
    const link = document.createElement('a'); link.href = url; link.download = `atoms-v${version.number}.html`; link.click(); setTimeout(() => URL.revokeObjectURL(url), 1000);
  }
  function composer(onHome: boolean) {
    return <div className={`composer ${onHome ? 'hero-composer' : ''}`}>
      <textarea ref={promptRef} aria-label={onHome ? '描述你想创建的应用' : '描述修改需求'} placeholder={onHome ? '描述你的想法，让它成为一个真正的应用…' : historical ? '返回当前版本后，继续描述修改需求…' : '接下来，你想调整什么？'} maxLength={6000} value={prompt} disabled={generating || historical || busy} onChange={e => setPrompt(e.target.value)} onKeyDown={e => { if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') { e.preventDefault(); void submit(); } }} />
      <div className="composer-footer"><button className="model-select" onClick={() => setSettingsOpen(true)}><Sparkles size={13} /><span>{status.configured ? status.model : '连接你的模型'}</span><ChevronDown size={12} /></button><span className="composer-hint">⌘ ↵</span><button aria-label={onHome ? '开始构建' : '发送修改需求'} className="send-button" disabled={!prompt.trim() || busy || generating || historical} onClick={() => void submit()}>{busy || generating ? <LoaderCircle size={18} className="spin" /> : <ArrowUp size={20} />}</button></div>
    </div>;
  }

  return <div className={`app ${detail ? 'in-project' : ''}`}>
    <aside className="sidebar">
      <button className="brand" onClick={home} aria-label="Atoms 首页"><Logo /><strong>atoms<span className="brand-period">.</span></strong></button>
      <div className="workspace-label"><span className="workspace-avatar">A</span><span>我的工作空间<small>{deployed ? 'YOUR WORKSPACE' : 'LOCAL WORKSPACE'}</small></span><ChevronDown size={13} /></div>
      <button className="new-project" onClick={home}><Plus size={17} />新建项目<span>↗</span></button>
      <button className={`nav-item ${!detail ? 'selected' : ''}`} onClick={home}><LayoutGrid size={16} />所有项目<span className="count">{projects.length}</span></button>
      <div className="sidebar-section">最近项目 <span>{projects.length > 0 ? '·' : ''}</span></div>
      <div className="project-list">{projects.length === 0 ? <div className="no-projects">你的下一个想法，<br />会从这里开始。</div> : projects.map(p => <button className={`project-item ${p.id === projectId ? 'active' : ''}`} key={p.id} title={p.title} onClick={() => void openProject(p.id)} disabled={busy}><FileCode2 size={15} /><span>{p.title}</span>{p.id === projectId && <span className="project-dot" />}</button>)}</div>
      <div className="sidebar-bottom"><div className="local-card"><span className="status-dot" /><strong>{deployed ? '安心构建，随时回来' : '在本地，安心构建'}</strong><p>{deployed ? '项目与版本自动持久保存。' : '项目与版本保存在这台电脑。'}</p><span className="local-tag">{deployed ? 'ONLINE WORKSPACE' : 'LOCAL MODE'}<ShieldCheck size={12} /></span></div><button className="nav-item muted" onClick={() => setSettingsOpen(true)}><Settings2 size={16} />模型设置</button><button className="nav-item muted" onClick={() => setHelpOpen(true)}><CircleHelp size={16} />使用指南<ArrowUpRight size={13} /></button><div className="profile"><span className="profile-avatar">Y</span><div>你的创作空间<small>让想法先发生</small></div><span className="local-pill">{deployed ? '在线' : '本地'}</span></div></div>
    </aside>

    <main className="main">
      <header className="topbar"><div className="breadcrumb"><span>工作空间</span><ChevronRight size={13} /><strong>{detail?.project.title || '概览'}</strong></div><div className="topbar-right"><span className="local-indicator"><span className="status-dot" />{deployed ? '在线运行' : '本地运行'}</span><span className="topbar-divider" /><button className="icon-button" aria-label="使用指南" onClick={() => setHelpOpen(true)}><CircleHelp size={17} /></button><span className="top-avatar">Y</span></div></header>
      {booting ? <div className="boot"><LoaderCircle className="spin" size={24} /><p>正在打开你的工作空间…</p></div> : !detail ? <div className="home-scroll">
        <section className="hero"><div className="hero-badge"><span className="status-dot" />从一个想法，到一个真实的应用<ArrowUpRight size={12} /></div><div className="hero-symbol"><Logo /></div><h1>你想创造什么<span>？</span></h1><p className="hero-subtitle">描述你的想法，和 AI 一起把它变成现实。</p>{composer(true)}<div className="suggestions">{suggestions.map(item => <button key={item.label} onClick={() => { setPrompt(item.prompt); promptRef.current?.focus(); }}><item.icon size={14} />{item.label}<ArrowUpRight size={12} /></button>)}</div><div className="hero-footnote"><ShieldCheck size={13} />无需注册 · 自动保存项目 · 支持连续对话修改</div></section>
        <section className="start-section"><div className="section-heading"><div><span className="eyebrow">A SMALL START, A REAL APP</span><h2>先看看，一个想法可以走多远</h2></div><span className="section-note">从这里，开始你的第一次构建</span></div><button className="example-card" disabled={busy} onClick={() => void createExample()}><div className="example-art"><div className="mini-window"><div className="mini-dots"><i /><i /><i /></div><div className="mini-content"><span>YOUR EVERYDAY, A LITTLE BETTER</span><strong>今天，专注一点 <span>✳</span></strong><div className="mini-progress" /><p><Check size={12} />给今天定一个小目标</p><p><i />读 20 分钟喜欢的书</p><p><i />出门走走，看看天空</p></div></div><span className="example-art-label"><span className="status-dot" />可交互预览</span></div><div className="example-info"><span className="example-tag">交互示例 · 非 AI 生成</span><h3>把每一天，理清楚一点。</h3><p>一个轻量的待办应用。试试新增、完成和筛选任务，<br className="wide-break" />感受从想法到可用产品的完整体验。</p><div className="example-features"><span><Check size={12} />真实交互</span><span><Check size={12} />数据保存</span><span><Check size={12} />代码可查看</span></div><span className="example-cta">打开交互示例 {busy ? <LoaderCircle size={16} className="spin" /> : <ArrowUpRight size={16} />}</span></div></button></section>
        {projects.length > 0 && <section className="recent-section"><div className="section-heading"><h2>继续你的创作</h2><span className="section-note">{projects.length} 个项目</span></div><div className="recent-grid">{projects.slice(0, 6).map(p => <button key={p.id} onClick={() => void openProject(p.id)}><div className="recent-icon"><FolderOpen size={21} /></div><h3>{p.title}</h3><p>{time(p.updatedAt)} 更新<ArrowUpRight size={14} /></p></button>)}</div></section>}
        <footer className="home-footer"><span>BUILT WITH INTENTION. MADE WITH AI.</span><span>一个想法，无限可能。</span></footer>
      </div> : <div className={`project-workspace ${expanded ? 'preview-expanded' : ''}`}>
        <section className="chat-panel"><div className="chat-header"><div><span className="project-type">YOUR CREATIVE PARTNER</span><h2>一起，把想法做好。</h2></div><Sparkles size={20} /></div><div className="messages" ref={chat}>{detail.messages.length === 0 ? <div className="chat-empty"><Logo small /><h3>从一句话开始</h3><p>说说你想做的应用，功能、风格，<br />或者一个还没成形的小想法。</p></div> : detail.messages.map(message => <div className={`message ${message.role}`} key={message.id}>{message.role === 'assistant' && <div className="assistant-label"><Logo small /><strong>Atoms</strong><span>你的构建伙伴</span></div>}<div className="message-content">{message.content}</div><span className="message-time">{time(message.createdAt)}</span></div>)}{activeRun && <div className={`run-card ${activeRun.status}`}><div>{activeRun.status === 'running' ? <LoaderCircle className="spin" size={16} /> : activeRun.status === 'complete' ? <CheckCheck size={16} /> : <TriangleAlert size={16} />}<strong>{activeRun.step}</strong></div><p>{activeRun.status === 'running' ? (current ? '正在处理你的需求，上一版预览仍然可用。' : '首次生成正在进行，完成后会在右侧显示。') : activeRun.error || '新版本已保存，可以在右侧体验。'}</p>{activeRun.status === 'failed' && <button onClick={() => setPrompt(activeRun.prompt)}>重新编辑需求<ArrowUpRight size={12} /></button>}</div>}</div><div className="chat-composer">{historical && <div className="inline-note">正在预览历史版本，请先返回当前版本再修改。</div>}{!status.configured && <button className="model-notice" onClick={() => setSettingsOpen(true)}><span className="status-dot amber" />连接模型后，继续用对话修改<ChevronRight size={13} /></button>}{composer(false)}<p className="composer-disclaimer">每一次修改，都会留下一个可以回来的版本。</p></div></section>
        <section className="preview-panel"><div className="preview-toolbar"><div className="segmented"><button className={tab === 'preview' ? 'on' : ''} onClick={() => setTab('preview')}><Eye size={14} />预览</button><button className={tab === 'code' ? 'on' : ''} onClick={() => setTab('code')}><Code2 size={14} />代码</button></div><div className="preview-actions"><button className="history-button" onClick={() => setHistoryOpen(true)} disabled={!version}><History size={14} /><span>版本历史</span><span className="version-count">{detail.versions.length}</span></button><button className="icon-button" aria-label="下载网页代码" onClick={download} disabled={!version}><Download size={15} /></button><button className="icon-button" aria-label={expanded ? '退出放大预览' : '放大预览'} onClick={() => setExpanded(v => !v)}><Maximize2 size={15} /></button></div></div>
          {historical && <div className="historical-banner"><History size={13} />正在预览版本 {version?.number}<button onClick={() => setSelectedVersionId(null)}>返回当前版本<ChevronRight size={12} /></button></div>}
          <div className={`preview-content ${tab !== 'preview' ? 'pane-hidden' : ''}`}><div className="browser-bar"><div className="browser-controls"><span /><span /><span /></div><button className="icon-button" aria-label="刷新预览" onClick={() => void refreshPreview()} disabled={!version}><RotateCcw size={13} /></button><div className="address"><ShieldCheck size={11} /><span>preview / {version ? `version-${version.number}` : 'new-project'}</span></div><div className="device-controls"><button aria-label="桌面预览" className={!mobile ? 'on' : ''} onClick={() => setMobile(false)}><Monitor size={14} /></button><button aria-label="手机预览" className={mobile ? 'on' : ''} onClick={() => setMobile(true)}><Smartphone size={14} /></button></div></div><div className={`preview-stage ${mobile ? 'mobile' : ''}`}>{version ? <iframe key={channel} ref={frame} title="生成应用预览" srcDoc={srcDoc} sandbox="allow-scripts allow-forms" referrerPolicy="no-referrer" /> : <div className="preview-empty"><div className="preview-empty-icon"><Code2 size={26} /><span><Sparkles size={12} /></span></div><h3>你的想法，即将在这里发生。</h3><p>{generating ? '正在构建你的第一个版本…' : '发送需求后，生成的应用会显示在这里。'}</p><span>LIVE PREVIEW</span></div>}</div></div><div className={`code-pane ${tab !== 'code' ? 'pane-hidden' : ''}`}><div className="code-file"><FileCode2 size={13} />index.html<span>{version ? `${version.html.split('\n').length} 行` : '尚无代码'}</span></div><pre><code>{version?.html || '// 生成后，你可以在这里查看完整网页代码。'}</code></pre></div>
          {previewError && <div className="preview-error"><TriangleAlert size={15} /><span>{previewError}</span><button disabled={generating || historical || busy || !status.configured} onClick={() => void submit(`请修复当前网页的运行错误，保留既有功能。错误信息：${previewError}`)}>尝试修复</button><button className="icon-button" aria-label="收起错误" onClick={() => setPreviewError('')}><X size={12} /></button></div>}
          <div className="preview-footer"><span><span className={`status-dot ${previewStatus === 'error' ? 'red' : !version || previewStatus === 'loading' ? 'gray' : ''}`} />{!version ? '等待首次构建' : previewStatus === 'ready' ? '预览已加载' : previewStatus === 'error' ? '预览出现异常' : '加载预览中'}</span><span className={saveStatus === '保存失败' ? 'save-error' : ''}>{saveStatus === '已保存' ? <Check size={12} /> : <LoaderCircle size={12} className={saveStatus === '保存中…' ? 'spin' : ''} />}{saveStatus}{version && <span className="footer-version">v{version.number}</span>}</span></div>
        </section>
      </div>}
    </main>

    {historyOpen && <div className="modal-backdrop" onClick={() => setHistoryOpen(false)}><section className="modal history-modal" role="dialog" aria-modal="true" aria-label="版本历史" onClick={e => e.stopPropagation()}><div className="modal-heading"><div><span className="eyebrow">EVERY IDEA LEAVES A TRACE</span><h2>版本历史</h2></div><button className="icon-button" aria-label="关闭版本历史" onClick={() => setHistoryOpen(false)}><X size={20} /></button></div><p className="modal-intro">每个版本独立保存。恢复会创建新版本，原有历史始终保留。</p><div className="history-list">{detail?.versions.map(v => <article key={v.id}><span className="timeline-dot" /><div className="version-heading"><strong>版本 {v.number}</strong>{v.id === detail.project.currentVersionId && <span>当前版本</span>}<time>{time(v.createdAt)}</time></div><p>{v.summary}</p><div className="version-buttons"><button onClick={() => { setSelectedVersionId(v.id); setPreviewError(''); setTab('preview'); setHistoryOpen(false); }}>查看预览<Eye size={13} /></button>{v.id !== detail.project.currentVersionId && <button disabled={busy || generating} onClick={() => void restore(v.id)}>恢复此版本<RotateCcw size={13} /></button>}</div></article>)}</div></section></div>}

    {settingsOpen && <div className="modal-backdrop" onClick={() => setSettingsOpen(false)}><section className="modal" role="dialog" aria-modal="true" aria-label="模型设置" onClick={e => e.stopPropagation()}><div className="modal-heading"><div><span className="eyebrow">CONNECT YOUR INTELLIGENCE</span><h2>连接你的模型</h2></div><button className="icon-button" aria-label="关闭模型设置" onClick={() => setSettingsOpen(false)}><X size={20} /></button></div><div className={`connection-state ${status.configured ? 'connected' : ''}`}><span className={`status-dot ${status.configured ? '' : 'amber'}`} /><strong>{status.configured ? `已配置 · ${status.model}` : '尚未配置模型接口'}</strong></div>{deployed ? <p className="modal-intro">{status.configured ? '模型已就绪。描述你的想法，即可开始创建和修改网页应用。' : '模型暂不可用，请稍后重试或联系维护者。'}</p> : <><p className="modal-intro">在项目目录的 <code>.env.local</code> 中填写兼容 Chat Completions 的模型配置，然后重启本地服务。</p><pre className="config-code">{'MODEL_BASE_URL=https://你的服务商/v1\nMODEL_API_KEY=你的密钥\nMODEL_NAME=模型名称'}</pre></>}<div className="setting-notes"><ShieldCheck size={16} /><p>模型密钥仅由服务端读取，不会传给生成网页。生成结果会在右侧预览，并独立保存为新版本。</p></div><button className="primary-button" onClick={() => { void api<ModelStatus>('status').then(s => { setStatus(s); setToast(s.configured ? '配置已读取，可以开始生成。' : '暂未读取到完整配置，请检查并重启服务。'); }).catch(e => setToast(e.message)); }}>重新检查配置<RotateCcw size={14} /></button><button className="text-button" onClick={() => setSettingsOpen(false)}>先体验交互示例<ChevronRight size={13} /></button></section></div>}

    {helpOpen && <div className="modal-backdrop" onClick={() => setHelpOpen(false)}><section className="modal" role="dialog" aria-modal="true" aria-label="使用指南" onClick={e => e.stopPropagation()}><div className="modal-heading"><div><span className="eyebrow">FROM IDEA TO INTERACTION</span><h2>从一句话开始创造</h2></div><button className="icon-button" aria-label="关闭使用指南" onClick={() => setHelpOpen(false)}><X size={20} /></button></div><div className="guide-steps"><p><span>01</span><strong>描述需求</strong>告诉 AI 应用的功能与风格，越具体越容易得到理想结果。</p><p><span>02</span><strong>体验并迭代</strong>在右侧操作生成网页，用对话描述想调整的地方。</p><p><span>03</span><strong>随时回到之前</strong>项目自动保存，每次修改都有独立版本，可以预览和恢复。</p></div><div className="help-note">当前支持无需外部依赖的单页前端应用。先连接模型，或打开标注为“非 AI 生成”的交互示例体验界面。</div></section></div>}
    {toast && <div className="toast" role="status"><TriangleAlert size={16} /><span>{toast}</span><button aria-label="关闭提示" onClick={() => setToast('')}><X size={14} /></button></div>}
  </div>;
}
