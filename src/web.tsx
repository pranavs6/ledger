// Shared request plumbing: the Hono env, page rendering, flash messages and
// form parsing.
import type { Context } from "hono";
import { deleteCookie, getCookie, setCookie } from "hono/cookie";
import { html } from "hono/html";
import type { Child } from "hono/jsx";
import type { User } from "./auth.ts";
import { Flash, Layout, type Nav } from "./views/layout.tsx";

export type Env = {
  Variables: {
    user: User & { tokenHash: string };
    ip: string;
  };
};
export type Ctx = Context<Env>;

const FLASH = "ledger_flash";

export function flash(c: Ctx, text: string): void {
  setCookie(c, FLASH, encodeURIComponent(text), { path: "/", httpOnly: true, sameSite: "Lax", maxAge: 60 });
}

export function page(
  c: Ctx,
  opts: { title: string; nav?: Nav; wide?: boolean; hero?: Child; map?: boolean; error?: boolean },
  body: Child,
) {
  const message = getCookie(c, FLASH);
  if (message) deleteCookie(c, FLASH, { path: "/" });
  if (isPartial(c)) {
    // Just the content, for the popup dialog (client/boot.ts).
    return c.html(
      <div class="lg-partial" data-title={opts.title}>
        {message && <Flash text={decodeURIComponent(message)} />}
        {body}
      </div>,
    );
  }
  const user = c.get("user");
  return c.html(
    html`<!DOCTYPE html>${(
      <Layout
        title={opts.error ? `Error: ${opts.title}` : opts.title}
        nav={opts.nav}
        wide={opts.wide}
        hero={opts.hero}
        map={opts.map}
        username={user?.username}
        theme={user?.theme ?? "system"}
        flash={message ? decodeURIComponent(message) : undefined}
      >
        {body}
      </Layout>
    )}`,
  );
}

export const PARTIAL_HEADER = "x-ledger-partial";
export const isPartial = (c: Ctx) => c.req.header(PARTIAL_HEADER) === "1";

export type Form = Record<string, string>;

/**
 * Parses a urlencoded/multipart body into trimmed strings (files are dropped).
 * Repeated fields, like a group of checkboxes, are joined with commas.
 */
export async function form(c: Ctx): Promise<Form> {
  const body = await c.req.parseBody({ all: true });
  const out: Form = {};
  for (const [k, v] of Object.entries(body)) {
    const values = (Array.isArray(v) ? v : [v]).filter((x): x is string => typeof x === "string").map((x) => x.trim());
    if (values.length) out[k] = values.join(",");
  }
  return out;
}

export const intParam = (c: Ctx, name = "id"): number => {
  const n = Number(c.req.param(name));
  return Number.isInteger(n) && n > 0 ? n : -1;
};

/** Only allow same-site relative paths as redirect targets. */
export const safeNext = (next: string | undefined, fallback = "/") =>
  next && next.startsWith("/") && !next.startsWith("//") ? next : fallback;
