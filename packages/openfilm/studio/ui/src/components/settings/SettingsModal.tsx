/**
 * Settings, opened from the logo at the top left: a search and the sections in groups on the left, the section on the
 * right as a page of titled groups. General (the theme and the language), Agents (in an app with a chat: the agents
 * it can use), Providers (the unified cloud/local provider cards), the keyboard shortcuts, Advanced and Developer;
 * the search finds a section by any phrase on it. At the
 * foot of the nav, quietly, where OpenFilm lives: its code, the examples and the website.
 */
import React from 'react';
import { X, Settings2, Keyboard, Sun, Moon, Monitor, Plug, Bot, Search, SquareTerminal, Loader2, SlidersHorizontal, Database } from 'lucide-react';
import { LANGUAGES, phrasesUnder, useLanguage, useLanguageChoice, useT, type LanguageChoice } from '@/i18n';
import { studioHost, type HostDeveloper, type HostUpdateState } from '@/lib/host';
import { showWhatsNew } from '@/lib/whats-new';
import { usePreviewPrefs, writePreviewPref } from '@/lib/preview-prefs';
import { hasNotes, newestVersion } from '../WhatsNew';
import { useWebUpdate } from '../UpdateButton';
import { api, type StudioPrefs, type StudioVersion } from '@/api';
import { AgentsSection } from './AgentsSection';
import { DiagnosticsGroup } from './DiagnosticsGroup';
import { ProviderCardsSection } from './ProviderCardsSection';
import { SettingsSelect } from './SettingsSelect';
import { ShortcutsSection } from './ShortcutsSection';
import { SettingsButton, SettingsGroup, SettingsItem, SettingsNumberField, SettingsPage, SettingsSegmented, SettingsSwitch } from './ui';
import { useThemeMode, type ThemeMode } from './theme';
import { StorageGroup } from './StorageGroup';
import { VectorStoreSection } from './VectorStoreSection';

export type SettingsSection = 'general' | 'agents' | 'providers' | 'vectorStore' | 'developer' | 'shortcuts' | 'advanced';

/* the nav, in groups: what OpenFilm does, then help (Agents only inside an app with a chat: lib/host.ts `agents`;
   Advanced for what is already set for the best experience; Developer always, for its diagnostics) */
const NAV: Array<{ group: 'settings' | 'help'; sections: SettingsSection[] }> = [
  { group: 'settings', sections: ['general', 'agents', 'providers', 'vectorStore'] },
  { group: 'help', sections: ['shortcuts', 'advanced', 'developer'] },
];

/** where OpenFilm lives, linked at the foot of the nav */
const LINKS = [
  { label: 'settings.links.github', href: 'https://github.com/openfilm/openfilm' },
  { label: 'settings.links.examples', href: 'https://github.com/openfilm/examples' },
  { label: 'settings.links.site', href: 'https://openfilm.dev' },
];

const SECTION_ICON: Record<SettingsSection, React.ReactNode> = {
  general: <Settings2 size={18} strokeWidth={1.75} />,
  agents: <Bot size={18} strokeWidth={1.75} />,
  providers: <Plug size={18} strokeWidth={1.75} />,
  vectorStore: <Database size={18} strokeWidth={1.75} />,
  developer: <SquareTerminal size={18} strokeWidth={1.75} />,
  shortcuts: <Keyboard size={18} strokeWidth={1.75} />,
  advanced: <SlidersHorizontal size={18} strokeWidth={1.75} />,
};

/** what a search through each section reads: its name and every phrase it shows */
const SECTION_WORDS: Record<SettingsSection, string | string[]> = {
  general: ['settings.appearance', 'settings.storage'],
  agents: 'settings.agents',
  providers: 'settings.providers',
  vectorStore: 'settings.vectorStore',
  developer: ['settings.developer', 'settings.report'],
  shortcuts: 'settings.shortcuts',
  advanced: ['settings.advanced', 'settings.playback'],
};

export interface SettingsModalProps {
  open: boolean;
  onClose: () => void;
  /** Where it opens (General when not given). */
  section?: SettingsSection;
  /** Keeps the address in step with the section shown. */
  onSection?: (section: SettingsSection) => void;
  /** The project whose vector stores are shown. */
  projectId?: string | null;
}

/** Shows on General each time, or on the section asked for. The page owns the whole window: sections are pages,
 *  not dialogs. */
