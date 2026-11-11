/**
 * Plays a demo script on the real screens: a cursor glides to each control and clicks, types or attaches through the
 * control itself, so every screen reacts exactly as it does for a person. Ported from Artist Atlas's replay cursor.
 */
export type Target = { text: string | RegExp; tag?: string };
export type DemoStep =
  | { do: "say"; caption: string; ms?: number }
  | { do: "stage"; stage: string }
  | { do: "click"; target: Target; caption?: string }
  | { do: "type"; target: Target; text: string; caption?: string }
  | { do: "select"; target: Target; option: string; caption?: string }
  | { do: "upload"; target: Target; file: string; name: string; caption?: string }
  | { do: "waitFor"; target: Target; caption?: string; timeoutMs?: number }
  | { do: "point"; target: Target; caption?: string }
  | { do: "repeat"; while: Target; steps: DemoStep[]; max: number };

export type RunContext = { cursor: Cursor; caption: (text: string) => void; stage?: (id: string) => void; action?: (label: string) => void; hold?: () => Promise<void>; signal: AbortSignal; files: Record<string, string>; reducedMotion: boolean };
export type Cursor = { move: (x: number, y: number) => Promise<void>; pulse: () => void; remove: () => void };

const CANDIDATES = "a,button,summary,input,select,textarea";
const ARROW = '<svg width="30" height="30" viewBox="0 0 24 24" aria-hidden="true"><path d="M4 2l15 9-6.5 1.6L9.6 19z" fill="#d9ff3f" stroke="#000" stroke-width="1.6" stroke-linejoin="round"/></svg>';

export function makeCursor(reducedMotion: boolean): Cursor {
  const el = document.createElement("div");
  el.setAttribute("aria-hidden", "true");
  el.dataset.demoCursor = "";
  el.innerHTML = ARROW;
  const glide = reducedMotion ? 0 : 700 * DEMO_PACE;
  Object.assign(el.style, { position: "fixed", left: "0", top: "0", zIndex: "9999", pointerEvents: "none", transition: `transform ${glide}ms cubic-bezier(.4,0,.2,1)`, filter: "drop-shadow(0 3px 4px rgba(0,0,0,.45))" });
  let at = { x: window.innerWidth * 0.8, y: window.innerHeight * 0.85 };
  const place = () => { el.style.transform = `translate(${at.x - 6}px, ${at.y - 3}px)`; };
  place();
  document.body.append(el);
  return {
    async move(x, y) { at = { x, y }; place(); await sleep(glide + 80); },
    pulse() {
      if (reducedMotion) return;
      const ring = document.createElement("div");
      Object.assign(ring.style, { position: "fixed", left: `${at.x - 18}px`, top: `${at.y - 18}px`, width: "36px", height: "36px", borderRadius: "50%", border: "3px solid #d9ff3f", zIndex: "9998", pointerEvents: "none", opacity: "0.9", transition: "transform 450ms ease-out, opacity 450ms ease-out" });
      document.body.append(ring);
      requestAnimationFrame(() => Object.assign(ring.style, { transform: "scale(2.2)", opacity: "0" }));
      window.setTimeout(() => ring.remove(), 500);
    },
    remove() { el.remove(); },
  };
}

const sleep = (ms: number) => new Promise<void>(done => window.setTimeout(done, ms));
/** Slows every on-screen beat (glides, holds, typing) so viewers can follow; polling is not paced. */
export const DEMO_PACE = 2.25;
const pause = (ms: number) => sleep(ms * DEMO_PACE);
const normalized = (value: string) => value.replace(/\s+/g, " ").trim();
const matches = (value: string, text: Target["text"]) => typeof text === "string" ? normalized(value).includes(text) : text.test(normalized(value));
function visible(el: Element) { return el.getClientRects().length > 0 && !el.closest("[data-demo-chrome]"); }

/** First visible match in page order, skipping one that wraps a closer match. A label resolves to its control. */
export function find(target: Target): HTMLElement | null {
  const found = Array.from(document.querySelectorAll<HTMLElement>(target.tag ?? CANDIDATES)).filter(el =>
    visible(el) && (matches(el.getAttribute("aria-label") ?? "", target.text) || matches(el.textContent ?? "", target.text)));
  const el = found.find(candidate => !found.some(other => other !== candidate && candidate.contains(other)));
  if (el instanceof HTMLLabelElement) return el.control ?? el.querySelector<HTMLElement>("input,textarea,select") ?? el;
  return el ?? null;
}

