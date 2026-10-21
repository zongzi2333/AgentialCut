/**
 * Step 3, storyboard and rough cut: the AI's draft of the film, before it reaches the timeline.
 *
 * Two things side by side, because a draft is both talk and pictures: the storyboard shows the shots and their shape in
 * time; the pane beside it is where the ask is typed and the history read. The panel keeps the same views it had in the
 * dock, less the shot list — the board is that list, with the room to draw it.
 */
import { AiPanel } from '../ai/AiPanel';
import { StoryboardBoard } from './StoryboardBoard';

export function RoughCutStage({ totalMs, selectedCount, subtitleCount, trackCount, onClose }: {
  totalMs: number;
  selectedCount: number;
  subtitleCount: number;
  trackCount: number;
  onClose: () => void;
}) {
  return (
    <div className="flex min-h-0 min-w-0 flex-1 gap-[6px]">
      <StoryboardBoard totalMs={totalMs} trackCount={trackCount} />
      <div className="flex w-[420px] shrink-0 flex-col overflow-hidden rounded-[7px] border border-[var(--border)] bg-[var(--dock-pane)] shadow-[var(--shadow-sm)]">
        <AiPanel
          totalMs={totalMs}
          selectedCount={selectedCount}
          subtitleCount={subtitleCount}
          onClose={onClose}
        />
      </div>
    </div>
  );
}
