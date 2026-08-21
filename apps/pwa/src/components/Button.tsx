import type { ButtonHTMLAttributes, ReactNode } from 'react'

type Variant = 'primary' | 'secondary' | 'danger' | 'ghost'

interface Props extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: Variant
  /** Full-width, extra tall. The driver's primary action on a screen. */
  hero?: boolean
  icon?: ReactNode
}

const VARIANTS: Record<Variant, string> = {
  primary:
    'bg-ink-900 text-paper hover:bg-ink-800 active:bg-ink-950 border-ink-900',
  secondary:
    'bg-paper text-ink-900 hover:bg-paper-dim active:bg-paper-dim border-line',
  danger:
    'bg-bad-500 text-white hover:brightness-110 active:brightness-95 border-bad-500',
  ghost:
    'bg-transparent text-ink-700 hover:bg-paper-dim border-transparent',
}

/**
 * Minimum height is 56px — the `touch` token. A driver wearing gloves cannot
 * reliably hit anything smaller, and a mis-tap in this app costs a rescan.
 */
export function Button({
  variant = 'primary', hero = false, icon, className = '', children, ...rest
}: Props) {
  return (
    <button
      className={`inline-flex items-center justify-center gap-2.5 rounded-card border-2
                  font-semibold transition disabled:opacity-40
                  disabled:cursor-not-allowed
                  ${hero ? 'w-full min-h-touch text-xl px-6' : 'min-h-12 px-5 text-base'}
                  ${VARIANTS[variant]} ${className}`}
      {...rest}
    >
      {icon}
      {children}
    </button>
  )
}
