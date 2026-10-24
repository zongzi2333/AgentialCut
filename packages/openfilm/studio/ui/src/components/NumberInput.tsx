/**
 * A numeric field that lets a number be typed before it is judged. The value is kept as a draft
 * string while focused, so typing `20` does not become `2`, get clamped, and overwrite the `0`.
 * A valid in-range number is reported on each keystroke; blur/Enter normalizes and commits.
 */
import * as React from 'react';

export type NumberInputProps = Omit<React.InputHTMLAttributes<HTMLInputElement>, 'value' | 'onChange' | 'type'> & {
  value: number | null;
  onCommit: (value: number | null) => void;
  /** Empty is a valid value (an unset dimension, for example). */
  allowEmpty?: boolean;
};

const DEFAULT_CLASS = 'h-8 w-full min-w-0 rounded-md border border-[var(--border)] bg-[var(--bg)] px-2 tabular-nums text-[var(--text)] outline-none focus:border-[var(--border-strong)]';

export const NumberInput = React.forwardRef<HTMLInputElement, NumberInputProps>(function NumberInput(
  { value, onCommit, allowEmpty = false, min, max, step, className, onBlur, onKeyDown, ...props },
  ref,
) {
  const [draft, setDraft] = React.useState(value == null ? '' : String(value));
  const focused = React.useRef(false);

  React.useEffect(() => {
    if (!focused.current) setDraft(value == null ? '' : String(value));
  }, [value]);

  const parse = (text: string) => {
    const trimmed = text.trim().replace(',', '.');
    if (!trimmed) return null;
    const number = Number(trimmed);
    return Number.isFinite(number) ? number : null;
  };

  const normalize = (text: string) => {
    let next = parse(text);
    if (next == null) {
      if (allowEmpty) return null;
      next = value ?? (typeof min === 'number' ? min : 0);
    }
    if (typeof min === 'number') next = Math.max(min, next);
    if (typeof max === 'number') next = Math.min(max, next);
    return next;
  };

  const commit = (text: string) => {
    const next = normalize(text);
    setDraft(next == null ? '' : String(next));
    if (next !== value) onCommit(next);
  };

  return (
    <input
      {...props}
      ref={ref}
      type="number"
      min={min}
      max={max}
      step={step}
      value={draft}
      onFocus={(event) => {
        focused.current = true;
        props.onFocus?.(event);
      }}
      onChange={(event) => {
        const text = event.target.value;
        setDraft(text);
        const parsed = parse(text);
        /* Report only complete, in-range values while typing. An empty or partial value stays
           as a draft; it is normalized when focus leaves. */
        if (parsed == null) return;
        if ((typeof min !== 'number' || parsed >= min) && (typeof max !== 'number' || parsed <= max) && parsed !== value) onCommit(parsed);
      }}
      onBlur={(event) => {
        focused.current = false;
        commit(event.target.value);
        onBlur?.(event);
      }}
      onKeyDown={(event) => {
        if (event.key === 'Enter') {
          event.preventDefault();
          commit(event.currentTarget.value);
          event.currentTarget.blur();
        }
        onKeyDown?.(event);
      }}
      className={className ?? DEFAULT_CLASS}
    />
  );
});
