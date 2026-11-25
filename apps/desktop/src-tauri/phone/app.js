// 手机传文件's phone page (plan/20): pick photos, files or a piece of text,
// send them to the pet, watch them go; below, what the computer sent with
// 发到手机, to download. Served by the app over the local network (src/phone/server.rs);
// plain HTTP, so no secure-context APIs (clipboard, share, randomUUID).
// Like the app's own pages, this only sets classes, data-* attributes and
// custom properties; app.css draws everything.
"use strict";
(() => {
  const config = JSON.parse(document.getElementById("config").textContent);
  const $ = (sel) => document.querySelector(sel);
  const part = (name) => $(`[data-part="${name}"]`);
  const t = (key, vars = {}) =>
    (config.t["phone.page." + key] ?? key).replace(/\{(\w+)\}/g, (_, k) => vars[k] ?? config[k] ?? "");
  for (const el of document.querySelectorAll("[data-t]")) el.textContent = t(el.dataset.t);
  document.title = t("title");
  part("title").textContent = config.pet;
  part("status").textContent = t("connected");
  part("desk-title").textContent = t("desk");
  part("desk-empty-text").textContent = t("deskEmpty");
  part("note").placeholder = t("textPlaceholder");

  // This phone, so the computer can trust it once and remember.
  const device = (() => {
    let id = "";
    try {
      id = localStorage.getItem("suiban-device") || "";
      if (!id) {
        id = Array.from({ length: 4 }, () => Math.random().toString(36).slice(2, 10)).join("");
        localStorage.setItem("suiban-device", id);
      }
    } catch {
      id = "anon-" + Math.random().toString(36).slice(2);
    }
    // What the computer calls this phone: iPhone, iPad, a HarmonyOS phone,
    // an Android phone by its model when the browser still tells it.
    const ua = navigator.userAgent;
    const model = (ua.match(/Android [\d.]+; ([^;)]+)/) || [])[1]?.replace(/ Build.*$/, "").trim();
    const name = /iPhone/.test(ua)
      ? "iPhone"
      : /iPad|Macintosh.*Mobile/.test(ua)
        ? "iPad"
        : /HarmonyOS|OpenHarmony/.test(ua)
          ? t("harmony")
          : /Android/.test(ua)
            ? model && model.length > 2 ? model : t("android")
            : t("aPhone");
    return { id, name };
  })();

  const size = (n) =>
    n < 1024 ? `${n} B` : n < 1048576 ? `${(n / 1024).toFixed(0)} KB` : n < 1073741824 ? `${(n / 1048576).toFixed(1)} MB` : `${(n / 1073741824).toFixed(2)} GB`;
  const esc = (s) => String(s).replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
  const buzz = () => navigator.vibrate?.(8);
  let toastTimer = 0;
  const toast = (text) => {
    const el = part("toast");
    el.textContent = text;
    el.dataset.show = "";
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => delete el.dataset.show, 2600);
  };
  // Changes of the sheet glide where the browser can (View Transitions).
  const glide = (change) => (document.startViewTransition ? document.startViewTransition(change) : change());

  // The pet's own color for the page: the average of its most colorful
  // pixels (fur, not white belly or dark outline), then made clear enough
  // to carry the page, so a pale or brown pet still gets a lively tint.
  const avatar = part("avatar");
  avatar.addEventListener("load", () => {
    try {
      const c = document.createElement("canvas");
      c.width = c.height = 32;
      const g = c.getContext("2d");
      g.drawImage(avatar, 0, 0, 32, 32);
      const d = g.getImageData(0, 0, 32, 32).data;
      const px = [];
      for (let i = 0; i < d.length; i += 4) {
        if (d[i + 3] < 200) continue;
        const [r, gr, b] = [d[i], d[i + 1], d[i + 2]];
        const max = Math.max(r, gr, b), min = Math.min(r, gr, b);
        px.push({ r, gr, b, sat: max ? (max - min) / max : 0 });
      }
      px.sort((a, b) => b.sat - a.sat);
      const top = px.slice(0, Math.max(8, Math.round(px.length / 3)));
      if (top.length) {
        const avg = (k) => top.reduce((s, p) => s + p[k], 0) / top.length;
        const [h, sl, l] = hsl(avg("r"), avg("gr"), avg("b"));
        const rgb = fromHsl(h, Math.max(sl, 0.5), Math.min(Math.max(l, 0.5), 0.62));
        document.documentElement.style.setProperty("--pet", rgb.join(" "));
      }
    } catch {}
    document.documentElement.dataset.avatar = "";
  });
  function hsl(r, g, b) {
    (r /= 255), (g /= 255), (b /= 255);
    const max = Math.max(r, g, b), min = Math.min(r, g, b), l = (max + min) / 2;
    if (max === min) return [0, 0, l];
    const d = max - min;
    const s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
    const h = max === r ? (g - b) / d + (g < b ? 6 : 0) : max === g ? (b - r) / d + 2 : (r - g) / d + 4;
    return [h / 6, s, l];
  }
  function fromHsl(h, s, l) {
    const q = l < 0.5 ? l * (1 + s) : l + s - l * s, p = 2 * l - q;
    const f = (t) => {
      t = (t + 1) % 1;
      return t < 1 / 6 ? p + (q - p) * 6 * t : t < 1 / 2 ? q : t < 2 / 3 ? p + (q - p) * (2 / 3 - t) * 6 : p;
    };
    return [f(h + 1 / 3), f(h), f(h - 1 / 3)].map((v) => Math.round(v * 255));
  }
  avatar.addEventListener("error", () => (avatar.closest(".avatar").dataset.missing = ""));

  // ---- picking ----
  const sheet = part("sheet");
  let picked = [];
  let mode = "files";
  const open = (step) => {
    glide(() => {
      sheet.dataset.step = step;
      document.body.dataset.sheet = "";
    });
  };
  const close = () => {
    // Closing what the computer sent leaves it in the list: show it there.
    const got = sheet.dataset.step === "got";
    glide(() => delete document.body.dataset.sheet);
    if (got) setTimeout(() => part("desk").scrollIntoView({ behavior: "smooth", block: "center" }), 380);
    for (const p of picked) if (p.url) URL.revokeObjectURL(p.url);
    picked = [];
  };
  const drawPicked = () => {
    const list = part("picked");
    list.innerHTML = picked
      .map(
        (p, i) => `<li data-kind="${p.kind}">
          ${p.url ? (p.kind === "video" ? `<video src="${p.url}" muted playsinline></video>` : `<img src="${p.url}" alt="">`) : `<i class="glyph" data-ext="${esc(ext(p.file.name))}"></i>`}
          <div class="what"><span class="name">${esc(p.file.name)}</span><span class="size">${size(p.file.size)}</span></div>
          <button type="button" class="remove" data-remove="${i}" aria-label="${esc(t("remove"))}"></button>
        </li>`,
      )
      .join("");
    const total = picked.reduce((s, p) => s + p.file.size, 0);
    $('[data-act="send"]').textContent = mode === "text" ? t("send") : t("sendN", { n: picked.length, size: size(total) });
    sheet.dataset.mode = mode;
    if (mode !== "text" && !picked.length) close();
  };
  const ext = (name) => (name.includes(".") ? name.split(".").pop().slice(0, 4).toUpperCase() : "");
  for (const input of document.querySelectorAll("[data-input]"))
    input.addEventListener("change", () => {
      mode = "files";
      picked = Array.from(input.files).map((file) => {
        const kind = file.type.startsWith("image/") ? "image" : file.type.startsWith("video/") ? "video" : "file";
        return { file, kind, url: kind === "file" ? "" : URL.createObjectURL(file) };
      });
      input.value = "";
      if (!picked.length) return;
      drawPicked();
      open("pick");
    });
  for (const tile of document.querySelectorAll("[data-pick]"))
    tile.addEventListener("click", () => {
      buzz();
      const what = tile.dataset.pick;
      if (what === "text") {
        mode = "text";
        picked = [];
        part("note").value = "";
        drawPicked();
        open("pick");
        setTimeout(() => part("note").focus(), 350);
      } else $(`[data-input="${what}"]`).click();
    });
  part("picked").addEventListener("click", (e) => {
    const i = e.target.closest("[data-remove]")?.dataset.remove;
    if (i === undefined) return;
    const [gone] = picked.splice(Number(i), 1);
    if (gone?.url) URL.revokeObjectURL(gone.url);
    drawPicked();
  });
  part("scrim").addEventListener("click", () => {
    if (["pick", "done", "no", "got"].includes(sheet.dataset.step)) close();
  });

  // ---- sending ----
  const api = async (path, init) => {
    const res = await fetch(path, init);
    const body = await res.json().catch(() => ({}));
    if (!res.ok) throw Object.assign(new Error(body.error || ""), { status: res.status });
    return body;
  };
  const fail = (title) => {
    part("no-title").textContent = title;
    open("no");
  };
  const offline = () => {
    document.body.dataset.offline = "";
    part("status").textContent = t("offline");
  };
  async function send() {
    const text = mode === "text" ? part("note").value : "";
    if (mode === "text" && !text.trim()) return;
    buzz();
    let offer;
    try {
      offer = await api("offer", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ device, files: picked.map((p) => ({ name: p.file.name, size: p.file.size })), text }),
      });
    } catch (e) {
      if (!e.status) offline();
      return fail(e.message || t("offline"));
    }
    let status = offer.status;
    if (status === "pending") {
      part("wait-title").textContent = t("waiting");
      open("wait");
      while (status === "pending") {
        try {
          status = (await api(`offer/${offer.id}`)).status;
        } catch (e) {
          if (!e.status) offline();
          return fail(t("offline"));
        }
      }
    }
    if (status === "rejected") return fail(t("rejected"));
    if (picked.length) await upload(offer.id);
    else finish();
  }
  async function upload(id) {
    open("send");
    const list = part("sending");
    list.innerHTML = picked
      .map((p, i) => `<li data-i="${i}" data-state="wait"><span class="name">${esc(p.file.name)}</span><i class="bar"></i></li>`)
      .join("");
    const total = picked.reduce((s, p) => s + p.file.size, 0) || 1;
    const sent = picked.map(() => 0);
    let done = 0;
    const meter = () => {
      sheet.style.setProperty("--p", String(sent.reduce((a, b) => a + b, 0) / total));
      part("send-title").textContent = t("sending", { done, n: picked.length });
    };
    meter();
    const one = (i) =>
      new Promise((resolve) => {
        const row = list.querySelector(`[data-i="${i}"]`);
        const xhr = new XMLHttpRequest();
        xhr.open("PUT", `file/${id}/${i}`);
        row.dataset.state = "going";
        xhr.upload.onprogress = (e) => {
          sent[i] = e.loaded;
          row.style.setProperty("--p", String(e.loaded / (e.total || 1)));
          meter();
        };
        xhr.onload = () => {
          const ok = xhr.status === 200;
          row.dataset.state = ok ? "done" : "failed";
          sent[i] = picked[i].file.size;
          if (ok) done++;
          meter();
          resolve(ok);
        };
        xhr.onerror = () => {
          row.dataset.state = "failed";
          resolve(false);
        };
        xhr.send(picked[i].file);
      });
    // Two at a time: quick on a home network, gentle on the phone.
    const queue = picked.map((_, i) => i);
    const results = [];
    await Promise.all(
      [0, 1].map(async () => {
        while (queue.length) {
          const i = queue.shift();
          results[i] = await one(i);
        }
      }),
    );
    if (results.every(Boolean)) finish();
    else fail(t("failed"));
  }
  function finish() {
    buzz();
    part("done-title").textContent = t("done");
    open("done");
  }
  $('[data-act="send"]').addEventListener("click", () => void send());
  for (const b of document.querySelectorAll('[data-act="cancel"], [data-act="close"]')) b.addEventListener("click", close);
  $('[data-act="again"]').addEventListener("click", close);

  // ---- what the computer sent ----
  // Tell the computer this phone is here, so it can show it is connected.
  fetch("hello", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ device }) }).catch(() => {});
  // How to keep a file differs: iOS saves photos by a long press, files
  // through the Files app; elsewhere a download is enough.
  const ios = /iPhone|iPad|Macintosh.*Mobile/.test(navigator.userAgent);
  part("got-hint").textContent = t(ios ? "keepIos" : "keep");
  // Items not seen on this phone before carry a 新 mark; ones that come in
  // (or were waiting when the page opened) also open in the tray.
  const seenKey = "suiban-seen";
  let seen = new Set();
  try {
    seen = new Set(JSON.parse(localStorage.getItem(seenKey) || "[]"));
  } catch {}
  let deskKey = "";
  let deskTexts = new Map();
  const kindOf = (i) => (i.text != null ? "text" : i.type.startsWith("image/") ? "image" : i.type.startsWith("video/") ? "video" : "file");
  // The file's kind for its icon color: document, sheet, slides, archive,
  // audio, video or other.
  const family = (name) => {
    const e = ext(name).toLowerCase();
    if (/^(pdf|doc|docx|pages|txt|md|rtf)$/.test(e)) return "doc";
    if (/^(xls|xlsx|csv|numb)$/.test(e)) return "sheet";
    if (/^(ppt|pptx|key)$/.test(e)) return "slides";
    if (/^(zip|rar|7z|gz|tar)$/.test(e)) return "archive";
    if (/^(mp3|m4a|wav|aac|flac)$/.test(e)) return "audio";
    if (/^(mp4|mov|m4v|webm|avi|3gp)$/.test(e)) return "video";
    return "other";
  };
  const mark = (fresh) => (fresh ? ` data-new="${esc(t("new"))}"` : "");
  const shot = (i, fresh) =>
    `<li class="shot"${mark(fresh)}><img loading="lazy" src="desk/${i.id}?view=1" alt="${esc(i.name)}"></li>`;
  const row = (i, fresh) => {
    if (kindOf(i) === "text")
      return `<li class="note-card"${mark(fresh)}><p class="snippet">${esc(i.text)}</p><button type="button" class="pill" data-copy="${i.id}">${esc(t("copy"))}</button></li>`;
    return `<li class="file-row"${mark(fresh)}><i class="glyph" data-family="${family(i.name)}" data-ext="${esc(ext(i.name))}"></i><div class="what"><span class="name">${esc(i.name)}</span><span class="size">${size(i.size)}</span></div><a class="get" href="desk/${i.id}" download="${esc(i.name)}" aria-label="${esc(t("download"))} ${esc(i.name)}"></a></li>`;
  };
  // "刚刚", "今天 14:20", "昨天 09:05", "11月14日 09:05": when it was sent.
  const when = (at) => {
    if (!at) return "";
    const d = new Date(at), now = new Date();
    if (now - d < 120_000) return t("justNow");
    const dateLocale = config.dateLocale || (config.lang === "en" ? "en" : "zh-CN");
    const time = d.toLocaleTimeString(dateLocale, { hour: "2-digit", minute: "2-digit" });
    const day = (x) => new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime();
    const back = Math.round((day(now) - day(d)) / 86_400_000);
    if (back === 0) return t("today", { time });
    if (back === 1) return t("yesterday", { time });
    return `${d.toLocaleDateString(dateLocale, { month: "short", day: "numeric" })} ${time}`;
  };
  /** Files sent together, newest first: pictures as a grid, then files and
   *  texts as rows. */
  const groups = (items, freshOf) => {
    const sets = [];
    for (const i of items) {
      const last = sets.at(-1);
      if (last && last.at === i.at) last.items.push(i);
      else sets.push({ at: i.at, items: [i] });
    }
    return sets
      .map(({ at, items }) => {
        const shots = items.filter((i) => kindOf(i) === "image");
        const rows = items.filter((i) => kindOf(i) !== "image");
        return `<section class="group">${at ? `<h3 class="when">${esc(when(at))}</h3>` : ""}${
          shots.length ? `<ul class="shots">${shots.map((i) => shot(i, freshOf(i))).join("")}</ul>` : ""
        }${rows.length ? `<ul class="rows">${rows.map((i) => row(i, freshOf(i))).join("")}</ul>` : ""}</section>`;
      })
      .join("");
  };
  function showDesk(items) {
    const key = items.map((i) => i.id).join();
    if (key === deskKey) return;
    deskKey = key;
    part("desk-empty").hidden = items.length > 0;
    const fresh = items.filter((i) => !seen.has(i.id));
    const freshIds = new Set(fresh.map((i) => i.id));
    part("desk").innerHTML = groups(items, (i) => freshIds.has(i.id));
    deskTexts = new Map(items.filter((i) => i.text != null).map((i) => [i.id, i.text]));
    // 全部下载 when there are two or more files (texts are copied instead).
    allIds = files(items);
    $('.desk-head [data-act="all"]').hidden = allIds.length < 2;
    // Seen once shown; the mark stays until the next look.
    for (const i of items) seen.add(i.id);
    try {
      localStorage.setItem(seenKey, JSON.stringify([...seen].slice(-500)));
    } catch {}
    // New ones come up in the tray, unless the user is busy sending.
    if (fresh.length && !document.body.hasAttribute("data-sheet")) {
      buzz();
      part("got-title").textContent = t("arrived", { n: fresh.length });
      part("got").innerHTML = groups(fresh, () => false);
      gotIds = files(fresh);
      $('.sheet-got [data-act="all"]').hidden = gotIds.length < 2;
      open("got");
    } else if (fresh.length) toast(t("arrived", { n: fresh.length }));
  }
  const online = () => {
    delete document.body.dataset.offline;
    part("status").textContent = t("connected");
  };
  async function loadDesk() {
    try {
      showDesk((await api("desk")).items);
      online();
    } catch (e) {
      if (!e.status) offline();
    }
  }
  // The long poll: the computer answers as soon as it sends something, or
  // after 25 seconds with nothing new. Paused while the page is hidden.
  const pause = (ms) => new Promise((r) => setTimeout(r, ms));
  async function follow() {
    let version = -1;
    for (;;) {
      if (document.visibilityState !== "visible") {
        await new Promise((r) => document.addEventListener("visibilitychange", r, { once: true }));
        continue;
      }
      try {
        const body = await api(version < 0 ? "desk" : `desk?v=${version}`);
        version = body.version;
        online();
        showDesk(body.items);
      } catch (e) {
        if (!e.status) offline();
        await pause(5000);
      }
    }
  }
  // 全部下载: an iPhone takes one download at a time, so it gets one zip
  // (opened in the Files app); other phones get each file in turn.
  const files = (items) => items.filter((i) => i.text == null).map((i) => i.id);
  let allIds = [];
  let gotIds = [];
  const save = (href) => {
    const a = document.createElement("a");
    a.href = href;
    a.download = "";
    document.body.append(a);
    a.click();
    a.remove();
  };
  const downloadAll = async (ids) => {
    buzz();
    if (ios) return save(`desk/all.zip?ids=${ids.join(",")}`);
    for (const id of ids) {
      save(`desk/${id}`);
      await pause(600);
    }
  };
  $('.desk-head [data-act="all"]').addEventListener("click", () => void downloadAll(allIds));
  $('.sheet-got [data-act="all"]').addEventListener("click", () => void downloadAll(gotIds));
  const tapped = (e) => {
    const copy = e.target.closest("[data-copy]");
    if (copy) {
      // No clipboard API on plain HTTP: the old way still works.
      const area = document.createElement("textarea");
      area.value = deskTexts.get(copy.dataset.copy) ?? "";
      document.body.append(area);
      area.select();
      document.execCommand("copy");
      area.remove();
      buzz();
      return toast(t("copied"));
    }
    const img = e.target.closest(".shot img");
    if (img) {
      part("viewer-img").src = img.src;
      part("viewer-get").href = img.src.replace("?view=1", "");
      glide(() => (part("viewer").hidden = false));
    }
  };
  part("desk").addEventListener("click", tapped);
  part("got").addEventListener("click", tapped);
  part("viewer").addEventListener("click", () => glide(() => (part("viewer").hidden = true)));
  void follow();
  // Back on screen: look at once rather than wait for the poll.
  document.addEventListener("visibilitychange", () => document.visibilityState === "visible" && void loadDesk());
})();
