import "./style.css";
import { syncDocumentLocale } from "./i18n.ts";

syncDocumentLocale();

const app = document.querySelector<HTMLDivElement>("#app")!;
// Skins and the desktop widgets follow the host system's conventions.
document.documentElement.dataset.platform = /Mac/.test(
  navigator.platform || navigator.userAgent,
)
  ? "mac"
  : "win";
const route = new URLSearchParams(location.search);
if (route.has("files")) {
  await (await import("./fileTransfer/entry.ts")).mountFiles(app);
} else if (route.has("snipcard")) {
  const { mountSnipCard } = await import("./snipCard.ts");
  await mountSnipCard(app);
} else if (route.has("snip")) {
  const { mountSnip } = await import("./snip.ts");
  mountSnip(
    app,
    Number(route.get("snip")),
    route.get("mode") === "chat" ? "chat" : "card",
  );
} else if (route.has("clock")) {
  // The 番茄钟 clock's own window beside the pet (plan/19 §9.3).
  await (await import("./clockWindow.ts")).mountClockWindow(app);
} else if (route.has("clock-preview")) {
  // The pet with its light and its clock, for checking the look in each skin.
  await (await import("./demos/clockPreview.ts")).mountClockPreview(app, route);
} else if (route.has("demo")) {
  // A demo alone, for checking its feel in each skin (plan/17).
  await (await import("./demos/demoPreview.ts")).mountDemoPreview(app, route);
} else if (route.has("fixture")) {
  app.replaceChildren();
} else if (route.has("chat")) {
  const { mountChatWindow } = await import("./chatWindow.ts");
  await mountChatWindow(app);
} else if (route.has("bubble")) {
  const { mountBubble } = await import("./bubble.ts");
  await mountBubble(app);
} else if (route.has("pet")) {
  document.body.classList.add("pet-window");
  document.documentElement.classList.add("pet-window");
  const [{ mountPet }, { mountPetScene }] = await Promise.all([
    import("./pet.ts"),
    import("./fileTransfer/petIntegration.ts"),
  ]);
  await mountPetScene(app, mountPet);
} else {
  const { mountStudio } = await import("./studio.ts");
  await mountStudio(app);
}
