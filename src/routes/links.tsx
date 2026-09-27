import { Hono } from "hono";
import { audit } from "../auth.ts";
import { type DomainRef, domainsJson, ensureDomains, listCategories, parseDomains, readDomainFields, setDomains } from "../categories.ts";
import { db, likeArg, now } from "../db.ts";
import {
  BackLink,
  Button,
  ButtonGroup,
  ButtonLink,
  DomainPicker,
  DomainTags,
  ErrorSummary,
  type Errors,
  Input,
  Select,
  Textarea,
} from "../views/components.tsx";
import { type Ctx, type Env, type Form, flash, form, intParam, page } from "../web.tsx";

export const linkRoutes = new Hono<Env>();

interface Link {
  id: number;
  title: string;
  url: string;
  description: string;
  domains: DomainRef[];
}
type Row = Omit<Link, "domains"> & { domains_json: string };
const toLink = ({ domains_json, ...l }: Row): Link => ({ ...l, domains: parseDomains(domains_json) });

const SELECT = `
  SELECT l.id, l.title, l.url, l.description, ${domainsJson("link_domains", "link_id", "l.id")} AS domains_json
  FROM links l
  WHERE l.user_id = ? AND l.deleted_at IS NULL`;

const getLink = (userId: number, id: number) => {
  const row = db().prepare(`${SELECT} AND l.id = ?`).get(userId, id) as Row | undefined;
  return row && toLink(row);
};

const hostOf = (url: string) => {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
};

linkRoutes.get("/", (c) => {
  const user = c.get("user");
  const q = c.req.query("q")?.trim() ?? "";
  const domain = c.req.query("domain") ?? "";
  const where: string[] = [];
  const args: unknown[] = [user.id];
  if (q) {
    where.push("(l.title LIKE ? ESCAPE '\\' OR l.url LIKE ? ESCAPE '\\' OR l.description LIKE ? ESCAPE '\\')");
    args.push(likeArg(q), likeArg(q), likeArg(q));
  }
  if (domain === "none") where.push("NOT EXISTS (SELECT 1 FROM link_domains x WHERE x.link_id = l.id)");
  else if (domain) {
    where.push("EXISTS (SELECT 1 FROM link_domains x WHERE x.link_id = l.id AND x.domain_id = ?)");
    args.push(Number(domain));
  }
  const links = db()
    .prepare(`${SELECT} ${where.map((w) => `AND ${w}`).join(" ")} ORDER BY l.title COLLATE NOCASE`)
    .all(...args)
    .map((r) => toLink(r as Row));
  const domains = listCategories("domains", user.id);

  return page(
    c,
    { title: "Links", nav: "links" },
    <>
      <div class="lg-title-row">
        <h1 class="govuk-heading-l">Links</h1>
        <ButtonLink href="/links/new">Add a link</ButtonLink>
      </div>
      <form method="get" action="/links" class="lg-filters" role="search">
        <Input name="q" label="Search" value={q} />
        <Select
          name="domain"
          label="Domain"
          value={domain}
          options={[{ value: "", text: "All" }, { value: "none", text: "No domain" }, ...domains.map((d) => ({ value: String(d.id), text: d.name }))]}
        />
        <Button variant="secondary">Apply</Button>
      </form>
      {links.length === 0 ? (
        <p class="govuk-body">{q || domain ? "No links match." : "No links yet. Keep docs, dashboards, runbooks and PRs here."}</p>
      ) : (
        <dl class="govuk-summary-list">
          {links.map((l) => (
            <div class="govuk-summary-list__row">
              <dt class="govuk-summary-list__key">
                <a class="govuk-link" href={l.url} rel="noreferrer noopener" target="_blank">
                  {l.title}
                  <span class="govuk-visually-hidden"> (opens in new tab)</span>
                </a>
                <br />
                <span class="govuk-body-s lg-muted">{hostOf(l.url)}</span>
              </dt>
              <dd class="govuk-summary-list__value">
                <span class="lg-tags">
                  <DomainTags domains={l.domains} />
                </span>{" "}
                {l.description}
              </dd>
              <dd class="govuk-summary-list__actions">
                <ul class="govuk-summary-list__actions-list">
                  <li class="govuk-summary-list__actions-list-item">
                    <a class="govuk-link" href={`/links/${l.id}/edit`}>
                      Change<span class="govuk-visually-hidden"> {l.title}</span>
                    </a>
                  </li>
                  <li class="govuk-summary-list__actions-list-item">
                    <a class="govuk-link" href={`/links/${l.id}/delete`}>
                      Delete<span class="govuk-visually-hidden"> {l.title}</span>
                    </a>
                  </li>
                </ul>
              </dd>
            </div>
          ))}
        </dl>
      )}
    </>,
  );
});

function validate(c: Ctx, f: Form): Errors {
  const errors: Errors = {};
  if (!f.url) errors.url = "Enter a web address";
  else {
    try {
      const u = new URL(f.url);
      if (u.protocol !== "http:" && u.protocol !== "https:") throw new Error();
    } catch {
      errors.url = "Enter a web address starting with http:// or https://";
    }
  }
  if (f.title && f.title.length > 200) errors.title = "Title must be 200 characters or fewer";
  Object.assign(errors, readDomainFields(c.get("user").id, f).errors);
  return errors;
}

