import fs from "node:fs";
import path from "node:path";
import { Hono } from "hono";
import { deleteCookie, getCookie, setCookie } from "hono/cookie";
import {
  audit,
  auditFor,
  checkPassword,
  createSession,
  endOtherSessions,
  endSession,
  LOCKOUT_MINUTES,
  lockedOut,
  sessionUser,
  setPassword,
  setTheme,
  type Theme,
  userSessions,
  validatePassword,
  verifyLogin,
} from "../auth.ts";
import { ROOT } from "../config.ts";
import { db } from "../db.ts";
import {
  Button,
  ErrorSummary,
  type Errors,
  fmtDateTime,
  Input,
  SummaryCard,
  SummaryList,
  Tag,
} from "../views/components.tsx";
import { type Ctx, type Env, flash, form, page, safeNext } from "../web.tsx";

export const SESSION_COOKIE = "ledger_session";

// ---------------------------------------------------------------- sign in (public)

export const authRoutes = new Hono<Env>();

function loginPage(c: Ctx, opts: { username?: string; errors?: Errors; next?: string }) {
  const errors = opts.errors ?? {};
  return page(
    c,
    { title: "Sign in", error: Object.keys(errors).length > 0 },
    <div class="govuk-grid-row">
      <div class="govuk-grid-column-two-thirds">
        <ErrorSummary errors={errors} />
        <h1 class="govuk-heading-l">Sign in to Ledger</h1>
        <form method="post" action="/login" novalidate>
          <input type="hidden" name="next" value={opts.next ?? "/"} />
          <Input name="username" label="Username" value={opts.username} error={errors.username} width="20" autocomplete="username" spellcheck={false} />
          <Input name="password" label="Password" type="password" error={errors.password} width="20" autocomplete="current-password" />
          <Button>Sign in</Button>
        </form>
        <details class="govuk-details">
          <summary class="govuk-details__summary">
            <span class="govuk-details__summary-text">I do not have an account</span>
          </summary>
          <div class="govuk-details__text">
            Accounts are created on the command line with <code class="lg-code">bin/ledger adduser &lt;name&gt;</code>.
          </div>
        </details>
      </div>
    </div>,
  );
}

authRoutes.get("/login", (c) => {
  if (sessionUser(getCookie(c, SESSION_COOKIE))) return c.redirect(safeNext(c.req.query("next")));
  return loginPage(c, { next: c.req.query("next") });
});

authRoutes.post("/login", async (c) => {
  const f = await form(c);
  const ip = c.get("ip");
  const next = safeNext(f.next);
  if (lockedOut(ip)) {
    c.status(429);
    return loginPage(c, {
      username: f.username,
      next,
      errors: { username: `Too many failed attempts. Try again in ${LOCKOUT_MINUTES} minutes` },
    });
  }
  const errors: Errors = {};
  if (!f.username) errors.username = "Enter your username";
  if (!f.password) errors.password = "Enter your password";
  if (!Object.keys(errors).length) {
    const userId = await verifyLogin(f.username, f.password, ip);
    if (userId) {
      const { token, expires } = createSession(userId, c.req.header("user-agent"));
      setCookie(c, SESSION_COOKIE, token, { path: "/", httpOnly: true, sameSite: "Lax", expires });
      audit(userId, "login", "", ip);
      return c.redirect(next);
    }
    audit(null, "login failed", f.username, ip);
    errors.username = "Enter a correct username and password";
  }
  c.status(400);
  return loginPage(c, { username: f.username, errors, next });
});

authRoutes.get("/licence", (c) => {
  const text = fs.readFileSync(path.join(ROOT, "LICENSE"), "utf8");
  const [heading, ...rest] = text.trim().split(/\n\s*\n/);
  return page(
    c,
    { title: "Licence" },
    <div class="govuk-grid-row">
      <div class="govuk-grid-column-two-thirds">
        <h1 class="govuk-heading-l">{heading}</h1>
        {rest.map((para) => (
          <p class="govuk-body">{para.replace(/\s*\n\s*/g, " ")}</p>
        ))}
      </div>
    </div>,
  );
});

authRoutes.post("/logout", (c) => {
  const token = getCookie(c, SESSION_COOKIE);
  const user = sessionUser(token);
  if (token) endSession(token);
  if (user) audit(user.id, "logout", "", c.get("ip"));
  deleteCookie(c, SESSION_COOKIE, { path: "/" });
  return c.redirect("/login");
});

// ---------------------------------------------------------------- profile

export const accountRoutes = new Hono<Env>();

