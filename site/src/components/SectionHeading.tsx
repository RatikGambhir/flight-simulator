import type { ReactNode } from 'react'
import { cn } from '@/lib/utils'
import { Reveal } from './Reveal'

type SectionHeadingProps = {
  eyebrow: string
  title: ReactNode
  children?: ReactNode
  align?: 'left' | 'center'
  className?: string
  id?: string
}

export function SectionHeading({ eyebrow, title, children, align = 'left', className, id }: SectionHeadingProps) {
  return (
    <div className={cn('flex flex-col gap-5', align === 'center' && 'items-center text-center', className)}>
      <Reveal>
        <p className="label-mono text-sun">{eyebrow}</p>
      </Reveal>
      <Reveal delay={0.06}>
        <h2 id={id} className="max-w-[18ch] text-4xl leading-[1.02] font-semibold tracking-[-0.035em] sm:text-5xl lg:text-6xl">
          {title}
        </h2>
      </Reveal>
      {children ? (
        <Reveal delay={0.12}>
          <p className="max-w-[56ch] text-base leading-relaxed text-muted-foreground sm:text-lg">{children}</p>
        </Reveal>
      ) : null}
    </div>
  )
}
