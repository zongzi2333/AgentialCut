/**
 * Settings → Providers: one card per vendor capability.
 *
 * A card is a service, not a vendor page: Alibaba's LLM, VL, embedding and web-search cards are
 * separate because they have different protocols/models. Cloud and local cards share this surface.
 * Cards can be dragged, added from the built-in catalog, edited, tested and removed. The Models page
 * is gone; each card's default model is the choice used by an agent or a media workflow.
 */
import * as React from 'react';
import {
  Check, ExternalLink, FlaskConical, GripVertical, Loader2, Plus,
  Server, Trash2, X,
} from 'lucide-react';
import {
  api, ApiError, type ProviderCardView, type ProviderCatalogEntry, type ProviderCategory,
  type ProviderCategoryInfo, type ProviderConnectionView, type ProviderModel, type ProviderStateView,
} from '@/api';
import { ProviderMark } from './ProviderMark';
import { SettingsButton, SettingsField, SettingsGroup, SettingsItem, SettingsNumberField, SettingsPage, SettingsSwitch, settingsError } from './ui';
import { SettingsSelect } from './SettingsSelect';
import { useProviders } from '@/lib/providers';
import { CustomServices } from './CustomServices';
import { useAutoSave } from '@/lib/use-auto-save';
import { useDismissExpanded } from './use-dismiss-expanded';

type CardsData = Awaited<ReturnType<typeof api.providerCards>>;
type DraftCard = ProviderCardView;
const EMPTY_STATE: ProviderStateView = { revision: 0, connections: [], cards: [], defaults: {} };

const CATEGORY_OPTIONS: { value: ProviderCategory; label: string }[] = [
  { value: 'llm', label: 'LLM' }, { value: 'vl', label: '视觉理解' }, { value: 'embedding', label: '向量编码' },
  { value: 'rerank', label: '重排' }, { value: 'asr', label: '语音识别' }, { value: 'tts', label: '语音合成' },
  { value: 'image', label: '图像生成' }, { value: 'video', label: '视频生成' }, { value: 'image-search', label: '图片搜索' },
  { value: 'web-search', label: '网页搜索' }, { value: 'web-fetch', label: '网页读取' }, { value: 'music', label: '音乐生成' }, { value: 'sfx', label: '音效生成' },
];



