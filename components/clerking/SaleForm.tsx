"use client";

import {
  useCallback,
  useEffect,
  useRef,
  useState,
  useSyncExternalStore,
  type ReactNode,
} from "react";
import { useLiveQuery } from "dexie-react-hooks";
import { useUserDb } from "@/components/providers/UserDbProvider";
import type { AuctionDB, Lot, Sale } from "@/lib/db";
import { liveQueryGuard } from "@/lib/dexie/liveQueryGuard";
import { formatConsignorDisplayLabel } from "@/lib/services/consignorCommission";
import { findLotByEventBaseAndSuffix } from "@/lib/clerking/findLotByBaseSuffix";
import {
  formatLotDisplayFromInput,
  lotDisplayBaseDigits,
  parseLotDisplay,
} from "@/lib/clerking/lotParse";
import {
  computeNewPassOutLotSuffix,
  nextPassOutLineDisplay,
} from "@/lib/clerking/passOutDb";
import { getNextSuggestedLotDisplay } from "@/lib/clerking/nextBaseLot";
import { Input } from "@/components/ui/Input";
import { Button } from "@/components/ui/Button";
import { PassOutCheckbox } from "./PassOutCheckbox";
import { useToast } from "@/components/providers/ToastProvider";
import { useCloudSync } from "@/components/providers/CloudSyncProvider";
import { formatCurrency } from "@/lib/utils/formatCurrency";
import {
  attachUnallocatedSalesToUnpaidInvoice,
  roundMoney,
} from "@/lib/services/invoiceLogic";
import { mutateWithEventTables } from "@/lib/db/mutateWithParentEventTouch";
import { newEntitySyncKey } from "@/lib/utils/clientSyncKey";
import { enqueueSalePut } from "@/lib/sync/ops/enqueueOps";
import {
  readSuggestNextLot,
  subscribeSuggestNextLot,
  writeSuggestNextLot,
} from "@/lib/clerkFormPrefs";
import {
  isNarrowSaleField,
  readSaleFormPrefs,
  SALE_FIELD_ORDER_CHANGED,
  SERVER_DEFAULT_SALE_FORM_PREFS,
  type SaleFieldId,
  tabOrderHelpFragment,
} from "@/lib/saleFormOrder";

const CLERK_KEY = "clerkbid:clerkInitials";

function stickyConsignorStorageKey(eventId: number) {
  return `clerkbid:stickyConsignor:${eventId}`;
}

type StickyConsignor = { label: string; linkedId: number | null };

function readStickyConsignor(eventId: number): StickyConsignor | null {
  try {
    const raw = sessionStorage.getItem(stickyConsignorStorageKey(eventId));
    if (!raw) return null;
    const parsed = JSON.parse(raw) as StickyConsignor;
    if (typeof parsed?.label !== "string") return null;
    return {
      label: parsed.label,
      linkedId: typeof parsed.linkedId === "number" ? parsed.linkedId : null,
    };
  } catch {
    return null;
  }
}

function writeStickyConsignor(
  eventId: number,
  label: string,
  linkedId: number | null
) {
  try {
    if (!label.trim() && linkedId == null) {
      sessionStorage.removeItem(stickyConsignorStorageKey(eventId));
      return;
    }
    sessionStorage.setItem(
      stickyConsignorStorageKey(eventId),
      JSON.stringify({ label, linkedId })
    );
  } catch {
    /* ignore */
  }
}

function clearStickyConsignor(eventId: number) {
  try {
    sessionStorage.removeItem(stickyConsignorStorageKey(eventId));
  } catch {
    /* ignore */
  }
}

function subscribeSaleFieldOrder(onStoreChange: () => void) {
  const fn = () => onStoreChange();
  if (typeof window !== "undefined") {
    window.addEventListener(SALE_FIELD_ORDER_CHANGED, fn);
    window.addEventListener("storage", fn);
    return () => {
      window.removeEventListener(SALE_FIELD_ORDER_CHANGED, fn);
      window.removeEventListener("storage", fn);
    };
  }
  return () => {};
}

