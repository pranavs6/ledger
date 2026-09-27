import { Hono } from "hono";
import { audit } from "../auth.ts";
import { dayBounds, db, localDate } from "../db.ts";
import { step } from "../location/detector.ts";
import { type Fingerprint, describe, readFingerprint } from "../location/fingerprint.ts";
import {
  addNetwork,
  createPlace,
  deletePlace,
  getPlace,
  listPlaces,
  type Place,
  placeNameTaken,
  placeNetworks,
  placesForGateway,
  removeNetwork,
  renamePlace,
  setLogging,
  type Visit,
  visitMs,
  visits,
  weeklyTotals,
} from "../places.ts";
import {
  ActionForm,
  BackLink,
  Button,
  ButtonGroup,
  ButtonLink,
  Checkbox,
  ErrorSummary,
  type Errors,
  fmtDate,
  fmtDateTime,
  fmtDuration,
  fmtShortDate,
  fmtTime,
  Input,
  InsetText,
  Select,
  SummaryCard,
  SummaryList,
  Tag,
} from "../views/components.tsx";
import { type Ctx, type Env, type Form, flash, form, intParam, page } from "../web.tsx";

export const placeRoutes = new Hono<Env>();

/** Swappable so tests do not shell out to route/arp. */
export const network = { read: readFingerprint as () => Promise<Fingerprint> };

const LoggingTag = ({ p }: { p: Place }) =>
  p.logging_enabled ? <Tag colour="green">Logging on</Tag> : <Tag colour="grey">Logging off</Tag>;

