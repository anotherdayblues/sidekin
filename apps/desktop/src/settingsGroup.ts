/**
 * One settings group, the single shape every group in 设置 uses: a small
 * title (and optional note) above one card that holds the rows. Callers put
 * rows into `card`; navigation and scrolling target `section` (#set-<id>).
 * A `bare` group holds one object that is its own surface (the usage
 * receipt): no card, so `card` is the section itself.
 */
export function settingsGroup(
  id: string,
  title: string,
  note = "",
  bare = false,
) {
  const section = document.createElement("section");
  section.className = "set-group";
  section.id = "set-" + id;
  section.innerHTML = `<h3 class="set-title">${title}</h3>${note ? `<p class="set-note">${note}</p>` : ""}${bare ? "" : `<div class="set-card"></div>`}`;
  return {
    section,
    card: section.querySelector<HTMLElement>(".set-card") ?? section,
    note: section.querySelector<HTMLElement>(".set-note"),
  };
}
