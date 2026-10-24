/**
 * The storyboard and rough-cut surface: cards grouped by scene, a rhythm strip, the contextual shelf,
 * and the director. It is the only owner of the storyboard document on this page; child components
 * receive shots and emit edits, so saving and revision conflicts stay in one place.
 */
import * as React from 'react';
import {
  ChevronDown, Clapperboard, Film, LayoutGrid, ListOrdered,
  Loader2, Lock, LockOpen, Plus, Sparkles, Trash2, Upload, WandSparkles, X,
} from 'lucide-react';
import { useT } from '@/i18n';
import { api, ApiError, type PipelineRun, type SemanticHit, type StoryboardCandidate, type StoryboardDocument, type StoryboardShot } from '@/api';
import { formatClipDuration, type MediaListing, type MediaSources, type WorkspaceResource } from '@/lib/workspace-resources';
import { ConfirmDialog } from '../../ConfirmDialog';
import { PANE_BAR, PANE_TITLE } from '../../dock-pane-bar';
import { sourceTime } from './time';
import { DockPaneDivider, MIN_DOCK_H, MIN_STAGE_H, PaneDivider, usePaneSize } from '../../PaneDivider';
import { loadBasket, saveBasket, type BasketItem } from '../../media/basket';
import { MaterialShelf, type ShelfTab } from './MaterialShelf';
import { DirectorPanel } from './DirectorPanel';
import { useStoryboard } from './use-storyboard';
import { MediaPreviewDialog, type PreviewTarget } from './MediaPreviewDialog';
import { useDismissOutside } from '@/lib/use-dismiss-outside';
import { NumberInput } from '../../NumberInput';

type View = 'board' | 'sequence';
type Filter = 'all' | 'review' | 'gap' | 'generated';

