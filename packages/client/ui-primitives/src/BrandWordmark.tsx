import { BRAND_MARK_HREF } from './FishLogo.tsx'
import type { IconProps } from './icons/props.ts'

/** Display options for the official brand wordmark. */
export interface BrandWordmarkProps extends IconProps {
  /** Whether to include the leading whale mark; defaults to true. */
  includeMark?: boolean | undefined
}

/**
 * Render the full brand wordmark.
 * @param props.size - height in px (default 24; width follows the selected artwork).
 * @param props.className - extra class for layout placement.
 * @param props.includeMark - whether to include the leading whale mark.
 * @returns the wordmark svg (aria-hidden decorative brand art).
 */
export function BrandWordmark({ size = 24, className, includeMark = true }: BrandWordmarkProps) {
  const width = includeMark ? 182 : 156
  return (
    <svg
      width={(size * width) / 24}
      height={size}
      className={className}
      viewBox={includeMark ? '0 0 182 24' : '0 0 156 24'}
      fill="none"
      aria-hidden="true"
    >
      {includeMark && <image width="24" height="24" href={BRAND_MARK_HREF} />}
      <text x={includeMark ? 32 : 0} y="18" fill="currentColor" fontSize="19" fontWeight="600" fontFamily="'Montserrat', 'Segoe UI', sans-serif">BaiLan</text>
    </svg>
  )
}
