/**
 * Settings → Services: which connected provider, and which of its models, makes each kind of media. One of the models
 * of a provider the person has a key for ("ElevenLabs · Eleven v3"), or none, listed by the providers' names, none put
 * first. Connecting a provider fills the kinds that have none, with its first model; the person changes any here.
 * Under them, the person's custom services, which their agent calls itself (CustomServices).
 */
import React from 'react';
import { Check, ChevronDown, ChevronRight, Database, HardDrive, Upload } from 'lucide-react';
import { useLanguage, useT } from '@/i18n';
import { USE_VERBS, couldMake, offered, useProviders, type ProviderVerb, type ProvidersHook } from '@/lib/providers';
import { Popover } from '@/components/Popover';
import { api, type SemanticModel } from '@/api';
import { ProviderMark } from './ProviderMark';
import { SettingsButton, SettingsGroup, SettingsItem, SettingsPage, settingsError } from './ui';
import { CustomServices, customProblem } from './CustomServices';

/** One thing a kind of media can be made with: a provider and its model. */
interface Choice {
  value: string;
  provider: string;
  providerName: string;
  name: string;
  pick: { model?: string };
}

export function ModelsSection({ onConnect }: { onConnect: () => void }) {
  const t = useT();
  const hook = useProviders();
  const providers = hook.state;
  const anything = Boolean(providers?.providers.some((p) => p.source));
  const [semanticModels, setSemanticModels] = React.useState<SemanticModel[]>([]);
  const importRef = React.useRef<HTMLInputElement>(null);

  React.useEffect(() => {
    void api.semanticModels().then((result) => setSemanticModels(result.models)).catch(() => {});
  }, []);

  return (
    <SettingsPage note={t('settings.models.desc')}>
      <SettingsGroup title={t('settings.models.semanticTitle')}>
        <p className="text-[12.5px] leading-relaxed text-[var(--text-muted)]">{t('settings.models.semanticDesc')}</p>
        {semanticModels.length ? (
          <div className="grid gap-2 sm:grid-cols-2">
            {semanticModels.map((model) => (
              <article key={model.id} className="min-w-0 rounded-[10px] border border-[var(--border)] bg-[var(--surface-2)] p-3">
                <div className="flex items-center gap-2">
                  <Database size={14} className="shrink-0 text-[var(--accent)]" />
                  <span className="min-w-0 flex-1 truncate text-[12.5px] font-medium text-[var(--text)]" title={model.id}>{model.name}</span>
                  <span className="rounded-full bg-[var(--surface)] px-1.5 py-[1px] text-[9.5px] text-[var(--text-faint)]">{t('settings.models.installed')}</span>
                </div>
                <p className="mt-1.5 text-[10.5px] text-[var(--text-faint)]">
                  {model.provider} · {model.dimension}d · {model.imageSize}px · {model.languages.join(' / ')}
                </p>
                {model.path ? (
                  <p className="mt-1.5 flex min-w-0 items-start gap-1 text-[10px] text-[var(--text-faint)]" title={model.path}>
                    <span className="shrink-0">{t('settings.models.storageLocation')}</span>
                    <HardDrive size={10} className="mt-0.5 shrink-0" />
                    <span className="min-w-0 flex-1 break-all font-mono leading-snug">{model.path}</span>
                  </p>
                ) : null}
              </article>
            ))}
          </div>
        ) : <p className="text-[12.5px] text-[var(--text-faint)]">{t('settings.models.noSemantic')}</p>}
        <div className="flex items-center gap-2">
          <SettingsButton onClick={() => importRef.current?.click()}><Upload size={13} />{t('settings.models.import')}</SettingsButton>
          <input ref={importRef} type="file" accept=".zip,application/zip" className="hidden"
            onChange={(event) => {
              const file = event.target.files?.[0];
              event.target.value = '';
              if (!file) return;
              void api.semanticImportModel(file).then(() => api.semanticModels()).then((result) => setSemanticModels(result.models)).catch(() => {});
            }} />
        </div>
      </SettingsGroup>

      {providers && !anything ? (
        <SettingsGroup>
          <SettingsItem description={t('settings.models.nothing')} title={t('settings.models.goConnect')}
            control={<SettingsButton onClick={onConnect}>{t('settings.models.goConnect')}</SettingsButton>} />
        </SettingsGroup>
      ) : null}
      {providers ? (
        <SettingsGroup title={t('settings.models.workflowModels')} footnote={t('settings.models.cardsHint')}>
          {USE_VERBS.filter((verb) => offered(providers, verb)).map((verb) => <ModelRow key={verb} verb={verb} hook={hook} onConnect={onConnect} />)}
        </SettingsGroup>
      ) : null}
      {providers ? <WorkflowModelCards hook={hook} /> : null}
      <CustomServices hook={hook} />
      {/* a custom service's problem is said under its form */}
      {hook.problem && !customProblem(hook) ? <p className={settingsError}>{hook.problem}</p> : null}
    </SettingsPage>
  );
}