export function StoryboardStage({
  projectId,
  listing,
  sources,
  onAddToTimeline,
  onHandoffComplete,
  onEnterEdit,
  onSettings,
  notify,
  error,
}: {
  projectId: string;
  listing: MediaListing | null;
  sources: MediaSources;
  onAddToTimeline: (items: readonly { path: string; startMs: number; endMs: number }[], options?: { replace?: boolean }) => Promise<number>;
  /** after the rough cut is in the timeline: make its subtitles when the person asked for them */
  onHandoffComplete?: (subtitles: boolean) => Promise<void>;
  onEnterEdit: () => void;
  onSettings: () => void;
  notify: (message: string) => void;
  error: (message: string) => void;
}) {
  const t = useT();
  const story = useStoryboard(projectId);
  const [view, setView] = React.useState<View>('board');
  const [filter, setFilter] = React.useState<Filter>('all');
  const [selected, setSelected] = React.useState<string[]>([]);
  const [expandedShot, setExpandedShot] = React.useState<string | null>(null);
  const [tab, setTab] = React.useState<ShelfTab>('library');
  const [basket, setBasket] = React.useState<BasketItem[]>(() => loadBasket(projectId));
  const [generateOpen, setGenerateOpen] = React.useState(false);
  const [generateText, setGenerateText] = React.useState('');
  const [generatePrompt, setGeneratePrompt] = React.useState('');
  const [generateDuration, setGenerateDuration] = React.useState(30);
  const [importing, setImporting] = React.useState(false);
  const [configured, setConfigured] = React.useState<boolean | null>(null);
  const [handoffOpen, setHandoffOpen] = React.useState(false);
  const [handoffSubtitles, setHandoffSubtitles] = React.useState(true);
  const [handoffBusy, setHandoffBusy] = React.useState(false);
  const [fillShot, setFillShot] = React.useState<StoryboardShot | null>(null);
  const [replaceOpen, setReplaceOpen] = React.useState(false);
  const [preview, setPreview] = React.useState<PreviewTarget | null>(null);
  /** Ranges marked with I/O in the preview, by material path; using a material takes this part. */
  const [previewRanges, setPreviewRanges] = React.useState<Record<string, { startMs: number; endMs: number }>>({});
  const [pipeline, setPipeline] = React.useState<PipelineRun | null>(null);
  const [pipelineStarting, setPipelineStarting] = React.useState(false);
  const [candidateLimit, setCandidateLimit] = React.useState(16);
  const stageRef = React.useRef<HTMLDivElement>(null);
  const rowRef = React.useRef<HTMLDivElement>(null);
  const { width: directorWidth, commit: commitDirectorWidth } = usePaneSize('openfilm.storyboard.directorW', 390, 300);
  const { width: shelfHeight, commit: commitShelfHeight } = usePaneSize('openfilm.storyboard.shelfH', 166, 120);
  const directorW = directorWidth ?? 390;
  const shelfH = shelfHeight ?? 166;
  const inputRef = React.useRef<HTMLInputElement>(null);
  const doc = story.doc;

  useDismissOutside(selected.length > 0, () => setSelected([]), '[data-shot-id], [data-storyboard-agent], [data-storyboard-shelf]');
  /* An expanded card collapses on any press outside it, including a dialog or toolbar control:
     once it is twice the card's size it covers enough of the board that its edges must be easy to
     dismiss. Its form is committed by the card when `expanded` turns false. */
  useDismissOutside(Boolean(expandedShot), () => setExpandedShot(null), '[data-expanded-shot]', { ignoreControls: false });

  React.useEffect(() => { saveBasket(projectId, basket); }, [projectId, basket]);
  React.useEffect(() => {
    void api.prefs().then((prefs) => setCandidateLimit(Math.max(3, Math.min(30, prefs.storyboard?.candidateCount ?? 16)))).catch(() => {});
  }, []);
  React.useEffect(() => {
    let live = true;
    const read = () => void Promise.all([api.agentCards(), api.providerCards()]).then(([agentCards, providers]) => {
      if (!live) return;
      const agent = agentCards.state.agents.find((item) => item.role === 'storyboard' && item.enabled);
      const card = providers.state.cards.find((item) => item.id === agent?.cardId && item.enabled);
      setConfigured(Boolean(agent && card && agent.modelId));
    }).catch(() => { if (live) setConfigured(null); });
    read();
    window.addEventListener('focus', read);
    return () => { live = false; window.removeEventListener('focus', read); };
  }, []);
  React.useEffect(() => {
    let live = true;
    void api.storyboardRun(projectId).then((run) => { if (live) setPipeline(run); }).catch(() => {});
    return () => { live = false; };
  }, [projectId]);
  React.useEffect(() => {
    if (pipeline?.state !== 'running') return undefined;
    let live = true;
    const timer = setInterval(() => {
      void api.storyboardRun(projectId).then((run) => {
        if (!live) return;
        setPipeline(run);
        if (run.state === 'done') {
          void story.load().then(() => notify(t('storyboard.saved')));
        } else if (run.state === 'error') {
          error(run.error || t('storyboard.error'));
        } else if (run.state === 'cancelled') {
          notify('已取消分镜流水线');
        }
      }).catch(() => {});
    }, 900);
    return () => { live = false; clearInterval(timer); };
  }, [pipeline?.state, projectId, story.load, notify, error, t]);
  React.useEffect(() => {
    if (!doc) return;
    setSelected((current) => current.filter((id) => doc.shots.some((shot) => shot.id === id)));
  }, [doc?.shots]);

  const files = React.useMemo(() => {
    if (!listing) return [] as WorkspaceResource[];
    const byPath = new Map<string, WorkspaceResource>();
    for (const file of listing.files) byPath.set(file.path, file);
    for (const page of listing.pages) if (!byPath.has(page.path)) byPath.set(page.path, page);
    return [...byPath.values()];
  }, [listing]);
  const primary = selected.length === 1 ? doc?.shots.find((shot) => shot.id === selected[0]) ?? null : null;
  const previewOfCandidate = (candidate: StoryboardCandidate, shotId?: string): PreviewTarget => {
    const file = files.find((item) => item.path === candidate.path);
    const src = file ? sources.file(file) : `/api/index/media?libraryId=${encodeURIComponent(candidate.libraryId)}&path=${encodeURIComponent(candidate.path)}`;
    const marked = previewRanges[candidate.path];
    return {
      title: candidate.name,
      src,
      ...(candidate.thumbUrl ? { poster: candidate.thumbUrl } : {}),
      kind: candidate.kind === 'video' ? 'video' : candidate.kind === 'image' ? 'image' : 'other',
      startMs: marked?.startMs ?? candidate.startMs,
      endMs: marked?.endMs ?? candidate.endMs,
      id: candidate.path,
      ...(shotId ? { shotId } : {}),
      candidateId: candidate.id,
    };
  };
  const previewOfFile = (file: WorkspaceResource): PreviewTarget => {
    const marked = previewRanges[file.path];
    return {
      title: file.name,
      src: sources.file(file),
      ...(file.kind === 'video' && sources.poster?.(file) ? { poster: sources.poster(file) } : {}),
      kind: file.kind === 'video' ? 'video' : file.kind === 'image' ? 'image' : 'other',
      startMs: marked?.startMs ?? 0,
      endMs: marked?.endMs ?? file.durationMs,
      id: file.path,
    };
  };
  const closePreview = (range?: { startMs: number; endMs: number; edited?: boolean }) => {
    const current = preview;
    if (current?.kind === 'video' && range?.edited && current.id) {
      setPreviewRanges((all) => ({ ...all, [current.id!]: { startMs: range.startMs, endMs: range.endMs } }));
      if (current.shotId && current.candidateId) {
        const duration = Math.max(500, range.endMs - range.startMs);
        story.update((draft) => {
          const shot = draft.shots.find((item) => item.id === current.shotId);
          const candidate = shot?.match.candidates.find((item) => item.id === current.candidateId);
          if (!shot || !candidate) return;
          candidate.startMs = range.startMs;
          candidate.endMs = range.endMs;
          if (shot.match.selectedId === candidate.id) {
            shot.targetMs = duration;
            shot.match.stale = false;
          }
        });
      }
    }
    setPreview(null);
  };
  const visibleShots = (doc?.shots ?? []).filter((shot) => {
    if (filter === 'review') return shot.match.state === 'review' || shot.match.stale;
    if (filter === 'gap') return shot.match.state === 'gap' || !shot.match.selectedId;
    if (filter === 'generated') return shot.generated || shot.match.candidates.some((candidate) => candidate.origin === 'generated');
    return true;
  });
  const pipelineStep = pipeline?.steps.find((item) => item.id === pipeline.step) ?? pipeline?.steps.find((item) => item.state === 'running') ?? null;
  const totalMs = (doc?.shots ?? []).reduce((sum, shot) => sum + shot.targetMs, 0);
  const gaps = (doc?.shots ?? []).filter((shot) => !shot.match.selectedId || shot.match.state === 'gap').length;
  const low = (doc?.shots ?? []).filter((shot) => shot.match.selectedId && shot.match.confidence < 55).length;

  const select = (shot: StoryboardShot, event?: Pick<React.MouseEvent, 'metaKey' | 'ctrlKey' | 'shiftKey'>) => {
    setSelected((current) => {
      if (event?.metaKey || event?.ctrlKey) return current.includes(shot.id) ? current.filter((id) => id !== shot.id) : [...current, shot.id];
      if (event?.shiftKey && current.length) {
        const all = doc?.shots ?? [];
        const from = all.findIndex((item) => item.id === current[current.length - 1]);
        const to = all.findIndex((item) => item.id === shot.id);
        if (from >= 0 && to >= 0) {
          const [a, b] = from < to ? [from, to] : [to, from];
          return all.slice(a, b + 1).map((item) => item.id);
        }
      }
      return [shot.id];
    });
    setTab('candidates');
  };

  const importFile = async (file: File | undefined) => {
    if (!file) return;
    if (/\.pdf$/i.test(file.name)) { error(t('storyboard.pdfHint')); return; }
    setImporting(true);
    try {
      const text = (await file.text()).replace(/\0/g, '').slice(0, 120_000);
      setGenerateText(text);
      setGenerateOpen(true);
    } catch (e) {
      error(e instanceof Error ? e.message : String(e));
    } finally {
      setImporting(false);
      if (inputRef.current) inputRef.current.value = '';
    }
  };

  const runPipeline = async (body: { text?: string; prompt?: string; brief?: { durationMs: number; aspect: string } }) => {
    setPipelineStarting(true);
    try {
      const run = await api.startStoryboardRun(projectId, body);
      setPipeline(run);
      return true;
    } catch (e) {
      error(e instanceof ApiError ? e.message : String(e));
      return false;
    } finally {
      setPipelineStarting(false);
    }
  };

  const generateNow = async () => {
    const started = await runPipeline({ text: generateText, prompt: generatePrompt, brief: { durationMs: Math.round(generateDuration * 1000), aspect: '16:9' } });
    if (started) {
      setGenerateOpen(false);
      setReplaceOpen(false);
      setGenerateText('');
      setGeneratePrompt('');
      setView('board');
      setTab('library');
    }
  };

  const generate = async () => {
    if (doc?.shots.length) { setReplaceOpen(true); return; }
    await generateNow();
  };

  const generateFromPrompt = async (text: string) => {
    const started = await runPipeline({ prompt: text, brief: { durationMs: Math.round(generateDuration * 1000), aspect: '16:9' } });
    if (started) {
      setView('board');
      setTab('library');
      return true;
    }
    return false;
  };

  const runMatch = async (shotIds?: string[]) => {
    await story.flush();
    const result = await story.match(shotIds?.length ? shotIds : selected, candidateLimit);
    if (result === 'success') {
      setTab('candidates');
      notify(t('storyboard.saved'));
    }
    return result;
  };

  const adopt = (candidate: StoryboardCandidate) => {
    if (!primary) return;
    const marked = previewRanges[candidate.path];
    const chosen = marked ? { ...candidate, startMs: marked.startMs, endMs: marked.endMs } : candidate;
    story.update((draft) => {
      const shot = draft.shots.find((item) => item.id === primary.id);
      if (!shot) return;
      shot.match = {
        ...shot.match,
        candidates: shot.match.candidates.map((item) => item.id === candidate.id ? chosen : item),
        selectedId: chosen.id,
        confidence: Math.round(chosen.score * 100),
        state: chosen.score < 0.55 ? 'review' : 'matched',
        stale: false,
      };
      if (marked && marked.endMs > marked.startMs) shot.targetMs = Math.max(500, marked.endMs - marked.startMs);
    });
  };

  const addBasket = (file: WorkspaceResource) => {
    setBasket((current) => current.some((item) => item.path === file.path)
      ? current
      : [...current, { path: file.path, name: file.name, kind: file.kind, startMs: 0, endMs: file.durationMs ?? 0 }]);
  };

  const assignCandidate = (shot: StoryboardShot, candidate: StoryboardCandidate) => {
    story.update((draft) => {
      const target = draft.shots.find((item) => item.id === shot.id);
      if (!target) return;
      target.match = { ...target.match, state: 'matched', candidates: [candidate, ...target.match.candidates.filter((item) => item.id !== candidate.id)], selectedId: candidate.id, confidence: Math.round(candidate.score * 100), stale: false };
    });
    setSelected([shot.id]);
  };

  const assignFile = (shot: StoryboardShot, path: string, startMs = 0, endMs?: number) => {
    const file = files.find((item) => item.path === path);
    if (!file) return;
    const marked = previewRanges[path];
    const from = endMs == null ? marked?.startMs ?? startMs : startMs;
    const end = endMs ?? marked?.endMs ?? file.durationMs ?? 0;
    assignCandidate(shot, {
      id: `candidate_manual_${Date.now().toString(36)}`,
      libraryId: projectId,
      libraryName: 'Project',
      assetId: path,
      path,
      name: file.name,
      kind: file.kind,
      startMs: from,
      endMs: end,
      score: 1,
      thumbUrl: file.kind === 'video' ? sources.poster?.(file) ?? '' : file.kind === 'image' ? sources.file(file) : '',
      origin: 'library',
    });
    if (endMs == null && marked && marked.endMs > marked.startMs) {
      story.update((draft) => {
        const target = draft.shots.find((item) => item.id === shot.id);
        if (target) target.targetMs = Math.max(500, marked.endMs - marked.startMs);
      });
    }
  };

  const assignHit = (hit: SemanticHit) => {
    if (!primary) { error('先选择一个分镜，再点击素材分配。'); return; }
    assignCandidate(primary, {
      id: `candidate_search_${Date.now().toString(36)}`,
      libraryId: hit.libraryId,
      libraryName: hit.libraryName,
      assetId: hit.assetId,
      path: hit.path,
      name: hit.name,
      kind: hit.kind,
      startMs: hit.startMs,
      endMs: hit.endMs,
      score: hit.score,
      thumbUrl: hit.thumbUrl,
      origin: 'library',
    });
  };

  const assignShelfFile = (file: WorkspaceResource) => {
    if (!primary) { error('先选择一个分镜，再点击素材分配。'); return; }
    assignFile(primary, file.path);
  };

  const moveShot = (fromId: string, toId: string) => {
    if (fromId === toId) return;
    story.update((draft) => {
      const from = draft.shots.findIndex((shot) => shot.id === fromId);
      const to = draft.shots.findIndex((shot) => shot.id === toId);
      if (from < 0 || to < 0) return;
      const sceneId = draft.shots[to].sceneId;
      const [moved] = draft.shots.splice(from, 1);
      moved.sceneId = sceneId;
      draft.shots.splice(from < to ? to - 1 : to, 0, moved);
      draft.shots.forEach((shot, index) => { shot.order = index; });
    });
  };

  const updateShot = (shotId: string, change: Partial<Pick<StoryboardShot, 'title' | 'narration' | 'visualIntent' | 'targetMs' | 'locked' | 'must' | 'avoid'>>) => {
    story.update((draft) => {
      const shot = draft.shots.find((item) => item.id === shotId);
      if (!shot) return;
      Object.assign(shot, change);
      if ('title' in change || 'narration' in change || 'visualIntent' in change) shot.match = { ...shot.match, stale: true };
    });
  };

  const addShot = (sceneId: string) => {
    story.update((draft) => {
      const index = draft.shots.filter((shot) => shot.sceneId === sceneId).length;
      draft.shots.push({
        id: `shot_${Date.now().toString(36)}`,
        sceneId,
        order: draft.shots.length,
        title: `Shot ${index + 1}`,
        narration: '',
        visualIntent: '',
        must: [],
        avoid: [],
        targetMs: 4000,
        locked: false,
        generated: false,
        match: { state: 'draft', candidates: [], selectedId: null, confidence: 0 },
      });
    });
  };

  const removeShot = (shotId: string) => {
    const shot = doc?.shots.find((item) => item.id === shotId);
    if (!shot || shot.locked) return;
    story.update((draft) => { draft.shots = draft.shots.filter((item) => item.id !== shotId); draft.shots.forEach((item, index) => { item.order = index; }); });
    setSelected((current) => current.filter((id) => id !== shotId));
  };

  const handoff = async () => {
    setHandoffBusy(true);
    try {
      await story.flush();
      const result = await story.handoff();
      if (!result) return;
      const added = result.clips.length ? await onAddToTimeline(result.clips.map((clip) => ({ path: clip.path, startMs: clip.startMs, endMs: clip.endMs })), { replace: true }) : 0;
      if (result.clips.length && !added) { error(t('storyboard.handoffGaps').replace('{n}', String(result.clips.length))); return; }
      if (added < result.clips.length) error(`只导入了 ${added}/${result.clips.length} 个镜头；其余素材不在项目文件夹中。`);
      setHandoffOpen(false);
      notify(t('storyboard.handoffDone'));
      await onHandoffComplete?.(handoffSubtitles);
      onEnterEdit();
    } finally {
      setHandoffBusy(false);
    }
  };

  const filteredScene = (sceneId: string) => (doc?.shots ?? []).filter((shot) => shot.sceneId === sceneId && visibleShots.includes(shot));

  if (story.loading) {
    return <div className="flex min-h-0 flex-1 items-center justify-center rounded-[7px] bg-[var(--dock-pane)] text-[12px] text-[var(--text-faint)]"><Loader2 size={15} className="mr-2 animate-spin" />{t('storyboard.generating')}</div>;
  }

  return (
    <div ref={stageRef} className="flex min-h-0 min-w-0 flex-1 flex-col gap-[6px]">
      <div ref={rowRef} className="flex min-h-0 min-w-0 flex-1 gap-[6px]">
        <section className="flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden rounded-[7px] bg-[var(--dock-pane)]">
          <div className={PANE_BAR}>
            <WandSparkles size={14} aria-hidden className="shrink-0 text-[var(--text-dim)]" />
            <span className={PANE_TITLE}>{t('storyboard.title')}</span>
            <span className="shrink-0 rounded-full border border-[var(--border)] px-1.5 py-[1px] text-[10px] leading-4 text-[var(--text-faint)]">
              {t('storyboard.shots').replace('{n}', String(doc?.shots.length ?? 0))} · {formatClipDuration(totalMs)}{doc ? ` · ${t('storyboard.target')} ${formatClipDuration(doc.brief.durationMs)}` : ''}{gaps ? ` · ${t('storyboard.gaps').replace('{n}', String(gaps))}` : ''}
            </span>
            <span className="min-w-0 flex-1" />
            {pipeline?.state === 'running' || pipelineStarting ? (
              <span className="flex shrink-0 items-center gap-1.5 rounded-full border border-[var(--accent)] bg-[var(--accent-soft)] px-2 py-[2px] text-[10px] text-[var(--text)]">
                <Loader2 size={10} className="animate-spin" />{pipelineStep?.label ?? '准备分镜流水线'}
                <button type="button" aria-label="取消分镜流水线" onClick={() => void api.cancelStoryboardRun(projectId).then(setPipeline).catch(() => {})} className="text-[var(--text-faint)] hover:text-[var(--err)]"><X size={10} /></button>
              </span>
            ) : pipeline?.state === 'error' ? (
              <span className="flex shrink-0 items-center gap-1 text-[10px] text-[var(--err)]" title={pipeline.error}>流水线失败</span>
            ) : pipeline?.state === 'done' && pipeline.applied.length ? (
              <button type="button" onClick={() => void api.undoStoryboardRun(projectId).then(async () => { await story.load(); setPipeline(null); notify('已撤销连续性 Agent 的安全修改'); }).catch((e) => error(e instanceof Error ? e.message : String(e)))} className="flex h-5 shrink-0 items-center gap-1 rounded px-1.5 text-[10px] text-[var(--text-muted)] ring-1 ring-inset ring-[var(--border)] hover:bg-[var(--bg-hover)] hover:text-[var(--text)]">撤销 AI 修改</button>
            ) : story.busy ? <span className="flex shrink-0 items-center gap-1 text-[10px] text-[var(--text-faint)]"><Loader2 size={10} className="animate-spin" />{t('storyboard.running')}</span> : story.saving ? <span className="shrink-0 text-[10px] text-[var(--text-faint)]">{t('storyboard.saving')}</span> : null}
            {low ? <span className="shrink-0 rounded-full border border-[var(--warn)] px-1.5 py-[1px] text-[10px] text-[var(--warn)]">{t('storyboard.review')} {low}</span> : null}
            <button type="button" onClick={() => void story.flush()} aria-label={t('storyboard.saved')} className="flex h-6 w-6 shrink-0 items-center justify-center rounded-md text-[var(--text-faint)] hover:bg-[var(--bg-hover)] hover:text-[var(--text)]"><ChevronDown size={13} /></button>
          </div>

          <div className="flex h-[42px] shrink-0 items-center gap-1.5 border-b border-[var(--border-soft)] px-2.5">
            <div className="flex gap-0.5 rounded-md border border-[var(--border)] bg-[var(--bg)] p-[2px]">
              <button type="button" onClick={() => setView('board')} className={`flex h-[24px] items-center gap-1 rounded px-2 text-[11px] ${view === 'board' ? 'bg-[var(--surface-3)] text-[var(--text)]' : 'text-[var(--text-muted)] hover:text-[var(--text)]'}`}><LayoutGrid size={11} />{t('storyboard.board')}</button>
              <button type="button" onClick={() => setView('sequence')} className={`flex h-[24px] items-center gap-1 rounded px-2 text-[11px] ${view === 'sequence' ? 'bg-[var(--surface-3)] text-[var(--text)]' : 'text-[var(--text-muted)] hover:text-[var(--text)]'}`}><ListOrdered size={11} />{t('storyboard.sequence')}</button>
            </div>
            <span className="mx-1 h-4 w-px bg-[var(--border)]" />
            {(['all', 'review', 'gap', 'generated'] as const).map((id) => (
              <button key={id} type="button" onClick={() => setFilter(id)} aria-pressed={filter === id}
                className={`h-[24px] rounded px-1.5 text-[10.5px] ${filter === id ? 'bg-[var(--surface-2)] text-[var(--text)]' : 'text-[var(--text-faint)] hover:text-[var(--text)]'}`}>
                {t(id === 'all' ? 'storyboard.all' : id === 'review' ? 'storyboard.reviewFilter' : id === 'gap' ? 'storyboard.gapsFilter' : 'storyboard.generatedFilter')}
              </button>
            ))}
            <span className="min-w-0 flex-1" />
            <button type="button" onClick={() => setGenerateOpen(true)} className="flex h-[26px] items-center gap-1 rounded-md px-2 text-[10.5px] text-[var(--text-muted)] ring-1 ring-inset ring-[var(--border)] hover:bg-[var(--bg-hover)] hover:text-[var(--text)]"><Upload size={11} />{t('storyboard.import')}</button>
            <button type="button" disabled={!doc?.shots.length || story.busy === 'match'} onClick={() => void runMatch(selected.length ? selected : undefined)}
              className="flex h-[26px] items-center gap-1 rounded-md px-2 text-[10.5px] text-[var(--text-muted)] ring-1 ring-inset ring-[var(--border)] hover:bg-[var(--bg-hover)] hover:text-[var(--text)] disabled:opacity-40">
              {story.busy === 'match' ? <Loader2 size={11} className="animate-spin" /> : <Sparkles size={11} />}{selected.length ? t('storyboard.matchSelected') : t('storyboard.autoMatch')}
            </button>
            <label className="flex h-[26px] items-center gap-1.5 rounded-md px-1.5 text-[10px] text-[var(--text-muted)]" title="导入粗剪后自动识别对白并生成字幕">
              <input type="checkbox" checked={handoffSubtitles} onChange={(event) => setHandoffSubtitles(event.target.checked)} />生成字幕
            </label>
            <button type="button" disabled={!doc?.shots.length || Boolean(story.busy)} onClick={() => setHandoffOpen(true)}
              className="flex h-[26px] items-center gap-1 rounded-md bg-[var(--text)] px-2.5 text-[10.5px] font-medium text-[var(--panel)] transition hover:opacity-90 disabled:opacity-40">{t('storyboard.enterEdit')}</button>
          </div>

          {story.error ? <div role="alert" className="flex shrink-0 items-center gap-2 border-b border-[rgba(235,77,77,.2)] bg-[rgba(235,77,77,.06)] px-3 py-1 text-[10.5px] text-[#ff9b9b]"><span className="h-1.5 w-1.5 rounded-full bg-[var(--err)]" />{story.error}</div> : null}

          {!doc?.shots.length ? (
            <EmptyBoard onImport={() => inputRef.current?.click()} onGenerate={() => setGenerateOpen(true)} importing={importing} />
          ) : view === 'board' ? (
            <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain px-3 py-3">
              {doc.scenes.map((scene) => {
                const shots = filteredScene(scene.id);
                if (!shots.length && filter !== 'all') return null;
                return (
                  <section key={scene.id} className="mb-4">
                    <div className="sticky top-0 z-10 mb-2 flex items-center gap-2 bg-[var(--dock-pane)]/95 py-1 backdrop-blur-sm">
                      <span className="text-[10px] font-medium uppercase tracking-[0.11em] text-[var(--text-faint)]">{t('storyboard.scene')} {String(scene.order + 1).padStart(2, '0')}</span>
                      <span className="text-[11px] font-medium text-[var(--text-muted)]">{scene.title}</span>
                      <span className="text-[10px] tabular-nums text-[var(--text-faint)]">{shots.length} {t('storyboard.shots').replace('{n}', '').trim()}</span>
                      <span className="min-w-0 flex-1" />
                      <button type="button" onClick={() => addShot(scene.id)} aria-label={t('storyboard.addShot')} className="flex h-5 w-5 items-center justify-center rounded text-[var(--text-faint)] hover:bg-[var(--bg-hover)] hover:text-[var(--text)]"><Plus size={12} /></button>
                    </div>
                    <div className="grid grid-cols-[repeat(auto-fill,minmax(236px,1fr))] gap-2.5">
                      {shots.map((shot) => (
                        <ShotCard key={shot.id} shot={shot} selected={selected.includes(shot.id)} expanded={expandedShot === shot.id} onToggleExpanded={(open) => setExpandedShot(open ? shot.id : null)} onSelect={(event) => select(shot, event)}
                          onChange={(change) => updateShot(shot.id, change)} onMatch={() => void runMatch([shot.id])} onRemove={() => removeShot(shot.id)}
                          onGenerateFill={() => setFillShot(shot)} onDropFile={(path, startMs, endMs) => assignFile(shot, path, startMs, endMs)}
                          onDropShot={(fromId) => moveShot(fromId, shot.id)} onPreview={(candidate) => setPreview(previewOfCandidate(candidate, shot.id))} />
                      ))}
                    </div>
                  </section>
                );
              })}
              <div className="h-1" />
            </div>
          ) : (
            <SequenceBoard doc={doc} selected={selected} onSelect={select} />
          )}

          <RhythmStrip doc={doc} selected={selected} onSelect={(shot) => select(shot)} />
        </section>

        <PaneDivider width={directorW} onResize={commitDirectorWidth} containerRef={rowRef} label="调整分镜板与 AI 导演的宽度" min={300} minRest={420} side="end" />
        <div className="flex min-h-0 shrink-0" style={{ width: directorW }}>
          <DirectorPanel doc={doc} selectedIds={selected} busy={story.busy} error={story.error || ''} configured={configured}
            chat={async (text, ids) => { await story.flush(); return story.chat(text, ids); }} apply={async (proposal, operations) => { await story.flush(); return story.apply(proposal, operations); }} onMatch={runMatch} onGenerateFromPrompt={generateFromPrompt} onOpenSettings={onSettings} onUndo={story.undo} pipeline={pipeline} />
        </div>
      </div>

      <DockPaneDivider height={shelfH} onResize={commitShelfHeight} containerRef={stageRef} label="调整素材池高度" min={MIN_DOCK_H} minRest={MIN_STAGE_H} />
      <div className="shrink-0" style={{ height: shelfH }}>
        <MaterialShelf projectId={projectId} files={files} sources={sources} doc={doc ?? emptyDoc()} shot={primary} tab={tab} onTab={setTab}
          basket={basket} onAddBasket={addBasket} onRemoveBasket={(item) => setBasket((current) => current.filter((one) => one !== item))}
          onSelectShot={(id) => { const shot = doc?.shots.find((item) => item.id === id); if (shot) select(shot); }} onAdopt={adopt} onAssignFile={assignShelfFile} onAssignHit={assignHit} onMatch={() => void runMatch(primary ? [primary.id] : selected)}
          matching={story.busy === 'match'} limit={candidateLimit} onPreview={(candidate) => setPreview(previewOfCandidate(candidate, doc?.shots.find((item) => item.match.candidates.some((one) => one.id === candidate.id))?.id))} onPreviewFile={(file) => setPreview(previewOfFile(file))} />
      </div>

      <MediaPreviewDialog target={preview} onClose={closePreview} />
      <input ref={inputRef} type="file" accept=".md,.markdown,.txt,.pdf,text/plain,text/markdown" className="hidden" onChange={(e) => void importFile(e.target.files?.[0])} />
      <GenerateDialog open={generateOpen} onClose={() => setGenerateOpen(false)} text={generateText} prompt={generatePrompt} duration={generateDuration}
        hasExisting={Boolean(doc?.shots.length)} onText={setGenerateText} onPrompt={setGeneratePrompt} onDuration={setGenerateDuration} busy={pipelineStarting || pipeline?.state === 'running'} onGenerate={() => void generate()} />
      <FillDialog shot={fillShot} busy={story.busy === 'fill'} error={story.error} onClose={() => setFillShot(null)}
        onGenerate={async (prompt, duration) => {
          if (!fillShot) return;
          await story.flush();
          const result = await story.fill(fillShot.id, prompt, duration);
          if (result === 'success') {
            setFillShot(null);
            setSelected([fillShot.id]);
            setTab('candidates');
            notify(t('storyboard.saved'));
          }
        }} />
      <ConfirmDialog open={replaceOpen} title={t('storyboard.replaceTitle')} description={t('storyboard.replaceHint').replace('{n}', String(doc?.shots.length ?? 0))}
        confirmLabel={t('storyboard.replaceConfirm')} cancelLabel={t('storyboard.handoffCancel')} onConfirm={() => void generateNow()} onCancel={() => setReplaceOpen(false)} />
      <ConfirmDialog open={handoffOpen} title={t('storyboard.handoffTitle')}
        description={`${t('storyboard.handoffHint')} ${gaps ? t('storyboard.handoffGaps').replace('{n}', String(gaps)) : ''} 会将当前剪辑时间线替换为这份粗剪${handoffSubtitles ? '，并自动生成字幕' : ''}。`}
        confirmLabel={handoffBusy ? t('storyboard.running') : t('storyboard.handoffConfirm')} cancelLabel={t('storyboard.handoffCancel')}
        onConfirm={() => void handoff()} onCancel={() => setHandoffOpen(false)} />
      {story.error ? <p className="sr-only" role="alert">{story.error}</p> : null}
    </div>
  );
}

