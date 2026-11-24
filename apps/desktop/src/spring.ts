/**
 * Damped springs for every moving part of the studio (Hooke's law plus
 * damping). Targets can change mid-flight; velocity carries over, so a
 * thrown control keeps its momentum and any motion can be interrupted.
 */
export interface SpringOptions {
  stiffness?: number;
  damping?: number;
  mass?: number;
}
export class Spring {
  velocity = 0;
  target: number;
  stiffness: number;
  damping: number;
  mass: number;
  constructor(
    public value: number,
    { stiffness = 260, damping = 24, mass = 1 }: SpringOptions = {},
  ) {
    this.target = value;
    this.stiffness = stiffness;
    this.damping = damping;
    this.mass = mass;
  }
  /** Advances by `dt` seconds with small fixed substeps for stability. */
  step(dt: number) {
    let left = Math.min(dt, 0.064);
    while (left > 0) {
      const h = Math.min(left, 1 / 240);
      const force =
        -this.stiffness * (this.value - this.target) -
        this.damping * this.velocity;
      this.velocity += (force / this.mass) * h;
      this.value += this.velocity * h;
      left -= h;
    }
    if (this.settled) {
      this.value = this.target;
      this.velocity = 0;
    }
  }
  get settled() {
    return (
      Math.abs(this.value - this.target) < 0.001 &&
      Math.abs(this.velocity) < 0.01
    );
  }
}

const reduced = () =>
  typeof matchMedia === "function" &&
  matchMedia("(prefers-reduced-motion: reduce)").matches;

/**
 * A spring wired to a render callback. `to()` retargets; the frame loop runs
 * only while something is moving. With reduced motion it jumps to the target.
 */
export class Motion {
  readonly spring: Spring;
  private frame = 0;
  private last = 0;
  constructor(
    value: number,
    private render: (value: number, velocity: number) => void,
    options?: SpringOptions,
  ) {
    this.spring = new Spring(value, options);
    render(value, 0);
  }
  get value() {
    return this.spring.value;
  }
  to(target: number, velocity?: number) {
    this.spring.target = target;
    if (velocity !== undefined) this.spring.velocity = velocity;
    if (reduced()) return this.set(target);
    if (!this.frame) {
      this.last = performance.now();
      this.frame = requestAnimationFrame(this.tick);
    }
  }
  /** Moves immediately, e.g. while a finger drags the control 1:1. */
  set(value: number, velocity = 0) {
    cancelAnimationFrame(this.frame);
    this.frame = 0;
    this.spring.value = this.spring.target = value;
    this.spring.velocity = velocity;
    this.render(value, velocity);
  }
  private tick = (now: number) => {
    this.spring.step((now - this.last) / 1000);
    this.last = now;
    this.render(this.spring.value, this.spring.velocity);
    this.frame = this.spring.settled ? 0 : requestAnimationFrame(this.tick);
  };
}

/** Exponential decay toward a target, like a lamp's brightness fading. */
export function decay(
  from: number,
  to: number,
  tau: number,
  render: (value: number) => void,
): Promise<void> {
  return new Promise((resolve) => {
    if (reduced()) {
      render(to);
      return resolve();
    }
    const start = performance.now();
    const tick = (now: number) => {
      const k = Math.exp(-(now - start) / 1000 / tau);
      const value = to + (from - to) * k;
      render(value);
      if (k < 0.01) {
        render(to);
        resolve();
      } else requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  });
}

/** Soft-plastic squash on press: wider and flatter, then a spring back. */
export function squish(el: HTMLElement, amount = 0.06) {
  const m = new Motion(
    0,
    (v) => {
      el.style.transform = v
        ? `scale(${1 + v * amount}, ${1 - v * amount})`
        : "";
    },
    { stiffness: 520, damping: 18 },
  );
  el.addEventListener("pointerdown", () => m.to(1));
  const release = () => m.to(0, -6);
  el.addEventListener("pointerup", release);
  el.addEventListener("pointerleave", () => {
    if (m.spring.target) release();
  });
}