export function SettingsModal({ open, onClose, section: opening, onSection, projectId }: SettingsModalProps) {
  const t = useT();
  const language = useLanguage();
  const [section, setSection] = React.useState<SettingsSection>('general');
  const [query, setQuery] = React.useState('');
  const search = React.useRef<HTMLInputElement>(null);
  /* the latest onClose without re-running the effect below */
  const close = React.useRef(onClose);
  close.current = onClose;

  const choose = (id: SettingsSection) => {
    setSection(id);
    onSection?.(id);
  };

  React.useEffect(() => { if (open) { setSection(opening ?? 'general'); setQuery(''); } }, [open, opening]);

  /* the sections a search finds: by their names and by every phrase on them */
  const words = React.useMemo(() => Object.fromEntries((Object.keys(SECTION_WORDS) as SettingsSection[]).map((id) => [
    id, [t(`settings.sections.${id}`), ...[SECTION_WORDS[id]].flat().flatMap((under) => phrasesUnder(under, language))].join('\n').toLowerCase(),
  ])) as Record<SettingsSection, string>, [t, language]);
  const needle = query.trim().toLowerCase();
  const nav = NAV.map((group) => ({ ...group, sections: group.sections.filter((id) => !needle || words[id].includes(needle)) }))
    .filter((group) => group.sections.length > 0);
  const found = nav.flatMap((group) => group.sections);
  const showing: SettingsSection | null = found.includes(section) ? section : found[0] ?? null;

  React.useEffect(() => {
    if (!open) return;
    const previousFocus = document.activeElement as HTMLElement | null;
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape' && !e.defaultPrevented) close.current(); };
    window.addEventListener('keydown', onKey);
    const r = requestAnimationFrame(() => search.current?.focus());
    return () => {
      window.removeEventListener('keydown', onKey);
      cancelAnimationFrame(r);
      if (previousFocus?.isConnected) previousFocus.focus();
    };
  }, [open]);

  if (!open) return null;

  return (
    <div className="workspace-shell flex h-[100dvh] min-h-0 w-full flex-col overflow-hidden bg-[var(--dock-shell)]">
      <div className="flex min-h-0 flex-1 overflow-hidden bg-[var(--dock-pane)]">
        <nav aria-label={t('settings.title')} className="flex w-[264px] shrink-0 flex-col overflow-y-auto border-r border-[var(--border)] px-3 pb-4 pt-3">
          <label className="mb-3 flex h-10 shrink-0 items-center gap-2.5 rounded-[9px] border border-[var(--border)] px-3 text-[var(--text-muted)] transition focus-within:border-[var(--text-muted)]">
            <Search size={17} strokeWidth={1.75} className="shrink-0" aria-hidden />
            <input
              ref={search}
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder={t('settings.search')}
              aria-label={t('settings.search')}
              className="min-w-0 flex-1 bg-transparent text-[15px] text-[var(--text)] outline-none placeholder:text-[var(--text-faint)]"
            />
          </label>
          {nav.map((group) => (
            <div key={group.group} className="mt-3 flex flex-col gap-0.5">
              <div className="px-2.5 pb-1.5 text-[13px] text-[var(--text-faint)]">{t(group.group === 'help' ? 'settings.groups.help' : 'settings.title')}</div>
              {group.sections.map((id) => {
                const active = showing === id;
                return (
                  <button
                    key={id}
                    type="button"
                    aria-current={active ? 'page' : undefined}
                    onClick={() => choose(id)}
                    className={`flex h-10 min-w-0 items-center gap-3 rounded-[8px] px-2.5 text-left text-[15px] transition ${
                      active ? 'bg-[var(--bg-active)] text-[var(--text)]' : 'text-[var(--text-dim)] hover:bg-[var(--bg-hover)] hover:text-[var(--text)]'
                    }`}
                  >
                    <span className={`shrink-0 ${active ? 'text-[var(--text)]' : 'text-[var(--text-muted)]'}`}>{SECTION_ICON[id]}</span>
                    <span className="min-w-0 truncate">{t(`settings.sections.${id}`)}</span>
                  </button>
                );
              })}
            </div>
          ))}
          {found.length === 0 ? <p className="px-2.5 pt-4 text-[14px] text-[var(--text-faint)]">{t('settings.noResults')}</p> : null}
          <div className="mt-auto flex flex-wrap gap-x-4 gap-y-1 px-2.5 pt-6 text-[13px] text-[var(--text-faint)]">
            {LINKS.map((link) => (
              <a key={link.href} href={link.href} target="_blank" rel="noreferrer" className="rounded-[4px] transition hover:text-[var(--text)]">{t(link.label)}</a>
            ))}
          </div>
        </nav>

        <main aria-label={t('settings.title')} className="relative flex min-w-0 flex-1 flex-col">
          <button type="button" onClick={onClose} aria-label={t('settings.done')}
            className="absolute right-4 top-4 z-10 flex h-9 w-9 items-center justify-center rounded-[8px] text-[var(--text-muted)] transition hover:bg-[var(--bg-hover)] hover:text-[var(--text)]">
            <X size={19} strokeWidth={1.75} />
          </button>
          <div key={showing ?? 'none'} className="min-h-0 flex-1 overflow-y-auto overscroll-contain px-10 pb-12 pt-9">
            {showing ? <h2 id="settings-title" className="mb-7 text-[22px] font-semibold tracking-[-0.015em] text-[var(--text)]">{t(`settings.sections.${showing}`)}</h2> : null}
            {showing === 'general' && <GeneralSection />}
            {showing === 'agents' && <AgentsSection projectId={projectId} />}
            {showing === 'providers' && <ProviderCardsSection />}
            {showing === 'vectorStore' && <VectorStoreSection projectId={projectId} />}
            {showing === 'developer' && <DeveloperSection />}
            {showing === 'shortcuts' && <ShortcutsSection />}
            {showing === 'advanced' && <AdvancedSection />}
          </div>
        </main>
      </div>
    </div>
  );
}

