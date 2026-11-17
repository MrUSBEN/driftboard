/** The Driftboard wordmark, drawn in the text colour so it reads on light and dark (wave and frame stay coral). */
export function Wordmark({ height = 15 }: { height?: number }) {
  return <svg className="wm" viewBox="-10 -14 535 112" height={height} style={{ display: 'block', width: 'auto', color: 'var(--text)' }} role="img" aria-label="Driftboard">
    <g fill="none" stroke="currentColor" strokeWidth={10} strokeLinecap="round" strokeLinejoin="round">
      <circle cx="20" cy="60" r="20" /><path d="M40 0V80" />
      <g transform="translate(64 0)"><path d="M0 40V80M0 58C0 46 8 40 20 40" /></g>
      <g transform="translate(108 0)"><path d="M0 40V80" /></g>
      <g transform="translate(132 0)"><path d="M12 80V20C12 6 20 0 32 0" /></g>
      <g transform="translate(184 0)"><path d="M12 8V68C12 76 17 80 26 80" /></g>
      <g transform="translate(232 0)"><path d="M0 0V80" /><circle cx="20" cy="60" r="20" /></g>
      <g transform="translate(296 0)"><circle cx="20" cy="60" r="20" /></g>
      <g transform="translate(360 0)"><circle cx="20" cy="60" r="20" /><path d="M40 40V80" /></g>
      <g transform="translate(424 0)"><path d="M0 40V80M0 58C0 46 8 40 20 40" /></g>
      <g transform="translate(468 0)"><circle cx="20" cy="60" r="20" /><path d="M40 0V80" /></g>
    </g>
    <path d="M130 40C145 31 156 49 171 40C185 31 197 49 214 40" fill="none" stroke="#FF6B4A" strokeWidth={10} strokeLinecap="round" />
    <rect x="100.5" y="10.5" width="15" height="15" rx="4" fill="#FF6B4A" transform="rotate(-12 108 18)" />
  </svg>;
}
