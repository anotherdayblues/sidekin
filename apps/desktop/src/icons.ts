import { t } from "./i18n.ts";
export const companionIcons = {
  glasses: "👓",
  pin: t("bubble.pin"),
  expand: t("bubble.expand"),
  close: t("bubble.close"),
  send: t("chat.send"),
  stop: t("chat.stop"),
  copy: t("common.copy"),
};
/** Line icons for the bubble's header keys; skins recolor them via currentColor. */
export const glyphs = {
  pin: '<svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true"><path d="M9.5 1.5l5 5-2 .5-2.5 2.5.5 3-1 1-3-3-3.5 3.5-.5-.5L6 9 3 6l1-1 3 .5L9.5 3z" fill="currentColor"/></svg>',
  expand:
    '<svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true"><path d="M9 2.5h4.5V7M7 13.5H2.5V9M13.5 2.5 9 7M2.5 13.5 7 9" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></svg>',
  topics:
    '<svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true"><path d="M5.5 4h8M5.5 8h8M5.5 12h8M2.5 4h.01M2.5 8h.01M2.5 12h.01" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></svg>',
  compose:
    '<svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true"><path d="M13 8.5V13a.5.5 0 0 1-.5.5h-9A.5.5 0 0 1 3 13V3.5a.5.5 0 0 1 .5-.5H8M11.5 2.5l2 2L8 10H6V8z" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></svg>',
  collapse:
    '<svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true"><path d="M3.5 8.5h9" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></svg>',
  image:
    '<svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true"><path d="M2.5 3.5h11v9h-11zM2.5 10.5l3-3 3 3 2-2 3 3M10.5 6.5h.01" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></svg>',
  snip: '<svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true"><path d="M2.5 5.5V3.5a1 1 0 0 1 1-1h2M10.5 2.5h2a1 1 0 0 1 1 1v2M13.5 10.5v2a1 1 0 0 1-1 1h-2M5.5 13.5h-2a1 1 0 0 1-1-1v-2M8 6v4M6 8h4" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></svg>',
  clip: '<svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true"><path d="M10.5 4.5 5.8 9.2a1.4 1.4 0 0 0 2 2l5-5a2.8 2.8 0 0 0-4-4l-5 5a4.2 4.2 0 0 0 6 6l4.2-4.2" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></svg>',
  paste:
    '<svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true"><path d="M6 3.5H4.5A1.5 1.5 0 0 0 3 5v8a1.5 1.5 0 0 0 1.5 1.5h7A1.5 1.5 0 0 0 13 13V5a1.5 1.5 0 0 0-1.5-1.5H10" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"/><rect x="5.75" y="2" width="4.5" height="2.75" rx="1" fill="none" stroke="currentColor" stroke-width="1.4"/></svg>',
  arrow:
    '<svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true"><path d="M8 13V3.5M4 7.5l4-4 4 4" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>',
  square:
    '<svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true"><rect x="4" y="4" width="8" height="8" rx="1.5" fill="currentColor"/></svg>',
  globe:
    '<svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true"><circle cx="8" cy="8" r="5.75" fill="none" stroke="currentColor" stroke-width="1.5"/><path d="M2.5 8h11M8 2.25c1.6 1.6 2.4 3.5 2.4 5.75S9.6 12.15 8 13.75M8 2.25C6.4 3.85 5.6 5.75 5.6 8s.8 4.15 2.4 5.75" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/></svg>',
  tune: '<svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true"><path d="M2.5 4.5h4M9.5 4.5h4M2.5 11.5h7M12.5 11.5h1M8 3v3M11 10v3" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/></svg>',
  close:
    '<svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true"><path d="M4 4l8 8M12 4l-8 8" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/></svg>',
  search:
    '<svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true"><circle cx="7" cy="7" r="4.5" fill="none" stroke="currentColor" stroke-width="1.5"/><path d="M10.5 10.5 13.5 13.5" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/></svg>',
  text: '<svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true"><path d="M3 4.5h10M3 8h10M3 11.5h6.5" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/></svg>',
  link: '<svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true"><path d="M6.5 9.5 9.5 6.5M5.2 7.8l-1.4 1.4a2.4 2.4 0 1 0 3.4 3.4l1.4-1.4M10.8 8.2l1.4-1.4a2.4 2.4 0 1 0-3.4-3.4L7.4 4.8" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"/></svg>',
  more: '<svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true"><circle cx="3.5" cy="8" r="1.15" fill="currentColor"/><circle cx="8" cy="8" r="1.15" fill="currentColor"/><circle cx="12.5" cy="8" r="1.15" fill="currentColor"/></svg>',
  trash:
    '<svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true"><path d="M3 4.5h10M6 4.5V3a.5.5 0 0 1 .5-.5h3a.5.5 0 0 1 .5.5v1.5M4.5 4.5l.6 8.2a1 1 0 0 0 1 .8h3.8a1 1 0 0 0 1-.8l.6-8.2M6.8 7v4M9.2 7v4" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"/></svg>',
  history:
    '<svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true"><circle cx="8" cy="8" r="5.5" fill="none" stroke="currentColor" stroke-width="1.4"/><path d="M8 5v3.2l2.1 1.3" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"/></svg>',
  copy: '<svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true"><rect x="5.5" y="5.5" width="7.5" height="8" rx="1.5" fill="none" stroke="currentColor" stroke-width="1.4"/><path d="M10.5 5.5V4A1.5 1.5 0 0 0 9 2.5H4A1.5 1.5 0 0 0 2.5 4v6A1.5 1.5 0 0 0 4 11.5h1.5" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"/></svg>',
};