function GeneralSection() {
  const t = useT();
  const [mode, setMode] = useThemeMode();
  const [language, setLanguage] = useLanguageChoice();

  return (
    <SettingsPage>
      <SettingsGroup title={t('settings.appearance.group')}>
        <SettingsItem
          title={t('settings.appearance.theme')}
          description={t('settings.appearance.themeHint')}
          control={(
            <SettingsSegmented<ThemeMode>
              label={t('settings.appearance.theme')}
              value={mode}
              onChange={setMode}
              options={[
                { value: 'system', label: t('settings.appearance.system'), icon: <Monitor size={15} /> },
                { value: 'light', label: t('settings.appearance.light'), icon: <Sun size={15} /> },
                { value: 'dark', label: t('settings.appearance.dark'), icon: <Moon size={15} /> },
              ]}
            />
          )}
        />
        <SettingsItem
          title={t('settings.appearance.language')}
          description={t('settings.appearance.languageHint')}
          control={(
            /* each language named in itself, so a person who cannot read the one shown still finds theirs */
            <SettingsSelect<LanguageChoice>
              label={t('settings.appearance.language')}
              value={language}
              onChange={setLanguage}
              options={[
                { value: 'system', label: t('settings.appearance.languageSystem') },
                ...LANGUAGES.map((l) => ({ value: l.code, label: l.name })),
              ]}
            />
          )}
        />
      </SettingsGroup>
      <StoryboardGroup />
      <StorageGroup />
      {studioHost?.update?.onState ? <AppAboutGroup /> : <AboutGroup />}
    </SettingsPage>
  );
}

/** How many candidate materials the rough-cut shelf asks for and shows. */
function StoryboardGroup() {
  const [prefs, setPrefs] = React.useState<StudioPrefs | null>(null);
  React.useEffect(() => { void api.prefs().then(setPrefs).catch(() => {}); }, []);
  if (!prefs) return null;
  const count = prefs.storyboard?.candidateCount ?? 16;
  const change = (next: number) => {
    const candidateCount = Math.max(3, Math.min(30, Math.round(next) || 16));
    setPrefs({ ...prefs, storyboard: { candidateCount } });
    void api.setPrefs({ storyboard: { candidateCount } }).catch(() => {});
  };
  return (
    <SettingsGroup title="分镜">
      <SettingsItem
        title="素材候选数量"
        description="分镜卡片做语义检索时返回并显示的候选素材数量（默认 16）；素材库和素材篮显示全部素材，不受此限制。"
        control={<SettingsNumberField min={3} max={30} step={1} value={count} onCommit={(value) => change(value ?? 16)} aria-label="素材候选数量" className="w-24 tabular-nums" />}
      />
    </SettingsGroup>
  );
}

/**
 * How the preview plays heavy footage (studio/server/proxies.mjs): from a lighter copy made in the background (a
 * proxy), and how tall that copy is; whether pages draw at the viewer's size, and whether stretches that play late are
 * rendered to play smoothly (lib/preview-prefs). Exports always read the originals and draw at full size.
 */
