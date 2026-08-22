/**
 * The RYLA mark.
 *
 * Two lockups, because the driver's header is 44 pixels tall and the tagline
 * is illegible there — shrinking the full logo to fit would render it as a
 * grey smear rather than a brand.
 *
 * NOTE: these SVGs are a reproduction traced from the supplied logo image, not
 * the original artwork. Replace `public/brand/ryla-logo.svg` and
 * `public/brand/ryla-mark.svg` with the official files and nothing else needs
 * to change — every usage points at those two paths.
 */

/** Full lockup: wordmark plus GLOBAL SERVICES. For login and the sidebar. */
export function BrandLogo({
  className = '', width = 200,
}: { className?: string; width?: number }) {
  return (
    <img
      src="/brand/ryla-logo.svg"
      alt="RYLA Global Services"
      width={width}
      height={Math.round((width / 830) * 252)}
      className={className}
    />
  )
}

/**
 * Wordmark only. `currentColor` drives the letters, so it sits on navy or on
 * white without a second asset; the orange accent stays orange either way.
 */
export function BrandMark({
  className = '', height = 22,
}: { className?: string; height?: number }) {
  return (
    <svg
      viewBox="0 0 830 190"
      height={height}
      width={Math.round((height / 190) * 830)}
      role="img"
      aria-label="RYLA"
      className={className}
    >
      <g fill="currentColor">
        <path
          fillRule="evenodd"
          d="M20 20h132c33 0 53 24 53 56 0 24-13 43-33 51l36 43h-58l-31-38H62v38H20V20Zm42 42h88c9 0 15 6 15 14s-6 14-15 14H62V62Z"
        />
        <path d="M352 20h48l-72 90v60h-44v-60L352 20Z" />
        <path d="M428 20h44v106h88v44H428V20Z" />
        <path d="M696 20c-17 0-29 10-34 26l-72 124h52l54-98h4l54 98h52l-76-124c-5-16-17-26-34-26Z" />
      </g>
      <path fill="#F58220" d="M222 20h48l58 90h-44L222 20Z" />
    </svg>
  )
}

/** Where the company lives, for footers. */
export const RYLA_WEBSITE = 'https://www.rylaglobalservices.com/'

export function BrandFooter({ className = '' }: { className?: string }) {
  return (
    <p className={`text-center text-xs text-ink-600 ${className}`}>
      <a
        href={RYLA_WEBSITE}
        target="_blank"
        rel="noreferrer noopener"
        className="inline-flex min-h-11 items-center underline decoration-line/60
                   underline-offset-2 hover:text-ink-900"
      >
        rylaglobalservices.com
      </a>
    </p>
  )
}
