// Inline SVG icon set — stroke-based, inherits currentColor.

const S = (size: number, inner: string, vb = 24) =>
  `<svg width="${size}" height="${size}" viewBox="0 0 ${vb} ${vb}" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="square" stroke-linejoin="miter" aria-hidden="true">${inner}</svg>`;

export const icons = {
  logo: (size = 22) =>
    `<svg width="${size}" height="${size}" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
      <path d="M12 1.2 14.6 8 12 10.4 9.4 8Z"/>
      <path d="M22.8 12 16 14.6 13.6 12 16 9.4Z"/>
      <path d="M12 22.8 9.4 16 12 13.6 14.6 16Z"/>
      <path d="M1.2 12 8 9.4 10.4 12 8 14.6Z"/>
    </svg>`,

  gridDots: (size = 18) =>
    `<svg width="${size}" height="${size}" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
      ${[5, 12, 19].map((y) => [5, 12, 19].map((x) => `<rect x="${x - 1.3}" y="${y - 1.3}" width="2.6" height="2.6"/>`).join("")).join("")}
    </svg>`,

  drone: (size = 20) =>
    S(
      size,
      `<rect x="9.2" y="9.2" width="5.6" height="5.6"/>
       <path d="M9.2 9.2 6.4 6.4M14.8 9.2l2.8-2.8M9.2 14.8l-2.8 2.8M14.8 14.8l2.8 2.8"/>
       <circle cx="5" cy="5" r="2.6"/><circle cx="19" cy="5" r="2.6"/>
       <circle cx="5" cy="19" r="2.6"/><circle cx="19" cy="19" r="2.6"/>`
    ),

  shield: (size = 18) =>
    S(size, `<path d="M12 3 19 5.6V11c0 4.6-2.9 7.7-7 9.4-4.1-1.7-7-4.8-7-9.4V5.6Z"/><path d="M9 11.4l2.1 2.1L15.4 9"/>`),

  xCircle: (size = 18) => S(size, `<circle cx="12" cy="12" r="8.6"/><path d="M8.9 8.9l6.2 6.2M15.1 8.9l-6.2 6.2"/>`),

  lock: (size = 18) =>
    S(size, `<rect x="5.5" y="10.5" width="13" height="9"/><path d="M8.5 10.5V8a3.5 3.5 0 0 1 7 0v2.5"/><path d="M12 14v2.5"/>`),

  people: (size = 18) =>
    S(
      size,
      `<circle cx="9" cy="8.4" r="3"/><path d="M3.5 19.5c0-3 2.5-5 5.5-5s5.5 2 5.5 5"/><circle cx="16.6" cy="9.4" r="2.4"/><path d="M16.2 14.6c2.6.2 4.4 2 4.4 4.4"/>`
    ),

  headset: (size = 18) =>
    S(
      size,
      `<path d="M4.5 13v-1.5a7.5 7.5 0 0 1 15 0V13"/><rect x="3.5" y="13" width="4" height="6"/><rect x="16.5" y="13" width="4" height="6"/><path d="M19 19v1.2c0 1-.8 1.8-1.8 1.8H13"/>`
    ),

  person: (size = 18) => S(size, `<circle cx="12" cy="8" r="3.4"/><path d="M4.8 20.5c0-4 3.2-6.4 7.2-6.4s7.2 2.4 7.2 6.4"/>`),

  sliders: (size = 18) =>
    S(
      size,
      `<path d="M4 7.5h16M4 12h16M4 16.5h16"/><rect x="7" y="5.6" width="3.4" height="3.8" fill="#0d0d0d"/><rect x="14" y="10.1" width="3.4" height="3.8" fill="#0d0d0d"/><rect x="9" y="14.6" width="3.4" height="3.8" fill="#0d0d0d"/>`
    ),

  pin: (size = 14) =>
    S(size, `<path d="M12 21s-6.6-5.4-6.6-10.4a6.6 6.6 0 0 1 13.2 0C18.6 15.6 12 21 12 21Z"/><circle cx="12" cy="10.4" r="2.3"/>`),

  clock: (size = 14) => S(size, `<circle cx="12" cy="12" r="8.6"/><path d="M12 6.8V12l3.4 2"/>`),

  layers: (size = 15) =>
    S(size, `<rect x="8.5" y="3.5" width="12" height="12"/><path d="M15.5 15.5v5h-12v-12h5"/>`),

  plus: (size = 14) => S(size, `<path d="M12 5v14M5 12h14"/>`),

  minus: (size = 14) => S(size, `<path d="M5 12h14"/>`),

  arrowUpRight: (size = 11) => S(size, `<path d="M7 17 17 7M9 7h8v8"/>`),

  chevronLeft: (size = 9) => S(size, `<path d="M14.5 4 7 12l7.5 8"/>`),

  chevronRight: (size = 9) => S(size, `<path d="M9.5 4 17 12l-7.5 8"/>`),

  target: (size = 15) =>
    S(size, `<circle cx="12" cy="12" r="7.5"/><path d="M12 2.5v4M12 17.5v4M2.5 12h4M17.5 12h4"/>`),
};