function PlaybackGroup() {
  const t = useT();
  const { fitPages, renders } = usePreviewPrefs();
  const [prefs, setPrefs] = React.useState<StudioPrefs | null>(null);
  React.useEffect(() => { void api.prefs().then(setPrefs).catch(() => {}); }, []);
  if (!prefs) return null;
  const change = (proxies: Partial<StudioPrefs['proxies']>) => {
    setPrefs({ ...prefs, proxies: { ...prefs.proxies, ...proxies } });
    void api.setPrefs({ proxies }).then(setPrefs).catch(() => {});
  };
  return (
    <SettingsGroup title={t('settings.playback.group')}>
      <SettingsItem
        title={t('settings.playback.proxies')}
        description={t('settings.playback.proxiesHint')}
        control={<SettingsSwitch checked={prefs.proxies.on} onChange={(on) => change({ on })} label={t('settings.playback.proxies')} />}
      />
      {prefs.proxies.on ? (
        <SettingsItem
          title={t('settings.playback.proxySize')}
          description={t('settings.playback.proxySizeHint')}
          control={(
            <SettingsSegmented<'540' | '720' | '1080'>
              label={t('settings.playback.proxySize')}
              value={String(prefs.proxies.height) as '540' | '720' | '1080'}
              onChange={(v) => change({ height: Number(v) as 540 | 720 | 1080 })}
              options={[{ value: '540', label: '540p' }, { value: '720', label: '720p' }, { value: '1080', label: '1080p' }]}
            />
          )}
        />
      ) : null}
      <SettingsItem
        title={t('settings.advanced.fitPages')}
        description={t('settings.advanced.fitPagesHint')}
        control={<SettingsSwitch checked={fitPages} onChange={(on) => writePreviewPref('fitPages', on)} label={t('settings.advanced.fitPages')} />}
      />
      <SettingsItem
        title={t('settings.advanced.renders')}
        description={t('settings.advanced.rendersHint')}
        control={<SettingsSwitch checked={renders} onChange={(on) => writePreviewPref('renders', on)} label={t('settings.advanced.renders')} />}
      />
    </SettingsGroup>
  );
}

/** What is already set for the best experience, for whoever wants it otherwise: how the preview plays (PlaybackGroup). */
function AdvancedSection() {
  const t = useT();
  return (
    <SettingsPage note={t('settings.advanced.intro')}>
      <PlaybackGroup />
    </SettingsPage>
  );
}

/**
 * This Studio's version and whether npm has a newer openfilm. In the desktop app, Studio comes with the app and is
 * updated with it; anywhere else the person (or their agent) runs the latest, and the CLI restarts Studio on it.
 */
function AboutGroup() {
  const t = useT();
  const [info, setInfo] = React.useState<StudioVersion | null>(null);
  const [state, setState] = React.useState<'idle' | 'checking' | 'failed'>('idle');
  React.useEffect(() => { void api.version().then(setInfo).catch(() => {}); }, []);
  const inApp = Boolean(studioHost);
  /* Update here as in the top bar: Studio runs the newest and starts again on it */
  const web = useWebUpdate();
  const check = () => {
    setState('checking');
    const before = info?.checkedAt ?? null;
    void api.version(true)
      .then((v) => { setInfo(v); setState(v.checkedAt != null && v.checkedAt !== before ? 'idle' : 'failed'); })
      .catch(() => setState('failed'));
  };
  const status = inApp ? t('settings.about.inApp')
    : info?.source ? t('settings.about.source')
    : info && !info.checking ? t('settings.about.off')
    : state === 'checking' ? t('settings.about.checking')
    : state === 'failed' ? t('settings.about.failed')
    : info?.newer ? t('settings.about.newer').replace('{version}', info.latest ?? '')
    : info?.latest ? t('settings.about.upToDate')
    : t('settings.about.never');
  return (
    <SettingsGroup title={t('settings.about.group')}>
      <SettingsItem
        title={info ? `OpenFilm ${info.version}` : 'OpenFilm'}
        description={status}
        control={inApp || !info?.checking ? null : (
          <SettingsButton disabled={state === 'checking'} onClick={check}>{t('settings.about.check')}</SettingsButton>
        )}
      >
        {hasNotes(info?.version) ? <WhatsNewLink version={info!.version} /> : null}
      </SettingsItem>
      {!inApp && !info?.source && info?.newer ? (
        <SettingsItem
          title={t('settings.about.howTitle')}
          description={web.update?.status === 'updating' ? t('update.webUpdating')
            : web.update?.status === 'waiting' ? t(web.update.reason === 'exporting' ? 'update.webExporting' : 'update.webMaking')
            : web.update?.status === 'failed' ? t('update.webFailed').replace('{error}', web.update.error)
            : t('settings.about.how')}
          control={(
            <>
              <code className="select-all rounded-md bg-[var(--surface-2)] px-2 py-1 font-mono text-[12px] text-[var(--text)]">npx -y openfilm@latest update</code>
              <SettingsButton variant="primary" disabled={!web.update || web.update.status === 'updating'} onClick={web.start}>
                {web.update?.status === 'updating' ? <Loader2 size={14} className="animate-spin" aria-hidden /> : null}
                {t('update.webUpdate')}
              </SettingsButton>
            </>
          )}
        />
      ) : null}
    </SettingsGroup>
  );
}

