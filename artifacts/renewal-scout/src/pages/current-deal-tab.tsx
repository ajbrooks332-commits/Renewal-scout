/**
 * Current Deal Tab — shown inside the service detail page.
 * Displays deal fields with provenance badges, upload button, and extraction confirmation.
 *
 * Key privacy & provenance rules enforced here:
 *  - Upload requires explicit consent checkbox (opt-in, not pre-ticked)
 *  - Confirmation sends only raw values — server assigns source: "extracted_confirmed"
 *  - Manual edits use the values+clear API — server assigns source: "user"
 *  - Discard calls the real server endpoint (not just client-side state clear)
 *  - Pending drafts are restored from the server on page load (survives refresh)
 */
import { useState, useRef, useEffect } from "react";
import { useQueryClient } from "@tanstack/react-query";
import {
  useGetCurrentDeal,
  useUpdateCurrentDeal,
  useConfirmExtractionDraft,
  useDiscardExtractionDraft,
  useGetPendingExtractionDraft,
  getGetCurrentDealQueryKey,
  getGetPendingExtractionDraftQueryKey,
} from "@workspace/api-client-react";
import type { ExtractionDraft } from "@workspace/api-client-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Checkbox } from "@/components/ui/checkbox";
import { useToast } from "@/hooks/use-toast";
import {
  Upload, Save, Loader2, Check, X, FileText, AlertTriangle, Pencil, Info, ShieldAlert
} from "lucide-react";

// ─── Types ────────────────────────────────────────────────────────────────────

type Source = "user" | "extracted_confirmed" | "extracted_unconfirmed" | "unknown";

interface FieldEntry {
  key: string;
  label: string;
  type: "text" | "number" | "date";
  placeholder?: string;
}

const FIELD_DEFS: FieldEntry[] = [
  { key: "provider", label: "Provider", type: "text" },
  { key: "tariffName", label: "Tariff / product name", type: "text" },
  { key: "productName", label: "Product name", type: "text" },
  { key: "monthlyCostGbp", label: "Monthly cost (£)", type: "number", placeholder: "e.g. 45.99" },
  { key: "annualCostGbp", label: "Annual cost (£)", type: "number" },
  { key: "annualPremiumGbp", label: "Annual premium (£)", type: "number" },
  { key: "renewalDate", label: "Renewal date", type: "date" },
  { key: "contractEndDate", label: "Contract end date", type: "date" },
  { key: "exitFeeGbp", label: "Exit / cancellation fee (£)", type: "number" },
  { key: "setupFeeGbp", label: "Setup fee (£)", type: "number" },
  { key: "noticeDays", label: "Notice period (days)", type: "number" },
  { key: "unitRatePencePkwh", label: "Unit rate (p/kWh)", type: "number" },
  { key: "standingChargePencePday", label: "Standing charge (p/day)", type: "number" },
  { key: "gasUnitRatePencePkwh", label: "Gas unit rate (p/kWh)", type: "number" },
  { key: "gasStandingChargePencePday", label: "Gas standing charge (p/day)", type: "number" },
  { key: "downloadSpeedMbps", label: "Download speed (Mbps)", type: "number" },
  { key: "uploadSpeedMbps", label: "Upload speed (Mbps)", type: "number" },
  { key: "coverType", label: "Cover type", type: "text" },
  { key: "excessGbp", label: "Excess (£)", type: "number" },
  { key: "aprPct", label: "APR (%)", type: "number" },
  { key: "balanceGbp", label: "Balance (£)", type: "number" },
  { key: "inclusions", label: "What's included", type: "text" },
  { key: "exclusions", label: "Key exclusions", type: "text" },
  { key: "notes", label: "Other notes", type: "text" },
];

const SOURCE_BADGE: Record<Source, { label: string; className: string }> = {
  user: { label: "Entered by you", className: "bg-blue-50 text-blue-700 border-blue-200" },
  extracted_confirmed: { label: "Confirmed from document", className: "bg-emerald-50 text-emerald-700 border-emerald-200" },
  extracted_unconfirmed: { label: "AI — unconfirmed", className: "bg-amber-50 text-amber-700 border-amber-200" },
  unknown: { label: "Unknown", className: "bg-muted text-muted-foreground" },
};