async function waitFor(target: Target, ctx: RunContext, timeoutMs = 30000, enabled = false): Promise<HTMLElement> {
  const until = Date.now() + timeoutMs;
  for (;;) {
    if (ctx.signal.aborted) throw new DOMException("Demo stopped", "AbortError");
    const el = find(target);
    if (el && !(enabled && (el as HTMLButtonElement).disabled)) return el;
    if (Date.now() > until) throw new Error(`demo_step_timeout: ${String(target.text)}`);
    await sleep(150);
  }
}

async function pointAt(el: HTMLElement, ctx: RunContext) {
  el.scrollIntoView({ block: "center", behavior: ctx.reducedMotion ? "auto" : "smooth" });
  await (ctx.reducedMotion ? sleep(50) : pause(450));
  const box = el.getBoundingClientRect();
  await ctx.cursor.move(box.left + Math.min(box.width / 2, 120), box.top + box.height / 2);
}

/** The name a viewer sees on a control: its own text, else its aria-label, else its label. */
function controlName(el: HTMLElement): string {
  const own = el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement || el instanceof HTMLSelectElement
    ? el.labels?.[0]?.textContent ?? "" : el.textContent ?? "";
  const name = normalized(own || el.getAttribute("aria-label") || "").replace(/\s*[→▶]\s*$/, "");
  return name.length > 60 ? `${name.slice(0, 57)}…` : name;
}

/** React tracks input values itself, so set through the native setter and announce the change. */
function setValue(el: HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement, value: string, event: "input" | "change") {
  const setter = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(el), "value")?.set;
  setter?.call(el, value);
  el.dispatchEvent(new Event(event, { bubbles: true }));
}

export async function runSteps(steps: DemoStep[], ctx: RunContext): Promise<void> {
  for (const step of steps) {
    if (ctx.signal.aborted) throw new DOMException("Demo stopped", "AbortError");
    // A paused presenter holds the replay between steps, never mid-click.
    await ctx.hold?.();
    if (ctx.signal.aborted) throw new DOMException("Demo stopped", "AbortError");
    if (step.do !== "repeat" && step.do !== "stage" && step.caption) ctx.caption(step.caption);
    if (step.do === "say") ctx.action?.("");
    switch (step.do) {
      case "stage": ctx.stage?.(step.stage); break;
      case "say": await pause(step.ms ?? 2200); break;
      case "point": await pointAt(await waitFor(step.target, ctx), ctx); await pause(1200); break;
      case "waitFor": await waitFor(step.target, ctx, step.timeoutMs); break;
      case "click": {
        const el = await waitFor(step.target, ctx, 30000, true);
        ctx.action?.(`Clicked: ${controlName(el)}`);
        await pointAt(el, ctx); ctx.cursor.pulse(); el.click(); await pause(700);
        break;
      }
      case "type": {
        const el = await waitFor(step.target, ctx, 30000, true) as HTMLInputElement | HTMLTextAreaElement;
        ctx.action?.(`Typed in: ${controlName(el)}`);
        await pointAt(el, ctx); ctx.cursor.pulse(); el.focus();
        if (ctx.reducedMotion) setValue(el, step.text, "input");
        else for (let index = 1; index <= step.text.length; index++) { setValue(el, step.text.slice(0, index), "input"); await pause(18); }
        await pause(400);
        break;
      }
      case "select": {
        const el = await waitFor(step.target, ctx, 30000, true) as HTMLSelectElement;
        await pointAt(el, ctx); ctx.cursor.pulse();
        const option = Array.from(el.options).find(item => normalized(item.text).includes(step.option));
        if (!option) throw new Error(`demo_option_missing: ${step.option}`);
        ctx.action?.(`Chose: ${normalized(option.text)}`);
        setValue(el, option.value, "change"); await pause(900);
        break;
      }
      case "upload": {
        const el = await waitFor(step.target, ctx, 30000, true) as HTMLInputElement;
        const content = ctx.files[step.file];
        if (content === undefined) throw new Error(`demo_file_missing: ${step.file}`);
        ctx.action?.(`Attached: ${step.name}`);
        await pointAt(el, ctx); ctx.cursor.pulse();
        const transfer = new DataTransfer();
        transfer.items.add(new File([content], step.name, { type: "text/markdown" }));
        el.files = transfer.files;
        el.dispatchEvent(new Event("change", { bubbles: true }));
        await pause(1200);
        break;
      }
      case "repeat":
        for (let round = 0; round < step.max && find(step.while); round++) await runSteps(step.steps, ctx);
        break;
    }
  }
}
