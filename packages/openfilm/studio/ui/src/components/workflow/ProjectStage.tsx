/**
 * Step 1, the project: what this film is, and the other films beside it.
 *
 * Left: the project in hand — its cover, the facts that decide how everything after it behaves, where it lives, and
 * the way back into editing. When a card on the right is picked, this pane shows that project instead, with the one
 * action that matters (open it) and no facts it cannot know before the film is loaded.
 *
 * Right: the project library itself — the same library the top bar's Projects window shows, embedded rather than
 * floating: search, sort, folders, covers, multi-select, and "New project" all keep working, because it is the same
 * component (ProjectsLibrary, embedded), not a second implementation.
 *
 * Picking is not opening: one click shows a project here, a double-click (or Enter, or the menu, or "Open project")
 * opens it. The project already open only ever gets picked — opening it again would reload the page for nothing.
 */
import * as React from 'react';
import {
  Clapperboard, FolderKanban, FolderOpen, Image as ImageIcon,
} from 'lucide-react';
import { api } from '@/api';
import { useLanguage, useT } from '@/i18n';
import { formatClipDuration } from '@/lib/workspace-resources';
import type { LibraryProject } from '../ProjectsView';
import { ProjectsPopover } from '../ProjectsLibrary';

const BTN = 'inline-flex h-8 shrink-0 items-center justify-center gap-1.5 rounded-lg px-3 text-[12.5px] font-medium outline-none transition focus-visible:ring-2 focus-visible:ring-[var(--text)]/30';
const PRIMARY = `${BTN} bg-[var(--text)] text-[var(--panel)] hover:opacity-90 disabled:pointer-events-none disabled:opacity-40`;
const SECONDARY = `${BTN} text-[var(--text)] ring-1 ring-inset ring-[var(--border-strong)] hover:bg-[var(--bg-hover)]`;

export function ProjectStage({ projectId, title, folder, poster, stage, fps, durationMs, tracks, clips, captions, onReveal, onExport, onEdit, onOpenProject, onLeave }: {
  projectId: string;
  title: string;
  folder: string;
  poster?: string;
  stage: { w: number; h: number };
  fps: number;
  durationMs: number;
  tracks: number;
  clips: number;
  captions: number;
  onReveal: () => void;
  onExport: () => void;
  onEdit: () => void;
  onOpenProject: (projectId: string) => void;
  onLeave: () => void;
}) {
  const t = useT();
  const [preview, setPreview] = React.useState<LibraryProject | null>(null);
  const [previewFolder, setPreviewFolder] = React.useState<string | undefined>(undefined);

  /* a card picked in the library: the open project means "no preview", so this pane goes back to the film in hand */
  const pick = React.useCallback((project: LibraryProject | null, folderName?: string) => {
    if (!project || project.id === projectId) { setPreview(null); setPreviewFolder(undefined); return; }
    setPreview(project);
    setPreviewFolder(folderName);
  }, [projectId]);

  return (
    <div className="flex min-h-0 min-w-0 flex-1 gap-[6px]">
      <aside className="flex w-[340px] shrink-0 flex-col overflow-hidden rounded-[7px] bg-[var(--dock-pane)]">
        <div className="flex shrink-0 items-center gap-2 px-4 pb-3 pt-5">
          <FolderKanban size={16} aria-hidden className="shrink-0 text-[var(--text-muted)]" />
          <h2 className="min-w-0 flex-1 truncate text-[17px] font-semibold tracking-[-0.01em] text-[var(--text)]">
            {preview ? t('projectStage.selected') : t('projectStage.current')}
          </h2>
          {preview ? (
            <span className="shrink-0 rounded-full border border-[var(--border)] px-1.5 py-[1px] text-[10px] leading-4 text-[var(--text-faint)]">{t('projectStage.previewChip')}</span>
          ) : null}
        </div>

        <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain px-4 pb-4">
          {preview ? (
            <PreviewPane project={preview} folderName={previewFolder}
              onOpen={() => onOpenProject(preview.id)} onBack={() => pick(null)} />
          ) : (
            <CurrentPane title={title} folder={folder} poster={poster} stage={stage} fps={fps} durationMs={durationMs}
              tracks={tracks} clips={clips} captions={captions}
              onReveal={onReveal} onExport={onExport} onEdit={onEdit} />
          )}
        </div>
      </aside>

      <div className="flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden rounded-[7px] bg-[var(--dock-pane)]">
        <ProjectsPopover
          embedded
          open
          currentProjectId={projectId}
          onOpen={onOpenProject}
          onCurrentRemoved={onLeave}
          previewId={preview?.id ?? null}
          onPreview={pick}
        />
      </div>
    </div>
  );
}

