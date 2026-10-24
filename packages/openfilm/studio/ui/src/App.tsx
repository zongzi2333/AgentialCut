/**
 * Studio is one place: a project (/projects/<id>). The projects are a popover inside it; `/` goes to the project
 * opened last, or (none left, or only ones whose folder is gone) shows the Projects window on its own, with "New
 * project" in it: no folder is made that the person did not ask for. The address is the state, so the agent's
 * `openfilm open` (which sends the page to a project) and the browser's back button both work.
 *
 * In an app with tabs (lib/host.ts `tabs`) this page is one project's tab: a project picked opens in its own tab (the
 * app's to open), `/` is the projects (the window with no tab open), and `openfilm open` is the app's to settle (every
 * tab hears it).
 */
import { useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { api, listen, studioConnection } from './api';
import { useT } from './i18n';
import { ProjectView } from './components/ProjectView';
import { BrandLoadingScreen } from './components/BrandLoadingScreen';
import { ProjectsPopover } from './components/ProjectsLibrary';
import { Launcher } from './components/Launcher';
import { studioHost } from './lib/host';
import { WhatsNew } from './components/WhatsNew';
import { SettingsModal, type SettingsSection } from './components/settings/SettingsModal';
import { sourcesApi } from './lib/project-sources';
import { LIST_WAIT_MS, within } from './lib/projects-page';

/**
 * `to` with this page's key in its address (the server puts it there): the address bar is what a person copies, and
 * with the key a copied address opens Studio in any browser on this machine, or in an agent's preview.
 */
const keepKey = (to: string) => {
  const key = new URLSearchParams(location.search).get('key');
  if (!key) return to;
  const at = new URL(to, location.origin);
  at.searchParams.set('key', key);
  return at.pathname + at.search;
};

const projectIn = (path: string) => /^\/projects\/([\w-]+)/.exec(path)?.[1] ?? null;
const SECTION_IDS = new Set<SettingsSection>(['general', 'agents', 'providers', 'vectorStore', 'developer', 'shortcuts', 'advanced']);
const settingsIn = (path: string): SettingsSection | null => {
  if (!path.startsWith('/settings')) return null;
  const asked = path.split('/')[2] as SettingsSection | undefined;
  return asked && SECTION_IDS.has(asked) ? asked : 'general';
};
/** the app's tabs, when Studio is a tab of an app's window */
const tabs = studioHost?.tabs ?? null;

export function App() {
  const [path, setPath] = useState(location.pathname);
  const [returnTo, setReturnTo] = useState('/');
  const [returnProjects, setReturnProjects] = useState(false);
  const settingsPushed = useRef(false);
  const returnHome = useRef(false);
  const [none, setNone] = useState(false);
  const go = (to: string, replace = false) => {
    if (to !== location.pathname) (replace ? history.replaceState : history.pushState).call(history, null, '', keepKey(to));
    setPath(to);
  };

  /* the examples and skills, read as Studio opens: a gallery opened later shows them at once */
  useEffect(() => { sourcesApi.preload(); }, []);

  useEffect(() => {
    const onPop = () => setPath(location.pathname);
    window.addEventListener('popstate', onPop);
    /* `openfilm open` while this page is open: show the project it opened (with tabs, the app says which tab does) */
    const stop = listen('events', (event) => {
      if (event.type !== 'open') return;
      if (tabs) tabs.openRequest(event.to); else go(event.to);
    }, { watch: true });
    return () => { window.removeEventListener('popstate', onPop); stop(); };
  }, []);

  /** Show a project: here, or (with tabs) in its own tab. */
  const open = (projectId: string) => { if (tabs) tabs.open(projectId); else go(`/projects/${projectId}`); };
  /** The project shown was deleted: its tab closes (with tabs), or back to the last project. */
  const leave = () => { if (tabs) tabs.report({ gone: true }); else go('/', true); };

  const id = projectIn(path);
  useEffect(() => { if (id) { setNone(false); returnHome.current = false; } }, [id]);
  const settingsSection = settingsIn(path);
  const openSettings = (section: SettingsSection = 'general', options?: { projects?: boolean }) => {
    if (!settingsIn(location.pathname)) {
      setReturnTo(location.pathname || '/');
      setReturnProjects(Boolean(options?.projects));
      returnHome.current = !projectIn(location.pathname);
      settingsPushed.current = true;
    }
    go(`/settings/${section}`);
  };
  const closeSettings = () => {
    /* Settings was pushed over the page it was opened from: going back keeps that page, its scroll and any window
       it had open, rather than rebuilding whatever happens to be the last project. */
    if (settingsPushed.current && history.length > 1) {
      settingsPushed.current = false;
      const home = returnHome.current;
      returnHome.current = false;
      history.back();
      if (home) setNone(true);
      return;
    }
    if (returnHome.current || returnTo === '/') {
      returnHome.current = false;
      setNone(true);
      go('/', true);
      return;
    }
    go(returnTo || '/');
  };
  /* Once the project page is back, the Projects window it opens is its own again: clear the request after its first
     render, so a later visit to the same project does not reopen it. */
  useEffect(() => {
    if (!settingsSection && returnProjects) setReturnProjects(false);
  }, [settingsSection, returnProjects]);
  /* no project in the address: the one opened last that is still there, else the Projects window (`none`); with
     tabs, the projects (no tab is open) */
  useEffect(() => {
    if (id || tabs || settingsSection || none) return;
    let alive = true;
    /* the list not read (refused, or no answer in time): the Projects window, which says so and tries again */
    void within(api.projects(), LIST_WAIT_MS).then((projects) => {
      if (!alive) return;
      const last = projects.find((p) => !p.missing);
      if (last) go(`/projects/${last.id}`, true);
      else setNone(true);
    }, () => { if (alive) setNone(true); });
    return () => { alive = false; };
  }, [id, settingsSection, none]);

  const settingsProject = projectIn(returnTo);
  const page = settingsSection ? (
    <SettingsModal open section={settingsSection} projectId={settingsProject}
      onSection={(next) => go(`/settings/${next}`, true)} onClose={closeSettings} />
  ) : id ? <ProjectView key={id} projectId={id} onProject={open} onLeave={leave} onSettings={openSettings} initialProjectsOpen={!settingsSection && returnProjects} />
    : tabs ? <Launcher onOpen={open} onSettings={openSettings} />
    : !none ? <BrandLoadingScreen labelKey="projects.opening" />
      : (
        <div className="workspace-shell bg-[var(--dock-shell)]">
          <ProjectsPopover open currentProjectId="" onOpen={(next) => go(`/projects/${next}`)} onCurrentRemoved={() => {}} />
        </div>
      );
  return <>{page}<ConnectionNotice /><WhatsNew /></>;
}

/**
 * Studio answers, but not this browser: it was opened at Studio's address without the key (pasted, typed, an agent's
 * browser given the bare address). Nothing to wait for: the page is covered and says which address lets it in.
 */
function LockedNotice() {
  const t = useT();
  const [copied, setCopied] = useState(false);
  const COMMAND = 'openfilm open';
  return (
    <div role="alert" className="fixed inset-0 z-[10050] flex items-center justify-center bg-[var(--dock-shell)] p-6">
      <div className="w-full max-w-[460px] rounded-2xl border border-[var(--border)] bg-[var(--surface)] p-6 shadow-[var(--shadow-lg)]">
        <p className="text-[16px] font-semibold text-[var(--text)]">{t('connection.lockedTitle')}</p>
        <p className="mt-2 text-[13px] leading-relaxed text-[var(--text-muted)]">{t('connection.lockedBody')}</p>
        <p className="mt-3 rounded-lg bg-[var(--surface-2)] px-3 py-2 font-mono text-[12px] text-[var(--text-dim)]">{`${location.origin}/open?key=…`}</p>
        {studioHost ? null : (
          <div className="mt-4 flex items-center gap-2 text-[12.5px] text-[var(--text-muted)]">
            <span>{t('connection.lockedHow')}</span>
            <button
              type="button"
              onClick={() => { void navigator.clipboard?.writeText(COMMAND).then(() => setCopied(true), () => {}); }}
              className="rounded-md bg-[var(--surface-2)] px-2 py-0.5 font-mono text-[12px] text-[var(--text)] ring-1 ring-inset ring-[var(--border)] hover:bg-[var(--bg-hover)]"
            >
              {copied ? t('connection.copied') : COMMAND}
            </button>
          </div>
        )}
      </div>
    </div>
  );
}

/**
 * Studio stopped (an update, a crash, the computer slept): a bar across the top while it is away, so nothing seems to
 * hang for no reason. Reconnecting is tried all along; once it has been away a while the page is covered (an export or
 * an edit made now would go nowhere) and the bar says how to start it again: this page reconnects by itself.
 */
function ConnectionNotice() {
  const t = useT();
  const state = useSyncExternalStore(studioConnection.subscribe, studioConnection.get);
  const [copied, setCopied] = useState(false);
  useEffect(() => { if (state === 'up') setCopied(false); }, [state]);
  if (state === 'up') return null;
  if (state === 'locked') return <LockedNotice />;
  const gone = state === 'gone';
  const COMMAND = 'openfilm open';
  return (
    <>
      {gone ? <div aria-hidden className="fixed inset-0 z-[10049] bg-black/40 backdrop-blur-[1.5px]" /> : null}
      <div role="alert" className={`fixed inset-x-0 top-0 z-[10050] flex flex-wrap items-center justify-center gap-x-3 gap-y-1.5 px-4 py-2.5 text-[13px] font-medium text-white shadow-lg ${gone ? 'bg-[#b42318]' : 'bg-[#b54708]'}`}>
        <span aria-hidden className={`h-2 w-2 shrink-0 rounded-full bg-white ${gone ? '' : 'animate-pulse'}`} />
        <span>{t(gone ? (studioHost ? 'connection.goneApp' : 'connection.gone') : 'connection.lost')}</span>
        {gone && !studioHost ? (
          <button
            type="button"
            onClick={() => { void navigator.clipboard?.writeText(COMMAND).then(() => setCopied(true), () => {}); }}
            className="rounded-md bg-white/15 px-2 py-0.5 font-mono text-[12.5px] ring-1 ring-inset ring-white/30 hover:bg-white/25"
          >
            {copied ? t('connection.copied') : COMMAND}
          </button>
        ) : null}
      </div>
    </>
  );
}
