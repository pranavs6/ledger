// Task statuses and domains share one set of pages.
import { Hono } from "hono";
import { audit } from "../auth.ts";
import {
  addCategory,
  type Category,
  getCategory,
  type Kind,
  listCategories,
  moveCategory,
  nameTaken,
  nextColour,
  setArchived,
  updateCategory,
  usage,
} from "../categories.ts";
import {
  ActionForm,
  BackLink,
  Button,
  ButtonGroup,
  Checkbox,
  COLOURS,
  ErrorSummary,
  type Errors,
  Input,
  isColour,
  Select,
  Tag,
} from "../views/components.tsx";
import { type Ctx, type Env, type Form, flash, form, intParam, page, safeNext } from "../web.tsx";

export const settingsRoutes = new Hono<Env>();

const TEXT: Record<Kind, { title: string; one: string; lead: string }> = {
  statuses: {
    title: "Task statuses",
    one: "status",
    lead: "Each status is a column on the task board, in this order. Closed statuses count as finished: their tasks are not overdue and drop off Today.",
  },
  domains: {
    title: "Domains",
    one: "domain",
    lead: "Domains group tasks and links by area of work.",
  },
};

// The board's "Add a status" box sends only a name; pick a colour for it.
const withColour = (kind: Kind, userId: number, f: Form): Form => (f.colour ? f : { ...f, colour: nextColour(kind, userId) });

const colourOptions = COLOURS.map((c) => ({ value: c, text: c[0].toUpperCase() + c.slice(1) }));

function kindOf(c: Ctx): Kind | undefined {
  const k = c.req.param("kind");
  return k === "statuses" || k === "domains" ? k : undefined;
}

function validate(kind: Kind, userId: number, f: Form, exceptId = 0): Errors {
  const errors: Errors = {};
  if (!f.name) errors.name = `Enter a name for the ${TEXT[kind].one}`;
  else if (f.name.length > 40) errors.name = "Name must be 40 characters or fewer";
  else if (nameTaken(kind, userId, f.name, exceptId)) errors.name = `You already have a ${TEXT[kind].one} called ${f.name}`;
  if (!isColour(f.colour ?? "")) errors.colour = "Select a colour";
  return errors;
}

function listPage(c: Ctx, kind: Kind, errors: Errors = {}, values: Form = {}) {
  const userId = c.get("user").id;
  const all = listCategories(kind, userId, true);
  const live = all.filter((x) => !x.archived_at);
  const archived = all.filter((x) => x.archived_at);
  const t = TEXT[kind];
  const Row = ({ x, i }: { x: Category; i: number }) => (
    <tr class="govuk-table__row">
      <td class="govuk-table__cell">
        <Tag colour={x.colour}>{x.name}</Tag>
      </td>
      {kind === "statuses" && <td class="govuk-table__cell">{x.is_closed ? "Closed" : "Open"}</td>}
      <td class="govuk-table__cell govuk-table__cell--numeric">{usage(kind, userId, x.id)}</td>
      <td class="govuk-table__cell lg-actions">
        {!x.archived_at && i > 0 && (
          <ActionForm action={`/settings/${kind}/${x.id}/move`} link hidden={{ dir: "-1" }}>
            Up<span class="govuk-visually-hidden"> {x.name}</span>
          </ActionForm>
        )}
        {!x.archived_at && i < live.length - 1 && (
          <ActionForm action={`/settings/${kind}/${x.id}/move`} link hidden={{ dir: "1" }}>
            Down<span class="govuk-visually-hidden"> {x.name}</span>
          </ActionForm>
        )}
        <a class="govuk-link" href={`/settings/${kind}/${x.id}`}>
          Change<span class="govuk-visually-hidden"> {x.name}</span>
        </a>
        {x.archived_at ? (
          <ActionForm action={`/settings/${kind}/${x.id}/restore`} link>
            Restore<span class="govuk-visually-hidden"> {x.name}</span>
          </ActionForm>
        ) : (
          <ActionForm action={`/settings/${kind}/${x.id}/archive`} link>
            Archive<span class="govuk-visually-hidden"> {x.name}</span>
          </ActionForm>
        )}
      </td>
    </tr>
  );
  const Head = () => (
    <thead class="govuk-table__head">
      <tr class="govuk-table__row">
        <th scope="col" class="govuk-table__header">Name</th>
        {kind === "statuses" && <th scope="col" class="govuk-table__header">Type</th>}
        <th scope="col" class="govuk-table__header govuk-table__header--numeric">Tasks</th>
        <th scope="col" class="govuk-table__header">
          <span class="govuk-visually-hidden">Actions</span>
        </th>
      </tr>
    </thead>
  );
  return page(
    c,
    { title: t.title, nav: "tasks", error: Object.keys(errors).length > 0 },
    <div class="govuk-grid-row">
      <div class="govuk-grid-column-two-thirds">
        <ErrorSummary errors={errors} />
        <span class="govuk-caption-l">Task board</span>
        <h1 class="govuk-heading-l">{t.title}</h1>
        <p class="govuk-body">{t.lead}</p>
        <table class="govuk-table">
          <Head />
          <tbody class="govuk-table__body">
            {live.map((x, i) => (
              <Row x={x} i={i} />
            ))}
          </tbody>
        </table>

        <h2 class="govuk-heading-m">Add a {t.one}</h2>
        <form method="post" action={`/settings/${kind}`} novalidate>
          <Input name="name" label="Name" value={values.name} error={errors.name} width="20" />
          <Select name="colour" label="Colour" options={colourOptions} value={values.colour ?? "grey"} error={errors.colour} />
          {kind === "statuses" && (
            <Checkbox name="closed" label="This status means the task is finished" checked={values.closed === "1"} />
          )}
          <Button variant="secondary">Add {t.one}</Button>
        </form>

        {archived.length > 0 && (
          <>
            <h2 class="govuk-heading-m">Archived</h2>
            <table class="govuk-table">
              <Head />
              <tbody class="govuk-table__body">
                {archived.map((x, i) => (
                  <Row x={x} i={i} />
                ))}
              </tbody>
            </table>
          </>
        )}
      </div>
    </div>,
  );
}