// ─── Provenance badge ─────────────────────────────────────────────────────────

function ProvenanceBadge({ source }: { source: Source }) {
  const meta = SOURCE_BADGE[source] ?? SOURCE_BADGE.unknown;
  return (
    <Badge variant="outline" className={`text-xs font-normal ${meta.className}`}>
      {meta.label}
    </Badge>
  );
}

// ─── Manual deal editor ───────────────────────────────────────────────────────

type DealFieldsMap = Record<string, { value: unknown; source: Source }>;

function ManualDealEditor({
  serviceId,
  fields,
  onSaved,
}: {
  serviceId: number;
  fields: DealFieldsMap;
  onSaved: () => void;
}) {
  const { toast } = useToast();

  // Initialise from both user-entered AND confirmed-extracted values so the
  // editor shows all known data (not just what the user previously typed).
  const [local, setLocal] = useState<Record<string, unknown>>(() => {
    const out: Record<string, unknown> = {};
    for (const { key } of FIELD_DEFS) {
      const pf = fields[key];
      if (pf?.source === "user" || pf?.source === "extracted_confirmed") {
        out[key] = pf.value;
      }
    }
    return out;
  });

  // Track which fields the user has actually edited.  Only touched fields are
  // included in the save payload so that untouched "extracted_confirmed" fields
  // retain their provenance on the server — they are not silently upgraded to
  // "user" source just because the editor was opened.
  const [touched, setTouched] = useState<Set<string>>(new Set());

  const save = useUpdateCurrentDeal();

  function handleChange(key: string, type: FieldEntry["type"], rawValue: string) {
    setTouched((t) => { const n = new Set(t); n.add(key); return n; });
    let parsed: unknown;
    if (rawValue === "") {
      parsed = null;
    } else if (type === "number") {
      const n = parseFloat(rawValue);
      parsed = isNaN(n) ? null : n;
    } else {
      parsed = rawValue;
    }
    setLocal((l) => ({ ...l, [key]: parsed }));
  }

  function handleSave() {
    // Only include fields the user actually touched.
    // Untouched fields (even if pre-populated from extracted_confirmed) are
    // omitted — the server preserves their existing source/provenance.
    const values: Record<string, unknown> = {};
    const clear: string[] = [];

    for (const { key, type } of FIELD_DEFS) {
      if (!touched.has(key)) continue; // preserve server-side provenance

      const val = local[key];
      const hasValue = val !== null && val !== undefined && String(val).trim() !== "";
      if (hasValue) {
        // Ensure numbers are sent as numbers, not strings
        values[key] = type === "number" ? Number(val) : val;
      } else {
        // User cleared a field they touched → request removal
        clear.push(key);
      }
    }

    save.mutate(
      { id: serviceId, data: { values, clear } },
      {
        onSuccess: () => { toast({ title: "Deal saved" }); onSaved(); },
        onError: (err) => {
          toast({
            title: "Failed to save",
            description: (err as { data?: { error?: string } }).data?.error,
            variant: "destructive",
          });
        },
      },
    );
  }

  return (
    <div className="space-y-4">
      {FIELD_DEFS.map(({ key, label, type, placeholder }) => {
        const existing = fields[key];
        const isTouched = touched.has(key);
        return (
          <div key={key}>
            <Label className="text-sm font-medium">{label}</Label>
            <Input
              type={type === "number" ? "number" : type === "date" ? "date" : "text"}
              placeholder={placeholder ?? "Leave blank if unknown"}
              value={(local[key] as string | number | undefined) ?? ""}
              onChange={(e) => handleChange(key, type, e.target.value)}
              className="mt-1"
            />
            <div className="mt-1 flex items-center gap-2">
              {/* Show provenance badge for pre-populated fields */}
              {existing && !isTouched && existing.source !== "user" && (
                <ProvenanceBadge source={existing.source} />
              )}
              {/* Once touched, indicate this field will be saved as user-entered */}
              {isTouched && (
                <span className="text-xs text-muted-foreground italic">edited — will save as user-entered</span>
              )}
            </div>
          </div>
        );
      })}
      <Button onClick={handleSave} disabled={save.isPending} className="gap-2">
        {save.isPending ? <Loader2 className="h-4 w-4 animate-spin" /> : <Save className="h-4 w-4" />}
        Save Deal Details
        {touched.size > 0 && (
          <span className="ml-1 text-xs opacity-75">({touched.size} changed)</span>
        )}
      </Button>
    </div>
  );
}

