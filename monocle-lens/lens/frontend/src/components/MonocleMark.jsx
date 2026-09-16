/**
 * Monocle's corporate mark, inlined.
 *
 * It has to be inline rather than an `<img src="/brand/logo.svg">`: an `<img>` loads
 * the SVG as its own document, so `currentColor` there resolves against the file's
 * own black rather than the surface it sits on, and the mark went black-on-navy in
 * the rail. Inlined, the letterforms inherit the text colour of whatever they are
 * placed on and the one component serves the navy rail and light surfaces alike.
 *
 * The diagonal keeps the brand red at all times — it is the fixed part of the mark.
 *
 * Source: monoclesolutions.com. `public/brand/logo.svg` is kept as the standalone
 * asset (favicons, exports, anywhere outside React).
 */
export default function MonocleMark({ className = '', title = 'Monocle' }) {
  return (
    <svg
      viewBox="0 0 170 50"
      className={className}
      role="img"
      aria-label={title}
      focusable="false"
    >
      <path fill="currentColor" d="M7.3,2.7c2,4.3,4,8.5,6.1,13.1c2.2-4.5,4.1-8.8,6.2-13.1H27v24.1h-5.4v-14c-0.1-0.1-0.3-0.1-0.4-0.2 c-2,4-4,8.1-6,12.2h-3.4c-2-3.9-4-8-6-12c-0.1,0-0.2,0-0.3,0v14H0V2.7H7.3z M44.4,6.9c-4,0-7.2,3.4-7.2,7.7c0,4.3,3.2,7.6,7.2,7.8 c3.8,0.1,7.7-3,7.5-7.8C51.9,11.3,49.7,6.8,44.4,6.9z M44.3,2.1c7.6,0,13.2,5.2,13.3,12.4c0.1,7.2-5.5,12.5-13,12.6 c-7.3,0.1-12.9-5.2-12.9-12.3C31.6,7.5,36.9,2.1,44.3,2.1z M77.4,24.9c-3.4-4.4-6.5-8.4-9.6-12.5c-0.1,0-0.2,0-0.3,0.1v14.3H62V2.7 h5.2c3.8,4.9,7.6,9.8,11.5,14.9c0.1,0,0.2-0.1,0.3-0.1V2.7h5.5v14.6C82.1,19.9,79.9,22.3,77.4,24.9z M152.3,18V42H170v-4.8h-12.1 v-4.8h10.7v-4.8h-10.7v-5h11.8V18H152.3z M128.5,22c-1.1,1.2-2.2,2.4-3.3,3.7c-0.8-0.7-1.4-1.2-2.2-1.7c-2.7-1.8-5.6-1.9-8.3-0.3 c-2.9,1.7-3.6,4.5-3.2,7.6c0.4,2.9,2,4.9,4.8,5.7c2.5,0.7,5,0.2,7.1-1.4c0.5-0.4,0.9-0.8,1.3-1.2c1.2,1.1,2.4,2.2,3.6,3.3 c-4.3,5.7-13.2,6.5-18.5,1.8c-5.4-4.8-5.7-13.4-0.5-18.4C114.7,15.8,123.5,16.2,128.5,22z M82.5,30.4c1.5,5.1,3.9,7.4,7.6,7.2 c3.1-0.1,5.9-2.5,6.6-5.6c0.9-4.4-0.8-7.5-5.5-9.8c1.2-1.2,2.4-2.5,3.6-3.7c5.1,1.7,8.2,6.9,7.8,12.6c-0.4,5.5-4.6,10.1-10.5,11.2 c-5.9,1.1-11.5-1.8-14.4-7.8c0.8-0.6,1.6-1.3,2.4-2C81,31.9,81.8,31.2,82.5,30.4z M132.6,18h5.4v19.3h10.3V42h-15.6V18z" />
      <path fill="#E82B2B" d="M108.4,0c-0.5,0.5-0.9,0.9-1.3,1.4C92,16.9,76.9,32.4,61.8,47.8c-0.2,0.2-0.4,0.3-0.6,0.4 c-1.4,0.6-2.8,1.1-4.2,1.6c-0.1,0-0.2,0.1-0.3,0.1c0.1-0.1,0.2-0.2,0.3-0.3C72.5,33.7,88,17.8,103.5,2c0.1-0.1,0.2-0.2,0.3-0.2 C105.3,1.2,106.8,0.6,108.4,0C108.3,0,108.4,0,108.4,0z" />
    </svg>
  )
}
