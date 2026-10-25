/**
 * Step 6, deliver: the export center in the workflow, not behind a dialog.
 *
 * The export center already knows every destination, quality and side file; the step gives it the workflow's own
 * pane bar and the full workspace, so choosing where the film goes is part of the film rather than a window over it.
 * Editing, sound and delivery then share one surface and one set of margins.
 */
import type { ReactNode } from 'react';
import { PackageCheck } from 'lucide-react';
import { useT } from '@/i18n';
import { PANE_BAR, PANE_TITLE } from '../dock-pane-bar';

export function DeliverStage({ children }: { children: ReactNode }) {
  const t = useT();
  return (
    <div className="flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden rounded-[7px] bg-[var(--dock-pane)]">
      <div className={PANE_BAR}>
        <PackageCheck size={14} aria-hidden className="shrink-0 text-[var(--text-dim)]" />
        <span className={PANE_TITLE}>{t('deliverStage.title')}</span>
        <span className="min-w-0 flex-1" />
        <span className="shrink-0 pr-1 text-[10.5px] text-[var(--text-faint)]">{t('deliverStage.hint')}</span>
      </div>
      <div className="min-h-0 flex-1 overflow-hidden">{children}</div>
    </div>
  );
}