/** Chosen plus newly named domains. Call only once the form is valid. */
function domainIds(c: Ctx, f: Form): number[] {
  const userId = c.get("user").id;
  const { ids, newNames } = readDomainFields(userId, f);
  return [...new Set([...ids, ...ensureDomains(userId, newNames)])];
}

function linkForm(c: Ctx, opts: { link?: Link; values: Form; errors?: Errors }) {
  const errors = opts.errors ?? {};
  const v = opts.values;
  const domains = listCategories("domains", c.get("user").id);
  return page(
    c,
    { title: opts.link ? "Change link" : "Add a link", nav: "links", error: Object.keys(errors).length > 0 },
    <div class="govuk-grid-row">
      <div class="govuk-grid-column-two-thirds">
        <BackLink href="/links" />
        <ErrorSummary errors={errors} />
        <span class="govuk-caption-l">Links</span>
        <h1 class="govuk-heading-l">{opts.link ? "Change link" : "Add a link"}</h1>
        <form method="post" action={opts.link ? `/links/${opts.link.id}` : "/links"} novalidate>
          <Input name="url" label="Web address" type="url" value={v.url} error={errors.url} spellcheck={false} />
          <Input name="title" label="Title" hint="Leave blank to use the web address" value={v.title} error={errors.title} />
          <DomainPicker domains={domains} selected={v.domain_ids} newValue={v.new_domains} error={errors.domain_ids} newError={errors.new_domains} />
          <Textarea name="description" label="Description" value={v.description} rows={3} />
          <ButtonGroup>
            <Button>{opts.link ? "Save changes" : "Add link"}</Button>
            <a class="govuk-link" href="/links">
              Cancel
            </a>
          </ButtonGroup>
        </form>
      </div>
    </div>,
  );
}

linkRoutes.get("/new", (c) => linkForm(c, { values: {} }));

linkRoutes.post("/", async (c) => {
  const user = c.get("user");
  const f = await form(c);
  const errors = validate(c, f);
  if (Object.keys(errors).length) {
    c.status(400);
    return linkForm(c, { values: f, errors });
  }
  const at = now();
  const title = f.title || hostOf(f.url);
  const { lastInsertRowid } = db()
    .prepare("INSERT INTO links (user_id, title, url, description, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)")
    .run(user.id, title, f.url, f.description ?? "", at, at);
  setDomains("link", Number(lastInsertRowid), domainIds(c, f));
  audit(user.id, "link added", title, c.get("ip"));
  flash(c, `${title} added`);
  return c.redirect("/links");
});

linkRoutes.get("/:id/edit", (c) => {
  const l = getLink(c.get("user").id, intParam(c));
  if (!l) return c.notFound();
  return linkForm(c, {
    link: l,
    values: { url: l.url, title: l.title, description: l.description, domain_ids: l.domains.map((d) => d.id).join(",") },
  });
});

linkRoutes.post("/:id", async (c) => {
  const user = c.get("user");
  const l = getLink(user.id, intParam(c));
  if (!l) return c.notFound();
  const f = await form(c);
  const errors = validate(c, f);
  if (Object.keys(errors).length) {
    c.status(400);
    return linkForm(c, { link: l, values: f, errors });
  }
  const title = f.title || hostOf(f.url);
  db()
    .prepare("UPDATE links SET title = ?, url = ?, description = ?, updated_at = ? WHERE id = ? AND user_id = ?")
    .run(title, f.url, f.description ?? "", now(), l.id, user.id);
  setDomains("link", l.id, domainIds(c, f));
  audit(user.id, "link changed", title, c.get("ip"));
  flash(c, `${title} saved`);
  return c.redirect("/links");
});

linkRoutes.get("/:id/delete", (c) => {
  const l = getLink(c.get("user").id, intParam(c));
  if (!l) return c.notFound();
  return page(
    c,
    { title: `Delete ${l.title}`, nav: "links" },
    <div class="govuk-grid-row">
      <div class="govuk-grid-column-two-thirds">
        <BackLink href="/links" />
        <h1 class="govuk-heading-l">Are you sure you want to delete {l.title}?</h1>
        <form method="post" action={`/links/${l.id}/delete`}>
          <ButtonGroup>
            <Button variant="warning">Yes, delete link</Button>
            <a class="govuk-link" href="/links">
              No, keep it
            </a>
          </ButtonGroup>
        </form>
      </div>
    </div>,
  );
});

linkRoutes.post("/:id/delete", (c) => {
  const user = c.get("user");
  const l = getLink(user.id, intParam(c));
  if (!l) return c.notFound();
  db().prepare("UPDATE links SET deleted_at = ? WHERE id = ? AND user_id = ?").run(now(), l.id, user.id);
  audit(user.id, "link deleted", l.title, c.get("ip"));
  flash(c, `${l.title} deleted`);
  return c.redirect("/links");
});
