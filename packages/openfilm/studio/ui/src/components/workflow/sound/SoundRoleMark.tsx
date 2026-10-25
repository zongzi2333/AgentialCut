/**
 * What a kind of sound looks like wherever it is named: a small mark in the timeline's own color for it, and a chip
 * that says the role in words. One place for the icons and colors, so the library, the inspector and the tracks agree.
 */
import type { AudioRole } from '@/api';
import { Film, Mic, Music4, Volume2, type LucideIcon } from 'lucide-react';
import { AUDIO_ROLE_COLOR } from '@/lib/sound';

export const AUDIO_ROLE_ICON: Record<AudioRole, LucideIcon> = {
  voice: Mic,
  music: Music4,
  sfx: Volume2,
  footage: Film,
};

export function SoundRoleMark({ role, size = 13 }: { role: AudioRole; size?: number }) {
  const Icon = AUDIO_ROLE_ICON[role] ?? Volume2;
  return <Icon size={size} aria-hidden className="shrink-0" style={{ color: AUDIO_ROLE_COLOR[role] }} />;
}

export function SoundRoleChip({ role, label, tone = 'plain' }: { role: AudioRole; label: string; tone?: 'plain' | 'solid' }) {
  const color = AUDIO_ROLE_COLOR[role];
  return (
    <span
      className={`inline-flex shrink-0 items-center gap-1 rounded-full px-1.5 py-[1px] text-[9.5px] leading-4 ${tone === 'solid' ? 'text-white' : 'text-[var(--text-muted)]'}`}
      style={tone === 'solid'
        ? { background: color }
        : { background: `color-mix(in srgb, ${color} 18%, transparent)`, boxShadow: `inset 0 0 0 1px color-mix(in srgb, ${color} 38%, transparent)` }}
    >
      <span aria-hidden className="h-1 w-1 rounded-full" style={{ background: tone === 'solid' ? 'rgba(255,255,255,0.8)' : color }} />
      {label}
    </span>
  );
}