function VisitsTable({ rows, showPlace }: { rows: Visit[]; showPlace?: boolean }) {
  return (
    <table class="govuk-table">
      <thead class="govuk-table__head">
        <tr class="govuk-table__row">
          {showPlace && <th scope="col" class="govuk-table__header">Place</th>}
          <th scope="col" class="govuk-table__header">Day</th>
          <th scope="col" class="govuk-table__header">Arrived</th>
          <th scope="col" class="govuk-table__header">Left</th>
          <th scope="col" class="govuk-table__header">Time there</th>
        </tr>
      </thead>
      <tbody class="govuk-table__body">
        {rows.map((v) => (
          <tr class="govuk-table__row">
            {showPlace && (
              <td class="govuk-table__cell">
                <a class="govuk-link" href={`/places/${v.place_id}`}>
                  {v.place_name}
                </a>
              </td>
            )}
            <td class="govuk-table__cell lg-nowrap">
              <a class="govuk-link" href={`/journal/day/${localDate(new Date(v.entered_at))}`}>
                {fmtDate(v.entered_at)}
              </a>
            </td>
            <td class="govuk-table__cell">{fmtTime(v.entered_at)}</td>
            <td class="govuk-table__cell">
              {v.exited_at ? (
                localDate(new Date(v.exited_at)) === localDate(new Date(v.entered_at)) ? (
                  fmtTime(v.exited_at)
                ) : (
                  fmtDateTime(v.exited_at)
                )
              ) : (
                <Tag colour="green">Here now</Tag>
              )}
            </td>
            <td class="govuk-table__cell">{fmtDuration(visitMs(v))}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

// ---------------------------------------------------------------- list

placeRoutes.get("/", async (c) => {
  const user = c.get("user");
  const fp = await network.read();
  const places = listPlaces(user.id);
  const matched = fp.gatewayMac ? placesForGateway(user.id, fp.gatewayMac) : [];
  const [from, to] = dayBounds(localDate());
  const todayMs = new Map<number, number>();
  for (const v of visits(user.id, { from, to })) todayMs.set(v.place_id, (todayMs.get(v.place_id) ?? 0) + visitMs(v, from, to));

  return page(
    c,
    { title: "My locations", nav: "places" },
    <>
      <div class="lg-title-row">
        <h1 class="govuk-heading-l">My locations</h1>
        <ButtonGroup>
          <ButtonLink href="/places/new">Add a place</ButtonLink>
          <ButtonLink href="/places/log" variant="secondary">
            Location log
          </ButtonLink>
        </ButtonGroup>
      </div>

      <div class="govuk-grid-row">
        <div class="govuk-grid-column-two-thirds">
          <InsetText>
            {!fp.gatewayMac ? (
              <>This Mac is not on a network right now.</>
            ) : matched.length ? (
              <>
                This Mac is at <strong>{matched.map((m) => m.name).join(", ")}</strong>, on {describe(fp)}.
              </>
            ) : (
              <>
                This Mac is on a network you have not added: {describe(fp)}.{" "}
                <a class="govuk-link" href="/places/new">
                  Add it as a new place
                </a>{" "}
                or open a place and choose ‘Add this network’.
              </>
            )}
          </InsetText>
          <p class="govuk-body-s lg-muted">
            Places are recognised by the router this Mac is connected to. Arrivals and departures are logged within about a minute, while
            this Mac is awake and Ledger is running.
          </p>
        </div>
      </div>

      {places.length === 0 ? (
        <p class="govuk-body">You have not added any places yet.</p>
      ) : (
        <table class="govuk-table">
          <thead class="govuk-table__head">
            <tr class="govuk-table__row">
              <th scope="col" class="govuk-table__header">Place</th>
              <th scope="col" class="govuk-table__header">Now</th>
              <th scope="col" class="govuk-table__header">Today</th>
              <th scope="col" class="govuk-table__header">Networks</th>
              <th scope="col" class="govuk-table__header">Logging</th>
            </tr>
          </thead>
          <tbody class="govuk-table__body">
            {places.map((p) => (
              <tr class="govuk-table__row">
                <td class="govuk-table__cell">
                  <a class="govuk-link" href={`/places/${p.id}`}>
                    {p.name}
                  </a>
                </td>
                <td class="govuk-table__cell">{p.here_since ? <Tag colour="green">Here since {fmtTime(p.here_since)}</Tag> : ""}</td>
                <td class="govuk-table__cell">{todayMs.get(p.id) ? fmtDuration(todayMs.get(p.id)!) : ""}</td>
                <td class="govuk-table__cell">{p.networks}</td>
                <td class="govuk-table__cell lg-actions">
                  <LoggingTag p={p} />
                  <ActionForm action={`/places/${p.id}/logging`} link hidden={{ on: p.logging_enabled ? "0" : "1", back: "/places" }}>
                    {p.logging_enabled ? "Turn off" : "Turn on"}
                    <span class="govuk-visually-hidden"> logging for {p.name}</span>
                  </ActionForm>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </>,
  );
});

// ---------------------------------------------------------------- log

placeRoutes.get("/log", (c) => {
  const user = c.get("user");
  const places = listPlaces(user.id);
  const placeId = Number(c.req.query("place")) || undefined;
  const rows = visits(user.id, { placeId, limit: 300 });
  return page(
    c,
    { title: "Location log", nav: "places" },
    <>
      <BackLink href="/places" text="My locations" />
      <h1 class="govuk-heading-l">Location log</h1>
      <form method="get" action="/places/log" class="lg-filters">
        <Select
          name="place"
          label="Place"
          value={placeId ? String(placeId) : ""}
          options={[{ value: "", text: "All places" }, ...places.map((p) => ({ value: String(p.id), text: p.name }))]}
        />
        <Button variant="secondary">Apply</Button>
      </form>
      {rows.length === 0 ? <p class="govuk-body">No visits logged yet.</p> : <VisitsTable rows={rows} showPlace />}
    </>,
  );
});

// ---------------------------------------------------------------- add / rename

function validateName(userId: number, f: Form, exceptId = 0): Errors {
  const errors: Errors = {};
  if (!f.name) errors.name = "Enter a name for the place";
  else if (f.name.length > 60) errors.name = "Name must be 60 characters or fewer";
  else if (placeNameTaken(userId, f.name, exceptId)) errors.name = `You already have a place called ${f.name}`;
  return errors;
}

async function newPlacePage(c: Ctx, values: Form = { add_network: "1" }, errors: Errors = {}) {
  const fp = await network.read();
  return page(
    c,
    { title: "Add a place", nav: "places", error: Object.keys(errors).length > 0 },
    <div class="govuk-grid-row">
      <div class="govuk-grid-column-two-thirds">
        <BackLink href="/places" />
        <ErrorSummary errors={errors} />
        <span class="govuk-caption-l">My locations</span>
        <h1 class="govuk-heading-l">Add a place</h1>
        <form method="post" action="/places" novalidate>
          <Input name="name" label="Name" hint="For example, Office, Home or Client site" value={values.name} error={errors.name} width="20" />
          {fp.gatewayMac ? (
            <Checkbox
              name="add_network"
              label="This Mac is here now: add its current network"
              hint={describe(fp)}
              checked={values.add_network === "1"}
            />
          ) : (
            <p class="govuk-body">This Mac is not on a network, so you will need to add one from the place’s page when you are there.</p>
          )}
          <Button>Add place</Button>
        </form>
      </div>
    </div>,
  );
}

placeRoutes.get("/new", (c) => newPlacePage(c));

placeRoutes.post("/", async (c) => {
  const user = c.get("user");
  const f = await form(c);
  const errors = validateName(user.id, f);
  if (Object.keys(errors).length) {
    c.status(400);
    return newPlacePage(c, f, errors);
  }
  const id = createPlace(user.id, f.name);
  if (f.add_network === "1") {
    const fp = await network.read();
    if (addNetwork(id, fp, fp.ssid ?? fp.dnsDomain ?? `${f.name} network`)) step(db(), new Date(), fp);
  }
  audit(user.id, "place added", f.name, c.get("ip"));
  flash(c, `${f.name} added`);
  return c.redirect(`/places/${id}`);
});

// ---------------------------------------------------------------- one place

placeRoutes.get("/:id", async (c) => {
  const user = c.get("user");
  const p = getPlace(user.id, intParam(c));
  if (!p) return c.notFound();
  const nets = placeNetworks(p.id);
  const fp = await network.read();
  const hasCurrent = !!fp.gatewayMac && nets.some((n) => n.gateway_mac === fp.gatewayMac);
  const weeks = weeklyTotals(user.id, p.id);
  const recent = visits(user.id, { placeId: p.id, limit: 20 });

  return page(
    c,
    { title: p.name, nav: "places" },
    <div class="govuk-grid-row">
      <div class="govuk-grid-column-two-thirds">
        <BackLink href="/places" text="My locations" />
        <span class="govuk-caption-l">My locations</span>
        <h1 class="govuk-heading-l">{p.name}</h1>

        <SummaryList
          rows={[
            { key: "Name", value: p.name, action: { href: `/places/${p.id}/edit`, text: "Change" } },
            { key: "Logging", value: <LoggingTag p={p} /> },
            { key: "Now", value: p.here_since ? `Here since ${fmtDateTime(p.here_since)}` : "Not here" },
          ]}
        />
        <ActionForm action={`/places/${p.id}/logging`} variant="secondary" hidden={{ on: p.logging_enabled ? "0" : "1" }}>
          {p.logging_enabled ? "Turn off entry and exit logging" : "Turn on entry and exit logging"}
        </ActionForm>

        <h2 class="govuk-heading-m">Networks</h2>
        {nets.length === 0 ? (
          <p class="govuk-body">No networks yet. Ledger cannot tell when you are here until you add one.</p>
        ) : (
          <table class="govuk-table">
            <thead class="govuk-table__head">
              <tr class="govuk-table__row">
                <th scope="col" class="govuk-table__header">Network</th>
                <th scope="col" class="govuk-table__header">Router</th>
                <th scope="col" class="govuk-table__header">
                  <span class="govuk-visually-hidden">Actions</span>
                </th>
              </tr>
            </thead>
            <tbody class="govuk-table__body">
              {nets.map((n) => (
                <tr class="govuk-table__row">
                  <td class="govuk-table__cell">
                    {n.label || n.ssid || `${p.name} network`} {n.gateway_mac === fp.gatewayMac && <Tag colour="green">Connected</Tag>}
                  </td>
                  <td class="govuk-table__cell">
                    <code class="lg-code">{n.gateway_mac}</code>
                  </td>
                  <td class="govuk-table__cell">
                    <ActionForm action={`/places/${p.id}/networks/${n.id}/delete`} link>
                      Remove<span class="govuk-visually-hidden"> {n.label || n.gateway_mac}</span>
                    </ActionForm>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
        {fp.gatewayMac && !hasCurrent && (
          <form method="post" action={`/places/${p.id}/networks`}>
            <Input
              name="label"
              label="Add this network"
              hint={`This Mac is on ${describe(fp)}. Only add it if you are at ${p.name} now.`}
              value={fp.ssid ?? fp.dnsDomain ?? `${p.name} network`}
              width="20"
            />
            <Button variant="secondary">Add this network</Button>
          </form>
        )}

        <h2 class="govuk-heading-m">Recent visits</h2>
        {recent.length === 0 ? <p class="govuk-body">No visits logged yet.</p> : <VisitsTable rows={recent} />}
        <p class="govuk-body">
          <a class="govuk-link" href={`/places/log?place=${p.id}`}>
            See all visits to {p.name}
          </a>
        </p>

        <p class="govuk-body">
          <a class="govuk-link lg-link--warning" href={`/places/${p.id}/delete`}>
            Delete this place
          </a>
        </p>
      </div>

      <div class="govuk-grid-column-one-third">
        <SummaryCard title="Hours by week">
          <SummaryList
            noBorder
            rows={weeks.map(([start, ms]) => ({ key: `Week of ${fmtShortDate(start)}`, value: ms ? fmtDuration(ms) : "None" }))}
          />
        </SummaryCard>
      </div>
    </div>,
  );
});

placeRoutes.post("/:id/logging", async (c) => {
  const user = c.get("user");
  const p = getPlace(user.id, intParam(c));
  if (!p) return c.notFound();
  const f = await form(c);
  const on = f.on === "1";
  setLogging(user.id, p.id, on);
  audit(user.id, on ? "logging on" : "logging off", p.name, c.get("ip"));
  flash(c, `Logging turned ${on ? "on" : "off"} for ${p.name}`);
  return c.redirect(f.back === "/places" ? "/places" : `/places/${p.id}`);
});

placeRoutes.post("/:id/networks", async (c) => {
  const user = c.get("user");
  const p = getPlace(user.id, intParam(c));
  if (!p) return c.notFound();
  const f = await form(c);
  const fp = await network.read();
  if (!addNetwork(p.id, fp, (f.label ?? "").slice(0, 60))) {
    flash(c, "This Mac is not on a network, so nothing was added");
    return c.redirect(`/places/${p.id}`);
  }
  step(db(), new Date(), fp);
  audit(user.id, "network added", `${p.name}: ${fp.gatewayMac}`, c.get("ip"));
  flash(c, `Network added to ${p.name}`);
  return c.redirect(`/places/${p.id}`);
});

placeRoutes.post("/:id/networks/:nid/delete", (c) => {
  const user = c.get("user");
  const p = getPlace(user.id, intParam(c));
  if (!p) return c.notFound();
  removeNetwork(p.id, intParam(c, "nid"));
  audit(user.id, "network removed", p.name, c.get("ip"));
  flash(c, `Network removed from ${p.name}`);
  return c.redirect(`/places/${p.id}`);
});

function renamePage(c: Ctx, p: Place, values: Form, errors: Errors = {}) {
  return page(
    c,
    { title: `Change ${p.name}`, nav: "places", error: Object.keys(errors).length > 0 },
    <div class="govuk-grid-row">
      <div class="govuk-grid-column-two-thirds">
        <BackLink href={`/places/${p.id}`} />
        <ErrorSummary errors={errors} />
        <form method="post" action={`/places/${p.id}`} novalidate>
          <Input name="name" label="What is this place called?" heading value={values.name} error={errors.name} width="20" />
          <ButtonGroup>
            <Button>Save</Button>
            <a class="govuk-link" href={`/places/${p.id}`}>
              Cancel
            </a>
          </ButtonGroup>
        </form>
      </div>
    </div>,
  );
}

placeRoutes.get("/:id/edit", (c) => {
  const p = getPlace(c.get("user").id, intParam(c));
  return p ? renamePage(c, p, { name: p.name }) : c.notFound();
});

placeRoutes.post("/:id", async (c) => {
  const user = c.get("user");
  const p = getPlace(user.id, intParam(c));
  if (!p) return c.notFound();
  const f = await form(c);
  const errors = validateName(user.id, f, p.id);
  if (Object.keys(errors).length) {
    c.status(400);
    return renamePage(c, p, f, errors);
  }
  renamePlace(user.id, p.id, f.name);
  audit(user.id, "place renamed", `${p.name} → ${f.name}`, c.get("ip"));
  flash(c, "Place saved");
  return c.redirect(`/places/${p.id}`);
});

placeRoutes.get("/:id/delete", (c) => {
  const p = getPlace(c.get("user").id, intParam(c));
  if (!p) return c.notFound();
  return page(
    c,
    { title: `Delete ${p.name}`, nav: "places" },
    <div class="govuk-grid-row">
      <div class="govuk-grid-column-two-thirds">
        <BackLink href={`/places/${p.id}`} />
        <h1 class="govuk-heading-l">Are you sure you want to delete {p.name}?</h1>
        <p class="govuk-body">Ledger will stop logging visits here. Visits already logged stay in the location log.</p>
        <form method="post" action={`/places/${p.id}/delete`}>
          <ButtonGroup>
            <Button variant="warning">Yes, delete place</Button>
            <a class="govuk-link" href={`/places/${p.id}`}>
              No, keep it
            </a>
          </ButtonGroup>
        </form>
      </div>
    </div>,
  );
});

placeRoutes.post("/:id/delete", (c) => {
  const user = c.get("user");
  const p = getPlace(user.id, intParam(c));
  if (!p) return c.notFound();
  deletePlace(user.id, p.id);
  audit(user.id, "place deleted", p.name, c.get("ip"));
  flash(c, `${p.name} deleted`);
  return c.redirect("/places");
});
