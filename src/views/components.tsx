// GOV.UK Design System components as hono/jsx. Markup follows govuk-frontend
// 6.5.1's templates; only the parts this app uses are implemented.
import type { Child, FC, PropsWithChildren } from "hono/jsx";
import { raw } from "hono/html";
import { marked } from "marked";
import sanitizeHtml from "sanitize-html";

export type Errors = Record<string, string>;

// v6 tag colours. Blue is the unmodified default.
export const COLOURS = [
  "grey",
  "blue",
  "teal",
  "turquoise",
  "green",
  "yellow",
  "orange",
  "red",
  "pink",
  "magenta",
  "purple",
] as const;
export type Colour = (typeof COLOURS)[number];
export const isColour = (c: string): c is Colour => (COLOURS as readonly string[]).includes(c);

export const Tag: FC<PropsWithChildren<{ colour?: string }>> = ({ colour, children }) => (
  <strong class={`govuk-tag${colour && colour !== "blue" ? ` govuk-tag--${colour}` : ""}`}>{children}</strong>
);

export const ErrorSummary: FC<{ errors: Errors }> = ({ errors }) => {
  const keys = Object.keys(errors);
  if (!keys.length) return null;
  return (
    <div class="govuk-error-summary" data-module="govuk-error-summary">
      <div role="alert">
        <h2 class="govuk-error-summary__title">There is a problem</h2>
        <div class="govuk-error-summary__body">
          <ul class="govuk-list govuk-error-summary__list">
            {keys.map((k) => (
              <li>
                <a href={`#${k}`}>{errors[k]}</a>
              </li>
            ))}
          </ul>
        </div>
      </div>
    </div>
  );
};

interface FieldProps {
  name: string;
  label: string;
  hint?: string;
  error?: string;
  /** Render the label as the page heading (GDS one-question pages). */
  heading?: boolean;
}

const Label: FC<FieldProps> = ({ name, label, heading }) =>
  heading ? (
    <h1 class="govuk-label-wrapper">
      <label class="govuk-label govuk-label--l" for={name}>
        {label}
      </label>
    </h1>
  ) : (
    <label class="govuk-label govuk-label--s" for={name}>
      {label}
    </label>
  );

const Group: FC<PropsWithChildren<FieldProps>> = (p) => (
  <div class={`govuk-form-group${p.error ? " govuk-form-group--error" : ""}`}>
    <Label {...p} />
    {p.hint && (
      <div id={`${p.name}-hint`} class="govuk-hint">
        {p.hint}
      </div>
    )}
    {p.error && (
      <p id={`${p.name}-error`} class="govuk-error-message">
        <span class="govuk-visually-hidden">Error:</span> {p.error}
      </p>
    )}
    {p.children}
  </div>
);

const describedBy = (p: FieldProps) =>
  [p.hint && `${p.name}-hint`, p.error && `${p.name}-error`].filter(Boolean).join(" ") || undefined;

export const Input: FC<
  FieldProps & { value?: string | null; type?: string; width?: string; autocomplete?: string; spellcheck?: boolean }
> = (p) => (
  <Group {...p}>
    <input
      class={`govuk-input${p.width ? ` govuk-input--width-${p.width}` : ""}${p.error ? " govuk-input--error" : ""}`}
      id={p.name}
      name={p.name}
      type={p.type ?? "text"}
      value={p.value ?? ""}
      autocomplete={p.autocomplete}
      spellcheck={p.spellcheck}
      aria-describedby={describedBy(p)}
    />
  </Group>
);

export const Textarea: FC<FieldProps & { value?: string | null; rows?: number }> = (p) => (
  <Group {...p}>
    <textarea
      class={`govuk-textarea lg-textarea${p.error ? " govuk-textarea--error" : ""}`}
      id={p.name}
      name={p.name}
      rows={p.rows ?? 8}
      aria-describedby={describedBy(p)}
    >
      {p.value ?? ""}
    </textarea>
  </Group>
);

export interface Option {
  value: string;
  text: string;
}

