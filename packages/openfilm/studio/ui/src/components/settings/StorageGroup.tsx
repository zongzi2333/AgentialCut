/**
 * Settings → General → Project save location: the projects library, the folder every project is a folder of
 * (studio/server's locations, src/locations.mjs). It shows its folder and the free space on its disk, and can be
 * changed, opened in the file manager, or set back to its default. The folder is picked in Studio's own browser, the
 * dialog the Projects window uses, so it sits above the settings page and matches the rest of Studio. When projects
 * are in it, a change asks whether they move too; left behind, they stay where they are, and in the list.
 */
import React from 'react';
import { useT } from '@/i18n';
import { api, type StudioLocation, type StudioLocations } from '@/api';
import { FolderBrowserDialog } from '../ProjectSources';
import { ConfirmDialog } from '../ConfirmDialog';
import { SettingsButton, SettingsGroup, SettingsItem, settingsError } from './ui';

type Which = keyof StudioLocations;

/** Bytes as the person reads a disk's free space: GB, or MB below one. */
function size(bytes: number): string {
  return bytes >= 1e9 ? `${(bytes / 1e9).toFixed(bytes >= 1e11 ? 0 : 1)} GB` : `${Math.max(1, Math.round(bytes / 1e6))} MB`;
}

export function StorageGroup() {
  const t = useT();
  const [where, setWhere] = React.useState<StudioLocations | null>(null);
  const [busy, setBusy] = React.useState<Which | null>(null);
  const [error, setError] = React.useState<{ which: Which; text: string } | null>(null);
  /* the library with projects in it: whether they move too */
  const [asking, setAsking] = React.useState<{ which: Which; folder: string | null } | null>(null);
  const [note, setNote] = React.useState<{ which: Which; text: string } | null>(null);
  /* Studio's own folder browser, where the app has none; it is drawn above this page */
  const [browser, setBrowser] = React.useState(false);
  const load = React.useCallback(() => { void api.locations().then(setWhere).catch(() => {}); }, []);
  React.useEffect(load, [load]);
  if (!where) return null;

  const apply = async (which: Which, folder: string | null, move: boolean) => {
    setBusy(which);
    setError(null);
    setNote(null);
    try {
      const done = await api.moveLibrary(folder, move);
      setWhere(done.locations);
      if (done.failed.length) {
        const first = done.failed[0];
        setError({ which, text: `${t('settings.storage.moveFailed').replace('{names}', done.failed.map((f) => f.name).join(', '))}${first?.error ? `: ${first.error}` : ''}` });
      }
      if (done.moved) setNote({ which, text: t('settings.storage.moved').replace('{count}', String(done.moved)) });
    } catch (e) {
      setError({ which, text: e instanceof Error ? e.message : String(e) });
    } finally {
      setBusy(null);
    }
  };
  const keep = (which: Which, folder: string | null) => {
    const now = where[which];
    if (now.count > 0 && (folder ?? now.default) !== now.path) setAsking({ which, folder });
    else void apply(which, folder, false);
  };
  const row = (which: Which, place: StudioLocation) => (
    <SettingsItem
      key={which}
      title={t(`settings.storage.${which}`)}
      description={(
        <>
          <span className="mt-1 block break-all font-mono text-[13px]" title={place.path}>{place.path}</span>
          {place.free != null ? <span className="mt-0.5 block text-[13px]">{t('settings.storage.free').replace('{size}', size(place.free))}</span> : null}
          {note?.which === which ? <span className="mt-1 block text-[13px]" role="status">{note.text}</span> : null}
          {error?.which === which ? <span className={`mt-1 block ${settingsError}`} role="alert">{error.text}</span> : null}
        </>
      )}
      control={(
        <>
          {place.chosen ? (
            <SettingsButton variant="quiet" disabled={busy === which} onClick={() => keep(which, null)} title={place.default}>{t('settings.storage.reset')}</SettingsButton>
          ) : null}
          <SettingsButton onClick={() => void api.openLocation(which).catch(() => {})}>{t('settings.storage.show')}</SettingsButton>
          <SettingsButton disabled={busy === which} onClick={() => setBrowser(true)}>{t('settings.storage.change')}</SettingsButton>
        </>
      )}
    />
  );

  return (
    <>
      <SettingsGroup title={t('settings.storage.group')}>
        {row('projects', where.projects)}
      </SettingsGroup>
      {browser ? (
        <FolderBrowserDialog
          mode="choose"
          title={t('settings.storage.projectsPick')}
          subtitle={where.projects.path}
          startAt={where.projects.path}
          onPick={async (path) => {
            setBrowser(false);
            keep('projects', path);
          }}
          onClose={() => setBrowser(false)}
        />
      ) : null}
      <ConfirmDialog
        open={!!asking}
        title={t('settings.storage.moveTitle')}
        description={asking ? t('settings.storage.moveDesc')
          .replace('{count}', String(where[asking.which].count))
          .replace('{from}', where[asking.which].path)
          .replace('{to}', asking.folder ?? where[asking.which].default) : undefined}
        confirmLabel={t('settings.storage.moveYes')}
        altLabel={t('settings.storage.moveNo')}
        onConfirm={() => { const a = asking; setAsking(null); if (a) void apply(a.which, a.folder, true); }}
        onAlt={() => { const a = asking; setAsking(null); if (a) void apply(a.which, a.folder, false); }}
        onCancel={() => setAsking(null)}
      />
    </>
  );
}