export function ProviderCardsSection() {
  const legacy = useProviders();
  const [data, setData] = React.useState<CardsData | null>(null);
  const [scope, setScope] = React.useState<'all' | 'cloud' | 'local'>('all');
  const [category, setCategory] = React.useState<'all' | ProviderCategory>('all');
  const [catalogOpen, setCatalogOpen] = React.useState(false);
  const [editing, setEditing] = React.useState<string | null>(null);
  const [error, setError] = React.useState('');
  const [notice, setNotice] = React.useState('');
  const drag = React.useRef<string | null>(null);
  const importRef = React.useRef<HTMLInputElement>(null);
  const hydrated = React.useRef(false);

  const load = React.useCallback(() => {
    setError('');
    void api.providerCards().then(setData).catch((e) => setError(e instanceof ApiError ? e.message : String(e)));
  }, []);
  React.useEffect(load, [load]);

  const state = data?.state ?? EMPTY_STATE;
  const auto = useAutoSave<ProviderStateView>({
    value: state,
    enabled: Boolean(data),
    save: (next) => api.saveProviderCards(next),
    onSaved: (saved) => setData((current) => current ? { ...current, state: saved } : current),
  });
  React.useEffect(() => {
    if (!data || hydrated.current) return;
    hydrated.current = true;
    auto.markSaved(data.state);
  }, [data, auto.markSaved]);
  useDismissExpanded(Boolean(editing), () => setEditing(null), '[data-provider-card]');

  if (!data) return <SettingsPage note="统一管理云端与本地提供商。每张卡片对应一个厂商的一种能力。"><p className="text-[13px] text-[var(--text-muted)]">{error || '正在读取提供商…'}</p></SettingsPage>;
  const changing = (fn: (draft: ProviderStateView) => void) => {
    setData((current) => {
      if (!current) return current;
      const next = structuredClone(current);
      fn(next.state);
      return next;
    });
    setNotice('');
  };
  const updateCard = (cardId: string, patch: Partial<DraftCard>) => changing((draft) => {
    const card = draft.cards.find((item) => item.id === cardId);
    if (card) Object.assign(card, patch);
  });
  const updateConnection = (connectionId: string, patch: Partial<ProviderConnectionView>) => changing((draft) => {
    const connection = draft.connections.find((item) => item.id === connectionId);
    if (connection) Object.assign(connection, patch);
  });
  const connectionOf = (card: DraftCard) => {
    const base = state.connections.find((item) => item.id === card.connectionId) ?? null;
    return base ? { ...base, ...(card.connectionOverride ?? {}) } : null;
  };
  const setShared = (card: DraftCard, shared: boolean) => updateCard(card.id, { connectionOverride: shared ? undefined : (connectionOf(card) ?? undefined) });
  const categoryLabel = (id: ProviderCategory) => data.categories.find((item) => item.id === id)?.label ?? id;
  const removeCard = (cardId: string) => {
    changing((draft) => {
      draft.cards = draft.cards.filter((card) => card.id !== cardId);
      for (const [name, id] of Object.entries(draft.defaults)) if (id === cardId) delete draft.defaults[name];
      draft.cards.forEach((card, index) => { card.order = index; });
    });
    setEditing((current) => current === cardId ? null : current);
  };
  const addCatalog = (entry: ProviderCatalogEntry) => {
    changing((draft) => {
      let connection = draft.connections.find((item) => item.vendorId === entry.vendorId && item.scope === entry.scope);
      if (!connection) {
        connection = { id: `conn_${Date.now().toString(36)}`, vendorId: entry.vendorId, name: entry.vendorName, scope: entry.scope, baseUrl: entry.baseUrl, auth: entry.auth, authHeader: 'x-api-key', key: '', hasKey: false, last4: '' };
        draft.connections.push(connection);
      }
      const card: DraftCard = {
        id: `card_${Date.now().toString(36)}`, catalogId: entry.id, vendorId: entry.vendorId, name: entry.name, category: entry.category,
        scope: entry.scope, protocol: entry.protocol, connectionId: connection.id, models: structuredClone(entry.models),
        defaultModelId: entry.defaultModelId, enabled: true, order: draft.cards.length, builtin: entry.builtin, docsUrl: entry.docsUrl,
      };
      draft.cards.push(card);
      if (!draft.defaults[entry.category]) draft.defaults[entry.category] = card.id;
    });
    setCatalogOpen(false);
    setEditing(null);
    setNotice('已添加卡片');
  };
  const addCustom = () => {
    const stamp = Date.now().toString(36);
    const cardId = `card_${stamp}`;
    changing((draft) => {
      const connection: ProviderConnectionView = { id: `conn_${stamp}`, vendorId: `custom_${stamp}`, name: '自定义提供商', scope: 'cloud', baseUrl: '', auth: 'bearer', authHeader: 'x-api-key', key: '', hasKey: false, last4: '' };
      draft.connections.push(connection);
      const card: DraftCard = {
        id: cardId, vendorId: connection.vendorId, name: '自定义提供商 · LLM', category: 'llm', scope: 'cloud', protocol: 'openai-chat',
        connectionId: connection.id, models: [{ id: 'default', name: 'Default' }], defaultModelId: 'default', enabled: true, order: draft.cards.length,
      };
      draft.cards.push(card);
    });
    setEditing(cardId);
    setNotice('已添加自定义卡片，请填写连接和模型');
  };
  const reorder = (from: string, to: string) => {
    if (from === to) return;
    changing((draft) => {
      const fromIndex = draft.cards.findIndex((card) => card.id === from);
      const toIndex = draft.cards.findIndex((card) => card.id === to);
      if (fromIndex < 0 || toIndex < 0) return;
      const [moved] = draft.cards.splice(fromIndex, 1);
      draft.cards.splice(fromIndex < toIndex ? toIndex - 1 : toIndex, 0, moved);
      draft.cards.forEach((card, index) => { card.order = index; });
    });
  };
  const visible = state.cards.filter((card) => (scope === 'all' || card.scope === scope) && (category === 'all' || card.category === category));
  const groups = scope === 'all' ? (['cloud', 'local'] as const).map((id) => ({ id, cards: visible.filter((card) => card.scope === id) })).filter((group) => group.cards.length) : [{ id: scope, cards: visible }];
  const catalog = data.catalog.filter((entry) => (scope === 'all' || entry.scope === scope) && (category === 'all' || entry.category === category));

  return (
    <SettingsPage note="每张卡片是“厂商 × 能力类别”。云端和本地都在这里；同一厂商的卡片默认共享连接，也可以单卡覆盖。">
      <div className="flex flex-wrap items-center gap-2 rounded-[10px] border border-[var(--border)] bg-[var(--surface-2)] p-2.5">
        <div className="flex rounded-lg border border-[var(--border)] bg-[var(--bg)] p-[2px]">
          {(['all', 'cloud', 'local'] as const).map((id) => (
            <button key={id} type="button" onClick={() => setScope(id)} className={`h-7 rounded-md px-2.5 text-[12px] ${scope === id ? 'bg-[var(--surface-3)] text-[var(--text)]' : 'text-[var(--text-muted)] hover:text-[var(--text)]'}`}>{id === 'all' ? '全部' : id === 'cloud' ? '云端' : '本地'}</button>
          ))}
        </div>
        <span className="h-5 w-px bg-[var(--border)]" />
        <button type="button" onClick={() => setCategory('all')} className={`h-7 rounded-md px-2 text-[11.5px] ${category === 'all' ? 'bg-[var(--surface-3)] text-[var(--text)]' : 'text-[var(--text-muted)] hover:text-[var(--text)]'}`}>全部类别</button>
        {data.categories.map((item) => (
          <button key={item.id} type="button" onClick={() => setCategory(item.id)} className={`h-7 rounded-md px-2 text-[11.5px] ${category === item.id ? 'bg-[var(--surface-3)] text-[var(--text)]' : 'text-[var(--text-muted)] hover:text-[var(--text)]'}`}>{item.label}</button>
        ))}
        <span className="min-w-0 flex-1" />
        <SettingsButton onClick={() => setCatalogOpen(true)}><Plus size={14} />从模板添加</SettingsButton>
        <SettingsButton variant="quiet" onClick={addCustom}><Plus size={14} />自定义卡片</SettingsButton>
        <SettingsButton variant="quiet" onClick={() => importRef.current?.click()}><Plus size={14} />导入本地模型包</SettingsButton>
        <input ref={importRef} type="file" accept=".zip,application/zip" className="hidden" onChange={(event) => {
          const file = event.target.files?.[0];
          event.target.value = '';
          if (!file) return;
          void api.semanticImportModel(file).then(async (result) => {
            const models = await api.semanticModels().catch(() => ({ models: [] }));
            const found = models.models.find((model) => model.id === result.model);
            changing((draft) => {
              let card = draft.cards.find((item) => item.vendorId === 'openfilm-clip' && item.category === 'embedding');
              if (!card) {
                let connection = draft.connections.find((item) => item.vendorId === 'openfilm-clip');
                if (!connection) {
                  connection = { id: `conn_${Date.now().toString(36)}`, vendorId: 'openfilm-clip', name: 'OpenFilm 本地 CLIP', scope: 'local', baseUrl: '', auth: 'none', authHeader: 'x-api-key', key: '', hasKey: false, last4: '' };
                  draft.connections.push(connection);
                }
                card = { id: `card_${Date.now().toString(36)}`, vendorId: 'openfilm-clip', name: 'OpenFilm 本地 CLIP · 向量编码', category: 'embedding', scope: 'local', protocol: 'local-clip', connectionId: connection.id, models: [], defaultModelId: '', enabled: true, order: draft.cards.length };
                draft.cards.push(card);
              }
              if (!card.models.some((model) => model.id === result.model)) card.models.push({ id: result.model, name: found?.name ?? result.model, dimension: found?.dimension, vision: true });
              card.defaultModelId ||= result.model;
            });
            setNotice(`已导入本地模型 ${result.model}`);
          }).catch((e) => setError(e instanceof ApiError ? e.message : String(e)));
        }} />

        <span className={`flex h-8 items-center gap-1.5 px-1 text-[10.5px] ${auto.status === 'error' ? 'text-[var(--err)]' : 'text-[var(--text-faint)]'}`}>
          {auto.status === 'saving' || auto.status === 'pending' ? <Loader2 size={12} className="animate-spin" /> : auto.status === 'error' ? null : <Check size={12} />}
          {auto.status === 'saving' ? '保存中' : auto.status === 'pending' ? '待保存' : auto.status === 'error' ? '保存失败' : '已自动保存'}
        </span>
      </div>

      {notice ? <p className="text-[12px] text-[var(--text-muted)]">{notice}</p> : null}
      {error ? <p className={settingsError} role="alert">{error}</p> : null}
      {auto.error ? <p className={settingsError} role="alert">{auto.error}</p> : null}

      {groups.map((group) => (
        <SettingsGroup key={group.id} title={group.id === 'cloud' ? `云端 · ${group.cards.length}` : `本地 · ${group.cards.length}`}>
          <div className="grid gap-2.5 lg:grid-cols-2">
            {group.cards.map((card) => (
              <div key={card.id} draggable data-provider-card={card.id}
                onDragStart={() => { drag.current = card.id; }}
                onDragOver={(event) => { if (drag.current) event.preventDefault(); }}
                onDrop={(event) => { event.preventDefault(); if (drag.current) reorder(drag.current, card.id); drag.current = null; }}
                className={`group min-w-0 rounded-[10px] border bg-[var(--surface)] p-3 transition ${editing === card.id ? 'border-[var(--accent)]' : 'border-[var(--border)] hover:border-[var(--border-strong)]'} ${card.enabled ? '' : 'opacity-60'}`}>
                <div className="flex items-start gap-2">
                  <span className="mt-0.5 cursor-grab text-[var(--text-faint)] active:cursor-grabbing"><GripVertical size={14} /></span>
                  <ProviderMark id={card.vendorId} size={17} />
                  <button type="button" onClick={() => setEditing(editing === card.id ? null : card.id)} className="min-w-0 flex-1 text-left">
                    <span className="block truncate text-[12.5px] font-medium text-[var(--text)]">{card.name}</span>
                    <span className="mt-0.5 flex items-center gap-1.5 text-[10px] text-[var(--text-faint)]">
                      <span className="rounded bg-[var(--surface-2)] px-1 py-[1px]">{categoryLabel(card.category)}</span>
                      <span>{card.scope === 'cloud' ? '云端' : '本地'}</span>
                      {card.builtin ? <span>内置适配器</span> : null}
                    </span>
                  </button>
                  <button type="button" aria-label={card.enabled ? '停用' : '启用'} onClick={() => updateCard(card.id, { enabled: !card.enabled })}
                    className={`mt-1 h-4 w-7 rounded-full p-[2px] transition ${card.enabled ? 'bg-[var(--ok)]' : 'bg-[var(--border-strong)]'}`}>
                    <span className={`block h-3 w-3 rounded-full bg-white transition ${card.enabled ? 'translate-x-3' : ''}`} />
                  </button>
                  <button type="button" aria-label="删除卡片" onClick={() => removeCard(card.id)} className="mt-0.5 flex h-6 w-6 items-center justify-center rounded text-[var(--text-faint)] hover:bg-[var(--bg-hover)] hover:text-[var(--err)]"><Trash2 size={13} /></button>
                </div>
                <div className="mt-2 flex items-center gap-1.5 text-[10.5px] text-[var(--text-muted)]">
                  <span className="h-1.5 w-1.5 rounded-full" style={{ background: connectionOf(card)?.hasKey || connectionOf(card)?.key ? 'var(--ok)' : card.scope === 'local' ? 'var(--warn)' : 'var(--text-faint)' }} />
                  <span className="min-w-0 flex-1 truncate font-mono">{connectionOf(card)?.baseUrl || '未填写 Base URL'}</span>
                  {state.defaults[card.category] === card.id ? <span className="shrink-0 rounded-full bg-[var(--surface-2)] px-1.5 py-[1px] text-[9px] text-[var(--text)]">默认</span> : null}
                </div>
                <div className="mt-1.5 flex items-center gap-1.5 text-[10.5px] text-[var(--text-faint)]">
                  <span className="min-w-0 flex-1 truncate">{card.models.length} 个模型 · {card.models.find((model) => model.id === card.defaultModelId)?.name ?? '未选择默认模型'}</span>
                  {state.defaults[card.category] !== card.id ? <button type="button" onClick={() => changing((draft) => { draft.defaults[card.category] = card.id; })} className="shrink-0 rounded px-1.5 py-[1px] text-[9.5px] ring-1 ring-inset ring-[var(--border)] hover:text-[var(--text)]">设为默认</button> : null}
                  <button type="button" onClick={() => setEditing(card.id)} className="shrink-0 rounded px-1.5 py-[1px] text-[9.5px] ring-1 ring-inset ring-[var(--border)] hover:text-[var(--text)]">配置</button>
                </div>
                {editing === card.id ? <ProviderCardEditor key={card.id} card={card} state={state}
                  onChange={(patch) => updateCard(card.id, patch)}
                  onChangeConnection={(connectionId, patch) => {
                    if (card.connectionOverride) updateCard(card.id, { connectionOverride: { ...card.connectionOverride, ...patch } });
                    else updateConnection(connectionId, patch);
                  }}
                  onShared={(shared) => setShared(card, shared)}
                  onClose={() => setEditing(null)} /> : null}
              </div>
            ))}
          </div>
        </SettingsGroup>
      ))}

      {!visible.length ? <SettingsItem title="没有符合条件的提供商" description="从模板添加，或切换云端/本地与类别筛选。" control={<SettingsButton onClick={() => setCatalogOpen(true)}><Plus size={14} />添加</SettingsButton>} /> : null}

      <CustomServices hook={legacy} />

      {catalogOpen ? <CatalogDialog catalog={catalog} categories={data.categories} scope={scope} onScope={setScope} onCategory={setCategory}
        category={category} onAdd={addCatalog} onClose={() => setCatalogOpen(false)} /> : null}
    </SettingsPage>
  );
}