/** The same choices as cards, grouped by the workflow that uses them. Clicking a card makes it the one for that
 *  workflow; the compact pickers above stay as the quick control. */
function WorkflowModelCards({ hook }: { hook: ProvidersHook }) {
  const t = useT();
  const state = hook.state;
  if (!state) return null;
  const verbs = USE_VERBS.filter((verb) => offered(state, verb));
  const sections = verbs.map((verb) => ({
    verb,
    choices: state.providers.flatMap((provider) => (
      (provider.source && provider.verbs.includes(verb) || provider.id === state.use[verb])
        ? (provider.models[verb] ?? []).map((model) => ({ provider, model }))
        : []
    )),
  })).filter((section) => section.choices.length > 0);
  if (!sections.length) return null;
  return (
    <SettingsGroup title={t('settings.models.catalogTitle')}>
      {sections.map(({ verb, choices }) => {
        return (
          <div key={verb} className="border-t border-[var(--border-soft)] pt-3 first:border-t-0 first:pt-0">
            <h3 className="text-[12.5px] font-medium text-[var(--text)]">{t(`settings.providers.verbs.${verb}`)}</h3>
            <p className="mt-0.5 text-[11.5px] text-[var(--text-faint)]">{t(`settings.models.about.${verb}`)}</p>
            <div className="mt-2 grid gap-2 sm:grid-cols-2">
              {choices.map(({ provider, model }) => {
                const current = state.use[verb] === provider.id && (state.model[verb] ?? provider.models[verb]?.[0]?.id) === model.id;
                return (
                  <button key={`${provider.id}:${model.id}`} type="button" onClick={() => void hook.choose(verb, provider.id, { model: model.id })}
                    className={`flex min-w-0 items-center gap-2 rounded-[9px] border p-2.5 text-left transition ${current ? 'border-[var(--text-muted)] bg-[var(--surface-2)]' : 'border-[var(--border)] hover:border-[var(--border-strong)]'}`}>
                    <ProviderMark id={provider.id} size={14} />
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-[11.5px] font-medium text-[var(--text)]">{model.name}</span>
                      <span className="block truncate text-[10px] text-[var(--text-faint)]">{provider.name}</span>
                    </span>
                    {current ? <Check size={13} className="shrink-0 text-[var(--accent)]" /> : null}
                  </button>
                );
              })}
            </div>
          </div>
        );
      })}
    </SettingsGroup>
  );
}

/** One kind of media and what makes it, picked from the connected providers' models. */
function ModelRow({ verb, hook, onConnect }: { verb: ProviderVerb; hook: ProvidersHook; onConnect: () => void }) {
  const t = useT();
  const state = hook.state!;
  const label = t(`settings.providers.verbs.${verb}`);
  const chosen = state.use[verb] ?? '';

  const choices: Choice[] = [];
  for (const p of state.providers) {
    if (!((p.source && p.verbs.includes(verb)) || p.id === chosen)) continue;
    for (const m of p.models[verb] ?? []) choices.push({ value: `${p.id}:${m.id}`, provider: p.id, providerName: p.name, name: m.name, pick: { model: m.id } });
  }
  /* by the providers' names; each provider's models stay in its own order (the sort is stable) */
  choices.sort((a, b) => a.providerName.localeCompare(b.providerName));
  const firstOf = (id: string) => state.providers.find((p) => p.id === id)?.models[verb]?.[0]?.id;
  const value = chosen ? `${chosen}:${state.model[verb] ?? firstOf(chosen) ?? ''}` : '';
  const current = choices.find((c) => c.value === value);
  /* nothing connected makes it: the providers that would, once connected */
  const could = couldMake(state, verb);

  return (
    <SettingsItem
      title={label}
      description={t(`settings.models.about.${verb}`)}
      control={(
        <ModelPicker
          label={label}
          choices={choices}
          current={current ?? null}
          busy={hook.busy === verb}
          could={could}
          onConnect={onConnect}
          onPick={(choice) => void hook.choose(verb, choice?.provider ?? '', choice?.pick)}
        />
      )}
    />
  );
}

/**
 * The button showing what makes a kind of media, and the menu of every model it could be, by provider. With nothing
 * connected that makes it, it names the providers that would and goes to connect one.
 */
