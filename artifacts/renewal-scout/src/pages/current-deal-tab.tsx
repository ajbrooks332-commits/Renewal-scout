/**
 * Current Deal Tab — shown inside the service detail page.
 * Displays deal fields with provenance badges, upload button, and extraction confirmation.
 */
import { useState, useRef } from "react";
import { useQueryClient } from "@tanstack/react-query";
import {
  useGetCurrentDeal,
  useUpdateCurrentDeal,
  useExtractDocument,
  useConfirmExtractionDraft,
  getGetCurrentDealQueryKey,
} from "@workspace/api-client-react";
import type { ProvenanceField, CurrentDealFields, ExtractionDraft } from "@workspace/api-client-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { useToast } from "@/hooks/use-toast";
import {
  Upload, Save, Loader2, Check, X, FileText, AlertTriangle, Pencil, Info
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
  { key: "monthlyCostGbp", label: "Monthly cost (£)", type: "number", placeholder: "e.g. 45.99" },
  { key: "annualCostGbp", label: "Annual cost (£)", type: "number" },
  { key: "renewalDate", label: "Renewal date", type: "date" },
  { key: "contractEndDate", label: "Contract end date", type: "date" },
  { key: "exitFeeGbp", label: "Exit / cancellation fee (£)", type: "number" },
  { key: "noticeDays", label: "Notice period (days)", type: "number" },
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
  const [local, setLocal] = useState<Record<string, unknown>>(() => {
    const out: Record<string, unknown> = {};
    for (const { key } of FIELD_DEFS) {
      const pf = fields[key];
      if (pf?.source === "user") out[key] = pf.value;
    }
    return out;
  });
  const save = useUpdateCurrentDeal();

  function handleSave() {
    const merged: DealFieldsMap = { ...fields };
    for (const { key } of FIELD_DEFS) {
      const val = local[key];
      if (val !== null && val !== undefined && String(val).trim() !== "") {
        merged[key] = { value: val, source: "user" };
      } else if (merged[key]?.source === "user") {
        delete merged[key];
      }
    }
    save.mutate(
      { id: serviceId, data: { fields: merged as unknown as CurrentDealFields } },
      {
        onSuccess: () => { toast({ title: "Deal saved" }); onSaved(); },
        onError: (err) => {
          toast({ title: "Failed to save", description: (err as { data?: { error?: string } }).data?.error, variant: "destructive" });
        },
      },
    );
  }

  return (
    <div className="space-y-4">
      {FIELD_DEFS.map(({ key, label, type, placeholder }) => (
        <div key={key}>
          <Label className="text-sm font-medium">{label}</Label>
          <Input
            type={type === "number" ? "number" : type === "date" ? "date" : "text"}
            placeholder={placeholder ?? "Leave blank if unknown"}
            value={(local[key] as string | number | undefined) ?? ""}
            onChange={(e) => setLocal((l) => ({ ...l, [key]: e.target.value || null }))}
            className="mt-1"
          />
          {fields[key] && fields[key]!.source !== "user" && (
            <div className="mt-1"><ProvenanceBadge source={fields[key]!.source} /></div>
          )}
        </div>
      ))}
      <Button onClick={handleSave} disabled={save.isPending} className="gap-2">
        {save.isPending ? <Loader2 className="h-4 w-4 animate-spin" /> : <Save className="h-4 w-4" />}
        Save Deal Details
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

  // Local edits to extracted values
  const [localValues, setLocalValues] = useState<Record<string, unknown>>(() => {
    const out: Record<string, unknown> = {};
    for (const [k, pf] of Object.entries(draft.fields as Record<string, { value: unknown; source: string }>)) {
      out[k] = pf.value;
    }
    return out;
  });
  const [deleted, setDeleted] = useState<Set<string>>(new Set());

  function handleConfirm() {
    const confirmedFields: DealFieldsMap = {};
    for (const key of Object.keys(draft.fields as object)) {
      if (!deleted.has(key)) {
        confirmedFields[key] = { value: localValues[key] ?? null, source: "extracted_confirmed" };
      }
    }
    confirm.mutate(
      {
        id: serviceId,
        extractionId: draft.extractionId,
        data: {
          confirmedFields: confirmedFields as unknown as Parameters<typeof confirm.mutate>[0]["data"]["confirmedFields"],
          deletedFields: Array.from(deleted),
        },
      },
      {
        onSuccess: () => {
          toast({ title: "Extraction confirmed", description: "Confirmed fields saved to current deal." });
          queryClient.invalidateQueries({ queryKey: getGetCurrentDealQueryKey(serviceId) });
          onDone();
        },
        onError: (err) => {
          toast({ title: "Failed to confirm", description: (err as { data?: { error?: string } }).data?.error, variant: "destructive" });
        },
      },
    );
  }

  const extractedKeys = Object.keys(draft.fields as object);
  const labelFor = (key: string) => FIELD_DEFS.find((f) => f.key === key)?.label ?? key;
  const typeFor = (key: string) => FIELD_DEFS.find((f) => f.key === key)?.type ?? "text";

  return (
    <div className="space-y-4">
      <div className="bg-amber-50 border border-amber-200 rounded-md p-4 flex gap-3 text-sm text-amber-800">
        <AlertTriangle className="h-4 w-4 mt-0.5 shrink-0 text-amber-600" />
        <div>
          <strong>Review all extracted values before confirming.</strong>{" "}
          {draft.aiDisclosure} Edit any incorrect values, then click Confirm.
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
        <Button onClick={handleConfirm} disabled={confirm.isPending} className="gap-2">
          {confirm.isPending ? <Loader2 className="h-4 w-4 animate-spin" /> : <Check className="h-4 w-4" />}
          Confirm {extractedKeys.length - deleted.size} field(s)
        </Button>
        <Button variant="outline" onClick={onDiscard}>
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

  const { data, isLoading } = useGetCurrentDeal(serviceId);
  const extract = useExtractDocument();

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

  if (isLoading) {
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
            Your document will be sent to the OpenAI API for processing — it is not stored by Renewal Scout.
          </CardDescription>
        </CardHeader>
        <CardContent>
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
              disabled={isUploading}
              className="gap-2"
            >
              {isUploading ? <Loader2 className="h-4 w-4 animate-spin" /> : <Upload className="h-4 w-4" />}
              {isUploading ? "Extracting…" : "Upload document"}
            </Button>
            <span className="text-xs text-muted-foreground">PDF, JPG, PNG · max 10 MB</span>
          </div>
          <p className="text-xs text-muted-foreground mt-3 flex gap-1.5">
            <Info className="h-3.5 w-3.5 shrink-0 mt-0.5" />
            No credentials, bank details, or sensitive personal information should appear in uploaded documents.
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
