/**
 * The chat, mounted in Studio's page (apps/desktop/shell): its column beside Studio, under the top bar. The theme is
 * the page's (`<html data-theme>`, Studio's), so there is nothing to follow; the language is Studio's too, and the
 * chat's own words follow it.
 *
 * The column is drawn before the app's first answer: a slow project read or a bridge that is not ready yet used to
 * leave an empty column where the chat should be, which reads as the chat having disappeared. A failed start says so
 * and offers to try again instead.
 */
import { StrictMode, type ReactNode } from 'react';
import { createRoot } from 'react-dom/client';
import { Loader2, MessageSquare, RefreshCw } from 'lucide-react';
import { App } from './App';
import { app } from './app-bridge';
import { setLanguage, useT } from './i18n';

const START_WAIT_MS = 15_000;

function Shell({ children }: { children: ReactNode }) {
  return (
    <aside className="flex h-full min-h-0 flex-col items-center justify-center gap-3 overflow-hidden rounded-[7px] bg-[var(--dock-pane)] px-6 text-center">
      {children}
    </aside>
  );
}

function Starting() {
  const t = useT();
  return (
    <Shell>
      <span className="flex h-9 w-9 items-center justify-center rounded-full bg-[var(--surface-2)] text-[var(--text-muted)]">
        <MessageSquare size={16} aria-hidden />
      </span>
      <p role="status" className="flex items-center gap-2 text-[12.5px] text-[var(--text-muted)]">
        <Loader2 size={13} className="animate-spin" aria-hidden /> {t('boot.starting')}
      </p>
    </Shell>
  );
}

function Unavailable({ message, onRetry }: { message: string; onRetry: () => void }) {
  const t = useT();
  return (
    <Shell>
      <span className="flex h-9 w-9 items-center justify-center rounded-full bg-[var(--surface-2)] text-[var(--text-muted)]">
        <MessageSquare size={16} aria-hidden />
      </span>
      <div className="flex max-w-[300px] flex-col gap-1">
        <p className="text-[13px] font-medium text-[var(--text)]">{t('boot.unavailable')}</p>
        <p className="break-words text-[11.5px] leading-relaxed text-[var(--text-muted)]">{message === 'timeout' ? t('boot.timeout') : message}</p>
      </div>
      <button type="button" onClick={onRetry}
        className="flex items-center gap-1.5 rounded-md border border-[var(--border)] px-2.5 py-1 text-[12px] text-[var(--text)] transition hover:bg-[var(--bg-hover)]">
        <RefreshCw size={12} aria-hidden /> {t('boot.retry')}
      </button>
    </Shell>
  );
}

export async function mountChat(root: HTMLElement) {
  const rendered = createRoot(root);
  let languageWired = false;
  let booting = false;
  /* the page's language before the app answers: Studio puts its own on <html> */
  setLanguage(document.documentElement.lang || navigator.language);

  const boot = async () => {
    if (booting) return;
    booting = true;
    rendered.render(<Starting />);
    let timer: ReturnType<typeof setTimeout> | null = null;
    try {
      const hello = await Promise.race([
        app.hello(),
        new Promise<never>((_, fail) => { timer = setTimeout(() => fail(new Error('timeout')), START_WAIT_MS); }),
      ]);
      if (timer) clearTimeout(timer);
      timer = null;
      if (!languageWired) {
        languageWired = true;
        setLanguage(hello.language);
        app.onLanguage(setLanguage);
      }
      rendered.render(
        <StrictMode><App initialProject={hello.project} initialSelection={hello.selection} initialFfmpeg={hello.ffmpeg} /></StrictMode>,
      );
    } catch (error) {
      const message = error instanceof Error && error.message ? error.message : String(error);
      rendered.render(<Unavailable message={message} onRetry={() => { booting = false; void boot(); }} />);
    } finally {
      if (timer) clearTimeout(timer);
      booting = false;
    }
  };

  await boot();
}