/** The project in hand: its face, its facts, and the way back into editing. */
function CurrentPane({ title, folder, poster, stage, fps, durationMs, tracks, clips, captions, onReveal, onExport, onEdit }: {
  title: string;
  folder: string;
  poster?: string;
  stage: { w: number; h: number };
  fps: number;
  durationMs: number;
  tracks: number;
  clips: number;
  captions: number;
  onReveal: () => void;
  onExport: () => void;
  onEdit: () => void;
}) {
  const t = useT();
  const [artFailed, setArtFailed] = React.useState(false);
  React.useEffect(() => setArtFailed(false), [poster]);
  const duration = formatClipDuration(durationMs);
  /* a project opened from a URL (an agent's `open`, the shared library) has no folder on this computer to reveal */
  const local = !/^https?:/i.test(folder) && /^([A-Za-z]:[\\/]|\/)/.test(folder);
  const filmPath = !folder ? 'film.html' : local ? `${folder.replace(/[\\/]+$/, '')}/film.html` : folder.replace(/\/+$/, '');
  return (
    <div className="flex flex-col gap-4">
      <div
        className="relative flex aspect-video w-full items-center justify-center overflow-hidden rounded-xl border border-[var(--border)] shadow-[var(--shadow-sm)]"
        style={{ background: poster && !artFailed ? 'var(--surface-2)' : 'linear-gradient(135deg, var(--brand-wind-from), var(--brand-wind-mid) 55%, var(--brand-wind-to))' }}
      >
        <Clapperboard size={28} aria-hidden className="text-white/80" />
        {poster && !artFailed ? (
          <img src={poster} alt="" className="absolute inset-0 h-full w-full object-cover" onError={() => setArtFailed(true)} />
        ) : null}
        <span className="absolute bottom-2 right-2.5 rounded bg-black/35 px-1.5 py-0.5 text-[11px] tabular-nums text-white/90">{duration}</span>
      </div>

      <div className="flex min-w-0 flex-col gap-1">
        <h3 className="truncate text-[19px] font-semibold tracking-tight text-[var(--text)]">{title || t('project.untitled')}</h3>
        <p className="truncate font-mono text-[11px] text-[var(--text-faint)]">{filmPath}</p>
        <p className="text-[12px] text-[var(--text-muted)]">
          {t('projectStage.meta').replace('{duration}', duration).replace('{w}', String(stage.w)).replace('{h}', String(stage.h)).replace('{fps}', String(fps))}
        </p>
      </div>

      <section aria-label={t('projectStage.facts')} className="grid grid-cols-2 gap-2">
        <Fact icon={<ImageIcon size={12} />} label={t('projectStage.canvas')} value={`${stage.w}×${stage.h}`} />
        <Fact label={t('projectStage.fps')} value={`${fps} fps`} />
        <Fact label={t('projectStage.duration')} value={duration} />
        <Fact label={t('projectStage.captions')} value={String(captions)} />
        <Fact label={t('projectStage.tracks')} value={String(tracks)} />
        <Fact label={t('projectStage.clips')} value={String(clips)} />
      </section>

      <div className="flex flex-col gap-1.5">
        <button type="button" onClick={onEdit} className={PRIMARY}>{t('projectStage.continue')}</button>
        <div className="flex items-center gap-1.5">
          <button type="button" onClick={onExport} disabled={durationMs <= 0} className={`${SECONDARY} flex-1`}>{t('projectStage.export')}</button>
          {local ? (
            <button type="button" onClick={onReveal} className={`${SECONDARY} flex-1`}>
              <FolderOpen size={13} aria-hidden />{t('projectStage.reveal')}
            </button>
          ) : null}
        </div>
      </div>

      <div className="flex flex-col gap-1 rounded-xl border border-[var(--border)] bg-[var(--surface-2)] p-3">
        <span className="text-[10.5px] font-medium text-[var(--text-faint)]">{t('projectStage.where')}</span>
        <span className="truncate font-mono text-[11px] leading-relaxed text-[var(--text-muted)]">{folder || '—'}</span>
      </div>
    </div>
  );
}