async function patchLotWithConsignor(
  db: AuctionDB,
  lotId: number,
  patch: Pick<
    Lot,
    "description" | "consignor" | "notes" | "quantity" | "status" | "updatedAt"
  >,
  consignorId: number | null
): Promise<void> {
  const cur = await db.lots.get(lotId);
  if (!cur) return;
  const next: Lot = { ...cur, ...patch };
  if (consignorId != null) next.consignorId = consignorId;
  else delete next.consignorId;
  await db.lots.put(next);
}

export function SaleForm({
  eventId,
  currencySymbol,
  buyersPremiumRate = 0,
}: {
  eventId: number;
  currencySymbol: string;
  buyersPremiumRate?: number;
}) {
  const { db } = useUserDb();
  const { showToast } = useToast();
  const { scheduleCloudPush } = useCloudSync();
  const [lotNumber, setLotNumber] = useState("");
  const [title, setTitle] = useState("");
  const [consignor, setConsignor] = useState("");
  const [linkedConsignorId, setLinkedConsignorId] = useState<number | null>(
    null
  );
  const [lotNotes, setLotNotes] = useState("");
  const [quantity, setQuantity] = useState("1");
  const [sellPrice, setSellPrice] = useState("");
  const [paddleNumber, setPaddleNumber] = useState("");
  const [clerkInitials, setClerkInitials] = useState("");
  const [passOutEnabled, setPassOutEnabled] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);

  const fieldRefs = useRef<Partial<Record<SaleFieldId, HTMLElement | null>>>(
    {}
  );
  const lotAutofillDebounceRef = useRef<ReturnType<typeof setTimeout> | null>(
    null
  );

  const saleFormPrefs = useSyncExternalStore(
    subscribeSaleFieldOrder,
    readSaleFormPrefs,
    () => SERVER_DEFAULT_SALE_FORM_PREFS
  );
  const fieldOrder = saleFormPrefs.order;
  const fieldRequired = saleFormPrefs.required;

  const suggestNextLotEnabled = useSyncExternalStore(
    subscribeSuggestNextLot,
    readSuggestNextLot,
    () => true
  );

  const consignors = useLiveQuery(
    async () =>
      liveQueryGuard("saleForm.consignors", async () => {
        if (!db) return [];
        return db.consignors
          .where("eventId")
          .equals(eventId)
          .sortBy("consignorNumber");
      }, []),
    [db, eventId]
  );

  const focusField = useCallback((id: SaleFieldId) => {
    const el = fieldRefs.current[id];
    requestAnimationFrame(() => el?.focus());
  }, []);

  const refreshLotSuggestion = useCallback(
    async (afterSoldDisplay?: string) => {
      if (!readSuggestNextLot()) {
        setLotNumber("");
        return;
      }
      if (!db) return;
      const next = await getNextSuggestedLotDisplay(
        db,
        eventId,
        afterSoldDisplay ? { afterSoldDisplay } : undefined
      );
      setLotNumber(next);
    },
    [db, eventId]
  );

  useEffect(() => {
    let cancelled = false;
    (async () => {
      let initials = "";
      try {
        initials = sessionStorage.getItem(CLERK_KEY) ?? "";
      } catch {
        /* ignore */
      }
      if (cancelled) return;
      setClerkInitials(initials);
      await refreshLotSuggestion();
      setTitle("");
      const sticky = readStickyConsignor(eventId);
      if (sticky && (sticky.label.trim() || sticky.linkedId != null)) {
        setConsignor(sticky.label);
        setLinkedConsignorId(sticky.linkedId);
      } else {
        setConsignor("");
        setLinkedConsignorId(null);
      }
      setLotNotes("");
      setQuantity("1");
      setSellPrice("");
      setPaddleNumber("");
      setPassOutEnabled(false);
      setFormError(null);
    })();
    return () => {
      cancelled = true;
    };
  }, [eventId, refreshLotSuggestion]);

  useEffect(() => {
    return () => {
      if (lotAutofillDebounceRef.current != null) {
        clearTimeout(lotAutofillDebounceRef.current);
        lotAutofillDebounceRef.current = null;
      }
    };
  }, []);

  const priceRaw = sellPrice.trim().replace(/[^0-9.-]/g, "");
  const unitHammerPreview = parseFloat(priceRaw);
  const qtyPreview = Math.max(1, parseInt(quantity.trim(), 10) || 1);
  const lineHammerPreview =
    Number.isFinite(unitHammerPreview) && unitHammerPreview >= 0
      ? roundMoney(unitHammerPreview * qtyPreview)
      : NaN;
  const bpPreview =
    buyersPremiumRate > 0 &&
    Number.isFinite(lineHammerPreview) &&
    lineHammerPreview >= 0
      ? roundMoney(lineHammerPreview * (1 + buyersPremiumRate))
      : null;

  async function autofillFromLot(lotFieldRaw?: string) {
    if (!db) return;
    const raw = lotFieldRaw ?? lotNumber;
    const parsed = parseLotDisplay(raw);
    if (!parsed) return;
    const lot = await findLotByEventBaseAndSuffix(
      db,
      eventId,
      parsed.base,
      parsed.suffix
    );
    if (lot) {
      setTitle(lot.description);
      setQuantity(String(lot.quantity));
      setLotNotes(lot.notes ?? "");
      // Only overwrite sticky consignor when the lot already has one.
      if (lot.consignorId != null) {
        const c = await db.consignors.get(lot.consignorId);
        if (c?.id != null) {
          const label = formatConsignorDisplayLabel(c);
          setLinkedConsignorId(c.id);
          setConsignor(label);
          writeStickyConsignor(eventId, label, c.id);
        } else if (lot.consignor?.trim()) {
          setLinkedConsignorId(null);
          setConsignor(lot.consignor);
          writeStickyConsignor(eventId, lot.consignor, null);
        }
      } else if (lot.consignor?.trim()) {
        setLinkedConsignorId(null);
        setConsignor(lot.consignor);
        writeStickyConsignor(eventId, lot.consignor, null);
      }
    }
  }

  async function resetAfterEscape() {
    setPassOutEnabled(false);
    setFormError(null);
    setTitle("");
    setConsignor("");
    setLinkedConsignorId(null);
    clearStickyConsignor(eventId);
    setLotNotes("");
    setQuantity("1");
    setSellPrice("");
    setPaddleNumber("");
    await refreshLotSuggestion();
    focusField("lot");
  }

  async function passLotNoSale() {
    if (!db) return;
    setFormError(null);

    const parsed = parseLotDisplay(lotNumber);
    if (!parsed) {
      setFormError("Enter a valid lot number to pass (e.g. 1 or 1A).");
      return;
    }

    const initialsRaw = clerkInitials.trim().toUpperCase().slice(0, 3);
    if (fieldRequired.initials && initialsRaw.length < 2) {
      setFormError("Clerk initials are required (2–3 characters).");
      return;
    }
    const initials = initialsRaw;

    const existingLot = await findLotByEventBaseAndSuffix(
      db,
      eventId,
      parsed.base,
      parsed.suffix
    );

    if (existingLot?.id == null) {
      setFormError(
        "No catalog lot matches that number. Import or add the lot first."
      );
      return;
    }

    if (existingLot.status === "withdrawn") {
      setFormError("Cannot pass — lot is withdrawn.");
      return;
    }

    if (existingLot.status === "sold") {
      setFormError("Cannot pass — lot is already marked sold.");
      return;
    }

    const salesCount = await db.sales
      .where("lotId")
      .equals(existingLot.id)
      .count();
    if (salesCount > 0) {
      setFormError("Cannot pass — this lot has a sale recorded.");
      return;
    }

    const displayStr =
      formatLotDisplayFromInput(lotNumber) ?? existingLot.displayLotNumber;
    const titleTrim = title.trim();
    const notesTrim = lotNotes.trim();
    const consignorTrim = consignor.trim();
    const qty = Math.max(1, parseInt(quantity.trim(), 10) || 1);
    const now = new Date();

    await patchLotWithConsignor(
      db,
      existingLot.id,
      {
        status: "passed",
        description: titleTrim || existingLot.description,
        consignor: consignorTrim || undefined,
        notes: notesTrim || undefined,
        quantity: qty,
        updatedAt: now,
      },
      linkedConsignorId
    );

    try {
      sessionStorage.setItem(CLERK_KEY, initials);
    } catch {
      /* ignore */
    }

    showToast({
      kind: "success",
      message: `Lot ${displayStr} marked passed (no sale).`,
    });
    scheduleCloudPush();

    setPassOutEnabled(false);
    setTitle("");
    // Keep consignor sticky between lots (Escape clears it).
    writeStickyConsignor(eventId, consignor, linkedConsignorId);
    setLotNotes("");
    setQuantity("1");
    setSellPrice("");
    setPaddleNumber("");

    await refreshLotSuggestion(displayStr);
    focusField("lot");
  }

  async function submitSale(shiftEnter: boolean) {
    if (!db) return;
    setFormError(null);
    const passOutActive = passOutEnabled || shiftEnter;
    if (shiftEnter) {
      setPassOutEnabled(true);
    }

    const titleTrim = title.trim();
    let parsed = parseLotDisplay(lotNumber);
    let lotInputForDisplay = lotNumber;

    if (fieldRequired.lot) {
      if (!parsed) {
        setFormError("Enter a valid lot number (e.g. 1 or 1A).");
        return;
      }
    } else if (lotNumber.trim() !== "") {
      if (!parsed) {
        setFormError(
          "Enter a valid lot number, or leave blank to use the suggested next lot."
        );
        return;
      }
    } else {
      if (!titleTrim) {
        setFormError(
          "Description / title is required when lot is left blank."
        );
        return;
      }
      const suggested = await getNextSuggestedLotDisplay(db, eventId);
      const p2 = parseLotDisplay(suggested);
      if (!p2) {
        setFormError("Could not assign a lot number. Enter a lot manually.");
        return;
      }
      parsed = p2;
      lotInputForDisplay = suggested;
    }

    if (fieldRequired.description && !titleTrim) {
      setFormError("Description / title is required.");
      return;
    }

    const priceRawInner = sellPrice.trim().replace(/[^0-9.-]/g, "");
    let unitHammer: number;
    if (!fieldRequired.price && priceRawInner === "") {
      unitHammer = 0;
    } else {
      unitHammer = parseFloat(priceRawInner);
      if (!Number.isFinite(unitHammer) || unitHammer < 0) {
        setFormError("Enter a valid hammer price per unit.");
        return;
      }
    }

    const paddle = parseInt(paddleNumber.trim(), 10);
    if (!Number.isFinite(paddle) || paddle < 1) {
      setFormError("Enter a valid paddle number.");
      return;
    }

    const bidder = await db.bidders
      .where("[eventId+paddleNumber]")
      .equals([eventId, paddle])
      .first();
    if (bidder?.id == null) {
      setFormError(`No bidder registered with paddle #${paddle}.`);
      return;
    }

    const initialsRaw = clerkInitials.trim().toUpperCase().slice(0, 3);
    if (fieldRequired.initials && initialsRaw.length < 2) {
      setFormError("Clerk initials are required (2–3 characters).");
      return;
    }
    const initials = initialsRaw;

    if (!passOutActive && parsed.suffix) {
      setFormError(
        "Lot has a letter suffix — enable pass out, or use a base lot number only."
      );
      return;
    }

    const baseNum = parsed.base;
    const newSuffix = passOutActive
      ? await computeNewPassOutLotSuffix(db, eventId, baseNum)
      : "";
    const baseDigits =
      lotDisplayBaseDigits(lotInputForDisplay) ?? String(baseNum);
    const displayStr = passOutActive
      ? baseDigits + newSuffix
      : formatLotDisplayFromInput(lotInputForDisplay) ?? baseDigits;

    const existingLot = await findLotByEventBaseAndSuffix(
      db,
      eventId,
      baseNum,
      newSuffix
    );

    const effectiveDescription = titleTrim
      ? titleTrim
      : existingLot?.description?.trim() || `Lot ${displayStr}`;

    const qtyParsed = parseInt(quantity.trim(), 10);
    if (fieldRequired.quantity) {
      if (!Number.isFinite(qtyParsed) || qtyParsed < 1) {
        setFormError("Enter a valid quantity (at least 1).");
        return;
      }
    }
    const qty = fieldRequired.quantity
      ? qtyParsed
      : Math.max(1, parseInt(quantity.trim(), 10) || 1);

    const notesTrim = lotNotes.trim();
    if (fieldRequired.notes && !notesTrim) {
      setFormError("Lot notes are required.");
      return;
    }

    const consignorTrimBody = consignor.trim();
    if (
      fieldRequired.consignor &&
      !consignorTrimBody &&
      linkedConsignorId == null
    ) {
      setFormError(
        "Consignor is required — choose a registered consignor or enter a label."
      );
      return;
    }
    const consignorTrim = consignorTrimBody || undefined;

    const now = new Date();
    const pendingSaleSyncKey = newEntitySyncKey();

    const lotMarkSold: Pick<
      Lot,
      "description" | "consignor" | "notes" | "quantity" | "status" | "updatedAt"
    > = {
      description: effectiveDescription,
      consignor: consignorTrim,
      notes: notesTrim || undefined,
      quantity: qty,
      status: "sold" as const,
      updatedAt: now,
    };

    const bidderId = bidder.id!;

    const lineHammer = roundMoney(unitHammer * qty);

    function buildSaleRow(lotId: number, saleSyncKey: string): Omit<Sale, "id"> {
      const row: Omit<Sale, "id"> = {
        eventId,
        lotId,
        bidderId,
        displayLotNumber: displayStr,
        paddleNumber: paddle,
        description: effectiveDescription,
        consignor: consignorTrim,
        quantity: qty,
        amount: lineHammer,
        clerkInitials: initials,
        createdAt: now,
        syncKey: saleSyncKey,
      };
      if (linkedConsignorId != null) row.consignorId = linkedConsignorId;
      return row;
    }

    let recordedSaleId = 0;

    try {
      if (!existingLot) {
        let newLotId = 0;
        let newSaleId = 0;
        await mutateWithEventTables(db, eventId, [db.lots, db.sales], async () => {
          const newLotRow: Omit<Lot, "id"> = {
            eventId,
            baseLotNumber: baseNum,
            lotSuffix: newSuffix,
            displayLotNumber: displayStr,
            ...lotMarkSold,
            createdAt: now,
          };
          if (linkedConsignorId != null) newLotRow.consignorId = linkedConsignorId;
          newLotId = (await db.lots.add(newLotRow)) as number;
          newSaleId = (await db.sales.add(
            buildSaleRow(newLotId, pendingSaleSyncKey)
          )) as number;
        });
        recordedSaleId = newSaleId;
      } else {
        const lotId = existingLot.id!;
        const salesOnLot = await db.sales
          .where("lotId")
          .equals(lotId)
          .toArray();

        const openCatalog =
          (existingLot.status === "unsold" || existingLot.status === "passed") &&
          salesOnLot.length === 0;

        if (!openCatalog) {
          if (salesOnLot.length > 1) {
            setFormError(
              "This lot has multiple sales; resolve outside the clerk form before continuing."
            );
            return;
          }
          if (
            !window.confirm(
              `Lot ${displayStr} already has a sale or is not an open catalog lot. OK to replace the stored sale and lot details with this form?`
            )
          ) {
            return;
          }
        }

        if (openCatalog) {
          let newSaleId = 0;
          await mutateWithEventTables(db, eventId, [db.lots, db.sales], async () => {
            await patchLotWithConsignor(
              db,
              lotId,
              lotMarkSold,
              linkedConsignorId
            );
            newSaleId = (await db.sales.add(
              buildSaleRow(lotId, pendingSaleSyncKey)
            )) as number;
          });
          recordedSaleId = newSaleId;
        } else if (salesOnLot.length === 1) {
          const prevSale = salesOnLot[0]!;
          await mutateWithEventTables(db, eventId, [db.lots, db.sales], async () => {
            await patchLotWithConsignor(
              db,
              lotId,
              lotMarkSold,
              linkedConsignorId
            );
            const salePatch = buildSaleRow(
              lotId,
              prevSale.syncKey ?? pendingSaleSyncKey
            );
            const curS = await db.sales.get(prevSale.id!);
            if (curS) {
              const nextS: Sale = { ...curS, ...salePatch };
              if (linkedConsignorId == null) delete nextS.consignorId;
              await db.sales.put(nextS);
            }
          });
          recordedSaleId = prevSale.id!;
        } else {
          let newSaleId = 0;
          await mutateWithEventTables(db, eventId, [db.lots, db.sales], async () => {
            await patchLotWithConsignor(
              db,
              lotId,
              lotMarkSold,
              linkedConsignorId
            );
            newSaleId = (await db.sales.add(
              buildSaleRow(lotId, pendingSaleSyncKey)
            )) as number;
          });
          recordedSaleId = newSaleId;
        }
      }
    } catch (e) {
      setFormError(
        e instanceof Error ? e.message : "Could not record sale (duplicate?)."
      );
      return;
    }

    try {
      sessionStorage.setItem(CLERK_KEY, initials);
    } catch {
      /* ignore */
    }

    const evCloud = await db.events.get(eventId);
    if (evCloud) {
      try {
        await attachUnallocatedSalesToUnpaidInvoice(db, evCloud, bidderId);
      } catch {
        /* sale is recorded; invoice can be generated from /invoices */
      }
    }
    if (evCloud?.syncId) {
      const s = await db.sales.get(recordedSaleId);
      if (s) await enqueueSalePut(db, evCloud.syncId, s);
    }

    showToast({ kind: "success", message: `Sale recorded — ${displayStr}` });
    scheduleCloudPush();

    if (passOutActive) {
      setPaddleNumber("");
      setLotNotes("");
      const nextDisp = await nextPassOutLineDisplay(db, eventId, baseNum);
      setLotNumber(nextDisp);
      focusField("paddle");
    } else {
      setPassOutEnabled(false);
      setTitle("");
      // Keep consignor sticky between sales (Escape clears it).
      writeStickyConsignor(eventId, consignor, linkedConsignorId);
      setLotNotes("");
      setQuantity("1");
      setSellPrice("");
      setPaddleNumber("");
      await refreshLotSuggestion(displayStr);
      focusField("lot");
    }
  }

  const setRef =
    (id: SaleFieldId) => (el: HTMLElement | null) => {
      fieldRefs.current[id] = el;
    };

  function fieldLabel(id: SaleFieldId, text: string) {
    return fieldRequired[id] ? text : `${text} (optional)`;
  }

  function renderField(id: SaleFieldId) {
    switch (id) {
      case "lot":
        return (
          <Input
            key="lot"
            ref={(el) => {
              setRef("lot")(el);
            }}
            id="sale-lot"
            label={fieldLabel("lot", "Lot number")}
            value={lotNumber}
            onChange={(e) => {
              const v = e.target.value;
              setLotNumber(v);
              if (lotAutofillDebounceRef.current != null) {
                clearTimeout(lotAutofillDebounceRef.current);
              }
              lotAutofillDebounceRef.current = setTimeout(() => {
                lotAutofillDebounceRef.current = null;
                void autofillFromLot(v);
              }, 200);
            }}
            onBlur={() => {
              if (lotAutofillDebounceRef.current != null) {
                clearTimeout(lotAutofillDebounceRef.current);
                lotAutofillDebounceRef.current = null;
              }
              void autofillFromLot();
            }}
            className="font-mono"
            autoComplete="off"
          />
        );
      case "price":
        return (
          <div key="price">
            <Input
              ref={(el) => {
                setRef("price")(el);
              }}
              id="sale-price"
              label={fieldLabel(
                "price",
                `Hammer per unit (${currencySymbol})`
              )}
              inputMode="decimal"
              value={sellPrice}
              onChange={(e) => setSellPrice(e.target.value)}
              className="font-mono"
              autoComplete="off"
            />
            {Number.isFinite(lineHammerPreview) && qtyPreview > 1 ? (
              <p className="mt-1 text-xs text-muted">
                Line hammer ({qtyPreview} ×{" "}
                {formatCurrency(unitHammerPreview, currencySymbol)}):{" "}
                <span className="font-mono font-medium text-navy dark:text-slate-200">
                  {formatCurrency(lineHammerPreview, currencySymbol)}
                </span>
              </p>
            ) : null}
            {bpPreview != null ? (
              <p className="mt-1 text-xs text-muted">
                With {Math.round(buyersPremiumRate * 100)}% buyer&apos;s premium
                (before tax), line:{" "}
                <span className="font-mono font-medium text-navy dark:text-slate-200">
                  {formatCurrency(bpPreview, currencySymbol)}
                </span>
              </p>
            ) : null}
          </div>
        );
      case "paddle":
        return (
          <Input
            key="paddle"
            ref={(el) => {
              setRef("paddle")(el);
            }}
            id="sale-paddle"
            label={fieldLabel("paddle", "Paddle number")}
            inputMode="numeric"
            value={paddleNumber}
            onChange={(e) => setPaddleNumber(e.target.value)}
            className="font-mono"
            autoComplete="off"
          />
        );
      case "quantity":
        return (
          <Input
            key="quantity"
            ref={(el) => {
              setRef("quantity")(el);
            }}
            id="sale-qty"
            label={fieldLabel("quantity", "Quantity")}
            inputMode="numeric"
            value={quantity}
            onChange={(e) => setQuantity(e.target.value)}
            autoComplete="off"
          />
        );
      case "description":
        return (
          <Input
            key="description"
            ref={(el) => {
              setRef("description")(el);
            }}
            id="sale-title"
            label={fieldLabel("description", "Lot description / title")}
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            autoComplete="off"
          />
        );
      case "notes":
        return (
          <div key="notes">
            <label
              htmlFor="sale-lot-notes"
              className="mb-1 block text-sm font-medium text-ink dark:text-slate-200"
            >
              {fieldLabel("notes", "Lot notes / ring")}
            </label>
            <textarea
              ref={(el) => {
                setRef("notes")(el);
              }}
              id="sale-lot-notes"
              className="w-full rounded-lg border border-navy/20 bg-white px-3 py-2 text-sm text-ink placeholder:text-muted focus:border-navy focus:outline-none focus:ring-1 focus:ring-navy dark:border-slate-600 dark:bg-slate-800 dark:text-slate-100 dark:placeholder:text-slate-500"
              rows={2}
              value={lotNotes}
              onChange={(e) => setLotNotes(e.target.value)}
              placeholder="Announcement line, ring notes…"
            />
          </div>
        );
      case "consignor":
        return (
          <div key="consignor" className="space-y-2">
            <div>
              <label
                htmlFor="sale-consignor-registry"
                className="mb-1 block text-sm font-medium text-ink dark:text-slate-100"
              >
                {fieldLabel("consignor", "Registered consignor")}
              </label>
              <select
                id="sale-consignor-registry"
                className="w-full rounded-lg border border-navy/20 bg-white px-3 py-2 text-sm text-ink focus:border-navy focus:outline-none focus:ring-1 focus:ring-navy dark:border-slate-600 dark:bg-slate-800 dark:text-slate-100"
                value={
                  linkedConsignorId != null ? String(linkedConsignorId) : ""
                }
                onChange={(e) => {
                  const v = e.target.value;
                  if (!v) {
                    setLinkedConsignorId(null);
                    writeStickyConsignor(eventId, consignor, null);
                    return;
                  }
                  const id = parseInt(v, 10);
                  const c = consignors?.find((x) => x.id === id);
                  if (c?.id != null) {
                    setLinkedConsignorId(id);
                    const label = formatConsignorDisplayLabel(c);
                    setConsignor(label);
                    writeStickyConsignor(eventId, label, id);
                  }
                }}
              >
                <option value="">— None —</option>
                {(consignors ?? [])
                  .filter((c) => c.id != null)
                  .map((c) => (
                    <option key={c.id} value={String(c.id)}>
                      #{c.consignorNumber} — {c.name}
                    </option>
                  ))}
              </select>
            </div>
            <Input
              ref={(el) => {
                setRef("consignor")(el);
              }}
              id="sale-consignor"
              label={fieldLabel("consignor", "Consignor label")}
              value={consignor}
              onChange={(e) => {
                const v = e.target.value;
                setConsignor(v);
                let nextLinked = linkedConsignorId;
                if (linkedConsignorId != null) {
                  const c = consignors?.find((x) => x.id === linkedConsignorId);
                  if (c && v.trim() !== formatConsignorDisplayLabel(c)) {
                    nextLinked = null;
                    setLinkedConsignorId(null);
                  }
                }
                writeStickyConsignor(eventId, v, nextLinked);
              }}
              autoComplete="off"
            />
          </div>
        );
      case "initials":
        return (
          <Input
            key="initials"
            ref={(el) => {
              setRef("initials")(el);
            }}
            id="sale-initials"
            label={fieldLabel("initials", "Clerk initials")}
            value={clerkInitials}
            onChange={(e) =>
              setClerkInitials(e.target.value.toUpperCase().slice(0, 3))
            }
            maxLength={3}
            className="font-mono uppercase"
            autoComplete="off"
          />
        );
      default:
        return null;
    }
  }

  function renderLayoutGroups(): ReactNode[] {
    const rows: ReactNode[] = [];
    let i = 0;
    while (i < fieldOrder.length) {
      const id = fieldOrder[i]!;
      if (!isNarrowSaleField(id)) {
        rows.push(
          <div key={`sale-row-${i}-${id}`}>{renderField(id)}</div>
        );
        i += 1;
        continue;
      }
      const next = fieldOrder[i + 1];
      if (next != null && isNarrowSaleField(next)) {
        rows.push(
          <div
            key={`sale-row-${i}-${id}-${next}`}
            className="grid gap-4 sm:grid-cols-2"
          >
            {renderField(id)}
            {renderField(next)}
          </div>
        );
        i += 2;
      } else {
        rows.push(
          <div key={`sale-row-${i}-${id}`}>{renderField(id)}</div>
        );
        i += 1;
      }
    }
    return rows;
  }

  return (
    <form
      className="space-y-4"
      onSubmit={(e) => {
        e.preventDefault();
        void submitSale(false);
      }}
      onKeyDown={(e) => {
        if (e.key === "Escape") {
          e.preventDefault();
          void resetAfterEscape();
          return;
        }
        if (e.key === "Enter" && e.shiftKey) {
          e.preventDefault();
          void submitSale(true);
        }
      }}
    >
      {formError ? (
        <p className="text-sm text-danger" role="alert">
          {formError}
        </p>
      ) : null}

      {renderLayoutGroups()}

      <label className="flex cursor-pointer flex-wrap items-center gap-2 text-sm font-medium text-ink">
        <input
          type="checkbox"
          checked={suggestNextLotEnabled}
          onChange={(e) => {
            const on = e.target.checked;
            writeSuggestNextLot(on);
            if (!on) {
              setLotNumber("");
              return;
            }
            if (db) {
              void getNextSuggestedLotDisplay(db, eventId).then(setLotNumber);
            }
          }}
          className="h-4 w-4 rounded border-navy/30 text-navy focus:ring-navy"
        />
        <span>Suggest next lot number after each sale</span>
        <span className="text-xs font-normal text-muted">
          When off, the lot field stays empty after reset or sale (pass-out line
          still advances automatically).
        </span>
      </label>

      <PassOutCheckbox
        checked={passOutEnabled}
        onChange={setPassOutEnabled}
      />

      <div className="space-y-1">
        <Button
          type="submit"
          variant="primary"
          className="w-full py-3 text-base font-semibold sm:py-2.5"
        >
          Record sale
        </Button>
        <p className="text-center text-xs text-muted sm:text-left">
          Same as pressing Enter — fill fields marked required in{" "}
          <strong className="font-medium text-ink dark:text-slate-200">
            Field order and requirements
          </strong>{" "}
          (and pass-out if needed).
        </p>
      </div>

      <div className="flex flex-wrap items-end gap-3">
        <Button type="button" variant="secondary" onClick={() => void passLotNoSale()}>
          Pass lot (no sale)
        </Button>
        <p className="max-w-xl text-xs text-muted">
          Marks this catalog lot as passed when it does not sell. Passed lots are
          skipped by the next-lot suggestion. Requires a valid lot number; clerk
          initials follow your requirements setting. Does not record a sale or use
          hammer price / paddle.
        </p>
      </div>

      <p className="text-xs text-muted">
        <span className="sm:hidden">
          Use <strong className="font-medium text-ink dark:text-slate-200">
            Record sale
          </strong>{" "}
          or a keyboard: Enter submits (normal or pass-out per checkbox).
        </span>
        <span className="hidden sm:inline">
          Enter records the sale (normal or pass-out per checkbox). Tab order:{" "}
          {tabOrderHelpFragment(fieldOrder)}, then next-lot suggestion, pass out,
          <strong className="font-medium text-ink dark:text-slate-200">
            {" "}
            Record sale
          </strong>
          , pass lot (no sale), then Enter to submit.
        </span>
      </p>
    </form>
  );
}
