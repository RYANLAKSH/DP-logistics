import type { ReactNode } from 'react'

export function Card({
  children, className = '', as: Tag = 'div',
}: { children: ReactNode; className?: string; as?: 'div' | 'section' | 'li' }) {
  return (
    <Tag className={`rounded-card border border-line/30 bg-white p-4 shadow-sm ${className}`}>
      {children}
    </Tag>
  )
}

export function CardHeader({
  title, subtitle, right,
}: { title: ReactNode; subtitle?: ReactNode; right?: ReactNode }) {
  return (
    <div className="mb-3 flex items-start justify-between gap-3">
      <div>
        <h2 className="text-lg font-bold text-ink-900">{title}</h2>
        {subtitle && <p className="text-sm text-ink-600">{subtitle}</p>}
      </div>
      {right}
    </div>
  )
}