function profilePage(c: Ctx, errors: Errors = {}) {
  const user = c.get("user");
  const sessions = userSessions(user.id);
  const others = sessions.length - 1;
  return page(
    c,
    { title: "Profile", nav: "account", error: Object.keys(errors).length > 0 },
    <div class="govuk-grid-row">
      <div class="govuk-grid-column-two-thirds">
        <ErrorSummary errors={errors} />
        <span class="govuk-caption-l">{user.username}</span>
        <h1 class="govuk-heading-l">Profile</h1>

        <SummaryCard title="Account">
          <SummaryList
            rows={[
              { key: "Username", value: user.username },
              { key: "Created", value: fmtDateTime(user.created_at) },
              { key: "Appearance", value: THEME_TEXT[user.theme] },
            ]}
          />
        </SummaryCard>

        <h2 class="govuk-heading-m">Change your password</h2>
        <form method="post" action="/profile/password" novalidate>
          <Input name="current" label="Current password" type="password" error={errors.current} width="20" autocomplete="current-password" />
          <Input name="password" label="New password" hint="At least 8 characters" type="password" error={errors.password} width="20" autocomplete="new-password" />
          <Input name="confirm" label="Confirm new password" type="password" error={errors.confirm} width="20" autocomplete="new-password" />
          <Button>Change password</Button>
        </form>

        <h2 class="govuk-heading-m">Sessions</h2>
        <table class="govuk-table">
          <thead class="govuk-table__head">
            <tr class="govuk-table__row">
              <th scope="col" class="govuk-table__header">Browser</th>
              <th scope="col" class="govuk-table__header">Signed in</th>
              <th scope="col" class="govuk-table__header">Expires</th>
            </tr>
          </thead>
          <tbody class="govuk-table__body">
            {sessions.map((s) => (
              <tr class="govuk-table__row">
                <td class="govuk-table__cell">
                  {browserName(s.user_agent)} {s.token_hash === user.tokenHash && <Tag colour="green">This one</Tag>}
                </td>
                <td class="govuk-table__cell">{fmtDateTime(s.created_at)}</td>
                <td class="govuk-table__cell">{fmtDateTime(s.expires_at)}</td>
              </tr>
            ))}
          </tbody>
        </table>
        {others > 0 && (
          <form method="post" action="/profile/sessions/end-others">
            <Button variant="secondary">
              Sign out {others} other {others === 1 ? "session" : "sessions"}
            </Button>
          </form>
        )}
      </div>
    </div>,
  );
}

const THEME_TEXT: Record<Theme, string> = { system: "Match system", light: "Light", dark: "Dark" };

function browserName(ua: string | null): string {
  if (!ua) return "Unknown";
  if (/Edg\//.test(ua)) return "Edge";
  if (/Chrome\//.test(ua)) return "Chrome";
  if (/Firefox\//.test(ua)) return "Firefox";
  if (/Safari\//.test(ua)) return "Safari";
  return ua.slice(0, 40);
}

accountRoutes.get("/profile", (c) => profilePage(c));

accountRoutes.post("/profile/password", async (c) => {
  const user = c.get("user");
  const f = await form(c);
  const errors: Errors = {};
  const row = db().prepare("SELECT pw_hash FROM users WHERE id = ?").get(user.id) as { pw_hash: string };
  if (!f.current) errors.current = "Enter your current password";
  else if (!(await checkPassword(row.pw_hash, f.current))) errors.current = "Your current password is incorrect";
  const problem = validatePassword(f.password ?? "");
  if (!f.password) errors.password = "Enter a new password";
  else if (problem) errors.password = problem;
  if (!errors.password && f.confirm !== f.password) errors.confirm = "Passwords do not match";
  if (Object.keys(errors).length) {
    c.status(400);
    return profilePage(c, errors);
  }
  await setPassword(user.id, f.password);
  const ended = endOtherSessions(user.id, user.tokenHash);
  audit(user.id, "password changed", ended ? `ended ${ended} other sessions` : "", c.get("ip"));
  flash(c, "Your password has been changed");
  return c.redirect("/profile");
});

accountRoutes.post("/profile/theme", async (c) => {
  const f = await form(c);
  const theme = f.theme as Theme;
  if (theme in THEME_TEXT) setTheme(c.get("user").id, theme);
  return c.redirect(safeNext(c.req.header("referer")?.replace(/^https?:\/\/[^/]+/, ""), "/profile"));
});

accountRoutes.post("/profile/sessions/end-others", (c) => {
  const user = c.get("user");
  const n = endOtherSessions(user.id, user.tokenHash);
  audit(user.id, "sessions ended", `${n}`, c.get("ip"));
  flash(c, `Signed out ${n} other ${n === 1 ? "session" : "sessions"}`);
  return c.redirect("/profile");
});

accountRoutes.get("/activity", (c) => {
  const rows = auditFor(c.get("user").id);
  return page(
    c,
    { title: "Activity", nav: "account" },
    <>
      <h1 class="govuk-heading-l">Activity</h1>
      <p class="govuk-body">The last 200 things done on your account.</p>
      <table class="govuk-table">
        <thead class="govuk-table__head">
          <tr class="govuk-table__row">
            <th scope="col" class="govuk-table__header">When</th>
            <th scope="col" class="govuk-table__header">What</th>
            <th scope="col" class="govuk-table__header">Detail</th>
          </tr>
        </thead>
        <tbody class="govuk-table__body">
          {rows.map((r) => (
            <tr class="govuk-table__row">
              <td class="govuk-table__cell lg-nowrap">{fmtDateTime(r.at)}</td>
              <td class="govuk-table__cell">{r.action}</td>
              <td class="govuk-table__cell">{r.detail}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </>,
  );
});