/** This release's notes again (components/WhatsNew). */
function WhatsNewLink({ version }: { version: string }) {
  const t = useT();
  return (
    <button type="button" onClick={() => showWhatsNew([version])}
      className="mb-2 text-[13.5px] text-[var(--text-muted)] underline underline-offset-2 transition hover:text-[var(--text)]">
      {t('settings.about.whatsNew')}
    </button>
  );
}

/** A check that answered this long ago is still news: opening About within it looks again only on a click. */
const CHECKED_FRESH_MS = 10 * 60_000;

/**
 * The app's version and its update (lib/host.ts `update`), as an app's About shows them: looked for on opening (unless
 * a check answered a few minutes ago), downloaded by itself with its progress, Restart when it is ready (it installs at
 * the next quit too). The menu's Check for Updates… stays.
 */
function AppAboutGroup() {
  const t = useT();
  const language = useLanguage();
  const update = studioHost?.update;
  const [state, setState] = React.useState<HostUpdateState | null>(null);
  const [refused, setRefused] = React.useState<string | null>(null);
  React.useEffect(() => update?.onState?.(setState), [update]);
  /* looked for once on opening, when the last answer is old or there is none */
  const looked = React.useRef(false);
  React.useEffect(() => {
    if (!state || looked.current) return;
    looked.current = true;
    const stale = state.checkedAt == null || Date.now() - state.checkedAt > CHECKED_FRESH_MS;
    if (stale && ['idle', 'current', 'error'].includes(state.status)) void update?.check?.();
  }, [state, update]);
  const check = () => { setRefused(null); void update?.check?.(); };
  const restart = () => {
    setRefused(null);
    void update?.restart().then((r) => { if (!r.ok && r.error) setRefused(r.error); });
  };
  const ago = (at: number) => {
    const minutes = Math.round((Date.now() - at) / 60_000);
    const rtf = new Intl.RelativeTimeFormat(language, { numeric: 'auto' });
    return minutes < 60 ? rtf.format(-minutes, 'minute') : minutes < 48 * 60 ? rtf.format(-Math.round(minutes / 60), 'hour') : rtf.format(-Math.round(minutes / 1440), 'day');
  };
  const s = state;
  const next = s?.availableVersion ?? '';
  const waiting = refused ?? (s?.status === 'ready' ? s.error : null);
  const why = waiting === 'agent-busy' ? t('update.agentBusy') : waiting === 'exporting' ? t('update.exporting')
    : waiting === 'install-failed' ? t('update.installFailed').replace('{version}', next) : null;
  const errorText = s?.error === 'offline' ? t('settings.about.appOffline') : s?.error === 'unavailable' ? t('settings.about.appUnavailable') : t('settings.about.appFailed');
  const busy = (text: string) => <span className="inline-flex items-center gap-1.5"><Loader2 size={13} className="animate-spin" aria-hidden />{text}</span>;
  const description = !s ? null
    : s.status === 'off' ? t('settings.about.appOff')
    : s.status === 'idle' || s.status === 'checking' ? busy(t('settings.about.checking'))
    : s.status === 'current' ? `${t('settings.about.upToDate')}${s.checkedAt ? ` ${t('settings.about.appChecked').replace('{time}', ago(s.checkedAt))}` : ''}`
    : s.status === 'available' || s.status === 'downloading' ? busy(`${t('settings.about.appDownloading').replace('{version}', next)}${s.status === 'downloading' ? ` ${Math.round(s.progress)}%` : ''}`)
    : s.status === 'staging' ? busy(t('settings.about.appStaging').replace('{version}', next))
    : s.status === 'ready' ? (why ?? t('update.ready').replace('{version}', next))
    : s.status === 'installing' ? busy(t('update.installing'))
    : errorText;
  const control = !s ? null
    : s.status === 'current' ? <SettingsButton onClick={check}>{t('settings.about.check')}</SettingsButton>
    : s.status === 'error' ? <SettingsButton onClick={check}>{t('settings.about.appRetry')}</SettingsButton>
    : s.status === 'ready' ? <SettingsButton variant="primary" onClick={restart}>{t('update.restart')}</SettingsButton>
    : null;
  return (
    <SettingsGroup title={t('settings.about.group')}>
      <SettingsItem
        title={`OpenFilm ${s?.version ?? ''}`.trim()}
        badge={s?.channel === 'beta' ? <span className="rounded-full bg-[var(--fill-tsp)] px-2 py-0.5 text-[11.5px] text-[var(--text-muted)]">beta</span> : null}
        description={description}
        control={control}
      >
        {hasNotes(s?.version) ? <WhatsNewLink version={s!.version} /> : null}
        {s?.status === 'downloading' ? (
          <div className="h-1 overflow-hidden rounded-full bg-[var(--fill-tsp)]" role="progressbar" aria-valuenow={Math.round(s.progress)} aria-valuemin={0} aria-valuemax={100}>
            <div className="h-full rounded-full bg-[var(--text)] transition-[width]" style={{ width: `${Math.max(2, s.progress)}%` }} />
          </div>
        ) : null}
      </SettingsItem>
    </SettingsGroup>
  );
}