export const Select: FC<FieldProps & { options: Option[]; value?: string | number | null }> = (p) => (
  <Group {...p}>
    <select
      class={`govuk-select${p.error ? " govuk-select--error" : ""}`}
      id={p.name}
      name={p.name}
      aria-describedby={describedBy(p)}
    >
      {p.options.map((o) => (
        <option value={o.value} selected={String(p.value ?? "") === o.value}>
          {o.text}
        </option>
      ))}
    </select>
  </Group>
);

export const Checkbox: FC<{ name: string; label: string; checked?: boolean; hint?: string }> = (p) => (
  <div class="govuk-form-group">
    <div class="govuk-checkboxes govuk-checkboxes--small" data-module="govuk-checkboxes">
      <div class="govuk-checkboxes__item">
        <input class="govuk-checkboxes__input" id={p.name} name={p.name} type="checkbox" value="1" checked={p.checked} />
        <label class="govuk-label govuk-checkboxes__label" for={p.name}>
          {p.label}
        </label>
        {p.hint && <div class="govuk-hint govuk-checkboxes__hint">{p.hint}</div>}
      </div>
    </div>
  </div>
);

/** Multi-select domains as small checkboxes, plus a box to create new ones inline. */
export const DomainPicker: FC<{
  domains: { id: number; name: string }[];
  selected: string | undefined;
  newValue?: string;
  error?: string;
  newError?: string;
}> = ({ domains, selected, newValue, error, newError }) => {
  const chosen = new Set((selected ?? "").split(",").filter(Boolean));
  return (
    <div class={`govuk-form-group${error || newError ? " govuk-form-group--error" : ""}`}>
      <fieldset class="govuk-fieldset" aria-describedby="domain_ids-hint">
        <legend class="govuk-fieldset__legend govuk-fieldset__legend--s">Domains</legend>
        <div id="domain_ids-hint" class="govuk-hint">
          Select all that apply.
        </div>
        {error && (
          <p id="domain_ids-error" class="govuk-error-message">
            <span class="govuk-visually-hidden">Error:</span> {error}
          </p>
        )}
        <div class="govuk-checkboxes govuk-checkboxes--small lg-checkbox-row" data-module="govuk-checkboxes">
          {domains.map((d, i) => (
            <div class="govuk-checkboxes__item">
              <input
                class="govuk-checkboxes__input"
                id={i === 0 ? "domain_ids" : `domain_ids-${i}`}
                name="domain_ids"
                type="checkbox"
                value={String(d.id)}
                checked={chosen.has(String(d.id))}
              />
              <label class="govuk-label govuk-checkboxes__label" for={i === 0 ? "domain_ids" : `domain_ids-${i}`}>
                {d.name}
              </label>
            </div>
          ))}
        </div>
        <div class="lg-new-domain">
          <label class="govuk-label govuk-label--s" for="new_domains">
            Add a new domain
          </label>
          <div id="new_domains-hint" class="govuk-hint">
            Optional. Separate more than one with commas.
          </div>
          {newError && (
            <p id="new_domains-error" class="govuk-error-message">
              <span class="govuk-visually-hidden">Error:</span> {newError}
            </p>
          )}
          <input
            class={`govuk-input govuk-input--width-20${newError ? " govuk-input--error" : ""}`}
            id="new_domains"
            name="new_domains"
            type="text"
            value={newValue ?? ""}
            aria-describedby="new_domains-hint"
          />
        </div>
      </fieldset>
    </div>
  );
};

export const DomainTags: FC<{ domains: { name: string; colour: string }[] }> = ({ domains }) => (
  <>
    {domains.map((d) => (
      <Tag colour={d.colour}>{d.name}</Tag>
    ))}
  </>
);

export const Radios: FC<
  FieldProps & { options: (Option & { hint?: string })[]; value?: string; inline?: boolean; small?: boolean }
