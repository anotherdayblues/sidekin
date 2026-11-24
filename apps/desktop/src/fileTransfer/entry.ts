import "./lab.css";
import { mountPiles } from "./piles.ts";
import { mountPhoneArrivals } from "./phoneArrivals.ts";
export async function mountFiles(root: HTMLElement) {
  document.documentElement.classList.add("file-transfer-window");
  const piles = await mountPiles(root);
  // Files from the phone fly in here too, for checking the flight.
  await mountPhoneArrivals(root, root, piles.receive);
}
