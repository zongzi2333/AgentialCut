/**
 * Settings → Agents: agent cards, each with the same fields. A card may own one work slot (storyboard,
 * director, query planning, visual review, continuity/assembly) or take no slot. Selecting a card
 * expands it; prompt, model, sampling, tools and mounted skills are edited in place. Defaults are
 * ordinary cards: they can be paused, edited or deleted.
 *
 * The skill pool below the cards is the same Skills/ system the Skills gallery uses. Adding or removing
 * a skill there touches real files; dragging one onto a card only mounts it for that agent.
 */
import * as React from 'react';
import { Bot, Check, ChevronDown, FolderPlus, GripVertical, Loader2, Plus, RotateCcw, Search, Trash2, X } from 'lucide-react';
import { api, ApiError, type AgentCard, type AgentCardsResponse, type ProviderStateView } from '@/api';
import { sourcesApi, type SkillEntry } from '@/lib/project-sources';
import { SettingsButton, SettingsField, SettingsGroup, SettingsPage, settingsError } from './ui';
import { SettingsSelect } from './SettingsSelect';
import { FolderBrowserDialog } from '../ProjectSources';
import { ConfirmDialog } from '../ConfirmDialog';
import { useAutoSave } from '@/lib/use-auto-save';
import { useDismissExpanded } from './use-dismiss-expanded';

const EMPTY_AGENTS: AgentCardsResponse['state'] = { revision: 0, agents: [] };
const INSTALLED = (skill: SkillEntry) => skill.installed !== false && !skill.off;