/**
 * Diagnostics (DiagnosticsGroup), for when something does not work; how playing goes, in the viewer's corner
 * (lib/preview-prefs `stats`); in the app, what its chat shows of each turn: what it changed in the files, and its
 * full log (lib/host.ts `developer`).
 */
function DeveloperSection() {
  const t = useT();
  const developer = studioHost?.developer;
  const [prefs, setPrefs] = React.useState<HostDeveloper | null>(null);
  React.useEffect(() => {
    if (!developer) return undefined;
    void developer.get().then(setPrefs);
    return developer.onChange(setPrefs);
  }, [developer]);
  const change = (next: Partial<HostDeveloper>) => {
    setPrefs((was) => (was ? { ...was, ...next } : was));
    void developer?.set(next);
  };
  const { stats } = usePreviewPrefs();
  return (
    <SettingsPage note={t('settings.developer.intro')}>
      <DiagnosticsGroup />
      <SettingsGroup title={t('settings.developer.playbackGroup')}>
        <SettingsItem
          title={t('settings.developer.playbackStats')}
          description={t('settings.developer.playbackStatsHint')}
          control={<SettingsSwitch checked={stats} onChange={(on) => writePreviewPref('stats', on)} label={t('settings.developer.playbackStats')} />}
        />
      </SettingsGroup>
      {developer ? (
        <SettingsGroup title={t('settings.developer.group')} footnote={t('settings.developer.where')}>
          {/* drawn once the app has said whether each is on: drawn off first, a switch slid on each time the page opened */}
          <SettingsItem
            title={t('settings.developer.changes')}
            description={t('settings.developer.changesHint')}
            control={prefs ? <SettingsSwitch checked={prefs.changes} label={t('settings.developer.changes')} onChange={(on) => change({ changes: on })} /> : null}
          />
          <SettingsItem
            title={t('settings.developer.logs')}
            description={t('settings.developer.logsHint')}
            control={prefs ? <SettingsSwitch checked={prefs.logs} label={t('settings.developer.logs')} onChange={(on) => change({ logs: on })} /> : null}
          />
        </SettingsGroup>
      ) : null}
      {newestVersion() ? (
        <SettingsGroup title={t('settings.developer.releaseGroup')}>
          <SettingsItem
            title={t('settings.developer.previewWhatsNew')}
            description={t('settings.developer.previewWhatsNewHint').replace('{version}', newestVersion()!)}
            control={<SettingsButton onClick={() => showWhatsNew([newestVersion()!])}>{t('settings.developer.preview')}</SettingsButton>}
          />
        </SettingsGroup>
      ) : null}
    </SettingsPage>
  );
}
