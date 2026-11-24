import { t, tn } from "./i18n.ts";
import type { Rule } from "./teaching.ts";
import type * as api from "./bridge.ts";
import type { mountDraftReader } from "./studioDrafts.ts";
import type { StudioContext } from "./studioContext.ts";

export function mountStudioDial(
  c: StudioContext,
  draftReader: ReturnType<typeof mountDraftReader>,
) {
  const { $, state, custom } = c;
  function renderDial(p: api.Pet | undefined) {
    const svg = $("#dial") as unknown as SVGSVGElement | null;
    // 待办 (plan/27) put today's note where the dial was.
    if (!svg) return;
    const NS = "http://www.w3.org/2000/svg";
    const c = 120,
      r = 92;
    const node = (
      tag: string,
      attrs: Record<string, string | number>,
      text = "",
    ) => {
      const n = document.createElementNS(NS, tag);
      for (const [k, v] of Object.entries(attrs)) n.setAttribute(k, String(v));
      if (text) n.textContent = text;
      return n;
    };
    const at = (hour: number, radius: number) => {
      const a = (hour / 24) * Math.PI * 2 - Math.PI / 2;
      return [c + Math.cos(a) * radius, c + Math.sin(a) * radius];
    };
    const arc = (h0: number, h1: number, radius: number) => {
      const [x0, y0] = at(h0, radius),
        [x1, y1] = at(h1, radius);
      const span = (h1 - h0 + 24) % 24;
      return `M ${x0} ${y0} A ${radius} ${radius} 0 ${span > 12 ? 1 : 0} 1 ${x1} ${y1}`;
    };
    svg.replaceChildren();
    svg.append(
      node("circle", { cx: c, cy: c, r: r + 14, class: "dial-face" }),
      node("path", { d: arc(19, 7, r), class: "dial-night" }),
    );
    for (let h = 0; h < 24; h++) {
      const major = h % 6 === 0;
      const [x0, y0] = at(h, r + (major ? 8 : 5)),
        [x1, y1] = at(h, r - (major ? 8 : 5));
      svg.append(
        node("line", {
          x1: x0,
          y1: y0,
          x2: x1,
          y2: y1,
          class: major ? "tick major" : "tick",
        }),
      );
      if (major) {
        const [tx, ty] = at(h, r - 22);
        svg.append(
          node(
            "text",
            { x: tx, y: ty + 3.5, class: "dial-num" },
            String(h).padStart(2, "0"),
          ),
        );
      }
    }
    const layer = custom(p).layer;
    // The dial previews the draft currently shown on the reader.
    const draft = p
      ? (state.snapshot.drafts.find(
          (d) => d.id === draftReader.shownId && d.petId === p.id,
        ) ?? state.snapshot.drafts.find((d) => d.petId === p.id))
      : undefined;
    const marks: { rule: Rule; pending: boolean }[] = [
      ...layer.rules.map((rule) => ({ rule, pending: false })),
      ...(draft?.addedRules ?? []).map((id) => ({
        rule: draft!.preview.rules.find((x) => x.id === id)!,
        pending: true,
      })),
    ];
    let hourly = 0;
    for (const { rule, pending } of marks) {
      if (rule.when.type !== "clock") continue;
      const [hh, mm] = rule.when.at.split(":");
      if (hh === "*") {
        // Every hour: one dashed inner ring instead of 24 dots.
        hourly++;
        const ring = node("circle", {
          cx: c,
          cy: c,
          r: r - 34 - hourly * 6,
          class: "hourly" + (pending ? " pending" : ""),
        });
        ring.append(node("title", {}, `${rule.when.at} · ${rule.label}`));
        svg.append(ring);
        continue;
      }
      const hour = Number(hh) + Number(mm) / 60;
      const [x, y] = at(hour, r);
      const g = node("g", { class: "mark" + (pending ? " pending" : "") });
      g.append(
        node("circle", { cx: x, cy: y, r: 6 }),
        node("title", {}, `${rule.when.at} · ${rule.label}`),
      );
      svg.append(g);
    }
    const now = new Date();
    const hour = now.getHours() + now.getMinutes() / 60;
    const [hx0, hy0] = at(hour, r - 22),
      [hx, hy] = at(hour, r + 9);
    svg.append(
      node("line", { x1: hx0, y1: hy0, x2: hx, y2: hy, class: "hand" }),
      node(
        "text",
        { x: c, y: c + 6, class: "dial-time" },
        `${String(now.getHours()).padStart(2, "0")}:${String(now.getMinutes()).padStart(2, "0")}`,
      ),
    );
    // Every accepted clock rule once; hourly ones are already among them.
    const count = layer.rules.filter((x) => x.when.type === "clock").length;
    svg.append(
      node(
        "text",
        { x: c, y: c + 22, class: "dial-caption" },
        count ? tn("studio.timedCount", count) : t("studio.noTimers"),
      ),
    );
  }

  return { renderDial };
}