/** A project picked in the library, before it is opened: what the list knows, and the way in. */
function PreviewPane({ project, folderName, onOpen, onBack }: {
  project: LibraryProject;
  folderName?: string;
  onOpen: () => void;
  onBack: () => void;
}) {
  const t = useT();
  const language = useLanguage();
  const [artFailed, setArtFailed] = React.useState(false);
  React.useEffect(() => setArtFailed(false), [project.poster]);
  const created = project.createdAt
    ? new Intl.DateTimeFormat(language, { year: 'numeric', month: 'short', day: 'numeric' }).format(new Date(project.createdAt))
    : '';
  return (
    <div className="flex flex-col gap-4">
      <div className="relative flex aspect-video w-full items-center justify-center overflow-hidden rounded-xl border border-[var(--border)] bg-[var(--surface-2)]">
        {project.poster && !artFailed ? (
          <img src={project.poster} alt="" className="absolute inset-0 h-full w-full object-cover" onError={() => setArtFailed(true)} />
        ) : (
          <span className="flex h-full w-full items-center justify-center bg-gradient-to-br from-[var(--surface-3)] to-[var(--surface-2)] text-[var(--text-faint)]">
            <Clapperboard size={26} aria-hidden />
          </span>
        )}
        {project.duration ? (
          <span className="absolute bottom-2 right-2.5 rounded bg-black/45 px-1.5 py-0.5 text-[11px] tabular-nums text-white/90">
            {formatClipDuration(project.duration * 1000)}
          </span>
        ) : null}
      </div>

      <div className="flex min-w-0 flex-col gap-1">
        <h3 className="truncate text-[19px] font-semibold tracking-tight text-[var(--text)]">{project.name || t('project.untitled')}</h3>
        <p className="truncate font-mono text-[11px] text-[var(--text-faint)]">{project.path}</p>
        <p className="text-[12px] text-[var(--text-muted)]">
          {created ? t('projectStage.created').replace('{date}', created) : ''}
          {folderName ? `${created ? ' · ' : ''}${folderName}` : ''}
        </p>
      </div>

      {project.missing ? (
        <p role="status" className="rounded-lg border border-[var(--warn)]/40 bg-[var(--surface-2)] px-3 py-2 text-[11.5px] leading-relaxed text-[var(--text-muted)]">
          {t('projectStage.missingOpen')}
        </p>
      ) : (
        <p className="text-[11px] leading-relaxed text-[var(--text-faint)]">{t('projectStage.openHint')}</p>
      )}

      <div className="flex flex-col gap-1.5">
        <button type="button" onClick={onOpen} disabled={project.missing} className={PRIMARY}>
          {t('projectStage.open')}
        </button>
        {!project.missing ? (
          <button type="button" onClick={() => void api.revealProject(project.id).catch(() => {})} className={SECONDARY}>
            <FolderOpen size={13} aria-hidden />{t('projectStage.reveal')}
          </button>
        ) : null}
        <button type="button" onClick={onBack}
          className="mt-0.5 flex h-7 items-center justify-center rounded-md text-[11.5px] text-[var(--text-muted)] transition hover:bg-[var(--bg-hover)] hover:text-[var(--text)]">
          {t('projectStage.back')}
        </button>
      </div>
    </div>
  );
}

function Fact({ icon, label, value }: { icon?: React.ReactNode; label: string; value: string }) {
  return (
    <div className="flex min-w-0 items-center gap-2 rounded-lg border border-[var(--border)] bg-[var(--surface-2)] px-2.5 py-2">
      {icon ? <span aria-hidden className="text-[var(--text-faint)]">{icon}</span> : null}
      <div className="min-w-0">
        <div className="truncate text-[10.5px] text-[var(--text-faint)]">{label}</div>
        <div className="truncate text-[13px] font-medium tabular-nums text-[var(--text)]">{value}</div>
      </div>
    </div>
  );
}