function ProviderCardEditor({ card, state, onChange, onChangeConnection, onShared, onClose }: {
  card: DraftCard; state: ProviderStateView;
  onChange: (patch: Partial<DraftCard>) => void;
  onChangeConnection: (connectionId: string, patch: Partial<ProviderConnectionView>) => void;
  onShared: (shared: boolean) => void; onClose: () => void;
}) {
  const base = state.connections.find((item) => item.id === card.connectionId);
  const connection = base ? { ...base, ...(card.connectionOverride ?? {}) } : null;
  const [test, setTest] = React.useState<{ state: 'idle' | 'busy' | 'ok' | 'error'; text: string }>({ state: 'idle', text: '' });
  const category = card.category;
  const protocols = protocolOptions(category);
  const shared = !card.connectionOverride;
  const custom = !card.catalogId;
  const runTest = async () => {
    setTest({ state: 'busy', text: '' });
    try {
      const result = await api.testProviderCard({ cardId: card.id, category: card.category, protocol: card.protocol, models: card.models, modelId: card.defaultModelId, baseUrl: connection?.baseUrl ?? '', key: connection?.key ?? undefined, auth: connection?.auth, authHeader: connection?.authHeader });
      setTest({ state: 'ok', text: `${result.detail} · ${result.elapsedMs} ms` });
    } catch (e) { setTest({ state: 'error', text: e instanceof ApiError ? e.message : String(e) }); }
  };
  const updateModel = (index: number, patch: Partial<ProviderModel>) => {
    const models = card.models.map((model, i) => i === index ? { ...model, ...patch } : model);
    onChange({ models, ...(patch.id && card.defaultModelId === card.models[index].id ? { defaultModelId: patch.id } : {}) });
  };
  const addModel = () => onChange({ models: [...card.models, { id: `model-${Date.now().toString(36)}`, name: 'New model' }] });
  const removeModel = (index: number) => {
    if (card.models.length <= 1) return;
    const models = card.models.filter((_, i) => i !== index);
    onChange({ models, defaultModelId: models.some((model) => model.id === card.defaultModelId) ? card.defaultModelId : models[0]?.id ?? '' });
  };
  return (
    <div className="mt-2 border-t border-[var(--border-soft)] pt-2" onClick={(event) => event.stopPropagation()}>
      <div className="mb-2 flex items-center gap-2">
        <span className="text-[11px] font-medium text-[var(--text)]">连接与模型</span>
        <span className="min-w-0 flex-1" />
        <SettingsButton variant="quiet" onClick={() => onShared(!shared)}>{shared ? '使用独立连接' : '改回共享连接'}</SettingsButton>
      </div>
      {custom ? (
        <div className="mb-2 grid gap-2 sm:grid-cols-2">
          <label className="flex flex-col gap-1 text-[10.5px] text-[var(--text-faint)]">卡片名称
            <SettingsField value={card.name} onChange={(e) => onChange({ name: e.target.value })} aria-label="卡片名称" />
          </label>
          <label className="flex flex-col gap-1 text-[10.5px] text-[var(--text-faint)]">类别
            <SettingsSelect label="类别" value={card.category} onChange={(/** @type {string} */ value) => { const next = value as ProviderCategory; const nextProtocol = protocolOptions(next)[0]?.value ?? card.protocol; onChange({ category: next, protocol: nextProtocol }); }} options={CATEGORY_OPTIONS} width={190} />
          </label>
          <label className="flex flex-col gap-1 text-[10.5px] text-[var(--text-faint)]">位置
            <SettingsSelect label="位置" value={card.scope} onChange={(/** @type {string} */ value) => { const next = value === 'local' ? 'local' : 'cloud'; onChange({ scope: next }); connection && onChangeConnection(connection.id, { scope: next }); }} options={[{ value: 'cloud', label: '云端' }, { value: 'local', label: '本地' }]} width={190} />
          </label>
        </div>
      ) : null}
      <div className="grid gap-2 sm:grid-cols-2">
        <label className="flex flex-col gap-1 text-[10.5px] text-[var(--text-faint)]">Base URL
          <SettingsField value={connection?.baseUrl ?? ''} onChange={(e) => connection && onChangeConnection(connection.id, { baseUrl: e.target.value })} placeholder="https://…/v1" aria-label="Base URL" spellCheck={false} className="font-mono placeholder:font-sans" />
        </label>
        <label className="flex flex-col gap-1 text-[10.5px] text-[var(--text-faint)]">API Key
          <SettingsField type="password" value={connection?.key ?? ''} onChange={(e) => connection && onChangeConnection(connection.id, { key: e.target.value })} placeholder={connection?.hasKey ? `已保存 ****${connection.last4 ?? ''}；留空保持` : 'API Key'} aria-label="API Key" spellCheck={false} />
        </label>
        <label className="flex flex-col gap-1 text-[10.5px] text-[var(--text-faint)]">协议
          <SettingsSelect label="协议" value={card.protocol} onChange={(value) => onChange({ protocol: value })} options={protocols} width={190} />
        </label>
        <label className="flex flex-col gap-1 text-[10.5px] text-[var(--text-faint)]">默认模型
          <SettingsSelect label="默认模型" value={card.defaultModelId} onChange={(value) => onChange({ defaultModelId: value })} options={card.models.map((model) => ({ value: model.id, label: model.name || model.id }))} width={190} />
        </label>
      </div>
      {card.category === 'embedding' ? (
        <div className="mt-2 grid gap-2 sm:grid-cols-2">
          <p className="sm:col-span-2 text-[10px] leading-relaxed text-[var(--text-faint)]">只有声明“图片输入”并填写向量维度的多模态 Embedding 才能建立画面向量库；纯文本模型只能保存和测试。</p>
          <label className="flex items-center gap-2 text-[10.5px] text-[var(--text-muted)]"><SettingsSwitch checked={Boolean(card.options?.imageMode)} label="图片输入" onChange={(on) => onChange({ options: { ...(card.options ?? {}), imageMode: on ? 'messages' : undefined } })} />图片输入</label>
          <label className="flex flex-col gap-1 text-[10.5px] text-[var(--text-faint)]">图片请求方式
            <SettingsSelect label="图片请求方式" value={String(card.options?.imageMode || 'none')} onChange={(value) => onChange({ options: { ...(card.options ?? {}), imageMode: value === 'none' ? undefined : value } })} options={[{ value: 'none', label: '仅文本' }, { value: 'messages', label: 'messages（Qwen3-VL）' }, { value: 'object', label: 'input object（Jina 等）' }]} width={190} />
          </label>
          <label className="flex items-center gap-2 text-[10.5px] text-[var(--text-muted)]"><SettingsSwitch checked={card.options?.textAsMessages !== false} label="文本使用 messages" onChange={(on) => onChange({ options: { ...(card.options ?? {}), textAsMessages: on } })} />文本使用 messages（对话模板）</label>
          <label className="flex flex-col gap-1 text-[10.5px] text-[var(--text-faint)]">图片字段 / 提示词
            <SettingsField value={String(card.options?.imagePrompt || '')} onChange={(e) => onChange({ options: { ...(card.options ?? {}), imagePrompt: e.target.value } })} placeholder="Represent the given image." aria-label="图片提示词" />
          </label>
        </div>
      ) : null}
      {card.category === 'video' ? (
        <div className="mt-2 grid gap-2 sm:grid-cols-2">
          <label className="flex flex-col gap-1 text-[10.5px] text-[var(--text-faint)]">提交路径
            <SettingsField value={String(card.options?.submitPath || '/videos')} onChange={(e) => onChange({ options: { ...(card.options ?? {}), submitPath: e.target.value } })} aria-label="视频提交路径" className="font-mono" />
          </label>
          <label className="flex flex-col gap-1 text-[10.5px] text-[var(--text-faint)]">查询路径（{'{id}'}）
            <SettingsField value={String(card.options?.statusPath || '/videos/{id}')} onChange={(e) => onChange({ options: { ...(card.options ?? {}), statusPath: e.target.value } })} aria-label="视频查询路径" className="font-mono" />
          </label>
        </div>
      ) : null}
      <div className="mt-2">
        <div className="mb-1 flex items-center gap-2"><span className="text-[10.5px] text-[var(--text-faint)]">模型</span><span className="min-w-0 flex-1" /><button type="button" onClick={addModel} className="text-[10px] text-[var(--text-muted)] hover:text-[var(--text)]">+ 添加模型</button></div>
        <div className="flex flex-col gap-1">
          {card.models.map((model, index) => (
            <div key={`${model.id}-${index}`} className="grid gap-1 rounded-md bg-[var(--surface-2)] p-1.5 sm:grid-cols-[1fr_1fr_70px_auto]">
              <SettingsField value={model.id} onChange={(e) => updateModel(index, { id: e.target.value })} aria-label="模型 ID" placeholder="model id" className="h-7 font-mono text-[11px]" />
              <SettingsField value={model.name} onChange={(e) => updateModel(index, { name: e.target.value })} aria-label="模型名称" placeholder="显示名称" className="h-7 text-[11px]" />
              <SettingsNumberField allowEmpty value={model.dimension ?? null} onCommit={(value) => updateModel(index, { dimension: value ?? undefined })} aria-label="向量维度" placeholder="维度" className="h-7 text-[11px]" />
              <div className="flex items-center gap-1">
                <SettingsSwitch checked={Boolean(model.vision)} label="图片输入" onChange={(vision) => updateModel(index, { vision })} />
                <button type="button" aria-label="移除模型" disabled={card.models.length <= 1} onClick={() => removeModel(index)} className="text-[var(--text-faint)] hover:text-[var(--err)] disabled:opacity-30"><Trash2 size={12} /></button>
              </div>
            </div>
          ))}
        </div>
      </div>
      <div className="mt-2 flex items-center gap-2">
        <SettingsButton variant="quiet" onClick={() => void runTest()} disabled={test.state === 'busy'}>{test.state === 'busy' ? <Loader2 size={13} className="animate-spin" /> : <FlaskConical size={13} />}测试连接</SettingsButton>
        {test.state === 'ok' ? <span className="text-[10.5px] text-[var(--ok)]">{test.text}</span> : test.state === 'error' ? <span className="min-w-0 flex-1 break-words text-[10.5px] text-[var(--err)]">{test.text}</span> : null}
        <span className="min-w-0 flex-1" />
        <button type="button" onClick={onClose} className="h-7 rounded-md px-2 text-[10.5px] text-[var(--text-muted)] hover:bg-[var(--bg-hover)]">收起</button>
      </div>
      {card.docsUrl ? <a href={card.docsUrl} target="_blank" rel="noreferrer" className="mt-1 inline-flex items-center gap-1 text-[10px] text-[var(--text-faint)] hover:text-[var(--text)]">文档<ExternalLink size={10} /></a> : null}
    </div>
  );
}

