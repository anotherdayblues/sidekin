// The light each skin paints onto the pet on the stage: a rim on the edges
// facing the light, a wash from top to bottom, and how strongly the rim
// glows. Skins without an entry leave the pet unlit.
export interface PetLight {
  rim: string;
  top: string;
  mid: string;
  base: string;
  glow: number;
}

/** `low` is how low the sun stands: 0 at noon, 1 morning and evening. */
export function petLight(
  skin: string,
  theme: "day" | "night",
  low: number,
): PetLight | null {
  if (skin === "studio")
    // A warm desk lamp at night; the afternoon sun by day.
    return theme === "night"
      ? {
          rim: "rgb(255, 205, 140)",
          top: "rgba(255, 186, 104, 0.26)",
          mid: "rgba(255, 170, 90, 0.06)",
          base: "rgba(18, 9, 3, 0.55)",
          glow: 0.5,
        }
      : {
          rim: "rgb(255, 226, 172)",
          top: `rgba(255, 226, 170, ${0.12 + 0.1 * low})`,
          mid: "rgba(255, 240, 220, 0)",
          base: "rgba(70, 60, 80, 0.16)",
          glow: 0.2,
        };
  if (skin === "native")
    // Matches the stage glow: white at noon, warmer as the sun sinks, and a
    // cool still light at night. Gentler than the toy's.
    return theme === "night"
      ? {
          rim: "rgb(185, 200, 255)",
          top: "rgba(150, 175, 255, 0.14)",
          mid: "rgba(150, 175, 255, 0.03)",
          base: "rgba(5, 8, 18, 0.4)",
          glow: 0.35,
        }
      : {
          rim: `rgb(255, ${Math.round(246 - 22 * low)}, ${Math.round(232 - 72 * low)})`,
          top: `rgba(255, 236, 205, ${0.05 + 0.12 * low})`,
          mid: "rgba(255, 250, 240, 0)",
          base: "rgba(60, 60, 80, 0.1)",
          glow: 0.16,
        };
  return null;
}
