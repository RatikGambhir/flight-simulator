import { motion, type Variants } from 'motion/react'
import type { ReactNode } from 'react'
import { EASE_OUT } from '@/lib/motion'

const item: Variants = {
  hidden: { opacity: 0, y: 18 },
  shown: { opacity: 1, y: 0, transition: { duration: 0.8, ease: EASE_OUT } },
}

type RevealProps = {
  children: ReactNode
  className?: string
  /** Seconds before this element starts, for hand-placed sequences. */
  delay?: number
  as?: 'div' | 'li' | 'p' | 'h2' | 'header'
}

/**
 * Fades and lifts content once, the first time it scrolls into view.
 * Reduced motion is handled globally by <MotionConfig reducedMotion="user">,
 * which drops the transform and keeps a plain fade.
 */
export function Reveal({ children, className, delay = 0, as = 'div' }: RevealProps) {
  const Tag = motion[as]
  return (
    <Tag
      className={className}
      initial="hidden"
      whileInView="shown"
      viewport={{ once: true, margin: '0px 0px -12% 0px' }}
      variants={item}
      transition={{ delay }}
    >
      {children}
    </Tag>
  )
}

const group: Variants = {
  hidden: {},
  shown: { transition: { staggerChildren: 0.08, delayChildren: 0.05 } },
}

/** Staggers its direct <RevealItem> children as the group enters view. */
export function RevealGroup({ children, className, as = 'div' }: { children: ReactNode; className?: string; as?: 'div' | 'ul' }) {
  const Tag = motion[as]
  return (
    <Tag className={className} initial="hidden" whileInView="shown" viewport={{ once: true, margin: '0px 0px -10% 0px' }} variants={group}>
      {children}
    </Tag>
  )
}

export function RevealItem({ children, className, as = 'div' }: { children: ReactNode; className?: string; as?: 'div' | 'li' }) {
  const Tag = motion[as]
  return (
    <Tag className={className} variants={item}>
      {children}
    </Tag>
  )
}
