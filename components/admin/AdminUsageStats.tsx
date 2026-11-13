import type { ReactNode } from "react";
import { Card } from "@/components/ui/Card";
import type { AdminUsageStats } from "@/lib/admin/usageStats";

const nf = new Intl.NumberFormat("en-US");

function Tile({
  label,
  value,
  hint,
}: {
  label: string;
  value: number;
  hint?: string;
}) {
  return (
    <Card className="p-4">
      <div className="text-xs font-medium uppercase tracking-wide text-muted">
        {label}
      </div>
      <div className="mt-1 text-2xl font-bold tabular-nums text-ink dark:text-slate-100">
        {nf.format(value)}
      </div>
      {hint ? <div className="mt-0.5 text-xs text-muted">{hint}</div> : null}
    </Card>
  );
}

function SectionCard({
  title,
  subtitle,
  children,
}: {
  title: string;
  subtitle?: string;
  children: ReactNode;
}) {
  return (
    <Card className="p-4">
      <h3 className="text-sm font-semibold text-ink dark:text-slate-100">
        {title}
      </h3>
      {subtitle ? <p className="mt-0.5 text-xs text-muted">{subtitle}</p> : null}
      <div className="mt-4">{children}</div>
    </Card>
  );
}

/** Column chart. Heights are relative to the largest value; zero stays a hairline. */
function Columns({
  items,
  unit,
}: {
  items: { key: string; label: string; value: number }[];
  unit: string;
}) {
  const max = Math.max(1, ...items.map((i) => i.value));
  const first = items[0];
  const last = items[items.length - 1];
  return (
    <div>
      <div
        className="flex h-28 items-end gap-0.5"
        role="img"
        aria-label={`${unit} by period, ${first?.label ?? ""} to ${last?.label ?? ""}. Peak ${nf.format(max)}.`}
      >
        {items.map((i) => (
          <div
            key={i.key}
            className="flex h-full min-w-0 flex-1 items-end"
            title={`${i.label}: ${nf.format(i.value)} ${unit}`}
          >
            <div
              className={`w-full rounded-t-sm ${
                i.value > 0
                  ? "bg-navy dark:bg-sky-400"
                  : "bg-navy/15 dark:bg-slate-700"
              }`}
              style={{
                height: i.value > 0 ? `${Math.max(4, (i.value / max) * 100)}%` : "2px",
              }}
            />
          </div>
        ))}
      </div>
      <div className="mt-1 flex justify-between text-[11px] text-muted">
        <span>{first?.label}</span>
        <span>peak {nf.format(max)}</span>
        <span>{last?.label}</span>
      </div>
    </div>
  );
}

function RankedList({
  rows,
  empty,
}: {
  rows: { key: string; label: string; detail?: string; value: number }[];
  empty: string;
}) {
  if (rows.length === 0) return <p className="text-sm text-muted">{empty}</p>;
  const max = Math.max(1, ...rows.map((r) => r.value));
  return (
    <ol className="space-y-2">
      {rows.map((r) => (
        <li key={r.key}>
          <div className="flex items-baseline justify-between gap-3 text-sm">
            <span className="min-w-0 truncate text-ink dark:text-slate-200">
              {r.label}
              {r.detail ? (
                <span className="ml-2 text-xs text-muted">{r.detail}</span>
              ) : null}
            </span>
            <span className="tabular-nums text-muted">{nf.format(r.value)}</span>
          </div>
          <div className="mt-1 h-1.5 rounded-full bg-navy/10 dark:bg-slate-700">
            <div
              className="h-full rounded-full bg-navy dark:bg-sky-400"
              style={{ width: `${(r.value / max) * 100}%` }}
            />
          </div>
        </li>
      ))}
    </ol>
  );
}

const shortDay = (iso: string) => {
  const [, m, d] = iso.split("-");
  return `${Number(m)}/${Number(d)}`;
};

