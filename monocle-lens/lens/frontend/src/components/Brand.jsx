import { Link } from 'react-router-dom'
import MonocleMark from './MonocleMark'

/**
 * The lockup: Monocle's corporate mark, a hairline, then the product name.
 *
 * Read left to right it says "Monocle — Lens": the house mark, then the product. The
 * mark is the real one, inlined by MonocleMark so its letterforms take `currentColor`
 * and read white on the navy rail and navy on light surfaces from one component.
 *
 * `size` keeps the rail and the mobile header in step.
 */
const SIZES = {
  md: { mark: 'h-[26px]', name: 'text-[19px]', rule: 'h-6' },
  lg: { mark: 'h-[30px]', name: 'text-[22px]', rule: 'h-7' },
}

export default function Brand({ size = 'md', className = '' }) {
  const s = SIZES[size] || SIZES.md

  return (
    <Link
      to="/"
      aria-label="Lens — home"
      className={`group inline-flex items-center gap-3.5 ${className}`}
    >
      {/* Inlined, so the letterforms take white on the navy rail and navy on
          light surfaces from one component. It lifts a touch on approach. */}
      <MonocleMark
        className={`${s.mark} w-auto shrink-0 transition-transform duration-500 ease-spring group-hover:-translate-y-px group-hover:scale-[1.03]`}
      />
      <span className={`${s.rule} w-px shrink-0 bg-current opacity-25`} aria-hidden="true" />
      <span
        className={`${s.name} font-semibold leading-none tracking-brand text-inherit transition-opacity duration-200 ease-smooth group-hover:opacity-80`}
      >
        Lens
      </span>
    </Link>
  )
}
