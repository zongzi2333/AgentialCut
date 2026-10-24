/**
 * The media library step: one command bar, the files, and what is picked.
 *
 * It is the library the workflow starts from, not a second editor: import, folders, name search, preview, facts,
 * multi-select and a basket all work here. The film is only written when the basket is taken to the timeline ("Add to
 * timeline"), one edit that appends its shots. The semantic search this page is shaped around (vector store, query
 * engine, encoders) has no service yet: its controls are shown off, with the reason, and the contract in
 * `search-contract.ts` is what a local sidecar will answer later.
 */
import * as React from 'react';
import {
  ChevronDown, ChevronRight, Film, FolderKanban, FolderOpen, FolderPlus, Image as ImageIcon, LayoutGrid, List, ListPlus, Lock, Music4, Pencil, Search, Sparkles, Trash2, Upload, X,
} from 'lucide-react';
import { useT } from '@/i18n';
import { keyAction, useKeyHint } from '@/lib/keymap-store';
import {
  safeName, type MediaListing, type MediaSources, type MediaResult, type WorkspaceResource,
} from '@/lib/workspace-resources';
import type { ImportProgress } from '../MediaPool';
import { PaneDivider, DockPaneDivider, usePaneSize } from '../PaneDivider';
import { ConfirmDialog } from '../ConfirmDialog';
import { ContextMenu, type ContextMenuEntry } from '../ContextMenu';
import { MenuSelect } from '../MenuSelect';
import { Popover } from '../Popover';
import { Tooltip } from '../Tooltip';
import { MediaGrid, type Upload as UploadRow } from './MediaGrid';
import { MediaInspector } from './MediaInspector';
import { MediaBasket } from './MediaBasket';
import { MediaSearchResults } from './MediaSearchResults';
import { SemanticIndexPanel } from './SemanticIndexPanel';
import { loadBasket, saveBasket, sameBasketItem, type BasketItem } from './basket';
import { useSemanticIndex } from './use-semantic-index';
import type { SemanticHit } from '@/api';
import { api } from '@/api';

type KindFilter = 'all' | 'video' | 'image' | 'audio' | 'mg';
type Sort = 'recent' | 'name' | 'duration' | 'kind';
type Mode = 'file' | 'visual';

const KIND_ORDER: KindFilter[] = ['all', 'video', 'image', 'audio', 'mg'];
const SORTS: Sort[] = ['recent', 'name', 'duration', 'kind'];
const FONT_DIRS = /(^|\/)fonts?(\/|$)/i;
const baseName = (path: string) => path.slice(path.lastIndexOf('/') + 1);

let uploadSeq = 0;

