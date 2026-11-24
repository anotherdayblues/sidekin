// A field you can type in or pick from. The browser's own datalist hides
// every option that does not match what is already typed, so a filled field
// showed almost nothing; here opening the field lists everything, and only
// typing filters. Options still come from the field's <datalist>, so code
// that refills the datalist keeps working.
import "./styles/combo.css";

export function comboBox(input: HTMLInputElement) {
  const source = input.list;
  if (!source || input.dataset.combo !== undefined) return;
  input.removeAttribute("list");
  input.dataset.combo = "";
  input.setAttribute("role", "combobox");
  input.setAttribute("aria-autocomplete", "list");
  input.setAttribute("aria-expanded", "false");
  const wrap = document.createElement("span");
  wrap.className = "combo";
  input.replaceWith(wrap);
  wrap.append(input);
  const list = document.createElement("ul");
  list.className = "combo-list";
  list.setAttribute("role", "listbox");
  list.hidden = true;
  wrap.append(list);
  let active = -1;
  let typed = false;

  const options = () =>
    [...source.options].map((o) => o.value).filter((v) => v.trim());
  function draw() {
    const q = typed ? input.value.trim().toLowerCase() : "";
    const shown = options().filter((v) => !q || v.toLowerCase().includes(q));
    list.replaceChildren(
      ...shown.map((v, i) => {
        const li = document.createElement("li");
        li.setAttribute("role", "option");
        li.textContent = v;
        li.setAttribute("aria-selected", String(i === active));
        if (v === input.value) li.dataset.current = "";
        li.onmousedown = (e) => {
          e.preventDefault();
          choose(v);
        };
        return li;
      }),
    );
    list.hidden = !shown.length;
    input.setAttribute("aria-expanded", String(!list.hidden));
    list
      .querySelector('[aria-selected="true"]')
      ?.scrollIntoView({ block: "nearest" });
  }
  function open() {
    const r = input.getBoundingClientRect();
    if (innerHeight - r.bottom < 240 && r.top > 240) list.dataset.up = "";
    else delete list.dataset.up;
    typed = false;
    active = options().indexOf(input.value);
    draw();
  }
  function close() {
    list.hidden = true;
    input.setAttribute("aria-expanded", "false");
  }
  function choose(value: string) {
    input.value = value;
    close();
    input.dispatchEvent(new Event("input", { bubbles: true }));
    input.dispatchEvent(new Event("change", { bubbles: true }));
  }
  input.addEventListener("focus", open);
  input.addEventListener("click", () => (list.hidden ? open() : undefined));
  input.addEventListener("input", (e) => {
    if (!e.isTrusted) return;
    typed = true;
    active = -1;
    draw();
  });
  input.addEventListener("blur", close);
  input.addEventListener("keydown", (e) => {
    const items = [...list.querySelectorAll("li")];
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      if (list.hidden) return open();
      active =
        (active + (e.key === "ArrowDown" ? 1 : -1) + items.length) %
        items.length;
      draw();
    } else if (e.key === "Enter" && !list.hidden && items[active]) {
      e.preventDefault();
      choose(items[active].textContent ?? "");
    } else if (e.key === "Escape" && !list.hidden) {
      e.preventDefault();
      e.stopPropagation();
      close();
    }
  });
}