// ─── Extraction confirmation screen ───────────────────────────────────────────

function ExtractionConfirmScreen({
  serviceId,
  draft,
  onDone,
  onDiscard,
}: {
  serviceId: number;
  draft: ExtractionDraft;
  onDone: () => void;
  onDiscard: () => void;
}) {
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const confirm = useConfirmExtractionDraft();
  const discard = useDiscardExtractionDraft();

  // Local edits to extracted values
  const [localValues, setLocalValues] = useState<Record<string, unknown>>(() => {
    const out: Record<string, unknown> = {};
    for (const [k, pf] of Object.entries(draft.fields as Record<string, { value: unknown; source: string }>)) {
      out[k] = pf.value;
    }
    return out;
  });
  const [deleted, setDeleted] = useState<Set<string>>(new Set());

  // Clears the pending-draft query cache synchronously so the parent useEffect
  // that restores pending drafts does NOT re-show the review screen immediately
  // after a successful confirm or discard.
  function clearPendingDraftCache() {
    queryClient.setQueryData(getGetPendingExtractionDraftQueryKey(serviceId), null);
    void queryClient.invalidateQueries({ queryKey: getGetPendingExtractionDraftQueryKey(serviceId) });
  }

  function handleConfirm() {
    // Do NOT send source — server assigns source: "extracted_confirmed" server-side.
    const confirmedFields: Record<string, { value: unknown }> = {};
    for (const key of Object.keys(draft.fields as object)) {
      if (!deleted.has(key)) {
        confirmedFields[key] = { value: localValues[key] ?? null };
      }
    }
    confirm.mutate(
      {
        id: serviceId,
        extractionId: draft.extractionId,
        data: {
          confirmedFields: confirmedFields as Parameters<typeof confirm.mutate>[0]["data"]["confirmedFields"],
          deletedFields: Array.from(deleted),
        },
      },
      {
        onSuccess: () => {
          toast({ title: "Extraction confirmed", description: "Confirmed fields saved to current deal." });
          // Wipe pending-draft cache first so the useEffect doesn't re-render the
          // review screen, then invalidate current-deal so fresh data is shown.
          clearPendingDraftCache();
          queryClient.invalidateQueries({ queryKey: getGetCurrentDealQueryKey(serviceId) });
          onDone();
        },
        onError: (err) => {
          const errData = err as { data?: { error?: string }; status?: number };
          const is409 = errData.status === 409;
          toast({
            title: is409 ? "Already applied" : "Failed to confirm",
            description: is409
              ? "This draft was already applied or discarded."
              : errData.data?.error,
            variant: "destructive",
          });
          if (is409) {
            clearPendingDraftCache();
            onDone(); // clear the draft UI
          }
        },
      },
    );
  }

  function handleDiscard() {
    // Call the real discard API — never just clear client-side state
    discard.mutate(
      { id: serviceId, extractionId: draft.extractionId },
      {
        onSuccess: () => {
          toast({ title: "Draft discarded" });
          // Wipe cache before clearing local state so useEffect cannot restore the
          // just-discarded draft.
          clearPendingDraftCache();
          onDiscard();
        },
        onError: (err) => {
          const errData = err as { data?: { error?: string }; status?: number };
          // 404 / 409 → treat as already gone
          if (errData.status === 404 || errData.status === 409) {
            clearPendingDraftCache();
            onDiscard();
            return;
          }
          toast({
            title: "Failed to discard",
            description: errData.data?.error,
            variant: "destructive",
          });
        },
      },
    );
  }

  const extractedKeys = Object.keys(draft.fields as object);
  const labelFor = (key: string) => FIELD_DEFS.find((f) => f.key === key)?.label ?? key;
  const typeFor = (key: string) => FIELD_DEFS.find((f) => f.key === key)?.type ?? "text";

  return (
    <div className="space-y-4">
      {/* AI disclosure notice */}
      <div className="bg-amber-50 border border-amber-200 rounded-md p-4 flex gap-3 text-sm text-amber-800">
        <AlertTriangle className="h-4 w-4 mt-0.5 shrink-0 text-amber-600" />
        <div>
          <strong>Review all extracted values before confirming.</strong>{" "}
          This document was processed by the OpenAI API. Document bytes were not retained
          by Renewal Scout or OpenAI. Edit any incorrect values, then click Confirm.
          Only confirmed fields are used in research comparisons.
        </div>
      </div>

      {extractedKeys.length === 0 && (
        <p className="text-sm text-muted-foreground py-4 text-center">
          The AI didn't find any deal fields in this document.
        </p>
      )}

      <div className="space-y-3">
        {extractedKeys.map((key) => (
          <div
            key={key}
            className={`border rounded-md p-3 transition-opacity ${deleted.has(key) ? "opacity-40" : ""}`}
          >
            <div className="flex items-center justify-between mb-2">
              <Label className="text-sm font-medium">{labelFor(key)}</Label>
              <button
                onClick={() =>
                  setDeleted((d) => {
                    const next = new Set(d);
                    if (next.has(key)) next.delete(key);
                    else next.add(key);
                    return next;
                  })
                }
                className="text-muted-foreground hover:text-destructive transition-colors p-1"
                title={deleted.has(key) ? "Restore" : "Remove"}
              >
                {deleted.has(key) ? <Check className="h-4 w-4" /> : <X className="h-4 w-4" />}
              </button>
            </div>
            {!deleted.has(key) && (
              <Input
                type={typeFor(key) === "number" ? "number" : typeFor(key) === "date" ? "date" : "text"}
                value={(localValues[key] as string | number | undefined) ?? ""}
                onChange={(e) => setLocalValues((l) => ({ ...l, [key]: e.target.value || null }))}
              />
            )}
          </div>
        ))}
      </div>

      <div className="flex gap-3 pt-2">
        <Button
          onClick={handleConfirm}
          disabled={confirm.isPending || discard.isPending}
          className="gap-2"
        >
          {confirm.isPending ? <Loader2 className="h-4 w-4 animate-spin" /> : <Check className="h-4 w-4" />}
          Confirm {extractedKeys.length - deleted.size} field(s)
        </Button>
        <Button
          variant="outline"
          onClick={handleDiscard}
          disabled={confirm.isPending || discard.isPending}
          className="gap-2"
        >
          {discard.isPending ? <Loader2 className="h-4 w-4 animate-spin" /> : <X className="h-4 w-4" />}
          Discard
        </Button>
      </div>
    </div>
  );
}

