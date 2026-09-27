// Page chrome, after loci's base.html: a blue header with the service name,
// a Menu button that opens a grouped panel, then GOV.UK Service Navigation
// for the everyday pages. No Crown, no GOV.UK wordmark.
import type { FC, PropsWithChildren } from "hono/jsx";
import { raw } from "hono/html";
import type { Theme } from "../auth.ts";

export type Nav = "today" | "journal" | "tasks" | "links" | "places" | "settings" | "account";

const PRIMARY: [Nav, string, string][] = [
  ["today", "Today", "/"],
  ["journal", "Journal", "/journal"],
  ["tasks", "Tasks", "/tasks/board"],
  ["links", "Links", "/links"],
  ["places", "My locations", "/places"],
];

const MENU: { heading: string; items: [string, string, string][] }[] = [
  {
    heading: "Work",
    items: [
      ["/journal/new", "Write in journal", "Add an entry for today or another day"],
      ["/tasks/board", "Task board", "Tasks as columns, plus statuses and domains"],
      ["/tasks", "All tasks", "Filter and sort as a list"],
      ["/links", "Links", "Docs, dashboards and references"],
    ],
  },
  {
    heading: "Places",
    items: [
      ["/places", "My locations", "Places, their networks and logging"],
      ["/places/log", "Location log", "Every arrival and departure"],
    ],
  },
  {
    heading: "Account",
    items: [
      ["/profile", "Profile", "Password, appearance and sessions"],
      ["/activity", "Activity", "Everything done on this service"],
    ],
  },
];

const VERSION = "0.1.0";

// Runs before first paint: tells govuk-frontend JS is on, and resolves
// "system" so the dark theme does not flash.
const BOOT = `document.body.className += ' js-enabled' + ('noModule' in HTMLScriptElement.prototype ? ' govuk-frontend-supported' : '');`;

export const Flash: FC<{ text: string }> = ({ text }) => (
  <div class="govuk-notification-banner govuk-notification-banner--success" role="alert" data-module="govuk-notification-banner">
    <div class="govuk-notification-banner__header">
      <h2 class="govuk-notification-banner__title">Success</h2>
    </div>
    <div class="govuk-notification-banner__content">
      <p class="govuk-notification-banner__heading">{text}</p>
    </div>
  </div>
);

export const Layout: FC<
  PropsWithChildren<{
    title: string;
    nav?: Nav;
    wide?: boolean;
    username?: string;
    theme: Theme;
    flash?: string;
  }>
> = ({ title, nav, wide, username, theme, flash, children }) => (
  <html lang="en-GB" class="govuk-template" data-theme={theme}>
    <head>
      <meta charset="utf-8" />
      <title>{title} - Ledger</title>
      <meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover" />
      <meta name="theme-color" content="#1d70b8" />
      <meta name="color-scheme" content={theme === "system" ? "light dark" : theme} />
      <link rel="icon" type="image/svg+xml" href="/static/favicon.svg" />
      <link rel="stylesheet" href="/assets/govuk-frontend.min.css" />
      <link rel="stylesheet" href="/static/ledger.css" />
    </head>
    <body class="govuk-template__body">
      <script>{raw(BOOT)}</script>
      <a href="#main-content" class="govuk-skip-link" data-module="govuk-skip-link">
        Skip to main content
      </a>

      <header class="lg-header">
        <div class="govuk-width-container lg-header__inner">
          <a href="/" class="lg-header__brand">
            LEDGER
          </a>
          {username && (
            <button type="button" class="lg-header__menu" id="menu-toggle" aria-controls="menu-panel" aria-expanded="false">
              <svg class="lg-header__chev" width="16" height="10" viewBox="0 0 16 10" fill="none" focusable="false" aria-hidden="true">
                <path d="M1.5 1.5 8 8l6.5-6.5" stroke="currentColor" stroke-width="2.5" />
              </svg>
              Menu
            </button>
          )}
        </div>
      </header>

      {username && (
        <nav class="lg-menu" id="menu-panel" aria-label="Menu" hidden>
          <div class="govuk-width-container">
            <div class="govuk-grid-row">
              {MENU.map((g) => (
                <div class="govuk-grid-column-one-third">
                  <h2 class="lg-menu__heading">{g.heading}</h2>
                  <ul class="lg-menu__list">
                    {g.items.map(([href, text, desc]) => (
                      <li>
                        <a href={href} class="lg-menu__link">
                          {text}
                        </a>
                        <span class="lg-menu__desc">{desc}</span>
                      </li>
                    ))}
                  </ul>
                </div>
              ))}
            </div>
            <div class="lg-menu__foot">
              <form method="post" action="/profile/theme" class="lg-menu__themes" aria-label="Appearance">
                <span class="lg-menu__desc">Appearance:</span>
                {(["system", "light", "dark"] as Theme[]).map((t) => (
                  <button type="submit" name="theme" value={t} class="lg-menu__theme" aria-pressed={String(theme === t)}>
                    {t === "system" ? "Match system" : t === "light" ? "Light" : "Dark"}
                  </button>
                ))}
              </form>
              <form method="post" action="/logout" class="lg-inline-form">
                <button type="submit" class="lg-menu__link lg-link-button">
                  Sign out
                </button>
                <span class="lg-menu__desc"> Signed in as {username}</span>
              </form>
            </div>
          </div>
        </nav>
      )}

      {username && (
        <section aria-label="Service information" class="govuk-service-navigation" data-module="govuk-service-navigation">
          <div class="govuk-width-container">
            <div class="govuk-service-navigation__container">
              <nav aria-label="Menu" class="govuk-service-navigation__wrapper">
                <ul class="govuk-service-navigation__list" id="navigation">
                  {PRIMARY.map(([key, text, href]) => (
                    <li class={`govuk-service-navigation__item${nav === key ? " govuk-service-navigation__item--active" : ""}`}>
                      <a class="govuk-service-navigation__link" href={href} aria-current={nav === key ? "true" : undefined}>
                        {nav === key ? <strong class="govuk-service-navigation__active-fallback">{text}</strong> : text}
                      </a>
                    </li>
                  ))}
                </ul>
              </nav>
            </div>
          </div>
        </section>
      )}

      <div class={`lg-page ${wide ? "lg-wide-container" : "govuk-width-container"}`}>
        <div class="govuk-phase-banner">
          <p class="govuk-phase-banner__content">
            <strong class="govuk-tag govuk-phase-banner__content__tag">Alpha</strong>
            <span class="govuk-phase-banner__text">Runs on this Mac only. Nothing leaves it.</span>
          </p>
        </div>
        <main class="govuk-main-wrapper" id="main-content">
          {flash && <Flash text={flash} />}
          {children}
        </main>
      </div>

      <footer class="govuk-footer lg-footer">
        <div class="govuk-width-container">
          <div class="govuk-footer__meta">
            <div class="govuk-footer__meta-item govuk-footer__meta-item--grow">Ledger v{VERSION}</div>
          </div>
        </div>
      </footer>

      <script type="module" src="/static/build/boot.js"></script>
    </body>
  </html>
);
