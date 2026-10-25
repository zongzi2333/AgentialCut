/**
 * The film's six steps, across the top of a project: project, media, storyboard and rough cut, sound, edit, deliver.
 *
 * It is a way through the work, not a set of tabs: each step is a place with its own surface (the project's facts, the
 * media library, the AI draft, the sound tools, the editor, the export center), and a person moves forward and back
 * freely. The order is the order a film is made in, so the first screen of a new project already says what comes next.
 *
 * Editing is the step that was here before; the others reuse what Studio already had (the media pane, the export
 * center) or add a surface of their own (the rough cut, the sound tools), so no two steps mean the same place.
 */
import * as React from 'react';
import {
  AudioLines, ChevronRight, FolderKanban, LibraryBig, PackageCheck, Scissors, WandSparkles,
} from 'lucide-react';
import { useT } from '@/i18n';
import { Tooltip } from '../Tooltip';

export type WorkflowStage = 'project' | 'media' | 'roughcut' | 'edit' | 'sound' | 'deliver';

/** In order: what a film goes through, from the folder it lives in to the file it becomes. */
const STEPS: readonly { id: WorkflowStage; icon: typeof FolderKanban }[] = [
  { id: 'project', icon: FolderKanban },
  { id: 'media', icon: LibraryBig },
  { id: 'roughcut', icon: WandSparkles },
  { id: 'sound', icon: AudioLines },
  { id: 'edit', icon: Scissors },
  { id: 'deliver', icon: PackageCheck },
];

export function WorkflowBar({ stage, onChange }: {
  stage: WorkflowStage;
  onChange: (stage: WorkflowStage) => void;
}) {
  const t = useT();
  return (
    <nav aria-label={t('workflow.title')}
      className="flex h-8 min-w-0 items-center gap-0.5 overflow-x-auto">
      {STEPS.map((step, i) => {
        const active = step.id === stage;
        return (
          <React.Fragment key={step.id}>
            {i ? <ChevronRight size={11} aria-hidden className="shrink-0 text-[var(--text-faint)]" /> : null}
            <Tooltip label={t(`workflow.${step.id}`)} side="bottom">
              <button
                type="button"
                aria-current={active ? 'step' : undefined}
                aria-label={t(`workflow.${step.id}`)}
                data-workflow-step={step.id}
                onClick={() => onChange(step.id)}
                className={`flex h-6 shrink-0 items-center gap-1 rounded-md px-1.5 text-[11.5px] transition ${
                  active
                    ? 'bg-[var(--surface-2)] text-[var(--text)] ring-1 ring-inset ring-[var(--border)]'
                    : 'text-[var(--text-muted)] hover:bg-[var(--bg-hover)] hover:text-[var(--text)]'
                }`}
              >
                {/* the step's number, filled when it is the one being worked on: order without pretending progress */}
                <span aria-hidden className={`flex h-3.5 min-w-3.5 items-center justify-center rounded-full px-0.5 text-[9px] font-medium tabular-nums ${
                  active ? 'bg-[var(--text)] text-[var(--panel)]' : 'bg-[var(--surface-2)] text-[var(--text-faint)]'
                }`}>{i + 1}</span>
                <step.icon size={12} aria-hidden className={active ? 'text-[var(--text)]' : 'text-[var(--text-dim)]'} />
                {/* narrow windows keep the icons and say the names on hover; the step in hand always says its name */}
                <span className={`${active ? '' : 'hidden min-[1100px]:inline'} whitespace-nowrap`}>{t(`workflow.${step.id}`)}</span>
              </button>
            </Tooltip>
          </React.Fragment>
        );
      })}
    </nav>
  );
}