function ModelPicker({ label, choices, current, busy, could, onConnect, onPick }: {
  label: string;
  choices: Choice[];
  current: Choice | null;
  busy: boolean;
  /** the names of the providers, not connected, that make this kind of media */
  could: string[];
  onConnect: () => void;
  onPick: (choice: Choice | null) => void;
}) {
  const t = useT();
  const language = useLanguage();
  const [open, setOpen] = React.useState(false);
  const list = React.useRef<HTMLDivElement>(null);
  const empty = choices.length === 0;
  const groups = choices.reduce<{ provider: string; name: string; choices: Choice[] }[]>((all, c) => {
    const group = all.find((g) => g.provider === c.provider);
    if (group) group.choices.push(c); else all.push({ provider: c.provider, name: c.providerName, choices: [c] });
    return all;
  }, []);

  /* the menu opens on the chosen one; the arrow keys move between them */
  React.useEffect(() => {
    if (!open) return;
    const r = requestAnimationFrame(() => (list.current?.querySelector<HTMLElement>('[aria-selected="true"]') ?? list.current?.querySelector<HTMLElement>('[role="option"]'))?.focus());
    return () => cancelAnimationFrame(r);
  }, [open]);
  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return;
    e.preventDefault();
    const options = Array.from(list.current?.querySelectorAll<HTMLElement>('[role="option"]') ?? []);
    const at = options.indexOf(document.activeElement as HTMLElement);
    options[(at + (e.key === 'ArrowDown' ? 1 : -1) + options.length) % options.length]?.focus();
  };
  const pick = (choice: Choice | null) => { setOpen(false); if (choice?.value !== current?.value) onPick(choice); };

  const option = (choice: Choice | null, text: string) => {
    const selected = (choice?.value ?? '') === (current?.value ?? '');
    return (
      <button key={choice?.value ?? ''} type="button" role="option" aria-selected={selected} onClick={() => pick(choice)}
        className="flex h-9 w-full items-center gap-2 rounded-[6px] px-2 text-left text-[14.5px] text-[var(--text)] outline-none hover:bg-[var(--bg-hover)] focus-visible:bg-[var(--bg-hover)]">
        <span className="min-w-0 flex-1 truncate">{text}</span>
        {selected ? <Check size={17} className="shrink-0 text-[var(--text-muted)]" /> : null}
      </button>
    );
  };

  const connect = could.length
    ? t('settings.models.connectNamed').replace('{names}', new Intl.ListFormat(language, { type: 'disjunction' }).format(could))
    : t('settings.models.goConnect');
  const trigger = empty ? (
    <button type="button" aria-label={`${label}: ${connect}`} title={connect} disabled={busy} onClick={onConnect}
      className="flex h-10 w-[280px] items-center gap-2 rounded-[8px] border border-[var(--border)] px-3 text-left text-[14.5px] text-[var(--text-muted)] transition hover:border-[var(--border-strong)] hover:text-[var(--text)] disabled:opacity-60">
      <span className="min-w-0 flex-1 truncate">{connect}</span>
      <ChevronRight size={15} className="shrink-0" />
    </button>
  ) : (
    <button type="button" aria-label={label} aria-haspopup="listbox" aria-expanded={open} disabled={busy}
      className={`flex h-10 w-[280px] items-center gap-2 rounded-[8px] border px-3 text-left text-[14.5px] text-[var(--text)] transition disabled:opacity-60 ${open ? 'border-[var(--text-muted)]' : 'border-[var(--border)] hover:border-[var(--border-strong)]'}`}>
      {current ? <ProviderMark id={current.provider} size={15} /> : null}
      <span className={`min-w-0 flex-1 truncate ${current ? '' : 'text-[var(--text-muted)]'}`}>
        {current ? `${current.providerName} · ${current.name}` : t('settings.models.none')}
      </span>
      <ChevronDown size={15} className="shrink-0 text-[var(--text-muted)]" />
    </button>
  );

  return (
    <div className="shrink-0">
      <Popover open={open && !empty} onOpenChange={setOpen} placement="auto" align="end" layer={10060} trigger={trigger}>
        <div ref={list} role="listbox" aria-label={label} onKeyDown={onKeyDown}
          className="max-h-[min(360px,var(--popover-max-h))] w-[288px] overflow-y-auto rounded-[10px] border border-[var(--border)] bg-[var(--surface)] p-1 shadow-[var(--shadow-lg)]">
          {groups.map((group) => (
            <div key={group.provider} className="mb-1" role="group" aria-label={group.name}>
              <div className="flex items-center gap-1.5 px-2 pb-1 pt-1.5 text-[14px] font-medium text-[var(--text-muted)]">
                <ProviderMark id={group.provider} size={15} />{group.name}
              </div>
              {group.choices.map((c) => option(c, c.name))}
            </div>
          ))}
          <div className="border-t border-[var(--border-soft)] pt-1">{option(null, t('settings.models.none'))}</div>
        </div>
      </Popover>
    </div>
  );
}