function EmptyBoard({ onImport, onGenerate, importing }: { onImport: () => void; onGenerate: () => void; importing: boolean }) {
  const t = useT();
  return (
    <div className="flex min-h-0 flex-1 items-center justify-center overflow-y-auto px-6 py-10">
      <div className="flex max-w-[620px] flex-col items-center text-center">
        <div className="mb-4 flex h-12 w-12 items-center justify-center rounded-2xl border border-[var(--border)] bg-[var(--surface-2)] text-[var(--text-muted)]"><Clapperboard size={22} /></div>
        <h2 className="text-[17px] font-semibold tracking-[-0.01em] text-[var(--text)]">{t('storyboard.emptyTitle')}</h2>
        <p className="mt-2 max-w-[430px] text-[12px] leading-relaxed text-[var(--text-muted)]">{t('storyboard.emptyHint')}</p>
        <div className="mt-4 flex items-center gap-2">
          <button type="button" onClick={onImport} disabled={importing} className="flex h-8 items-center gap-1.5 rounded-lg bg-[var(--text)] px-3 text-[11.5px] font-medium text-[var(--panel)] disabled:opacity-40"><Upload size={13} />{importing ? t('storyboard.generating') : t('storyboard.import')}</button>
          <button type="button" onClick={onGenerate} className="flex h-8 items-center gap-1.5 rounded-lg border border-[var(--border-strong)] px-3 text-[11.5px] text-[var(--text)] hover:bg-[var(--bg-hover)]"><Sparkles size={13} />{t('storyboard.startChat')}</button>
        </div>
        <p className="mt-2 text-[10.5px] text-[var(--text-faint)]">{t('storyboard.importHint')}</p>
        <div className="mt-8 grid w-full grid-cols-4 gap-2 text-left">
          {['01 Brief', '02 Storyboard', '03 Match', '04 Fine cut'].map((step, index) => (
            <div key={step} className="rounded-lg border border-[var(--border)] bg-[var(--surface-2)] p-2.5">
              <span className="text-[10px] tabular-nums text-[var(--text-faint)]">0{index + 1}</span>
              <p className="mt-1 text-[11px] text-[var(--text-muted)]">{step.slice(3)}</p>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

function GenerateDialog({ open, onClose, text, prompt, duration, hasExisting, onText, onPrompt, onDuration, busy, onGenerate }: {
  open: boolean; onClose: () => void; text: string; prompt: string; duration: number; hasExisting: boolean;
  onText: (value: string) => void; onPrompt: (value: string) => void; onDuration: (value: number) => void;
  busy: boolean; onGenerate: () => void;
}) {
  const t = useT();
  if (!open) return null;
  return (
    <div className="fixed inset-0 z-[10100] flex items-center justify-center bg-black/45 p-4 backdrop-blur-[2px]" onClick={onClose}>
      <div className="w-full max-w-[560px] overflow-hidden rounded-[10px] border border-[var(--border-strong)] bg-[var(--panel)] shadow-[var(--shadow-lg)]" onClick={(event) => event.stopPropagation()} role="dialog" aria-modal="true" aria-label={t('storyboard.generateTitle')}>
        <div className="flex items-center gap-2 border-b border-[var(--border-soft)] px-4 py-3">
          <Sparkles size={15} className="text-[var(--accent)]" />
          <span className="text-[13px] font-medium text-[var(--text)]">{t('storyboard.generateTitle')}</span>
          <span className="min-w-0 flex-1" />
          <button type="button" onClick={onClose} className="text-[var(--text-faint)] hover:text-[var(--text)]"><X size={15} /></button>
        </div>
        <div className="flex flex-col gap-3 p-4">
          <p className="text-[11px] leading-relaxed text-[var(--text-muted)]">{t('storyboard.generateHint')}</p>
          <textarea value={text} onChange={(event) => onText(event.target.value)} rows={7} placeholder="# Scene 01&#10;..." aria-label="Script"
            className="w-full resize-y rounded-lg border border-[var(--border)] bg-[var(--bg)] px-3 py-2 text-[12px] leading-relaxed text-[var(--text)] outline-none placeholder:text-[var(--text-faint)] focus:border-[var(--border-strong)]" />
          <input value={prompt} onChange={(event) => onPrompt(event.target.value)} placeholder={t('storyboard.promptPlaceholder')} aria-label={t('storyboard.promptPlaceholder')}
            className="h-9 rounded-lg border border-[var(--border)] bg-[var(--bg)] px-3 text-[12px] text-[var(--text)] outline-none placeholder:text-[var(--text-faint)] focus:border-[var(--border-strong)]" />
          <label className="flex items-center gap-3 text-[11px] text-[var(--text-muted)]">{t('storyboard.briefDuration')}
            <NumberInput min={1} max={600} value={duration} onCommit={(value) => onDuration(value ?? 30)}
              className="h-8 w-20 rounded-md border border-[var(--border)] bg-[var(--bg)] px-2 tabular-nums text-[var(--text)] outline-none" /> s
          </label>
        </div>
        <div className="flex items-center justify-end gap-2 border-t border-[var(--border-soft)] px-4 py-2.5">
          <button type="button" onClick={onClose} className="h-7 rounded-md px-3 text-[11px] text-[var(--text-muted)] hover:bg-[var(--bg-hover)]">{t('storyboard.handoffCancel')}</button>
          <button type="button" onClick={onGenerate} disabled={busy || (!text.trim() && !prompt.trim() && !hasExisting)}
            className="flex h-7 items-center gap-1.5 rounded-md bg-[var(--text)] px-3 text-[11px] font-medium text-[var(--panel)] disabled:opacity-40">
            {busy ? <Loader2 size={12} className="animate-spin" /> : <Sparkles size={12} />}{busy ? t('storyboard.generating') : t('storyboard.generate')}
          </button>
        </div>
      </div>
    </div>
  );
}

function FillDialog({ shot, busy, error, onClose, onGenerate }: {
  shot: StoryboardShot | null; busy: boolean; error: string; onClose: () => void; onGenerate: (prompt: string, duration: number) => Promise<void>;
}) {
  const t = useT();
  const [prompt, setPrompt] = React.useState('');
  const [duration, setDuration] = React.useState(5);
  React.useEffect(() => {
    if (!shot) return;
    setPrompt([shot.visualIntent, shot.must.join('，'), shot.avoid.length ? `避免：${shot.avoid.join('，')}` : ''].filter(Boolean).join('；'));
    setDuration(Math.max(4, Math.min(30, Math.round(shot.targetMs / 1000))));
  }, [shot]);
  if (!shot) return null;
  return (
    <div className="fixed inset-0 z-[10100] flex items-center justify-center bg-black/45 p-4 backdrop-blur-[2px]" onClick={onClose}>
      <div className="w-full max-w-[480px] overflow-hidden rounded-[10px] border border-[var(--border-strong)] bg-[var(--panel)] shadow-[var(--shadow-lg)]" onClick={(event) => event.stopPropagation()} role="dialog" aria-modal="true" aria-label={t('storyboard.generateFill')}>
        <div className="flex items-center gap-2 border-b border-[var(--border-soft)] px-4 py-3"><Sparkles size={14} className="text-[var(--warn)]" /><span className="text-[13px] font-medium text-[var(--text)]">{t('storyboard.generateFill')}</span><span className="min-w-0 flex-1" /><button type="button" onClick={onClose} className="text-[var(--text-faint)] hover:text-[var(--text)]"><X size={15} /></button></div>
        <div className="flex flex-col gap-3 p-4">
          <p className="text-[11px] leading-relaxed text-[var(--text-muted)]">{t('storyboard.fillHint')}</p>
          <label className="flex flex-col gap-1 text-[11px] text-[var(--text-faint)]">{t('storyboard.fillPrompt')}
            <textarea value={prompt} onChange={(event) => setPrompt(event.target.value)} rows={4} className="resize-y rounded-lg border border-[var(--border)] bg-[var(--bg)] px-3 py-2 text-[12px] leading-relaxed text-[var(--text)] outline-none focus:border-[var(--border-strong)]" />
          </label>
          <label className="flex items-center gap-2 text-[11px] text-[var(--text-muted)]">{t('storyboard.briefDuration')}
            <NumberInput min={4} max={30} value={duration} onCommit={(value) => setDuration(value ?? 5)} className="h-8 w-16 rounded border border-[var(--border)] bg-[var(--bg)] px-2 tabular-nums text-[var(--text)] outline-none" /> s
          </label>
          {error ? <p role="alert" className="text-[10.5px] leading-relaxed text-[var(--err)]">{error}</p> : null}
        </div>
        <div className="flex items-center justify-end gap-2 border-t border-[var(--border-soft)] px-4 py-2.5">
          <button type="button" onClick={onClose} className="h-7 rounded-md px-3 text-[11px] text-[var(--text-muted)] hover:bg-[var(--bg-hover)]">{t('storyboard.handoffCancel')}</button>
          <button type="button" disabled={busy || !prompt.trim()} onClick={() => void onGenerate(prompt, duration)} className="flex h-7 items-center gap-1.5 rounded-md bg-[var(--text)] px-3 text-[11px] font-medium text-[var(--panel)] disabled:opacity-40">{busy ? <Loader2 size={12} className="animate-spin" /> : <Sparkles size={12} />}{busy ? t('storyboard.running') : t('storyboard.fillGenerate')}</button>
        </div>
      </div>
    </div>
  );
}

function ShotCard({ shot, selected, expanded, onToggleExpanded, onSelect, onChange, onMatch, onRemove, onGenerateFill, onDropFile, onDropShot, onPreview }: {
  shot: StoryboardShot; selected: boolean; expanded: boolean;
  onToggleExpanded: (open: boolean) => void;
  onSelect: (event: React.MouseEvent) => void;
  onChange: (change: Partial<Pick<StoryboardShot, 'title' | 'narration' | 'visualIntent' | 'targetMs' | 'locked' | 'must' | 'avoid'>>) => void;
  onMatch: () => void; onRemove: () => void; onGenerateFill: () => void;
  onDropFile: (path: string, startMs: number, endMs?: number) => void;
  onDropShot: (fromId: string) => void;
  onPreview: (candidate: StoryboardCandidate) => void;
}) {
  const t = useT();
  const card = React.useRef<HTMLElement>(null);
  const [collapsedSize, setCollapsedSize] = React.useState<{ width: number; height: number } | null>(null);
  const candidate = shot.match.candidates.find((item) => item.id === shot.match.selectedId) ?? null;
  const low = Boolean(candidate && shot.match.confidence < 55);
  const bad = Boolean(candidate && shot.match.confidence < 35);
  const poster = candidate?.thumbUrl;
  const [form, setForm] = React.useState(() => ({
    title: shot.title, narration: shot.narration, visualIntent: shot.visualIntent,
    targetMs: shot.targetMs, must: shot.must.join('，'), avoid: shot.avoid.join('，'),
  }));
  /* The expanded card is exactly twice the collapsed card in both directions. Measure the
     collapsed card rather than guessing from the viewport: cards get wider in a wider board. */
  React.useLayoutEffect(() => {
    const el = card.current;
    if (!el || expanded) return undefined;
    const measure = () => {
      const next = { width: el.offsetWidth, height: el.offsetHeight };
      if (!next.width || !next.height) return;
      setCollapsedSize((current) => current && current.width === next.width && current.height === next.height ? current : next);
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(el);
    return () => observer.disconnect();
  }, [expanded]);
  const commitDetails = () => {
    const next = {
      title: form.title,
      narration: form.narration,
      visualIntent: form.visualIntent,
      targetMs: Math.max(500, Math.min(120_000, Math.round(Number(form.targetMs) || 4000))),
      must: form.must.split(/[，,]/).map((item) => item.trim()).filter(Boolean),
      avoid: form.avoid.split(/[，,]/).map((item) => item.trim()).filter(Boolean),
    };
    if (next.title !== shot.title || next.narration !== shot.narration || next.visualIntent !== shot.visualIntent
      || next.targetMs !== shot.targetMs || next.must.join('\u0000') !== shot.must.join('\u0000') || next.avoid.join('\u0000') !== shot.avoid.join('\u0000')) {
      onChange(next);
    }
  };
  const wasExpanded = React.useRef(expanded);
  React.useEffect(() => {
    if (wasExpanded.current && !expanded) commitDetails();
    wasExpanded.current = expanded;
  });
  const openDetails = () => {
    setForm({ title: shot.title, narration: shot.narration, visualIntent: shot.visualIntent, targetMs: shot.targetMs, must: shot.must.join('，'), avoid: shot.avoid.join('，') });
    onToggleExpanded(true);
  };
  const closeDetails = () => onToggleExpanded(false);
  const stateLabel = shot.locked ? t('storyboard.locked') : shot.match.stale ? t('storyboard.stale') : shot.match.state === 'gap' ? t('storyboard.gap') : shot.match.state === 'review' ? t('storyboard.review') : shot.match.state === 'matched' ? t('storyboard.matched') : t('storyboard.draft');
  const stateClass = shot.match.state === 'gap' ? 'gap' : shot.match.state === 'review' || shot.match.stale ? 'review' : shot.match.state === 'matched' ? 'ok' : '';
  return (
    <article ref={card} data-shot-id={shot.id} data-expanded-shot={expanded ? '' : undefined} onClick={onSelect} draggable
      style={expanded && collapsedSize ? { width: collapsedSize.width * 2, minHeight: collapsedSize.height * 2, justifySelf: 'start' } : undefined}
      onDoubleClick={(event) => {
        const target = event.target as HTMLElement;
        if (target.closest('input, textarea, button, select, [role="button"]')) return;
        if (target.closest('[data-shot-preview]')) {
          event.stopPropagation();
          if (candidate) onPreview(candidate);
          return;
        }
        if (target.closest('[data-shot-text]')) {
          event.stopPropagation();
          if (expanded) closeDetails(); else openDetails();
        }
      }}
      onDragStart={(event) => {
        if ((event.target as HTMLElement).closest('input, textarea, button')) { event.preventDefault(); return; }
        event.dataTransfer.setData('application/x-openfilm-storyboard-shot', shot.id);
        event.dataTransfer.effectAllowed = 'move';
      }}
      onDragOver={(event) => { if (event.dataTransfer.types.some((type) => ['application/x-openfilm-media', 'application/x-openfilm-shot', 'application/x-openfilm-storyboard-shot'].includes(type))) { event.preventDefault(); event.dataTransfer.dropEffect = event.dataTransfer.types.includes('application/x-openfilm-storyboard-shot') ? 'move' : 'copy'; } }}
      onDrop={(event) => {
        const fromId = event.dataTransfer.getData('application/x-openfilm-storyboard-shot');
        const path = event.dataTransfer.getData('application/x-openfilm-media');
        const raw = event.dataTransfer.getData('application/x-openfilm-shot');
        if (fromId) onDropShot(fromId);
        else if (raw) { try { const shotData = JSON.parse(raw) as { path?: string; startMs?: number; endMs?: number }; if (shotData.path) onDropFile(shotData.path, shotData.startMs ?? 0, shotData.endMs); } catch { /* ignore */ } }
        else if (path) onDropFile(path, 0);
        if (path || raw || fromId) { event.preventDefault(); event.stopPropagation(); }
      }}
      className={`group cursor-grab overflow-hidden rounded-lg border bg-[var(--surface)] transition active:cursor-grabbing ${expanded ? 'col-span-2' : ''} ${bad ? 'border-[rgba(235,77,77,.5)]' : low ? 'border-[rgba(255,191,54,.42)]' : 'border-[var(--border)]'} ${selected ? 'ring-1 ring-[var(--accent)]' : ''}`}>
      <div className="flex h-[32px] items-center gap-1.5 border-b border-[var(--border-soft)] px-2">
        <span className="font-mono text-[10px] tabular-nums text-[var(--text-faint)]">{String(shot.order + 1).padStart(2, '0')}</span>
        <span className={`rounded-full px-1.5 py-[1px] text-[9px] ${stateClass === 'gap' ? 'bg-[rgba(235,77,77,.12)] text-[#ff8585]' : stateClass === 'review' ? 'bg-[rgba(255,191,54,.11)] text-[var(--warn)]' : stateClass === 'ok' ? 'bg-[rgba(94,185,45,.11)] text-[#9fe274]' : 'bg-[var(--surface-2)] text-[var(--text-faint)]'}`}>{stateLabel}{candidate && shot.match.state !== 'gap' ? ` ${shot.match.confidence}%` : ''}</span>
        {shot.generated || candidate?.origin === 'generated' ? <span className="rounded bg-[var(--accent-soft)] px-1 py-[1px] text-[9px] text-[var(--accent)]">{t('storyboard.generatedShot')}</span> : null}
        <span className="min-w-0 flex-1" />
        <button type="button" aria-label={shot.locked ? t('storyboard.locked') : t('storyboard.locked')} onClick={(event) => { event.stopPropagation(); onChange({ locked: !shot.locked }); }} className="flex h-6 w-6 items-center justify-center rounded text-[var(--text-faint)] hover:bg-[var(--bg-hover)] hover:text-[var(--text)]">{shot.locked ? <Lock size={13} /> : <LockOpen size={13} />}</button>
        <button type="button" aria-label={t('storyboard.handoffCancel')} onClick={(event) => { event.stopPropagation(); onRemove(); }} className="flex h-6 w-6 items-center justify-center rounded text-[var(--text-faint)] opacity-0 hover:bg-[var(--bg-hover)] hover:text-[var(--err)] group-hover:opacity-100"><Trash2 size={13} /></button>
      </div>
      <div data-shot-preview className={`relative aspect-video select-none overflow-hidden border-b border-[var(--border-soft)] ${candidate ? 'cursor-zoom-in' : ''} ${shot.match.state === 'gap' ? 'bg-[repeating-linear-gradient(135deg,#242424,#242424_7px,#2b2b2b_7px,#2b2b2b_14px)]' : 'bg-[linear-gradient(135deg,#2b4057,#172330)]'}`}>
        {poster ? <img src={poster} alt="" className="absolute inset-0 h-full w-full object-cover" draggable={false} /> : shot.match.state === 'gap' ? <span className="absolute inset-0 flex items-center justify-center text-[10.5px] text-[var(--text-faint)]">{t('storyboard.gap')}</span> : <span className="absolute inset-0 flex items-center justify-center text-[var(--text-faint)]"><Film size={20} /></span>}
        {candidate ? <span className="absolute inset-x-0 bottom-0 flex items-center gap-1 bg-gradient-to-t from-black/75 to-transparent px-2 pb-1.5 pt-5 text-[9.5px] tabular-nums text-white/85"><span>{sourceTime(candidate.startMs)} – {sourceTime(candidate.endMs)}</span><span className="ml-auto">{shot.match.confidence}%</span></span> : null}
      </div>
      <div data-shot-text className={`flex flex-col gap-1 px-2 py-1.5 ${expanded ? 'pb-2' : ''}`}>
        <div className="grid grid-cols-[26px_minmax(0,1fr)] items-baseline gap-1.5">
          <span className="text-[9px] tabular-nums text-[var(--text-faint)]">标题</span>
          <span className="truncate text-[11.5px] font-medium text-[var(--text)]" title={shot.title}>{shot.title}</span>
        </div>
        <div className="grid grid-cols-[26px_minmax(0,1fr)] items-baseline gap-1.5">
          <span className="text-[9px] text-[var(--text-faint)]">旁白</span>
          <span className="line-clamp-2 min-h-[27px] text-left text-[10.5px] leading-snug text-[var(--text-muted)]">{shot.narration || '暂无旁白；双击这里填写'}</span>
        </div>
        <div className="grid grid-cols-[26px_minmax(0,1fr)] items-baseline gap-1.5">
          <span className="text-[9px] text-[var(--text-faint)]">画面</span>
          <span className="truncate text-left text-[10px] text-[var(--text-faint)]" title={shot.visualIntent}>{shot.visualIntent || '暂无画面要求'}</span>
        </div>
        <div className="flex flex-wrap gap-1">
          {shot.must.slice(0, 3).map((item) => <span key={`m${item}`} className="rounded bg-[var(--accent-soft)] px-1 py-[1px] text-[9px] text-[#a8d5ff]">{item}</span>)}
          {shot.avoid.slice(0, 2).map((item) => <span key={`a${item}`} className="rounded bg-[rgba(235,77,77,.08)] px-1 py-[1px] text-[9px] text-[#ffb0b0]">{t('storyboard.avoid')} {item}</span>)}
        </div>
        <div className="flex items-center gap-1 border-t border-[var(--border-soft)] pt-1">
          <span className="min-w-0 flex-1 truncate text-[9.5px] text-[var(--text-faint)]">{candidate ? candidate.name : t('storyboard.candidateEmpty')}</span>
          <button type="button" onClick={(event) => { event.stopPropagation(); expanded ? closeDetails() : openDetails(); }} className="flex h-6 items-center rounded px-1.5 text-[10.5px] text-[var(--text-muted)] ring-1 ring-inset ring-[var(--border)] hover:text-[var(--text)]">{expanded ? '完成' : '详情'}</button>
          <span className="text-[10px] tabular-nums text-[var(--text-faint)]">{(shot.targetMs / 1000).toFixed(1)}s</span>
          {!candidate ? <button type="button" onClick={(event) => { event.stopPropagation(); onGenerateFill(); }} className="flex h-6 items-center rounded px-1.5 text-[10px] text-[var(--warn)] ring-1 ring-inset ring-[rgba(255,191,54,.3)] hover:bg-[rgba(255,191,54,.08)]">{t('storyboard.generateFill')}</button> : null}
          <button type="button" onClick={(event) => { event.stopPropagation(); onMatch(); }} className="flex h-6 items-center rounded px-1.5 text-[10px] text-[var(--text-muted)] ring-1 ring-inset ring-[var(--border)] hover:text-[var(--text)]">{t('storyboard.match')}</button>
        </div>
        <div aria-hidden={!expanded} className={`grid overflow-hidden transition-[grid-template-rows,opacity] duration-200 ${expanded ? 'grid-rows-[1fr] opacity-100' : 'pointer-events-none grid-rows-[0fr] opacity-0'}`}>
          <div className="min-h-0">
            <div className="mt-1 grid gap-1.5 border-t border-[var(--border-soft)] pt-2 sm:grid-cols-2">
              <label className="flex flex-col gap-0.5 text-[9px] text-[var(--text-faint)]">标题<input value={form.title} onChange={(event) => setForm({ ...form, title: event.target.value })} onClick={(event) => event.stopPropagation()} className="h-7 rounded border border-[var(--border)] bg-[var(--bg)] px-1.5 text-[10.5px] text-[var(--text)] outline-none focus:border-[var(--border-strong)]" /></label>
              <label className="flex flex-col gap-0.5 text-[9px] text-[var(--text-faint)]">画面要求<input value={form.visualIntent} onChange={(event) => setForm({ ...form, visualIntent: event.target.value })} onClick={(event) => event.stopPropagation()} className="h-7 rounded border border-[var(--border)] bg-[var(--bg)] px-1.5 text-[10.5px] text-[var(--text)] outline-none focus:border-[var(--border-strong)]" /></label>
              <label className="flex flex-col gap-0.5 text-[9px] text-[var(--text-faint)] sm:col-span-2">旁白<textarea value={form.narration} onChange={(event) => setForm({ ...form, narration: event.target.value })} onClick={(event) => event.stopPropagation()} rows={2} className="resize-y rounded border border-[var(--border)] bg-[var(--bg)] px-1.5 py-1 text-[10.5px] text-[var(--text)] outline-none focus:border-[var(--border-strong)]" /></label>
              <div className="grid grid-cols-2 gap-1.5">
                <label className="flex flex-col gap-0.5 text-[9px] text-[var(--text-faint)]">目标秒数<NumberInput min={0.5} max={120} step={0.1} value={form.targetMs / 1000} onCommit={(value) => setForm({ ...form, targetMs: Math.max(500, Math.round((value ?? 4) * 1000)) })} onClick={(event) => event.stopPropagation()} className="h-7 rounded border border-[var(--border)] bg-[var(--bg)] px-1.5 text-[10.5px] tabular-nums text-[var(--text)] outline-none" /></label>
                <label className="flex items-center gap-1 text-[9px] text-[var(--text-faint)]"><input type="checkbox" checked={shot.locked} onChange={() => onChange({ locked: !shot.locked })} onClick={(event) => event.stopPropagation()} />锁定</label>
              </div>
              <label className="flex flex-col gap-0.5 text-[9px] text-[var(--text-faint)]">必须出现（逗号分隔）<input value={form.must} onChange={(event) => setForm({ ...form, must: event.target.value })} onClick={(event) => event.stopPropagation()} className="h-7 rounded border border-[var(--border)] bg-[var(--bg)] px-1.5 text-[10.5px] text-[var(--text)] outline-none" /></label>
              <label className="flex flex-col gap-0.5 text-[9px] text-[var(--text-faint)]">不能出现（逗号分隔）<input value={form.avoid} onChange={(event) => setForm({ ...form, avoid: event.target.value })} onClick={(event) => event.stopPropagation()} className="h-7 rounded border border-[var(--border)] bg-[var(--bg)] px-1.5 text-[10.5px] text-[var(--text)] outline-none" /></label>
            </div>
          </div>
        </div>
      </div>
    </article>
  );
}

function SequenceBoard({ doc, selected, onSelect }: { doc: StoryboardDocument; selected: readonly string[]; onSelect: (shot: StoryboardShot) => void }) {
  const t = useT();
  const lengthOf = (shot: StoryboardShot) => {
    const candidate = shot.match.candidates.find((item) => item.id === shot.match.selectedId);
    if (!candidate || candidate.endMs <= candidate.startMs) return shot.targetMs;
    /* The rough cut uses at most the target length; a long camera file is not imported whole. */
    return Math.min(candidate.endMs - candidate.startMs, shot.targetMs);
  };
  return (
    <div className="min-h-0 flex-1 overflow-y-auto px-4 py-4">
      <div className="mb-2 flex items-center gap-2 text-[10.5px] font-semibold uppercase tracking-[0.12em] text-[var(--text)]"><span className="h-1.5 w-1.5 rounded-full bg-[var(--accent)]" />{t('storyboard.sequence')}<span className="font-normal normal-case tracking-normal text-[var(--text-faint)]">素材片段长度</span></div>
      <div className="overflow-x-auto">
        <div className="flex min-h-[300px] min-w-max items-stretch gap-1 rounded-lg bg-[var(--tl-lane)] p-2">
          {doc.shots.map((shot) => {
            const candidate = shot.match.candidates.find((item) => item.id === shot.match.selectedId);
            const lengthMs = lengthOf(shot);
            return (
              <button key={shot.id} type="button" onClick={() => onSelect(shot)} style={{ flexGrow: Math.max(1, lengthMs / 1000), minWidth: 72 }}
                title={`${shot.title} · 素材 ${(lengthMs / 1000).toFixed(1)}s · 目标 ${(shot.targetMs / 1000).toFixed(1)}s`}
                className={`relative overflow-hidden rounded-md border text-left transition ${selected.includes(shot.id) ? 'border-[var(--accent)]' : 'border-transparent'} ${shot.match.state === 'gap' ? 'bg-[repeating-linear-gradient(135deg,#3a2f1f,#3a2f1f_5px,#4b3b23_5px,#4b3b23_10px)]' : 'bg-[var(--tl-video)]'}`}>
                {candidate?.thumbUrl ? <img src={candidate.thumbUrl} alt="" className="absolute inset-0 h-full w-full object-cover opacity-55" draggable={false} /> : null}
                <span className="relative z-10 flex h-full flex-col justify-between p-1.5 text-white">
                  <span className="text-[9px] tabular-nums text-white/70">{String(shot.order + 1).padStart(2, '0')}</span>
                  <span className="line-clamp-2 text-[10px] leading-tight">{shot.title}</span>
                  <span className="text-[9px] tabular-nums text-white/70">{(lengthMs / 1000).toFixed(1)}s</span>
                </span>
              </button>
            );
          })}
        </div>
      </div>
    </div>
  );
}

function RhythmStrip({ doc, selected, onSelect }: { doc: StoryboardDocument | null; selected: readonly string[]; onSelect: (shot: StoryboardShot) => void }) {
  const t = useT();
  const shots = doc?.shots ?? [];
  const lengthOf = (shot: StoryboardShot) => {
    const candidate = shot.match.candidates.find((item) => item.id === shot.match.selectedId);
    if (!candidate || candidate.endMs <= candidate.startMs) return shot.targetMs;
    /* The rough cut uses at most the target length; a long camera file is not imported whole. */
    return Math.min(candidate.endMs - candidate.startMs, shot.targetMs);
  };
  const materialTotal = shots.reduce((sum, shot) => sum + lengthOf(shot), 0);
  const targetTotal = shots.reduce((sum, shot) => sum + shot.targetMs, 0);
  /* The strip reads the assigned clip lengths, not the target durations: a 30 s source used for a
     4 s shot must look long here, so the mismatch is visible before the cut is imported. Each
     segment keeps a readable minimum; more than fits scrolls instead of squeezing. */
  const segmentWidth = 56;
  return (
    <div className="shrink-0 border-t border-[var(--border-soft)] bg-[rgba(0,0,0,.08)] px-3 py-1.5">
      <div className="mb-1 flex items-center gap-2 text-[10px] font-semibold tracking-[0.08em] text-[var(--text)]"><span>{t('storyboard.sequence')}</span><span className="font-normal tracking-normal text-[var(--text-faint)]">素材长度</span><span className="min-w-0 flex-1" /><span className="font-normal tabular-nums text-[var(--text-muted)]">{(materialTotal / 1000).toFixed(1)}s</span><span className="font-normal tabular-nums text-[var(--text-faint)]">/ 目标 {(targetTotal / 1000).toFixed(1)}s</span></div>
      <div className="overflow-x-auto pb-0.5">
        <div className="flex min-w-full h-8 items-stretch gap-[3px] rounded bg-[var(--tl-lane)] p-[3px]">
          {shots.map((shot) => {
            const candidate = shot.match.candidates.find((item) => item.id === shot.match.selectedId);
            const lengthMs = lengthOf(shot);
            const source = candidate ? `${sourceTime(candidate.startMs)} – ${sourceTime(candidate.endMs)}` : null;
            return (
              <button key={shot.id} type="button" onClick={() => onSelect(shot)}
                style={{ flexGrow: Math.max(1, lengthMs / 1000), minWidth: segmentWidth }}
                title={`${shot.title} · 素材 ${(lengthMs / 1000).toFixed(1)}s${source ? `（${source}）` : ''} · 目标 ${(shot.targetMs / 1000).toFixed(1)}s`}
                className={`flex min-w-0 items-center justify-between gap-1 overflow-hidden rounded-[3px] px-1.5 text-left text-[10px] font-semibold text-[var(--text)] ${selected.includes(shot.id) ? 'ring-2 ring-inset ring-[var(--accent)]' : ''} ${shot.match.state === 'gap' ? 'bg-[repeating-linear-gradient(135deg,#3a2f1f,#3a2f1f_5px,#4b3b23_5px,#4b3b23_10px)] !text-[var(--warn)]' : 'bg-[var(--surface-2)]'}`}>
                <span className="tabular-nums">{String(shot.order + 1).padStart(2, '0')}</span>
                <span className="tabular-nums text-[9px] font-normal text-[var(--text-muted)]">{(lengthMs / 1000).toFixed(1)}s</span>
              </button>
            );
          })}
        </div>
      </div>
    </div>
  );
}

function emptyDoc(): StoryboardDocument {
  return {
    version: 1, revision: 0, id: '', title: '', brief: { durationMs: 30_000, aspect: '16:9', tone: '', notes: '' },
    scenes: [], shots: [], source: 'manual', createdAt: 0, updatedAt: 0, handedOffAt: null, roughcut: null,
  };
}