export function MediaLibraryStage({ projectId, listing, sources, usedSrcs, onImport, onMove, onDelete, onReveal, onNewFolder, onExtractAudio, onSetCover, onUseInEdit, onAddToTimeline, notify, error }: {
  projectId: string;
  listing: MediaListing | null;
  sources: MediaSources;
  usedSrcs: readonly string[];
  onImport: (files: File[], into: string, onProgress: ImportProgress) => Promise<string[]>;
  onMove: (from: string, to: string) => Promise<MediaResult>;
  onDelete: (path: string) => Promise<MediaResult>;
  onReveal: (path: string) => void;
  onNewFolder: (path: string) => Promise<MediaResult>;
  onExtractAudio: (path: string) => Promise<MediaResult>;
  onSetCover: (path: string) => void;
  onUseInEdit: (file: WorkspaceResource) => void;
  /** Append the basket's shots to the end of their tracks; the number that made it. */
  onAddToTimeline: (items: readonly { path: string; startMs: number; endMs: number }[]) => Promise<number>;
  notify: (message: string) => void;
  error: (message: string) => void;
}) {
  const t = useT();
  const keyHint = useKeyHint();
  const semantic = useSemanticIndex(projectId);
  const [at, setAt] = React.useState('');
  const [query, setQuery] = React.useState('');
  const [mode, setMode] = React.useState<Mode>('file');
  const [searchScope, setSearchScope] = React.useState<'project' | 'global' | string>('project');
  const [shot, setShot] = React.useState<SemanticHit | null>(null);
  const [kind, setKind] = React.useState<KindFilter>('all');
  const [sort, setSort] = React.useState<Sort>('recent');
  const [view, setView] = React.useState<'grid' | 'list'>('grid');
  const [selected, setSelected] = React.useState<string[]>([]);
  const [primary, setPrimary] = React.useState<string | null>(null);
  const [descriptions, setDescriptions] = React.useState<Record<string, string>>({});
  const [describing, setDescribing] = React.useState<string | null>(null);
  const [notice, setNotice] = React.useState<string | null>(null);
  const [uploads, setUploads] = React.useState<UploadRow[]>([]);
  const [menu, setMenu] = React.useState<{ x: number; y: number; file: WorkspaceResource } | null>(null);
  const [naming, setNaming] = React.useState<{ mode: 'rename'; file: WorkspaceResource } | { mode: 'folder' } | null>(null);
  const [nameDraft, setNameDraft] = React.useState('');
  const [deleting, setDeleting] = React.useState<WorkspaceResource[] | null>(null);
  const [basket, setBasket] = React.useState<BasketItem[]>(() => loadBasket(projectId));
  const [adding, setAdding] = React.useState(false);
  const [basketOver, setBasketOver] = React.useState(false);
  const [libraryOpen, setLibraryOpen] = React.useState(false);
  const [indexOpen, setIndexOpen] = React.useState(false);
  const anchor = React.useRef<string | null>(null);
  const inputRef = React.useRef<HTMLInputElement>(null);
  const imageInputRef = React.useRef<HTMLInputElement>(null);
  const searchRef = React.useRef<HTMLInputElement>(null);
  const rowRef = React.useRef<HTMLDivElement>(null);
  const bodyRef = React.useRef<HTMLDivElement>(null);
  const { width: inspectorWidth, commit: commitInspectorWidth } = usePaneSize('openfilm.mediaStage.inspectorW', 340, 300);
  const { width: basketHeight, commit: commitBasketHeight } = usePaneSize('openfilm.mediaStage.basketH', 88, 88);

  React.useEffect(() => { saveBasket(projectId, basket); }, [basket, projectId]);
  React.useEffect(() => {
    let live = true;
    void api.assetDescriptions(projectId).then((next) => { if (live) setDescriptions(next); }, () => {});
    return () => { live = false; };
  }, [projectId, primary]);
  /* files changed on disk (the watcher reloads the listing): the index's picture of them has changed too */
  React.useEffect(() => { void semantic.refresh(); }, [listing, semantic.refresh]);
  React.useEffect(() => {
    semantic.clearSearch();
    setShot(null);
  }, [mode, semantic.clearSearch]);
  React.useEffect(() => {
    const libraries = semantic.status?.libraries ?? [];
    if (searchScope !== 'project' && searchScope !== 'global' && !libraries.some((library) => library.id === searchScope)) {
      setSearchScope('project');
    }
  }, [semantic.status, searchScope]);

  const all = React.useMemo(() => {
    if (!listing) return [] as WorkspaceResource[];
    const byPath = new Map<string, WorkspaceResource>();
    for (const file of listing.files) byPath.set(file.path, file);
    for (const page of listing.pages) if (!byPath.has(page.path)) byPath.set(page.path, page);
    return [...byPath.values()];
  }, [listing]);

  const fileSearch = mode === 'file' && Boolean(query.trim());
  const inFolder = React.useMemo(
    () => all.filter((file) => (file.kind === 'mg' ? at === '' : file.dir === at)),
    [all, at],
  );
  const visible = React.useMemo(() => {
    const needle = query.trim().toLowerCase();
    const found = (fileSearch || (mode === 'visual' && !needle) ? all : inFolder).filter((file) => {
      if (kind !== 'all' && file.kind !== kind) return false;
      return !needle || file.name.toLowerCase().includes(needle) || file.path.toLowerCase().includes(needle);
    });
    const sorted = [...found];
    sorted.sort((a, b) => {
      if (sort === 'name') return a.name.localeCompare(b.name, undefined, { numeric: true });
      if (sort === 'duration') return (b.durationMs ?? 0) - (a.durationMs ?? 0);
      if (sort === 'kind') return a.kind.localeCompare(b.kind) || a.name.localeCompare(b.name);
      return (b.addedMs ?? b.mtimeMs) - (a.addedMs ?? a.mtimeMs);
    });
    return sorted;
  }, [all, inFolder, fileSearch, kind, sort, query, mode]);
  const externalLibraries = semantic.status?.libraries ?? [];
  const searchLibraryIds = searchScope === 'project'
    ? [projectId]
    : searchScope === 'global'
      ? undefined
      : [searchScope];
  const scopeLabel = searchScope === 'project'
    ? '项目文件'
    : searchScope === 'global'
      ? '全局向量库'
      : externalLibraries.find((library) => library.id === searchScope)?.name ?? '项目文件';
  const visualResults = mode === 'visual' && Boolean(semantic.meta || semantic.searching || semantic.searchError);
  const unindexed = React.useMemo(() => {
    const states = semantic.status?.project?.assetStates ?? {};
    return new Set(Object.entries(states).filter(([path, state]) => state !== 'ready' && all.some((file) => file.path === path && (file.kind === 'video' || file.kind === 'image'))).map(([path]) => path));
  }, [semantic.status?.project?.assetStates, all]);

  const folders = React.useMemo(() => {
    if (!listing || fileSearch) return [];
    const prefix = at ? `${at}/` : '';
    return listing.dirs.filter((dir) => dir.startsWith(prefix) && !dir.slice(prefix.length).includes('/') && !FONT_DIRS.test(dir));
  }, [listing, at, fileSearch]);

  const primaryFile = React.useMemo(() => all.find((file) => file.path === primary) ?? null, [all, primary]);
  const selectedFiles = React.useMemo(
    () => selected.map((path) => all.find((file) => file.path === path)).filter((x): x is WorkspaceResource => Boolean(x)),
    [selected, all],
  );

  /* the picked file left the library (deleted, moved): let it go */
  React.useEffect(() => {
    if (!primary || !listing) return;
    if (all.some((file) => file.path === primary)) return;
    setPrimary(null);
    setSelected([]);
  }, [all, primary, listing]);

  /* `/` searches, as in the editor's media pane; not while typing elsewhere */
  React.useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.defaultPrevented || event.metaKey || event.ctrlKey || event.altKey) return;
      const el = event.target as HTMLElement | null;
      if (el && (el.closest('input, textarea, select, [contenteditable="true"], [role="dialog"]'))) return;
      if (event.key === '/') { event.preventDefault(); searchRef.current?.focus(); }
      if (event.key === 'Escape' && document.activeElement === searchRef.current) { setQuery(''); }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  /* Delete / Backspace takes the selection out of the library (the files stay where they are); Escape lets it go */
  React.useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.defaultPrevented || event.repeat || event.metaKey || event.ctrlKey || event.altKey) return;
      const el = event.target instanceof Element ? event.target : null;
      if (el?.closest('input, textarea, select, [contenteditable="true"], [role="dialog"]')) return;
      if (deleting) return;
      if (keyAction(event) === 'remove' && (primaryFile || selectedFiles.length)) {
        event.preventDefault();
        event.stopPropagation();
        setDeleting(selectedFiles.length ? selectedFiles : primaryFile ? [primaryFile] : []);
        return;
      }
      if (event.key === 'Escape') {
        setSelected([]);
        setPrimary(null);
        anchor.current = null;
      }
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [primaryFile, selectedFiles, deleting]);

  const clearNotice = () => setNotice(null);
  const reserved = (message: string) => setNotice(message);

  function select(file: WorkspaceResource, event: Pick<React.MouseEvent, 'metaKey' | 'ctrlKey' | 'shiftKey'>) {
    setNotice(null);
    setShot(null);
    if (event.shiftKey && anchor.current) {
      const from = visible.findIndex((f) => f.path === anchor.current);
      const to = visible.findIndex((f) => f.path === file.path);
      if (from >= 0 && to >= 0) {
        const [a, b] = from < to ? [from, to] : [to, from];
        setSelected(visible.slice(a, b + 1).map((f) => f.path));
        setPrimary(file.path);
        return;
      }
    }
    if (event.metaKey || event.ctrlKey) {
      setSelected((cur) => (cur.includes(file.path) ? cur.filter((p) => p !== file.path) : [...cur, file.path]));
      setPrimary(file.path);
      anchor.current = file.path;
      return;
    }
    setSelected([file.path]);
    setPrimary(file.path);
    anchor.current = file.path;
  }

  function openFolder(rel: string) {
    setAt(rel);
    setQuery('');
    setSelected([]);
    setPrimary(null);
    setShot(null);
    anchor.current = null;
  }

  async function upload(files: File[], intoRel = at) {
    if (!files.length) return;
    setNotice(null);
    const batch: UploadRow[] = files.map((file) => ({ id: `upload-${++uploadSeq}`, name: file.name, ratio: 0 }));
    setUploads((cur) => [...cur, ...batch]);
    try {
      /* a folder that cannot be written (a project served from elsewhere) must not leave a spinner for ever */
      const timeout = new Promise<never>((_, reject) => setTimeout(() => reject(new Error(t('mediaLibrary.uploadTimeout'))), 30000));
      await Promise.race([
        onImport(files, intoRel ? `assets/${intoRel}` : 'assets', (i, ratio, landed) => {
          const id = batch[i]?.id;
          if (!id) return;
          setUploads((cur) => cur.map((row) => (row.id === id ? { ...row, ratio: ratio < 0 ? 0.5 : ratio, ...(landed ? { done: true } : {}) } : row)));
        }),
        timeout,
      ]);
      setUploads((cur) => cur.map((row) => (batch.some((b) => b.id === row.id) ? { ...row, ratio: 1, done: true } : row)));
      setTimeout(() => setUploads((cur) => cur.filter((row) => !batch.some((b) => b.id === row.id))), 1600);
    } catch (e) {
      setUploads((cur) => cur.filter((row) => !batch.some((b) => b.id === row.id)));
      const message = e instanceof Error && e.message ? e.message : t('mediaLibrary.uploadFailed');
      setNotice(message);
      error(message);
    }
  }

  async function moveTo(from: string, to: string) {
    const result = await onMove(from, to).catch(() => 'failed' as MediaResult);
    if (result === 'taken') setNotice(t('mediaLibrary.nameTaken'));
    else if (result !== 'ok') setNotice(t('mediaLibrary.moveFailed'));
    else setNotice(null);
    return result;
  }

  function openMenu(file: WorkspaceResource, x: number, y: number) { setMenu({ file, x, y }); }

  const menuEntries = (): ContextMenuEntry[] => {
    if (!menu) return [];
    const file = menu.file;
    const entries: ContextMenuEntry[] = [
      { id: 'use', icon: <Film size={14} />, label: t('mediaLibrary.inEdit'), onSelect: () => onUseInEdit(file) },
      { id: 'basket', icon: <ListPlus size={14} />, label: t('mediaLibrary.addToBasket'), onSelect: () => addToBasket([file]) },
      ...(file.kind === 'video' || file.kind === 'image'
        ? [{ id: 'index', icon: <Sparkles size={14} />, label: t('semanticIndex.index'), onSelect: () => indexFile(file) }]
        : []),
      { id: 'sep1', separator: true },
      { id: 'reveal', icon: <FolderOpen size={14} />, label: t('mediaLibrary.reveal'), onSelect: () => onReveal(file.path) },
    ];
    if (file.kind === 'video') {
      entries.push({ id: 'audio', icon: <Music4 size={14} />, label: t('mediaLibrary.extractAudio'), onSelect: () => void extractAudio(file) });
    }
    if (file.kind === 'image' || file.kind === 'video' || file.kind === 'mg') {
      entries.push({ id: 'cover', icon: <ImageIcon size={14} />, label: t('mediaLibrary.setCover'), onSelect: () => onSetCover(file.path) });
    }
    if (file.kind !== 'mg') {
      entries.push({ id: 'sep2', separator: true });
      entries.push({ id: 'rename', icon: <Pencil size={14} />, label: t('mediaLibrary.rename'), onSelect: () => startRename(file) });
      entries.push({ id: 'delete', icon: <Trash2 size={14} />, label: t('mediaLibrary.delete'), shortcut: keyHint('remove'), danger: true, onSelect: () => setDeleting(selected.includes(file.path) && selected.length > 1 ? selectedFiles : [file]) });
    }
    return entries;
  };

  async function extractAudio(file: WorkspaceResource) {
    const result = await onExtractAudio(file.path).catch(() => 'failed' as MediaResult);
    if (result !== 'ok') setNotice(t('mediaLibrary.extractFailed'));
    else notify(t('mediaLibrary.extractStarted'));
  }

  function startRename(file: WorkspaceResource) {
    setNameDraft(file.name.replace(/\.[^.]+$/, ''));
    setNaming({ mode: 'rename', file });
  }

  function startFolder() {
    setNameDraft(t('mediaLibrary.untitledFolder'));
    setNaming({ mode: 'folder' });
  }

  async function commitName() {
    if (!naming) return;
    const clean = safeName(nameDraft);
    if (!clean) return;
    if (naming.mode === 'rename') {
      const file = naming.file;
      const dir = file.path.slice(0, file.path.lastIndexOf('/'));
      const ext = /\.([^.]+)$/.exec(file.name)?.[0] ?? '';
      const name = /\.[^.]+$/.test(clean) ? clean : `${clean}${ext}`;
      const to = `${dir}/${name}`;
      setNaming(null);
      if (to !== file.path) {
        const result = await moveTo(file.path, to);
        if (result === 'ok') { setPrimary(to); setSelected([to]); }
      }
      return;
    }
    const rel = at ? `${at}/${clean}` : clean;
    setNaming(null);
    const result = await onNewFolder(rel ? `assets/${rel}` : 'assets').catch(() => 'failed' as MediaResult);
    if (result === 'taken') setNotice(t('mediaLibrary.nameTaken'));
    else if (result !== 'ok') setNotice(t('mediaLibrary.folderFailed'));
    else openFolder(rel);
  }

  /* Deleting follows the server's rule: a link loses only its link (the original stays where it is); a copy in the
     project goes to the system Trash. */
  async function confirmDelete() {
    const files = deleting;
    setDeleting(null);
    if (!files?.length) return;
    let failed = 0;
    for (const file of files) {
      // eslint-disable-next-line no-await-in-loop
      const result = await onDelete(file.path).catch(() => 'failed' as MediaResult);
      if (result !== 'ok') failed += 1;
    }
    if (failed) setNotice(t('mediaLibrary.deleteFailed'));
    const gone = new Set(files.map((file) => file.path));
    setBasket((current) => current.filter((item) => !gone.has(item.path)));
    setSelected([]);
    setPrimary(null);
    setShot(null);
  }

  async function takeBasketToTimeline() {
    if (!basket.length || adding) return;
    const asked = [...basket];
    setNotice(null);
    setAdding(true);
    try {
      const added = await onAddToTimeline(asked.map((item) => ({ path: item.path, startMs: item.startMs, endMs: item.endMs })));
      if (added === asked.length) {
        setBasket((cur) => cur.filter((item) => !asked.some((done) => sameBasketItem(item, done))));
        notify(t('mediaLibrary.basketAdded').replace('{n}', String(added)));
      } else if (added > 0) {
        setNotice(t('mediaLibrary.basketPartlyAdded').replace('{added}', String(added)).replace('{total}', String(asked.length)));
      } else {
        setNotice(t('mediaLibrary.basketAddFailed'));
      }
    } finally {
      setAdding(false);
    }
  }

  /* Export shots saves the source files: the basket holds whole files while there is no shot search. The server
     streams each one from the project (content-disposition: attachment), so a large clip is never read into memory.
     A ranged shot will ask the local sidecar's exporter (search-contract) rather than pretend the whole file is the
     shot. */
  function exportBasket() {
    if (!basket.length) return;
    setNotice(null);
    let saved = 0;
    let ranged = false;
    for (const item of basket) {
      const file = all.find((candidate) => candidate.path === item.path);
      if (!file) continue;
      const whole = item.startMs <= 0 && (!file.durationMs || item.endMs >= file.durationMs - 1);
      if (!whole) { ranged = true; continue; }
      const link = document.createElement('a');
      link.href = `/api/projects/${encodeURIComponent(projectId)}/media?what=file&path=${encodeURIComponent(item.path)}`;
      link.download = file.name;
      link.rel = 'noopener';
      document.body.append(link);
      link.click();
      link.remove();
      saved += 1;
    }
    if (ranged) setNotice(t('mediaLibrary.exportRangeReserved'));
    if (saved) notify(t('mediaLibrary.basketExported').replace('{n}', String(saved)));
    else if (!ranged) setNotice(t('mediaLibrary.basketExportFailed'));
  }

  function addToBasket(files: readonly WorkspaceResource[], range?: { startMs: number; endMs: number }) {
    setBasket((cur) => {
      const next = [...cur];
      for (const file of files) {
        const item: BasketItem = {
          path: file.path,
          name: file.name,
          kind: file.kind,
          startMs: range?.startMs ?? 0,
          endMs: range?.endMs ?? file.durationMs ?? 0,
        };
        if (!next.some((existing) => sameBasketItem(existing, item))) next.push(item);
      }
      return next;
    });
  }

  function selectHit(hit: SemanticHit) {
    const file = all.find((candidate) => candidate.path === hit.path);
    setNotice(null);
    setShot(hit);
    if (file) {
      setPrimary(file.path);
      setSelected([file.path]);
      anchor.current = file.path;
    } else {
      setPrimary(null);
      setSelected([]);
      anchor.current = null;
    }
  }

  function addShotToBasket(hit: SemanticHit) {
    const file = all.find((candidate) => candidate.path === hit.path);
    if (!file) {
      setNotice(t('semanticIndex.externalBasket'));
      return;
    }
    addToBasket([file], { startMs: hit.startMs, endMs: hit.endMs });
    notify(t('semanticIndex.shotAdded'));
  }

  function runVisualSearch() {
    const text = query.trim();
    if (!text) return;
    setNotice(null);
    setShot(null);
    void semantic.search({ type: 'text', text }, 'chunk', searchLibraryIds);
  }

  function indexFile(file: WorkspaceResource) {
    if (!indexEnabled) { setNotice(t('semanticIndex.indexUnavailable')); return; }
    if (!semantic.status?.models.length) { setNotice(t('semanticIndex.noModels')); return; }
    void semantic.start({ assetIds: [file.path] });
  }

  async function describeMaterial(file: WorkspaceResource, regenerate: boolean) {
    setDescribing(file.path);
    try {
      const desc = await api.describeAsset(projectId, file.path, regenerate);
      setDescriptions((current) => ({ ...current, [file.path]: desc }));
      notify(regenerate ? '素材描述已重新生成' : '素材描述已生成');
    } catch (e) {
      error(e instanceof Error ? e.message : String(e));
    } finally {
      setDescribing(null);
    }
  }

  function runImageSearch(file: File) {
    const reader = new FileReader();
    reader.onload = () => {
      if (typeof reader.result !== 'string') return;
      setNotice(null);
      setShot(null);
      void semantic.search({ type: 'image', dataUrl: reader.result }, 'chunk', searchLibraryIds);
    };
    reader.readAsDataURL(file);
  }

  const fileOf = React.useCallback((path: string) => all.find((file) => file.path === path) ?? null, [all]);
  const crumb = at.split('/').filter(Boolean);
  const indexProject = semantic.status?.project;
  const indexJob = indexProject?.job;
  const indexWorking = indexJob?.state === 'queued' || indexJob?.state === 'running';
  const indexChip = (() => {
    if (!semantic.status || semantic.status.sidecar.state !== 'ready') return t('semanticIndex.chipOff');
    if (indexWorking) return t('semanticIndex.chipIndexing').replace('{n}', String(Math.round(indexJob?.progress ?? 0)));
    if (!indexProject?.stores?.some((store) => store.state === 'ready')) return t('semanticIndex.chipIdle');
    if (indexProject.assets.total > 0 && indexProject.assets.ready === 0 && (indexProject.assets.missing ?? 0) > 0) return t('semanticIndex.chipNoReady');
    const pending = (indexProject.assets.stale ?? 0) + (indexProject.assets.notIndexed ?? 0);
    if (pending) return t('semanticIndex.chipStale').replace('{n}', String(pending));
    return t('semanticIndex.chipReady');
  })();
  const indexEnabled = semantic.status?.sidecar.state === 'ready';

  return (
    <div className="flex min-h-0 min-w-0 flex-1 flex-col gap-[6px] bg-[var(--dock-shell)]">
      <div className="flex shrink-0 flex-col overflow-hidden rounded-[7px] bg-[var(--dock-pane)]">
      {/* search, and what kind of search */}
      <div className="flex h-11 shrink-0 items-center gap-2 border-b border-[var(--border-soft)] px-3">
        <span className="relative flex min-w-0 flex-1 items-center">
          <Search size={14} aria-hidden className="pointer-events-none absolute left-2.5 text-[var(--text-faint)]" />
          <input
            ref={searchRef}
            value={query}
            onChange={(event) => { setQuery(event.target.value); setNotice(null); }}
            onPaste={(event) => {
              const file = event.clipboardData.files?.[0];
              if (file && mode === 'visual' && file.type.startsWith('image/')) { event.preventDefault(); runImageSearch(file); }
            }}
            onKeyDown={(event) => {
              if (event.key === 'Escape') { setQuery(''); event.currentTarget.blur(); }
              if (event.key === 'Enter' && mode === 'visual') { event.preventDefault(); runVisualSearch(); }
            }}
            placeholder={mode === 'visual' ? t('semanticIndex.searchPlaceholder') : t('mediaLibrary.searchPlaceholder')}
            aria-label={mode === 'visual' ? t('semanticIndex.searchPlaceholder') : t('mediaLibrary.searchPlaceholder')}
            className="h-8 w-full rounded-lg bg-[var(--surface-2)] pl-8 pr-8 text-[12px] text-[var(--text)] outline-none placeholder:text-[var(--text-faint)] focus:ring-1 focus:ring-[var(--border-strong)]"
          />
          {query ? (
            <button type="button" aria-label={t('mediaLibrary.clearSearch')} onClick={() => { setQuery(''); if (mode === 'visual') semantic.clearSearch(); }}
              className="absolute right-2 flex h-5 w-5 items-center justify-center rounded text-[var(--text-faint)] hover:bg-[var(--bg-hover)] hover:text-[var(--text)]">
              <X size={12} />
            </button>
          ) : null}
        </span>
        {mode === 'visual' ? (
          <>
            <Tooltip label={t('semanticIndex.searchImage')} side="top">
              <button type="button" aria-label={t('semanticIndex.searchImage')} onClick={() => imageInputRef.current?.click()}
                className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg text-[var(--text-muted)] ring-1 ring-inset ring-[var(--border)] hover:bg-[var(--bg-hover)] hover:text-[var(--text)]">
                <ImageIcon size={14} />
              </button>
            </Tooltip>
            <input ref={imageInputRef} type="file" accept="image/*" className="hidden"
              onChange={(event) => { const file = event.target.files?.[0]; event.target.value = ''; if (file) runImageSearch(file); }} />
          </>
        ) : null}
        <div className="flex h-7 shrink-0 items-center gap-0.5 rounded-lg border border-[var(--border)] bg-[var(--bg)] p-[2px]" role="group" aria-label={t('mediaLibrary.searchModes')}>
          {(['file', 'visual'] as const).map((id) => {
            const active = mode === id;
            const enabled = id === 'file' || indexEnabled;
            return (
              <button key={id} type="button" aria-pressed={active}
                onClick={() => { if (enabled) { setMode(id); setNotice(null); } else reserved(t('semanticIndex.indexUnavailable')); }}
                className={`flex h-5 items-center gap-1 rounded-md px-2 text-[11px] transition ${
                  active && enabled ? 'bg-[var(--surface-3)] text-[var(--text)] shadow-[var(--shadow-sm)]' : enabled ? 'text-[var(--text-muted)] hover:text-[var(--text)]' : 'text-[var(--text-faint)]'
                }`}>
                {t(`mediaLibrary.mode.${id}`)}
                {enabled ? null : <Lock size={9} aria-hidden />}
              </button>
            );
          })}
        </div>
        <button type="button" onClick={() => inputRef.current?.click()}
          className="flex h-8 shrink-0 items-center gap-1.5 rounded-lg bg-[var(--text)] px-3 text-[12px] font-medium text-[var(--panel)] transition hover:opacity-90">
          <Upload size={13} aria-hidden />{t('mediaLibrary.import')}
        </button>
        <input ref={inputRef} type="file" multiple className="hidden"
          onChange={(event) => { const files = [...(event.target.files ?? [])]; event.target.value = ''; void upload(files); }} />
      </div>

      {/* the library, its folders, and the view */}
      <div className="flex h-10 shrink-0 items-center gap-2 border-b border-[var(--border-soft)] px-3">
        <Popover open={libraryOpen} onOpenChange={setLibraryOpen} align="start"
          trigger={
            <button type="button" aria-haspopup="menu" aria-expanded={libraryOpen}
              className="flex h-7 shrink-0 items-center gap-1.5 rounded-md px-1.5 text-[11.5px] text-[var(--text-muted)] transition hover:bg-[var(--bg-hover)] hover:text-[var(--text)]">
              <FolderKanban size={13} aria-hidden />
              <span className="max-w-[150px] truncate">{scopeLabel}</span>
              <ChevronDown size={11} aria-hidden />
            </button>
          }>
          <div role="menu" className="w-[280px] rounded-xl border border-[var(--border)] bg-[var(--surface)] p-1.5 shadow-[var(--shadow-lg)]">
            {([['project', '项目文件'], ['global', '全局向量库']] as const).map(([value, label]) => (
              <button key={value} type="button" role="menuitemradio" aria-checked={searchScope === value}
                onClick={() => { setSearchScope(value); if (value !== 'project') { setMode('visual'); semantic.clearSearch(); } setLibraryOpen(false); }}
                className="flex w-full items-start gap-2 rounded-md px-2 py-1.5 text-left hover:bg-[var(--bg-hover)]">
                <span className={`mt-0.5 h-3.5 w-3.5 shrink-0 rounded-full ${searchScope === value ? 'border-[3px] border-[var(--text)]' : 'border border-[var(--border-strong)]'}`} aria-hidden />
                <span className="min-w-0">
                  <span className="block text-[12px] text-[var(--text)]">{label}</span>
                  {value === 'project' ? <span className="mt-0.5 block text-[10.5px] text-[var(--text-faint)]">{t('mediaLibrary.libraryHint')}</span> : null}
                </span>
              </button>
            ))}
            {externalLibraries.map((library) => (
              <button key={library.id} type="button" role="menuitemradio" aria-checked={searchScope === library.id}
                onClick={() => { setSearchScope(library.id); setMode('visual'); semantic.clearSearch(); setLibraryOpen(false); }}
                className="mt-0.5 flex w-full items-start gap-2 rounded-md px-2 py-1.5 text-left hover:bg-[var(--bg-hover)]">
                <span className={`mt-0.5 h-3.5 w-3.5 shrink-0 rounded-full ${searchScope === library.id ? 'border-[3px] border-[var(--text)]' : 'border border-[var(--border-strong)]'}`} aria-hidden />
                <span className="min-w-0 flex-1">
                  <span className="flex items-center gap-1 text-[12px] text-[var(--text)]"><span className="truncate">{library.name}</span>{library.offline ? <span className="text-[9.5px] text-[var(--text-faint)]">{t('semanticIndex.externalOffline')}</span> : null}</span>
                  <span className="mt-0.5 block truncate text-[10.5px] text-[var(--text-faint)]">
                    {library.stores?.[0]?.modelId ?? t('semanticIndex.chipIdle')} · {library.assets?.ready ?? 0}/{library.assets?.total ?? 0}
                  </span>
                </span>
              </button>
            ))}
            {!externalLibraries.length ? (
              <p className="mt-1 border-t border-[var(--border-soft)] px-2 pt-1.5 text-[10.5px] leading-relaxed text-[var(--text-faint)]">{t('semanticIndex.addExternal')}</p>
            ) : null}
          </div>
        </Popover>

        <span className="flex min-w-0 items-center gap-0.5 text-[11.5px] text-[var(--text-faint)]">
          <button type="button" onClick={() => openFolder('')} className="rounded px-1 py-0.5 hover:bg-[var(--bg-hover)] hover:text-[var(--text)]">
            {t('mediaLibrary.allFolders')}
          </button>
          {crumb.map((part, i) => (
            <React.Fragment key={`${part}-${i}`}>
              <ChevronRight size={11} aria-hidden />
              <button type="button" onClick={() => openFolder(crumb.slice(0, i + 1).join('/'))}
                className="max-w-[140px] truncate rounded px-1 py-0.5 hover:bg-[var(--bg-hover)] hover:text-[var(--text)]">
                {part}
              </button>
            </React.Fragment>
          ))}
        </span>
        <span className="shrink-0 text-[10.5px] tabular-nums text-[var(--text-faint)]">{t('mediaLibrary.items').replace('{n}', String(visible.length))}</span>
        <span className="min-w-0 flex-1" />

        <div className="w-[116px] shrink-0">
        <MenuSelect label={t('mediaLibrary.filter')} value={kind} size="sm"
          groups={[{ choices: KIND_ORDER.map((value) => ({ value, label: t(`mediaLibrary.kind.${value}`) })) }]}
          onPick={(value) => setKind(value as KindFilter)} />
        </div>
        <div className="w-[124px] shrink-0">
        <MenuSelect label={t('mediaLibrary.sort')} value={sort} size="sm"
          groups={[{ choices: SORTS.map((value) => ({ value, label: t(`mediaLibrary.sortBy.${value}`) })) }]}
          onPick={(value) => setSort(value as Sort)} />
        </div>
        <div className="flex h-7 shrink-0 items-center gap-0.5 rounded-md bg-[var(--surface-2)] p-[2px]" role="group" aria-label={t('mediaLibrary.view')}>
          <button type="button" aria-label={t('mediaLibrary.grid')} aria-pressed={view === 'grid'} onClick={() => setView('grid')}
            className={`flex h-5 w-5 items-center justify-center rounded ${view === 'grid' ? 'bg-[var(--surface)] text-[var(--text)] shadow-[var(--shadow-sm)]' : 'text-[var(--text-faint)] hover:text-[var(--text)]'}`}>
            <LayoutGrid size={12} />
          </button>
          <button type="button" aria-label={t('mediaLibrary.list')} aria-pressed={view === 'list'} onClick={() => setView('list')}
            className={`flex h-5 w-5 items-center justify-center rounded ${view === 'list' ? 'bg-[var(--surface)] text-[var(--text)] shadow-[var(--shadow-sm)]' : 'text-[var(--text-faint)] hover:text-[var(--text)]'}`}>
            <List size={12} />
          </button>
        </div>

        <Popover open={indexOpen} onOpenChange={setIndexOpen} align="end"
          trigger={
            <button type="button" aria-haspopup="dialog" aria-expanded={indexOpen}
              className="flex h-7 shrink-0 items-center gap-1.5 rounded-md px-2 text-[11px] text-[var(--text-faint)] ring-1 ring-inset ring-[var(--border)] transition hover:bg-[var(--bg-hover)] hover:text-[var(--text)]">
              <span aria-hidden className={`h-1.5 w-1.5 rounded-full ${indexEnabled ? indexWorking ? 'bg-[var(--warn)]' : indexProject?.stores?.some((store) => store.state === 'ready') ? 'bg-[var(--accent)]' : 'bg-[var(--text-faint)]' : 'bg-[var(--err)]'}`} />
              {indexChip}
            </button>
          }>
          <SemanticIndexPanel
            status={semantic.status}
            error={semantic.error}
            selectedCount={selected.length}
            selectedPaths={selected}
            folder={at ? `assets/${at}` : 'assets'}
            onStart={semantic.start}
            onStartExternal={semantic.startExternal}
            onCancel={semantic.cancel}
            onRemove={semantic.remove}
            onAddExternal={semantic.addExternal}
            onRemoveExternal={semantic.removeExternal}
            onImportModel={semantic.importModel}
            onRefresh={semantic.refresh}
            notify={notify}
          />
        </Popover>

        <Tooltip label={t('mediaLibrary.newFolder')} side="top">
          <button type="button" aria-label={t('mediaLibrary.newFolder')} onClick={startFolder}
            className="flex h-7 w-7 shrink-0 items-center justify-center rounded-md text-[var(--text-faint)] transition hover:bg-[var(--bg-hover)] hover:text-[var(--text)]">
            <FolderPlus size={14} />
          </button>
        </Tooltip>
      </div>

      {notice ? (
        <div role="status" className="flex shrink-0 items-center gap-2 border-b border-[var(--border-soft)] bg-[var(--surface-2)] px-3 py-1.5 text-[11px] text-[var(--text-muted)]">
          <span className="min-w-0 flex-1">{notice}</span>
          <button type="button" aria-label={t('mediaLibrary.dismiss')} onClick={clearNotice}
            className="flex h-5 w-5 items-center justify-center rounded text-[var(--text-faint)] hover:bg-[var(--bg-hover)] hover:text-[var(--text)]">
            <X size={11} />
          </button>
        </div>
      ) : null}
      </div>

      <div ref={bodyRef} className="flex min-h-0 min-w-0 flex-1 flex-col">
      <div ref={rowRef} className="flex min-h-0 min-w-0 flex-1">
        <div className="flex min-w-0 flex-1 flex-col overflow-hidden rounded-[7px] bg-[var(--dock-pane)]">
        {visualResults ? (
          <MediaSearchResults
            hits={semantic.hits}
            meta={semantic.meta}
            searching={semantic.searching}
            error={semantic.searchError}
            selected={shot ? `${shot.assetId}:${shot.startMs}:${shot.endMs}:${shot.storeId}` : null}
            onSelect={selectHit}
            onOpen={selectHit}
          />
        ) : (
        <MediaGrid
          items={visible}
          folders={folders}
          at={at}
          view={view}
          searching={fileSearch}
          selected={new Set(selected)}
          primaryPath={primary}
          sources={sources}
          usedSrcs={usedSrcs}
          unindexed={unindexed}
          uploads={uploads}
          onOpenFolder={openFolder}
          onSelect={select}
          onOpen={onUseInEdit}
          onMenu={openMenu}
          onClear={() => { setSelected([]); setPrimary(null); setShot(null); anchor.current = null; }}
          onDropFiles={(files) => void upload(files)}
          onDropOnFolder={(path, folder) => void moveTo(path, `assets/${folder}/${baseName(path)}`)}
        />
        )}
        </div>
        <PaneDivider width={inspectorWidth ?? 340} onResize={commitInspectorWidth} containerRef={rowRef}
          label={t('mediaLibrary.resizeInspector')} min={300} minRest={420} side="end" />
        <MediaInspector
          width={inspectorWidth ?? 340}
          file={primaryFile}
          shot={shot}
          selected={selectedFiles}
          used={Boolean(primary && usedSrcs.includes(primary))}
          sources={sources}
          onAdd={addToBasket}
          onAddShot={addShotToBasket}
          onUseInEdit={onUseInEdit}
          onReveal={(file) => onReveal(file.path)}
          onExtractAudio={(file) => void extractAudio(file)}
          onSetCover={(file) => onSetCover(file.path)}
          onRemove={(files) => setDeleting([...files])}
          onIndex={(file) => indexFile(file)}
          description={primaryFile ? descriptions[primaryFile.path] ?? primaryFile.desc ?? '' : ''}
          describing={Boolean(primaryFile && describing === primaryFile.path)}
          onDescribe={(file, regenerate) => void describeMaterial(file, regenerate)}
        />
      </div>

      <DockPaneDivider height={basketHeight ?? 88} onResize={commitBasketHeight} containerRef={bodyRef}
        label={t('mediaLibrary.resizeBasket')} min={88} minRest={240} />

      <div data-media-basket="" className={`shrink-0 overflow-hidden rounded-[7px] bg-[var(--dock-pane)] ${basketOver ? 'ring-1 ring-inset ring-[var(--accent)]' : ''}`} style={{ height: basketHeight ?? 88 }}
        onDragOver={(event) => {
          if (!event.dataTransfer.types.includes('application/x-openfilm-media') && !event.dataTransfer.types.includes('application/x-openfilm-shot')) return;
          event.preventDefault();
          event.stopPropagation();
          event.dataTransfer.dropEffect = 'copy';
          setBasketOver(true);
        }}
        onDragLeave={(event) => { if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setBasketOver(false); }}
        onDrop={(event) => {
          const path = event.dataTransfer.getData('application/x-openfilm-media');
          const shot = event.dataTransfer.getData('application/x-openfilm-shot');
          if (!path && !shot) return;
          event.preventDefault();
          event.stopPropagation();
          setBasketOver(false);
          let range: { startMs: number; endMs: number } | undefined;
          let at = path;
          if (shot) {
            try {
              const parsed = JSON.parse(shot) as { path?: unknown; startMs?: unknown; endMs?: unknown };
              if (typeof parsed.path === 'string') at = parsed.path;
              if (typeof parsed.startMs === 'number' && typeof parsed.endMs === 'number') range = { startMs: parsed.startMs, endMs: parsed.endMs };
            } catch { /* a malformed drag: nothing to add */ }
          }
          const file = at ? all.find((candidate) => candidate.path === at) : null;
          if (file) {
            addToBasket([file], range);
            notify(t('semanticIndex.shotAdded'));
          }
        }}>
      <MediaBasket
        items={basket}
        sources={sources}
        fileOf={fileOf}
        busy={adding}
        onAddToTimeline={() => void takeBasketToTimeline()}
        onExport={() => void exportBasket()}
        onRemove={(item) => setBasket((cur) => cur.filter((x) => !sameBasketItem(x, item)))}
        onClear={() => setBasket([])}
      />
      </div>
      </div>

      {menu ? (
        <ContextMenu x={menu.x} y={menu.y} items={menuEntries()} onClose={() => setMenu(null)} align="end" />
      ) : null}

      <ConfirmDialog
        open={deleting !== null}
        title={deleting && deleting.length > 1
          ? t('mediaLibrary.deleteManyTitle').replace('{n}', String(deleting.length))
          : t('mediaLibrary.deleteTitle')}
        description={deleting && deleting.length > 1
          ? t('mediaLibrary.deleteManyDesc')
          : t('mediaLibrary.deleteDesc').replace('{name}', deleting?.[0]?.name ?? '')}
        confirmLabel={t('mediaLibrary.delete')}
        cancelLabel={t('mediaLibrary.cancel')}
        danger
        onCancel={() => setDeleting(null)}
        onConfirm={() => void confirmDelete()}
      />

      {naming ? (
        <div className="fixed inset-0 z-[10060] flex items-center justify-center bg-black/50 p-4"
          onMouseDown={(event) => { if (event.target === event.currentTarget) setNaming(null); }}>
          <div role="dialog" aria-modal="true"
            aria-label={naming.mode === 'rename' ? t('mediaLibrary.rename') : t('mediaLibrary.newFolder')}
            className="flex w-full max-w-[400px] flex-col gap-3 rounded-2xl border border-[var(--border)] bg-[var(--surface)] p-5 shadow-[var(--shadow-lg)]">
            <h3 className="text-[15px] font-semibold text-[var(--text)]">
              {naming.mode === 'rename' ? t('mediaLibrary.renameTitle') : t('mediaLibrary.newFolder')}
            </h3>
            <input autoFocus value={nameDraft} maxLength={80}
              onChange={(event) => setNameDraft(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === 'Enter') void commitName();
                if (event.key === 'Escape') setNaming(null);
              }}
              onFocus={(event) => event.currentTarget.select()}
              aria-label={naming.mode === 'rename' ? t('mediaLibrary.name') : t('mediaLibrary.folderName')}
              className="h-9 w-full rounded-lg border border-[var(--border)] bg-[var(--bg)] px-3 text-[13px] text-[var(--text)] outline-none focus:border-[var(--border-strong)]"
            />
            <div className="flex items-center justify-end gap-2">
              <button type="button" onClick={() => setNaming(null)}
                className="h-8 rounded-lg px-3 text-[12.5px] font-medium text-[var(--text)] hover:bg-[var(--bg-hover)]">
                {t('mediaLibrary.cancel')}
              </button>
              <button type="button" disabled={!nameDraft.trim()} onClick={() => void commitName()}
                className="h-8 rounded-lg bg-[var(--text)] px-4 text-[12.5px] font-medium text-[var(--panel)] transition hover:opacity-90 disabled:pointer-events-none disabled:opacity-40">
                {naming.mode === 'rename' ? t('mediaLibrary.confirmRename') : t('mediaLibrary.create')}
              </button>
            </div>
          </div>
        </div>
      ) : null}
    </div>
  );
}
