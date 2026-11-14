import type { ComponentProps } from 'react'
import { cn } from '@/lib/utils'
import type { Photo } from '@/content/images'

type PictureProps = {
  photo: Photo
  /** Layout width hint for the browser's candidate choice. */
  sizes: string
  /** Above-the-fold images load eagerly with high priority. */
  priority?: boolean
  className?: string
  imgClassName?: string
} & Pick<ComponentProps<'img'>, 'style'>

/** AVIF with a JPEG fallback, intrinsic dimensions declared so nothing shifts. */
export function Picture({ photo, sizes, priority = false, className, imgClassName, style }: PictureProps) {
  return (
    <picture className={cn('block size-full', className)}>
      <source type="image/avif" srcSet={photo.avif.map((c) => `${c.src} ${c.width}w`).join(', ')} sizes={sizes} />
      <img
        src={photo.fallback}
        alt={photo.alt}
        width={photo.width}
        height={photo.height}
        loading={priority ? 'eager' : 'lazy'}
        decoding={priority ? 'sync' : 'async'}
        fetchPriority={priority ? 'high' : 'auto'}
        draggable={false}
        className={cn('size-full object-cover', imgClassName)}
        style={style}
      />
    </picture>
  )
}