> = (p) => (
  <div class={`govuk-form-group${p.error ? " govuk-form-group--error" : ""}`}>
    <fieldset class="govuk-fieldset" aria-describedby={describedBy(p)}>
      <legend class={`govuk-fieldset__legend ${p.heading ? "govuk-fieldset__legend--l" : "govuk-fieldset__legend--s"}`}>
        {p.heading ? <h1 class="govuk-fieldset__heading">{p.label}</h1> : p.label}
      </legend>
      {p.hint && (
        <div id={`${p.name}-hint`} class="govuk-hint">
          {p.hint}
        </div>
      )}
      {p.error && (
        <p id={`${p.name}-error`} class="govuk-error-message">
          <span class="govuk-visually-hidden">Error:</span> {p.error}
        </p>
      )}
      <div
        class={`govuk-radios${p.inline ? " govuk-radios--inline" : ""}${p.small ? " govuk-radios--small" : ""}`}
        data-module="govuk-radios"
      >
        {p.options.map((o, i) => (
          <div class="govuk-radios__item">
            <input
              class="govuk-radios__input"
              id={i === 0 ? p.name : `${p.name}-${i}`}
              name={p.name}
              type="radio"
              value={o.value}
              checked={p.value === o.value}
            />
            <label class="govuk-label govuk-radios__label" for={i === 0 ? p.name : `${p.name}-${i}`}>
              {o.text}
            </label>
            {o.hint && <div class="govuk-hint govuk-radios__hint">{o.hint}</div>}
          </div>
        ))}
      </div>
    </fieldset>
  </div>
);

export const Button: FC<
  PropsWithChildren<{ variant?: "secondary" | "warning" | "inverse"; name?: string; value?: string; small?: boolean }>
> = ({ variant, children, name, value, small }) => (
  <button
    type="submit"
    class={`govuk-button${variant ? ` govuk-button--${variant}` : ""}${small ? " lg-button--small" : ""}`}
    data-module="govuk-button"
    name={name}
    value={value}
  >
    {children}
  </button>
);

export const ButtonLink: FC<PropsWithChildren<{ href: string; variant?: "secondary" | "warning"; modal?: boolean }>> = ({
  href,
  variant,
  modal,
  children,
}) => (
  <a
    href={href}
    role="button"
    draggable={false}
    class={`govuk-button${variant ? ` govuk-button--${variant}` : ""}`}
    data-module="govuk-button"
    data-modal={modal}
  >
    {children}
  </a>
);

export const ButtonGroup: FC<PropsWithChildren> = ({ children }) => <div class="govuk-button-group">{children}</div>;

export const BackLink: FC<{ href: string; text?: string }> = ({ href, text }) => (
  <a href={href} class="govuk-back-link">
    {text ?? "Back"}
  </a>
);

export const SummaryList: FC<{
  rows: { key: string; value: Child; action?: { href: string; text: string } }[];
  noBorder?: boolean;
}> = ({ rows, noBorder }) => (
  <dl class={`govuk-summary-list${noBorder ? " govuk-summary-list--no-border" : ""}`}>
    {rows.map((r) => (
      <div class="govuk-summary-list__row">
        <dt class="govuk-summary-list__key">{r.key}</dt>
        <dd class="govuk-summary-list__value">{r.value}</dd>
        {r.action && (
          <dd class="govuk-summary-list__actions">
            <a class="govuk-link" href={r.action.href}>
              {r.action.text}
              <span class="govuk-visually-hidden"> {r.key.toLowerCase()}</span>
            </a>
          </dd>
        )}
      </div>
    ))}
  </dl>
);

export const SummaryCard: FC<PropsWithChildren<{ title: Child; actions?: Child[] }>> = ({ title, actions, children }) => (
  <div class="govuk-summary-card">
    <div class="govuk-summary-card__title-wrapper">
      <h2 class="govuk-summary-card__title">{title}</h2>
      {actions && actions.length > 0 && (
        <ul class="govuk-summary-card__actions">
          {actions.map((a) => (
            <li class="govuk-summary-card__action">{a}</li>
          ))}
        </ul>
      )}
    </div>
    <div class="govuk-summary-card__content">{children}</div>
  </div>
);

