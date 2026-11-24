export function companionMotion() {
  const css = getComputedStyle(document.documentElement),
    n = (key: string) => Number(css.getPropertyValue("--brain-" + key));
  return {
    reminderJumpMs: n("reminder-jump-ms"), // Allow one reminder jump before returning to idle.
    curiousMs: n("curious-ms"), // How long the pet tilts its head when there is no selection.
    stiffness: n("stiffness"), // Spring response when the bubble opens or closes.
    damping: n("damping"), // Controls spring overshoot.
    fadeMs: n("fade-ms"), // Wait for the closing animation before hiding the native window.
    readMs: n("read-ms"), // Reading time after the final visible character.
    cps: n("cps"), // Normal characters per second.
    maxCps: n("cps-max"), // Upper limit while catching up.
    backlog: n("backlog"), // Queued characters needed to switch to the faster speed.
  };
}
