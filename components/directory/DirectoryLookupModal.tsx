"use client";

import { useMemo, useState } from "react";
import { Input } from "@/components/ui/Input";
import { Modal } from "@/components/ui/Modal";
import { Button } from "@/components/ui/Button";

export function DirectoryLookupModal<
  T extends { syncKey: string },
>({
  open,
  title,
  description,
  rows,
  onClose,
  onSelect,
  filter,
  renderRow,
}: {
  open: boolean;
  title: string;
  description: string;
  rows: T[];
  onClose: () => void;
  onSelect: (row: T) => void;
  filter: (row: T, query: string) => boolean;
  renderRow: (row: T) => { primary: string; secondary: string };
}) {
  const [query, setQuery] = useState("");
  const matches = useMemo(() => {
    const q = query.trim();
    if (!q) return rows.slice(0, 50);
    return rows.filter((r) => filter(r, q)).slice(0, 50);
  }, [rows, query, filter]);

  return (
    <Modal
      open={open}
      title={title}
      onClose={() => {
        setQuery("");
        onClose();
      }}
      maxWidthClass="max-w-xl"
      footer={
        <Button variant="secondary" type="button" onClick={onClose}>
          Cancel
        </Button>
      }
    >
      <div className="space-y-3">
        <p className="text-sm text-muted">{description}</p>
        <Input
          id="directory-lookup-q"
          label="Search"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Name, email, or last 4 of phone"
          autoComplete="off"
        />
        <ul className="max-h-72 divide-y divide-navy/10 overflow-y-auto rounded-lg border border-navy/10 dark:divide-slate-700 dark:border-slate-700">
          {matches.length === 0 ? (
            <li className="px-3 py-6 text-center text-sm text-muted">
              No matching people.
            </li>
          ) : (
            matches.map((row) => {
              const { primary, secondary } = renderRow(row);
              return (
                <li key={row.syncKey}>
                  <button
                    type="button"
                    className="flex w-full flex-col items-start gap-0.5 px-3 py-2 text-left hover:bg-surface/80 dark:hover:bg-slate-800"
                    onClick={() => {
                      onSelect(row);
                      setQuery("");
                    }}
                  >
                    <span className="text-sm font-medium text-ink dark:text-slate-100">
                      {primary}
                    </span>
                    {secondary ? (
                      <span className="text-xs text-muted">{secondary}</span>
                    ) : null}
                  </button>
                </li>
              );
            })
          )}
        </ul>
      </div>
    </Modal>
  );
}