export const InsetText: FC<PropsWithChildren> = ({ children }) => <div class="govuk-inset-text">{children}</div>;

export const WarningText: FC<PropsWithChildren> = ({ children }) => (
  <div class="govuk-warning-text">
    <span class="govuk-warning-text__icon" aria-hidden="true">
      !
    </span>
    <strong class="govuk-warning-text__text">
      <span class="govuk-visually-hidden">Warning</span>
      {children}
    </strong>
  </div>
);

export const Caption: FC<PropsWithChildren> = ({ children }) => <span class="govuk-caption-l">{children}</span>;

/** A POST form holding only a button, for actions that change state. */
export const ActionForm: FC<
  PropsWithChildren<{ action: string; variant?: "secondary" | "warning"; link?: boolean; hidden?: Record<string, string> }>
> = ({ action, variant, link, hidden, children }) => (
  <form method="post" action={action} class="lg-inline-form">
    {hidden && Object.entries(hidden).map(([k, v]) => <input type="hidden" name={k} value={v} />)}
    {link ? (
      <button type="submit" class="lg-link-button govuk-link">
        {children}
      </button>
    ) : (
      <Button variant={variant}>{children}</Button>
    )}
  </form>
);

export const Markdown: FC<{ src: string }> = ({ src }) => {
  if (!src.trim()) return <p class="govuk-body lg-muted">No details.</p>;
  const html = sanitizeHtml(marked.parse(src, { async: false, gfm: true, breaks: true }), {
    allowedTags: sanitizeHtml.defaults.allowedTags.concat(["del", "input"]),
    allowedAttributes: { a: ["href", "title"], input: ["type", "checked", "disabled"], code: ["class"] },
    allowedSchemes: ["http", "https", "mailto"],
    transformTags: { a: sanitizeHtml.simpleTransform("a", { class: "govuk-link", rel: "noreferrer noopener" }) },
  });
  return <div class="lg-prose">{raw(html)}</div>;
};

// ---------------------------------------------------------------- formatting (GDS style)

const MONTHS = "January February March April May June July August September October November December".split(" ");

/** "27 September 2026" from YYYY-MM-DD or ISO. */
export function fmtDate(d: string | null | undefined): string {
  if (!d) return "";
  const date = d.length === 10 ? new Date(`${d}T00:00:00`) : new Date(d);
  return `${date.getDate()} ${MONTHS[date.getMonth()]} ${date.getFullYear()}`;
}

/** "27 Sep", for tight spaces. */
export function fmtShortDate(d: string): string {
  const date = new Date(`${d}T00:00:00`);
  return `${date.getDate()} ${MONTHS[date.getMonth()].slice(0, 3)}`;
}

/** "Sunday 27 September 2026". */
export function fmtDay(d: string): string {
  const date = new Date(`${d}T00:00:00`);
  return `${date.toLocaleDateString("en-GB", { weekday: "long" })} ${fmtDate(d)}`;
}

/** "4:30pm", GDS style. */
export function fmtTime(iso: string): string {
  const d = new Date(iso);
  const h = d.getHours() % 12 || 12;
  const m = d.getMinutes();
  const ampm = d.getHours() < 12 ? "am" : "pm";
  if (m === 0 && d.getHours() === 12) return "midday";
  if (m === 0 && d.getHours() === 0) return "midnight";
  return `${h}:${String(m).padStart(2, "0")}${ampm}`;
}

export const fmtDateTime = (iso: string) => `${fmtDate(iso)} at ${fmtTime(iso)}`;

/** "3 hours 5 minutes". */
export function fmtDuration(ms: number): string {
  const mins = Math.round(ms / 60_000);
  const h = Math.floor(mins / 60);
  const m = mins % 60;
  const part = (n: number, unit: string) => `${n} ${unit}${n === 1 ? "" : "s"}`;
  if (h && m) return `${part(h, "hour")} ${part(m, "minute")}`;
  if (h) return part(h, "hour");
  return part(m, "minute");
}