settingsRoutes.get("/:kind", (c) => {
  const kind = kindOf(c);
  return kind ? listPage(c, kind) : c.notFound();
});

settingsRoutes.post("/:kind", async (c) => {
  const kind = kindOf(c);
  if (!kind) return c.notFound();
  const user = c.get("user");
  const f = withColour(kind, user.id, await form(c));
  const errors = validate(kind, user.id, f);
  if (Object.keys(errors).length) {
    c.status(400);
    return listPage(c, kind, errors, f);
  }
  addCategory(kind, user.id, f.name, f.colour, f.closed === "1");
  audit(user.id, `${TEXT[kind].one} added`, f.name, c.get("ip"));
  flash(c, `${f.name} added`);
  return c.redirect(safeNext(f.back, `/settings/${kind}`));
});

function editPage(c: Ctx, kind: Kind, x: Category, errors: Errors = {}, values?: Form) {
  const v = values ?? { name: x.name, colour: x.colour, closed: x.is_closed ? "1" : "" };
  return page(
    c,
    { title: `Change ${x.name}`, nav: "tasks", error: Object.keys(errors).length > 0 },
    <div class="govuk-grid-row">
      <div class="govuk-grid-column-two-thirds">
        <BackLink href={`/settings/${kind}`} />
        <ErrorSummary errors={errors} />
        <span class="govuk-caption-l">{TEXT[kind].title}</span>
        <h1 class="govuk-heading-l">Change {x.name}</h1>
        <form method="post" action={`/settings/${kind}/${x.id}`} novalidate>
          <Input name="name" label="Name" value={v.name} error={errors.name} width="20" />
          <Select name="colour" label="Colour" options={colourOptions} value={v.colour} error={errors.colour} />
          {kind === "statuses" && <Checkbox name="closed" label="This status means the task is finished" checked={v.closed === "1"} />}
          <ButtonGroup>
            <Button>Save changes</Button>
            <a class="govuk-link" href={`/settings/${kind}`}>
              Cancel
            </a>
          </ButtonGroup>
        </form>
      </div>
    </div>,
  );
}

settingsRoutes.get("/:kind/:id", (c) => {
  const kind = kindOf(c);
  const x = kind && getCategory(kind, c.get("user").id, intParam(c));
  return kind && x ? editPage(c, kind, x) : c.notFound();
});

settingsRoutes.post("/:kind/:id", async (c) => {
  const kind = kindOf(c);
  const user = c.get("user");
  const x = kind && getCategory(kind, user.id, intParam(c));
  if (!kind || !x) return c.notFound();
  const f = await form(c);
  const errors = validate(kind, user.id, f, x.id);
  if (Object.keys(errors).length) {
    c.status(400);
    return editPage(c, kind, x, errors, f);
  }
  updateCategory(kind, user.id, x.id, f.name, f.colour, f.closed === "1");
  audit(user.id, `${TEXT[kind].one} changed`, f.name === x.name ? x.name : `${x.name} → ${f.name}`, c.get("ip"));
  flash(c, `${f.name} saved`);
  return c.redirect(`/settings/${kind}`);
});

settingsRoutes.post("/:kind/:id/move", async (c) => {
  const kind = kindOf(c);
  const user = c.get("user");
  const x = kind && getCategory(kind, user.id, intParam(c));
  if (!kind || !x) return c.notFound();
  const f = await form(c);
  moveCategory(kind, user.id, x.id, f.dir === "-1" ? -1 : 1);
  return c.redirect(`/settings/${kind}`);
});

settingsRoutes.post("/:kind/:id/archive", (c) => {
  const kind = kindOf(c);
  const user = c.get("user");
  const x = kind && getCategory(kind, user.id, intParam(c));
  if (!kind || !x) return c.notFound();
  if (kind === "statuses") {
    const n = usage(kind, user.id, x.id);
    const live = listCategories(kind, user.id).length;
    const problem =
      n > 0
        ? `Move the ${n} ${n === 1 ? "task" : "tasks"} in ${x.name} to another status before archiving it`
        : live <= 1
          ? "You need at least one status"
          : undefined;
    if (problem) {
      c.status(400);
      return listPage(c, kind, { name: problem });
    }
  }
  setArchived(kind, user.id, x.id, true);
  audit(user.id, `${TEXT[kind].one} archived`, x.name, c.get("ip"));
  flash(c, `${x.name} archived`);
  return c.redirect(`/settings/${kind}`);
});

settingsRoutes.post("/:kind/:id/restore", (c) => {
  const kind = kindOf(c);
  const user = c.get("user");
  const x = kind && getCategory(kind, user.id, intParam(c));
  if (!kind || !x) return c.notFound();
  if (nameTaken(kind, user.id, x.name, x.id)) {
    c.status(400);
    return listPage(c, kind, { name: `Rename the live ${TEXT[kind].one} called ${x.name} before restoring this one` });
  }
  setArchived(kind, user.id, x.id, false);
  audit(user.id, `${TEXT[kind].one} restored`, x.name, c.get("ip"));
  flash(c, `${x.name} restored`);
  return c.redirect(`/settings/${kind}`);
});