// ─── Main component ────────────────────────────────────────────────────────────

export function CurrentDealTab({ serviceId }: { serviceId: number }) {
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const fileRef = useRef<HTMLInputElement>(null);
  const [editMode, setEditMode] = useState(false);
  const [draft, setDraft] = useState<ExtractionDraft | null>(null);
  const [isUploading, setIsUploading] = useState(false);

  /**
   * Consent checkbox — must be ticked before upload is enabled.
   * Unticked by default (spec requirement: opt-in, not pre-ticked).
   */
  const [consentGiven, setConsentGiven] = useState(false);

  const { data, isLoading } = useGetCurrentDeal(serviceId);

  // Restore a pending draft from the server on first load (survives page refresh).
  // Always fetch on mount — if we already have draft in state, the useEffect
  // below is a no-op (we only set state when draft is still null).
  const { data: pendingDraft, isLoading: pendingLoading } =
    useGetPendingExtractionDraft(serviceId);

  useEffect(() => {
    if (pendingDraft && !draft) {
      setDraft(pendingDraft);
    }
  }, [pendingDraft, draft]);

  const fields = (data?.fields ?? {}) as DealFieldsMap;
  const hasAny = Object.keys(fields).length > 0;
  const confirmedFields = Object.entries(fields).filter(
    ([, pf]) => pf.source === "user" || pf.source === "extracted_confirmed",
  );
  const unconfirmedFields = Object.entries(fields).filter(
    ([, pf]) => pf.source === "extracted_unconfirmed",
  );

  async function handleFileChange(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;
    setIsUploading(true);
    const formData = new FormData();
    formData.append("document", file);
    try {
      const res = await fetch(`/api/services/${serviceId}/extract-document`, {
        method: "POST",
        body: formData,
        credentials: "include",
      });
      if (!res.ok) {
        const err = (await res.json()) as { error?: string };
        throw new Error(err.error ?? `HTTP ${res.status}`);
      }
      const result = (await res.json()) as ExtractionDraft;
      setDraft(result);
      setEditMode(false);
      // Reset consent after each upload (re-read before next upload)
      setConsentGiven(false);
    } catch (err) {
      toast({
        title: "Upload failed",
        description: (err as Error).message,
        variant: "destructive",
      });
    } finally {
      setIsUploading(false);
      if (fileRef.current) fileRef.current.value = "";
    }
  }

  if (isLoading || pendingLoading) {
    return (
      <div className="flex items-center gap-2 py-8 text-muted-foreground">
        <Loader2 className="h-4 w-4 animate-spin" /> Loading…
      </div>
    );
  }

  // Extraction confirmation screen
  if (draft) {
    return (
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <FileText className="h-5 w-5 text-primary" />
            Review Extracted Fields
          </CardTitle>
          <CardDescription>
            These values were extracted from your document. Edit any that are wrong, then confirm.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <ExtractionConfirmScreen
            serviceId={serviceId}
            draft={draft}
            onDone={() => {
              setDraft(null);
              queryClient.invalidateQueries({ queryKey: getGetCurrentDealQueryKey(serviceId) });
            }}
            onDiscard={() => setDraft(null)}
          />
        </CardContent>
      </Card>
    );
  }

  return (
    <div className="space-y-4">
      {/* Upload CTA */}
      <Card>
        <CardHeader>
          <CardTitle>Upload a Bill or Letter</CardTitle>
          <CardDescription>
            Upload a PDF, JPG or PNG (max 10 MB) and the AI will extract your current deal details.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          {/* AI data-sharing disclosure */}
          <div className="bg-muted/50 border rounded-md p-3 flex gap-2.5 text-xs text-muted-foreground">
            <ShieldAlert className="h-3.5 w-3.5 shrink-0 mt-0.5 text-amber-500" />
            <span>
              <strong className="text-foreground">AI disclosure:</strong>{" "}
              Your document will be sent to the OpenAI API for text extraction.
              Renewal Scout sets <code>store: false</code> so OpenAI does not retain the
              document content. No document bytes are stored by Renewal Scout.
              Review all extracted values carefully — AI extraction may contain errors.
            </span>
          </div>

          {/* Consent checkbox — must be ticked to enable upload (opt-in, not pre-ticked) */}
          <div className="flex items-start gap-2.5">
            <Checkbox
              id="ai-consent"
              checked={consentGiven}
              onCheckedChange={(v) => setConsentGiven(Boolean(v))}
              className="mt-0.5"
            />
            <label
              htmlFor="ai-consent"
              className="text-sm leading-snug cursor-pointer select-none"
            >
              I understand this document will be sent to the OpenAI API for processing and
              I consent to this for the purpose of extracting deal information.
            </label>
          </div>

          {/* Upload button — disabled until consent is given */}
          <div className="flex items-center gap-3">
            <input
              ref={fileRef}
              type="file"
              accept=".pdf,.jpg,.jpeg,.png"
              className="hidden"
              onChange={handleFileChange}
            />
            <Button
              variant="outline"
              onClick={() => fileRef.current?.click()}
              disabled={isUploading || !consentGiven}
              className="gap-2"
              title={!consentGiven ? "Please tick the consent checkbox above to enable upload" : undefined}
            >
              {isUploading ? <Loader2 className="h-4 w-4 animate-spin" /> : <Upload className="h-4 w-4" />}
              {isUploading ? "Extracting…" : "Upload document"}
            </Button>
            <span className="text-xs text-muted-foreground">PDF, JPG, PNG · max 10 MB</span>
          </div>

          <p className="text-xs text-muted-foreground flex gap-1.5">
            <Info className="h-3.5 w-3.5 shrink-0 mt-0.5" />
            Do not upload documents containing passwords, bank account details, or National Insurance numbers.
          </p>
        </CardContent>
      </Card>

      {/* Current deal fields display */}
      {hasAny ? (
        <Card>
          <CardHeader>
            <div className="flex items-center justify-between">
              <div>
                <CardTitle>Current Deal Details</CardTitle>
                <CardDescription>
                  Only confirmed fields (entered by you or verified from a document) are used in research.
                </CardDescription>
              </div>
              <Button
                variant="outline"
                size="sm"
                onClick={() => setEditMode(!editMode)}
                className="gap-2"
              >
                <Pencil className="h-3.5 w-3.5" />
                {editMode ? "Cancel" : "Edit"}
              </Button>
            </div>
          </CardHeader>
          <CardContent>
            {editMode ? (
              <ManualDealEditor
                serviceId={serviceId}
                fields={fields}
                onSaved={() => {
                  setEditMode(false);
                  queryClient.invalidateQueries({ queryKey: getGetCurrentDealQueryKey(serviceId) });
                }}
              />
            ) : (
              <div className="space-y-4">
                {confirmedFields.length > 0 && (
                  <div>
                    <h4 className="text-sm font-medium mb-2 text-foreground">Confirmed</h4>
                    <div className="divide-y divide-border border rounded-md">
                      {confirmedFields.map(([key, pf]) => {
                        const def = FIELD_DEFS.find((f) => f.key === key);
                        return (
                          <div key={key} className="flex items-center justify-between p-3 gap-4">
                            <span className="text-sm text-muted-foreground">{def?.label ?? key}</span>
                            <div className="flex items-center gap-2">
                              <span className="text-sm font-medium">{String(pf.value)}</span>
                              <ProvenanceBadge source={pf.source} />
                            </div>
                          </div>
                        );
                      })}
                    </div>
                  </div>
                )}
                {unconfirmedFields.length > 0 && (
                  <div>
                    <h4 className="text-sm font-medium mb-2 text-amber-700">Pending confirmation</h4>
                    <div className="divide-y divide-border border rounded-md">
                      {unconfirmedFields.map(([key, pf]) => {
                        const def = FIELD_DEFS.find((f) => f.key === key);
                        return (
                          <div key={key} className="flex items-center justify-between p-3 gap-4">
                            <span className="text-sm text-muted-foreground">{def?.label ?? key}</span>
                            <div className="flex items-center gap-2">
                              <span className="text-sm font-medium text-amber-700">{String(pf.value)}</span>
                              <ProvenanceBadge source={pf.source} />
                            </div>
                          </div>
                        );
                      })}
                    </div>
                    <p className="text-xs text-amber-700 mt-2">
                      Unconfirmed values won't be used in research. Upload a new document to re-confirm.
                    </p>
                  </div>
                )}
              </div>
            )}
          </CardContent>
        </Card>
      ) : (
        <Card>
          <CardContent className="py-8 text-center">
            <FileText className="h-10 w-10 text-muted-foreground mx-auto mb-3" />
            <p className="text-sm text-muted-foreground mb-4">No current deal details saved yet.</p>
            <Button
              variant="outline"
              onClick={() => setEditMode(true)}
              className="gap-2"
            >
              <Pencil className="h-4 w-4" />
              Enter manually
            </Button>
            {editMode && (
              <div className="mt-4 text-left">
                <ManualDealEditor
                  serviceId={serviceId}
                  fields={fields}
                  onSaved={() => {
                    setEditMode(false);
                    queryClient.invalidateQueries({ queryKey: getGetCurrentDealQueryKey(serviceId) });
                  }}
                />
              </div>
            )}
          </CardContent>
        </Card>
      )}
    </div>
  );
}