function CatalogDialog({ catalog, categories, scope, onScope, category, onCategory, onAdd, onClose }: {
  catalog: ProviderCatalogEntry[]; categories: ProviderCategoryInfo[]; scope: 'all' | 'cloud' | 'local'; category: 'all' | ProviderCategory;
  onScope: (scope: 'all' | 'cloud' | 'local') => void; onCategory: (category: 'all' | ProviderCategory) => void;
  onAdd: (entry: ProviderCatalogEntry) => void; onClose: () => void;
}) {
  return (
    <div className="fixed inset-0 z-[10100] flex items-center justify-center bg-black/45 p-4 backdrop-blur-[2px]" onClick={onClose}>
      <div className="flex max-h-[min(760px,90vh)] w-full max-w-[860px] flex-col overflow-hidden rounded-[12px] border border-[var(--border-strong)] bg-[var(--panel)] shadow-[var(--shadow-lg)]" onClick={(event) => event.stopPropagation()}>
        <div className="flex shrink-0 items-center gap-2 border-b border-[var(--border-soft)] px-4 py-3"><Server size={15} className="text-[var(--accent)]" /><span className="text-[13px] font-medium text-[var(--text)]">添加内置提供商</span><span className="min-w-0 flex-1" /><button type="button" onClick={onClose} className="text-[var(--text-faint)] hover:text-[var(--text)]"><X size={15} /></button></div>
        <div className="flex flex-wrap items-center gap-1 border-b border-[var(--border-soft)] px-3 py-2">
          {(['all', 'cloud', 'local'] as const).map((id) => <button key={id} type="button" onClick={() => onScope(id)} className={`h-6 rounded px-2 text-[10.5px] ${scope === id ? 'bg-[var(--surface-3)] text-[var(--text)]' : 'text-[var(--text-muted)]'}`}>{id === 'all' ? '全部' : id === 'cloud' ? '云端' : '本地'}</button>)}
          <span className="h-4 w-px bg-[var(--border)]" />
          <button type="button" onClick={() => onCategory('all')} className={`h-6 rounded px-2 text-[10.5px] ${category === 'all' ? 'bg-[var(--surface-3)] text-[var(--text)]' : 'text-[var(--text-muted)]'}`}>全部类别</button>
          {categories.map((item) => <button key={item.id} type="button" onClick={() => onCategory(item.id)} className={`h-6 rounded px-2 text-[10.5px] ${category === item.id ? 'bg-[var(--surface-3)] text-[var(--text)]' : 'text-[var(--text-muted)]'}`}>{item.label}</button>)}
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto p-3">
          <div className="grid gap-2 sm:grid-cols-2">
            {catalog.map((entry) => (
              <button key={entry.id} type="button" onClick={() => onAdd(entry)} className="flex min-w-0 items-center gap-2 rounded-[9px] border border-[var(--border)] bg-[var(--surface-2)] p-2.5 text-left transition hover:border-[var(--border-strong)]">
                <ProviderMark id={entry.vendorId} size={16} />
                <span className="min-w-0 flex-1"><span className="block truncate text-[11.5px] font-medium text-[var(--text)]">{entry.name}</span><span className="block truncate text-[9.5px] text-[var(--text-faint)]">{entry.scope === 'cloud' ? '云端' : '本地'} · {entry.models.length} 个模型 · {entry.protocol}</span></span>
                <Plus size={13} className="shrink-0 text-[var(--text-faint)]" />
              </button>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}

function protocolOptions(category: ProviderCategory) {
  const chat = [
    { value: 'openai-chat', label: 'OpenAI Chat' }, { value: 'openai-responses', label: 'OpenAI Responses' },
    { value: 'anthropic-messages', label: 'Anthropic Messages' }, { value: 'gemini-generate', label: 'Gemini' },
  ];
  const builtin = { value: 'builtin', label: '内置适配器' };
  if (category === 'embedding') return [
    { value: 'openai-embeddings', label: 'OpenAI Embeddings' },
    { value: 'openai-multimodal-embeddings', label: '多模态 Embeddings' },
    { value: 'local-clip', label: '本地 CLIP（sidecar）' },
  ];
  if (category === 'llm' || category === 'vl') return chat;
  if (category === 'web-search') return [...chat, { value: 'openai-chat-search', label: 'Chat + 联网搜索' }, builtin];
  if (category === 'tts') return [{ value: 'openai-speech', label: 'OpenAI Speech' }, builtin];
  if (category === 'asr') return [{ value: 'openai-transcriptions', label: 'OpenAI Transcriptions' }, builtin];
  if (category === 'image') return [{ value: 'openai-images', label: 'OpenAI Images' }, builtin];
  if (category === 'video') return [{ value: 'openai-video-async', label: '异步视频' }, builtin];
  return [...chat, builtin];
}