export function AgentCardsSection({ embedded = false }: { embedded?: boolean }) {
  const [agents, setAgents] = React.useState<AgentCardsResponse | null>(null);
  const [providers, setProviders] = React.useState<ProviderStateView | null>(null);
  const [skills, setSkills] = React.useState<SkillEntry[]>([]);
  const [selected, setSelected] = React.useState<string | null>(null);
  const [error, setError] = React.useState('');
  const [notice, setNotice] = React.useState('');
  const [skillQuery, setSkillQuery] = React.useState('');
  const [importOpen, setImportOpen] = React.useState(false);
  const [removingSkill, setRemovingSkill] = React.useState<SkillEntry | null>(null);
  const drag = React.useRef<string | null>(null);
  const hydrated = React.useRef(false);

  const load = React.useCallback(() => {
    setError('');
    void Promise.all([api.agentCards(), api.providerCards(), sourcesApi.skills(null)]).then(([nextAgents, nextProviders, nextSkills]) => {
      setAgents(nextAgents);
      setProviders(nextProviders.state);
      setSkills(nextSkills);
      setSelected((current) => current && nextAgents.state.agents.some((agent) => agent.id === current) ? current : nextAgents.state.agents[0]?.id ?? null);
    }).catch((e) => setError(e instanceof ApiError ? e.message : String(e)));
  }, []);
  React.useEffect(load, [load]);

  const auto = useAutoSave<AgentCardsResponse['state']>({
    value: agents?.state ?? EMPTY_AGENTS,
    enabled: Boolean(agents),
    save: async (next) => (await api.saveAgentCards(next)).state,
    onSaved: (saved) => setAgents((current) => current ? { ...current, state: saved } : current),
  });
  React.useEffect(() => {
    if (!agents || hydrated.current) return;
    hydrated.current = true;
    auto.markSaved(agents.state);
  }, [agents, auto.markSaved]);
  useDismissExpanded(Boolean(selected), () => setSelected(null), '[data-agent-card]');

  const change = (fn: (draft: AgentCard[]) => void) => {
    setAgents((current) => {
      if (!current) return current;
      const next = structuredClone(current);
      fn(next.state.agents);
      next.state.agents.forEach((agent, index) => { agent.order = index; });
      return next;
    });
    setNotice('');
  };
  const update = (id: string, patch: Partial<AgentCard>) => change((draft) => {
    const agent = draft.find((item) => item.id === id);
    if (agent) Object.assign(agent, patch);
  });
  const add = () => {
    const id = `agent_${Date.now().toString(36)}`;
    change((draft) => draft.push({
      id, name: '自定义智能体', role: '', description: '手动智能体', enabled: true, order: draft.length,
      cardId: '', modelId: '', systemPrompt: agents?.prompts?.storyboard ?? '你是 OpenFilm 的智能体。', temperature: 0.2, maxTokens: 3000, topP: 0.9, tools: [], skills: [],
    }));
    setSelected(id);
  };
  const setRole = (id: string, role: AgentCard['role']) => change((draft) => {
    const agent = draft.find((item) => item.id === id);
    if (!agent) return;
    agent.role = role;
    agent.cardId = '';
    agent.modelId = '';
    if (role) {
      agent.enabled = true;
      for (const other of draft) if (other.id !== id && other.role === role) other.enabled = false;
    }
  });
  const remove = (id: string) => {
    change((draft) => {
      const index = draft.findIndex((agent) => agent.id === id);
      if (index >= 0) draft.splice(index, 1);
    });
    setSelected((current) => current === id ? null : current);
  };
  const reorder = (from: string, to: string) => {
    change((draft) => {
      const a = draft.findIndex((agent) => agent.id === from);
      const b = draft.findIndex((agent) => agent.id === to);
      if (a < 0 || b < 0) return;
      const [moved] = draft.splice(a, 1);
      draft.splice(a < b ? b - 1 : b, 0, moved);
    });
  };
  const mount = (agentId: string, name: string) => update(agentId, {
    skills: [...new Set([...(agents?.state.agents.find((agent) => agent.id === agentId)?.skills ?? []), name])],
  });
  const unmount = (agentId: string, name: string) => update(agentId, {
    skills: (agents?.state.agents.find((agent) => agent.id === agentId)?.skills ?? []).filter((skill) => skill !== name),
  });
  const roles = agents?.roles ?? [];
  const roleLabel = (id: string) => roles.find((role) => role.id === id)?.label ?? '不参与流程';
  const categoriesFor = (role: AgentCard['role']) => role === 'verify' ? ['vl'] as const : ['llm'] as const;
  const modelCardsFor = (role: AgentCard['role']) => (providers?.cards ?? []).filter((card) => card.enabled && (categoriesFor(role) as readonly string[]).includes(card.category));
  const installedSkills = skills.filter(INSTALLED);
  const pool = installedSkills.filter((skill) => {
    const q = skillQuery.trim().toLowerCase();
    return !q || [skill.name, skill.description, skill.shown?.title?.zh, skill.shown?.title?.en, skill.shown?.summary?.zh, skill.shown?.summary?.en].some((word) => word?.toLowerCase().includes(q));
  });
  const skillLabel = (skill: SkillEntry) => skill.shown?.title?.zh ?? skill.shown?.title?.en ?? skill.name;

  if (!agents || !providers) return <SettingsPage note="智能体卡片：提示词、模型、技能和采样参数都在这里。"><p className="text-[13px] text-[var(--text-muted)]">{error || '正在读取智能体…'}</p></SettingsPage>;

  const body = (
    <>
      <div className="flex items-center gap-2 rounded-[10px] border border-[var(--border)] bg-[var(--surface-2)] p-2.5">
        <span className="flex min-w-0 flex-1 items-center gap-1.5 text-[11.5px] text-[var(--text-muted)]"><Bot size={14} />{agents.state.agents.length} 张智能体卡</span>
        <span className="flex items-center gap-1.5 px-1 text-[10.5px] text-[var(--text-faint)]">
          {auto.status === 'saving' || auto.status === 'pending' ? <Loader2 size={12} className="animate-spin" /> : auto.status === 'error' ? null : <Check size={12} />}
          {auto.status === 'saving' ? '保存中' : auto.status === 'pending' ? '待保存' : auto.status === 'error' ? '保存失败' : '已自动保存'}
        </span>
        <SettingsButton variant="quiet" onClick={add}><Plus size={14} />添加智能体</SettingsButton>
      </div>
      {notice ? <p className="text-[12px] text-[var(--text-muted)]">{notice}</p> : null}
      {error || auto.error ? <p className={settingsError} role="alert">{error || auto.error}</p> : null}
      {!providers.cards.length ? <div className="rounded-lg border border-[var(--border)] bg-[var(--surface-2)] p-3 text-[12px] text-[var(--text-muted)]">还没有提供商卡片。先在“提供商”添加 LLM 或 VL 卡片，智能体才能绑定模型。</div> : null}
      <div className="grid gap-2.5 md:grid-cols-2">
        {agents.state.agents.map((agent) => {
          const open = selected === agent.id;
          const cards = modelCardsFor(agent.role);
          const card = providers.cards.find((item) => item.id === agent.cardId);
          const model = card?.models.find((item) => item.id === agent.modelId) ?? card?.models[0];
          const mounted = agent.skills ?? [];
          return (
            <article key={agent.id} draggable data-agent-card={agent.id}
              onDragStart={(event) => {
                if ((event.target as HTMLElement).closest('[data-agent-control]')) return;
                drag.current = agent.id;
              }}
              onDragOver={(event) => {
                if (event.dataTransfer.types.includes('application/x-openfilm-agent-skill') || drag.current) event.preventDefault();
              }}
              onDrop={(event) => {
                const skill = event.dataTransfer.getData('application/x-openfilm-agent-skill');
                if (skill) { event.preventDefault(); event.stopPropagation(); mount(agent.id, skill); return; }
                if (drag.current) { event.preventDefault(); reorder(drag.current, agent.id); drag.current = null; }
              }}
              className={`min-w-0 rounded-[10px] border bg-[var(--surface)] p-3 transition ${open ? 'border-[var(--accent)] ring-1 ring-[var(--accent)] md:col-span-2' : 'border-[var(--border)] hover:border-[var(--border-strong)]'} ${agent.enabled ? '' : 'opacity-60'}`}>
              <div className="flex items-start gap-2">
                <button type="button" data-agent-control onClick={() => setSelected(open ? null : agent.id)} className="min-w-0 flex-1 text-left">
                  <span className="flex items-center gap-1.5"><span className="truncate text-[13px] font-medium text-[var(--text)]">{agent.name}</span>{agent.role ? <span className="rounded bg-[var(--surface-2)] px-1 py-[1px] text-[9px] text-[var(--text-faint)]">{roleLabel(agent.role)}</span> : null}</span>
                  <span className="mt-0.5 block truncate text-[10.5px] text-[var(--text-faint)]">{card ? `${card.name} · ${model?.name ?? '未选模型'}` : '未绑定模型'}{mounted.length ? ` · ${mounted.length} 个技能` : ''}</span>
                </button>
                <button type="button" data-agent-control aria-label={agent.enabled ? '停用智能体' : '启用智能体'} onClick={() => update(agent.id, { enabled: !agent.enabled })}
                  className={`mt-1 h-4 w-7 rounded-full p-[2px] transition ${agent.enabled ? 'bg-[var(--ok)]' : 'bg-[var(--border-strong)]'}`}><span className={`block h-3 w-3 rounded-full bg-white transition ${agent.enabled ? 'translate-x-3' : ''}`} /></button>
                <button type="button" data-agent-control aria-label="删除智能体" onClick={() => remove(agent.id)} className="mt-0.5 flex h-6 w-6 items-center justify-center rounded text-[var(--text-faint)] hover:bg-[var(--bg-hover)] hover:text-[var(--err)]"><Trash2 size={13} /></button>
              </div>
              {open ? (
                <div className="mt-3 border-t border-[var(--border-soft)] pt-3">
                  <div className="grid gap-2 sm:grid-cols-2">
                    <label className="flex flex-col gap-1 text-[10.5px] text-[var(--text-faint)]">名称<SettingsField value={agent.name} onChange={(e) => update(agent.id, { name: e.target.value })} aria-label="名称" /></label>
                    <label className="flex flex-col gap-1 text-[10.5px] text-[var(--text-faint)]">工作槽位<SettingsSelect label="工作槽位" value={agent.role} onChange={(/** @type {string} */ value) => setRole(agent.id, value as AgentCard['role'])} options={[{ value: '', label: '不参与流程' }, ...roles.map((role) => ({ value: role.id, label: role.label }))]} width={190} /></label>
                    <label className="flex flex-col gap-1 text-[10.5px] text-[var(--text-faint)]">提供商卡片<SettingsSelect label="提供商卡片" value={agent.cardId} onChange={(/** @type {string} */ value) => { const nextCard = cards.find((item) => item.id === value); update(agent.id, { cardId: value, modelId: nextCard?.models[0]?.id ?? '' }); }} options={[{ value: '', label: cards.length ? '未选择' : '没有可用卡片' }, ...cards.map((item) => ({ value: item.id, label: item.name }))]} width={220} /></label>
                    <label className="flex flex-col gap-1 text-[10.5px] text-[var(--text-faint)]">模型<SettingsSelect label="模型" value={agent.modelId} onChange={(/** @type {string} */ value) => update(agent.id, { modelId: value })} options={[{ value: '', label: card?.models.length ? '未选择' : '先选择提供商卡片' }, ...(card?.models ?? []).map((item) => ({ value: item.id, label: item.name }))]} width={220} /></label>
                    <label className="flex flex-col gap-1 text-[10.5px] text-[var(--text-faint)]">Temperature<SettingsField type="number" step="0.05" min="0" max="2" value={agent.temperature} onChange={(e) => update(agent.id, { temperature: Number(e.target.value) })} aria-label="Temperature" /></label>
                    <label className="flex flex-col gap-1 text-[10.5px] text-[var(--text-faint)]">Max tokens<SettingsField type="number" min="64" value={agent.maxTokens} onChange={(e) => update(agent.id, { maxTokens: Number(e.target.value) })} aria-label="Max tokens" /></label>
                    <label className="flex flex-col gap-1 text-[10.5px] text-[var(--text-faint)]">Top P<SettingsField type="number" step="0.05" min="0" max="1" value={agent.topP} onChange={(e) => update(agent.id, { topP: Number(e.target.value) })} aria-label="Top P" /></label>
                    <label className="flex flex-col gap-1 text-[10.5px] text-[var(--text-faint)]">工具权限<SettingsSelect label="工具权限" value={agent.tools.includes('web-search') ? 'web-search' : ''} onChange={(/** @type {string} */ value) => update(agent.id, { tools: value ? ['web-search'] : [] })} options={[{ value: '', label: '无工具' }, { value: 'web-search', label: '允许网页搜索' }]} width={190} /></label>
                  </div>
                  <div className="mt-2">
                    <span className="text-[10.5px] text-[var(--text-faint)]">已挂载技能</span>
                    <div className="mt-1 flex min-h-[30px] flex-wrap items-center gap-1 rounded-lg border border-[var(--border)] bg-[var(--bg)] p-1.5">
                      {mounted.length ? mounted.map((name) => (
                        <span key={name} draggable onDragStart={(event) => { event.dataTransfer.setData('application/x-openfilm-agent-skill', name); event.dataTransfer.effectAllowed = 'copy'; }}
                          className="inline-flex max-w-full items-center gap-1 rounded-md bg-[var(--surface-2)] px-1.5 py-1 text-[10px] text-[var(--text-muted)]">
                          <GripVertical size={10} className="shrink-0 text-[var(--text-faint)]" /><span className="truncate">{name}</span>
                          <button type="button" data-agent-control aria-label={`卸载 ${name}`} onClick={() => unmount(agent.id, name)} className="text-[var(--text-faint)] hover:text-[var(--err)]"><X size={10} /></button>
                        </span>
                      )) : <span className="text-[10px] text-[var(--text-faint)]">从下方技能池拖入，或点击技能后的 +</span>}
                    </div>
                  </div>
                  <label className="mt-2 flex flex-col gap-1 text-[10.5px] text-[var(--text-faint)]">系统提示词
                    <textarea value={agent.systemPrompt} onChange={(event) => update(agent.id, { systemPrompt: event.target.value })} rows={9}
                      className="min-h-[130px] resize-y rounded-lg border border-[var(--border)] bg-[var(--bg)] px-2.5 py-2 font-mono text-[11px] leading-relaxed text-[var(--text)] outline-none focus:border-[var(--border-strong)]" />
                  </label>
                  <div className="mt-2 flex items-center gap-2">
                    <button type="button" onClick={() => update(agent.id, { systemPrompt: agents.prompts?.[agent.role || 'storyboard'] ?? '' })} className="flex h-6 items-center gap-1 rounded px-1.5 text-[10px] text-[var(--text-muted)] hover:bg-[var(--bg-hover)] hover:text-[var(--text)]"><RotateCcw size={11} />恢复默认提示词</button>
                    <span className="min-w-0 flex-1" />
                    <button type="button" onClick={() => setSelected(null)} className="flex h-6 items-center gap-1 rounded px-1.5 text-[10px] text-[var(--text-muted)] hover:bg-[var(--bg-hover)]">收起<ChevronDown size={11} className="rotate-180" /></button>
                  </div>
                </div>
              ) : null}
            </article>
          );
        })}
      </div>

      <SettingsGroup title={`技能池 · ${installedSkills.length}`} footnote="拖到上方的智能体卡片即可挂载；未挂载的技能不会进入该智能体的提示词。添加和删除会修改真实技能文件夹。">
        <div className="flex flex-wrap items-center gap-2 rounded-[10px] border border-[var(--border)] bg-[var(--surface-2)] p-2">
          <label className="flex h-8 min-w-[180px] flex-1 items-center gap-1.5 rounded-md border border-[var(--border)] bg-[var(--bg)] px-2 text-[10.5px] text-[var(--text-faint)]">
            <Search size={12} /><input value={skillQuery} onChange={(event) => setSkillQuery(event.target.value)} placeholder="搜索技能" aria-label="搜索技能" className="min-w-0 flex-1 bg-transparent text-[var(--text)] outline-none placeholder:text-[var(--text-faint)]" />
          </label>
          <SettingsButton variant="quiet" onClick={() => setImportOpen(true)}><FolderPlus size={13} />添加 Skill 文件夹</SettingsButton>
        </div>
        <div className="grid gap-1.5 sm:grid-cols-2">
          {pool.map((skill) => (
            <div key={`${skill.source}:${skill.name}`} className="flex min-w-0 items-center gap-2 rounded-lg border border-[var(--border)] bg-[var(--surface)] px-2 py-1.5">
              <span draggable onDragStart={(event) => { event.dataTransfer.setData('application/x-openfilm-agent-skill', skill.name); event.dataTransfer.effectAllowed = 'copy'; }} className="cursor-grab active:cursor-grabbing"><GripVertical size={12} className="shrink-0 text-[var(--text-faint)]" /></span>
              <span className="min-w-0 flex-1"><span className="block truncate text-[11.5px] text-[var(--text)]">{skillLabel(skill)}</span><span className="block truncate text-[9.5px] text-[var(--text-faint)]">{skill.source === 'mine' ? '我的' : skill.source === 'project' ? '项目' : '官方'} · {skill.name}</span></span>
              <button type="button" aria-label={`删除技能 ${skill.name}`} onClick={() => setRemovingSkill(skill)} className="flex h-5 w-5 shrink-0 items-center justify-center rounded text-[var(--text-faint)] hover:bg-[var(--bg-hover)] hover:text-[var(--err)]"><Trash2 size={11} /></button>
              <button type="button" aria-label={`挂载 ${skill.name}`} onClick={() => { if (agents.state.agents.length) { const target = selected ?? agents.state.agents[0]!.id; mount(target, skill.name); setSelected(target); } }}
                className="flex h-5 w-5 shrink-0 items-center justify-center rounded text-[var(--text-faint)] hover:bg-[var(--bg-hover)] hover:text-[var(--text)]"><Plus size={12} /></button>
            </div>
          ))}
          {!pool.length ? <p className="col-span-full px-1 py-2 text-[11.5px] text-[var(--text-faint)]">没有可用技能。可以从技能库安装官方技能，或添加一个包含 SKILL.md 的文件夹。</p> : null}
        </div>
      </SettingsGroup>

      {importOpen ? <FolderBrowserDialog mode="choose" title="添加 Skill 文件夹" startAt="" onPick={async (path) => { setImportOpen(false); try { await sourcesApi.importSkill(path); setSkills(await sourcesApi.skills(null)); setNotice('已添加技能'); } catch (e) { setError(e instanceof ApiError ? e.message : String(e)); } }} onClose={() => setImportOpen(false)} /> : null}
      <ConfirmDialog open={Boolean(removingSkill)} danger title={`删除技能 ${removingSkill ? skillLabel(removingSkill) : ''}`} description="这会删除真实的技能文件夹（官方技能则是卸载），并从所有智能体上卸载。确定继续？" confirmLabel="删除" cancelLabel="取消" onCancel={() => setRemovingSkill(null)}
        onConfirm={() => {
          const skill = removingSkill;
          setRemovingSkill(null);
          if (!skill) return;
          const removing = skill;
          setSkills((list) => list.filter((item) => !(item.source === removing.source && item.name === removing.name)));
          setAgents((current) => current ? { ...current, state: { ...current.state, agents: current.state.agents.map((agent) => ({ ...agent, skills: (agent.skills ?? []).filter((name) => name !== removing.name) })) } } : current);
          const request = removing.source === 'official' ? sourcesApi.setSkillInstalled(removing.name, false) : sourcesApi.removeSkill(removing.name, null);
          void request.then(() => sourcesApi.skills(null)).then((next) => setSkills(next)).catch((e) => setError(e instanceof ApiError ? e.message : String(e)));
        }} />
    </>
  );
  return embedded ? body : <SettingsPage note="五张默认智能体只是普通的智能体卡片；提示词、模型、采样参数和技能都可修改，也可以删除或添加自定义智能体。">{body}</SettingsPage>;
}
