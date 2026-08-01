import { cn } from '@/lib/utils';

export function BrandMark({ className, compact = false }: { className?: string; compact?: boolean }) {
  return (
    <div className={cn('flex items-center gap-2.5', className)}>
      <span
        aria-hidden="true"
        className="grid size-9 place-items-center rounded-xl bg-[linear-gradient(145deg,var(--brand-cyan),var(--brand-teal))] text-base font-black text-[#10232a] shadow-[0_6px_20px_color-mix(in_oklch,var(--brand-teal),transparent_65%)]"
      >
        S
      </span>
      {!compact && (
        <span className="font-display text-lg font-semibold tracking-[-0.04em] text-current">
          Stream Slack
        </span>
      )}
    </div>
  );
}