export function AdminUsageStats({ stats }: { stats: AdminUsageStats }) {
  const { totals, content, activity, roles, signupsByWeek, opsByDay, topOrgs, topOpTypes } =
    stats;

  return (
    <section className="mt-6" aria-labelledby="usage-heading">
      <h2
        id="usage-heading"
        className="text-sm font-semibold text-ink dark:text-slate-100"
      >
        Usage
      </h2>
      <p className="mt-1 text-xs text-muted">
        &ldquo;Active&rdquo; means the user pushed a change or a cloud backup to
        the server; it does not include time spent offline or signing in. Days
        and weeks are UTC.
      </p>

      {stats.failedSections.length > 0 ? (
        <Card className="mt-3 border-amber-200 bg-amber-50 p-3 text-xs text-amber-900 dark:border-amber-900/50 dark:bg-amber-950/30 dark:text-amber-100">
          Some sections could not be loaded ({stats.failedSections.join(", ")}).
          Check the server logs for <code>[admin/usageStats]</code>.
        </Card>
      ) : null}

      <div className="mt-3 grid grid-cols-2 gap-3 md:grid-cols-4">
        {totals ? (
          <>
            <Tile
              label="Users"
              value={totals.users}
              hint={`+${nf.format(totals.signups7d)} in 7 days · +${nf.format(totals.signups30d)} in 30`}
            />
            <Tile label="Organizations" value={totals.orgs} />
          </>
        ) : null}
        {activity ? (
          <>
            <Tile
              label="Active orgs (7 days)"
              value={activity.activeOrgs7d}
              hint={`${nf.format(activity.activeOrgs30d)} in 30 days`}
            />
            <Tile
              label="Active users (7 days)"
              value={activity.activeUsers7d}
              hint={`${nf.format(activity.activeUsers30d)} in 30 days`}
            />
          </>
        ) : null}
        {content ? (
          <>
            <Tile label="Synced events" value={content.syncedEvents} />
            <Tile label="Lots" value={content.lots} />
            <Tile label="Bidders" value={content.bidders} />
            <Tile
              label="Sales"
              value={content.sales}
              hint={`${nf.format(content.invoices)} invoices`}
            />
          </>
        ) : null}
      </div>

      <div className="mt-3 grid gap-3 lg:grid-cols-2">
        {opsByDay ? (
          <SectionCard
            title="Changes synced per day"
            subtitle="Last 30 days, all organizations"
          >
            <Columns
              unit="changes"
              items={opsByDay.map((d) => ({
                key: d.day,
                label: shortDay(d.day),
                value: d.ops,
              }))}
            />
          </SectionCard>
        ) : null}
        {signupsByWeek ? (
          <SectionCard
            title="New users per week"
            subtitle="Last 12 weeks, weeks start Monday"
          >
            <Columns
              unit="signups"
              items={signupsByWeek.map((w) => ({
                key: w.weekStart,
                label: shortDay(w.weekStart),
                value: w.count,
              }))}
            />
          </SectionCard>
        ) : null}
        {topOrgs ? (
          <SectionCard
            title="Busiest organizations"
            subtitle="Changes synced in the last 30 days"
          >
            <RankedList
              empty="No synced changes in the last 30 days."
              rows={topOrgs.map((o) => ({
                key: String(o.vendorId),
                label: o.name,
                detail: `${o.members} ${o.members === 1 ? "member" : "members"}`,
                value: o.ops30d,
              }))}
            />
          </SectionCard>
        ) : null}
        {topOpTypes || roles ? (
          <SectionCard title="What people are doing">
            {topOpTypes ? (
              <RankedList
                empty="No synced changes in the last 30 days."
                rows={topOpTypes.map((t) => ({
                  key: t.opType,
                  label: t.opType,
                  value: t.count,
                }))}
              />
            ) : null}
            {roles ? (
              <p className="mt-4 text-xs text-muted">
                Roles:{" "}
                {roles.map((r) => `${nf.format(r.count)} ${r.role}`).join(" · ")}
              </p>
            ) : null}
          </SectionCard>
        ) : null}
      </div>
    </section>
  );
}
