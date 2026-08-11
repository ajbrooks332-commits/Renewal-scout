/**
 * Service Requirements Tab — shown inside the service detail page.
 * Renders service-type-specific questions; saves to /api/services/:id/requirements.
 *
 * Answer-state semantics (mirrored server-side):
 *   - Field key absent from API response → unanswered (never set)
 *   - Field key present with null value  → "I don't know" (explicit)
 *   - Field key present with a value     → answered
 *
 * unknownFields: local set of field keys the user has explicitly toggled as
 * "I don't know". Sent to the API so the UI can restore toggle state even if
 * the value is null for another reason.
 */
import { useState, useEffect } from "react";
import { useGetServiceRequirements, useUpdateServiceRequirements } from "@workspace/api-client-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { useToast } from "@/hooks/use-toast";
import { Save, Loader2 } from "lucide-react";

// ─── Question definitions per service type ─────────────────────────────────────

type FieldType = "number" | "select" | "boolean";

interface FieldDef {
  key: string;
  label: string;
  hint?: string;
  type: FieldType;
  options?: { value: string; label: string }[];
  min?: number;
  max?: number;
  placeholder?: string;
}

const QUESTIONS: Record<string, FieldDef[]> = {
  // ── Broadband ─────────────────────────────────────────────────────────────
  Broadband: [
    { key: "downloadSpeedMbps",    label: "Minimum download speed (Mbps)",  type: "number", placeholder: "e.g. 50" },
    { key: "uploadSpeedMbps",      label: "Minimum upload speed (Mbps)",    type: "number", placeholder: "e.g. 10" },
    { key: "simultaneousUsers",    label: "Typical simultaneous users",     type: "number", placeholder: "e.g. 3", min: 1, max: 20 },
    { key: "workFromHome",         label: "Do you regularly work from home?", type: "boolean" },
    { key: "videoCallsFrequent",   label: "Frequent video calls (Teams, Zoom, etc.)?", type: "boolean" },
    { key: "onlineGaming",         label: "Online gaming in the household?",  type: "boolean" },
    { key: "streamingHd",          label: "4K / HD streaming (Netflix, Disney+, etc.)?", type: "boolean" },
    { key: "landlineRequired",     label: "Must include a landline / line rental?", type: "boolean" },
    { key: "fullFibrePreferred",   label: "Prefer full fibre (FTTP) over part-fibre (FTTC)?", type: "boolean" },
    { key: "maxContractMonths",    label: "Maximum contract length (months)", type: "select",
      options: [
        { value: "12",  label: "12 months" },
        { value: "18",  label: "18 months" },
        { value: "24",  label: "24 months" },
        { value: "any", label: "No preference" },
      ]
    },
    { key: "maxMonthlyBudgetGbp",  label: "Maximum monthly budget (£)",    type: "number", placeholder: "e.g. 35", min: 0 },
    { key: "linkedSkyTv",          label: "Do you already have a Sky TV subscription?", type: "boolean",
      hint: "If yes, you may be eligible for bundle pricing." },
    { key: "linkedSkyMobile",      label: "Do you already have Sky Mobile?",  type: "boolean" },
    { key: "linkedVirginMedia",    label: "Do you already have Virgin Media?", type: "boolean" },
    { key: "bundleDiscountImportant", label: "Is a bundle discount important to you?", type: "boolean" },
    { key: "willingToSplitBundle", label: "Would you consider splitting broadband from your TV bundle?", type: "boolean" },
    { key: "tvAddon",              label: "Want a TV add-on?",             type: "boolean" },
    { key: "homePhoneAddon",       label: "Want a home phone add-on?",     type: "boolean" },
  ],

  // ── Electricity ───────────────────────────────────────────────────────────
  Electricity: [
    { key: "tariffType", label: "Tariff preference", type: "select",
      options: [
        { value: "fixed",    label: "Fixed rate" },
        { value: "variable", label: "Variable rate" },
        { value: "tracker",  label: "Tracker tariff" },
        { value: "economy7", label: "Economy 7 (day/night split)" },
        { value: "any",      label: "No preference" },
      ]
    },
    { key: "greenPreferred",    label: "Prefer 100% renewable energy?",              type: "boolean" },
    { key: "smartMeter",        label: "Do you have a smart meter?",                 type: "boolean" },
    { key: "smartMeterType",    label: "Smart meter type", type: "select",
      hint: "SMETS2 meters work with all suppliers. SMETS1 meters may only work with the original supplier.",
      options: [
        { value: "SMETS1", label: "SMETS1 (first generation)" },
        { value: "SMETS2", label: "SMETS2 (second generation)" },
        { value: "none",   label: "No smart meter" },
      ]
    },
    { key: "paymentMethod",     label: "Preferred payment method", type: "select",
      options: [
        { value: "direct_debit", label: "Direct debit" },
        { value: "prepay",       label: "Prepayment meter" },
        { value: "quarterly",    label: "Quarterly bill" },
        { value: "any",          label: "No preference" },
      ]
    },
    { key: "dayNightSplit",     label: "Do you use Economy 7 / day-night tariff?",  type: "boolean" },
    // EV-specific
    { key: "shiftToOffPeak",    label: "Willing to shift EV charging to off-peak hours?", type: "boolean",
      hint: "Off-peak tariffs can significantly reduce EV charging costs." },
    { key: "homeChargerKw",     label: "Home EV charger power (kW)",                type: "number", placeholder: "e.g. 7", min: 0 },
    { key: "overnightChargingStart", label: "Preferred overnight charging start",   type: "select",
      hint: "Used to match you to off-peak tariff windows.",
      options: [
        { value: "21:00", label: "9 pm" }, { value: "22:00", label: "10 pm" },
        { value: "23:00", label: "11 pm" }, { value: "00:00", label: "Midnight" },
        { value: "01:00", label: "1 am" },
      ]
    },
    // Solar / home battery
    { key: "solarPanels",       label: "Do you have solar panels?",                 type: "boolean" },
    { key: "homeBattery",       label: "Do you have a home battery (e.g. Powerwall)?", type: "boolean" },
    { key: "homeBatteryCapacityKwh", label: "Home battery capacity (kWh)",          type: "number", placeholder: "e.g. 10", min: 0 },
  ],

  // ── Gas and electricity ───────────────────────────────────────────────────
  "Gas and electricity": [
    { key: "tariffType", label: "Tariff preference", type: "select",
      options: [
        { value: "fixed",    label: "Fixed rate" },
        { value: "variable", label: "Variable rate" },
        { value: "tracker",  label: "Tracker tariff" },
        { value: "any",      label: "No preference" },
      ]
    },
    { key: "greenPreferred",    label: "Prefer 100% renewable energy?",              type: "boolean" },
    { key: "smartMeter",        label: "Do you have a smart meter?",                 type: "boolean" },
    { key: "smartMeterType",    label: "Smart meter type", type: "select",
      options: [
        { value: "SMETS1", label: "SMETS1 (first generation)" },
        { value: "SMETS2", label: "SMETS2 (second generation)" },
        { value: "none",   label: "No smart meter" },
      ]
    },
    { key: "paymentMethod",     label: "Preferred payment method", type: "select",
      options: [
        { value: "direct_debit", label: "Direct debit" },
        { value: "prepay",       label: "Prepayment meter" },
        { value: "quarterly",    label: "Quarterly bill" },
        { value: "any",          label: "No preference" },
      ]
    },
    { key: "shiftToOffPeak",    label: "Willing to shift EV charging to off-peak hours?", type: "boolean" },
    { key: "homeChargerKw",     label: "Home EV charger power (kW)",                type: "number", placeholder: "e.g. 7", min: 0 },
    { key: "solarPanels",       label: "Do you have solar panels?",                 type: "boolean" },
    { key: "homeBattery",       label: "Do you have a home battery?",               type: "boolean" },
    { key: "homeBatteryCapacityKwh", label: "Home battery capacity (kWh)",          type: "number", placeholder: "e.g. 10", min: 0 },
  ],

  // ── Car insurance ─────────────────────────────────────────────────────────
  "Car insurance": [
    { key: "coverType", label: "Cover type", type: "select",
      options: [
        { value: "comprehensive", label: "Comprehensive" },
        { value: "tpft",          label: "Third party, fire & theft" },
        { value: "tpo",           label: "Third party only" },
      ]
    },
    { key: "namedDrivers",    label: "Number of named drivers (including you)", type: "number", placeholder: "e.g. 1", min: 1, max: 10 },
    { key: "parkingLocation", label: "Where is the car parked overnight?", type: "select",
      options: [
        { value: "garage",   label: "Garage" },
        { value: "driveway", label: "Driveway / off-road" },
        { value: "street",   label: "Street / public road" },
      ]
    },
    { key: "voluntaryExcessGbp", label: "Preferred voluntary excess (£)", type: "number", placeholder: "e.g. 250" },
    { key: "useType", label: "Vehicle use", type: "select",
      options: [
        { value: "social",     label: "Social, domestic & pleasure only" },
        { value: "commuting",  label: "Social + commuting" },
        { value: "business",   label: "Business use" },
      ]
    },
  ],

  // ── Home insurance ────────────────────────────────────────────────────────
  "Home insurance": [
    { key: "coverType", label: "Cover needed", type: "select",
      options: [
        { value: "buildings_and_contents", label: "Buildings & contents" },
        { value: "buildings_only",         label: "Buildings only" },
        { value: "contents_only",          label: "Contents only" },
      ]
    },
    { key: "voluntaryExcessGbp", label: "Preferred voluntary excess (£)", type: "number", placeholder: "e.g. 250" },
    { key: "highValueItems",     label: "High-value items (jewellery, art, etc.) to specify?", type: "boolean" },
    { key: "floodRisk",          label: "Is the property in a flood risk area?",             type: "boolean" },
  ],

  // ── Life insurance ────────────────────────────────────────────────────────
  "Life insurance": [
    { key: "coverType", label: "Cover type", type: "select",
      options: [
        { value: "level_term",      label: "Level term" },
        { value: "decreasing_term", label: "Decreasing term" },
        { value: "whole_of_life",   label: "Whole of life" },
      ]
    },
    { key: "termYears",           label: "Cover term (years)", type: "number", placeholder: "e.g. 25", min: 1, max: 50 },
    { key: "jointPolicy",         label: "Joint policy?",                      type: "boolean" },
    { key: "criticalIllnessCover", label: "Include critical illness cover?",   type: "boolean" },
  ],

  // ── Credit card ───────────────────────────────────────────────────────────
  "Credit card": [
    { key: "primaryUse", label: "Primary use", type: "select",
      options: [
        { value: "purchases",         label: "Everyday purchases" },
        { value: "balance_transfer",  label: "Balance transfer" },
        { value: "travel",            label: "Travel rewards" },
        { value: "cashback",          label: "Cashback" },
      ]
    },
    { key: "balanceTransfer", label: "Planning a balance transfer?", type: "boolean" },
  ],

  // ── Loan ──────────────────────────────────────────────────────────────────
  Loan: [
    { key: "purposeOfLoan", label: "Loan purpose", type: "select",
      options: [
        { value: "home_improvement",   label: "Home improvement" },
        { value: "car",                label: "Car" },
        { value: "debt_consolidation", label: "Debt consolidation" },
        { value: "other",              label: "Other" },
      ]
    },
    { key: "amountGbp",   label: "Loan amount (£)",          type: "number", placeholder: "e.g. 10000" },
    { key: "termMonths",  label: "Preferred term (months)",  type: "number", placeholder: "e.g. 36" },
  ],

  // ── Mobile phone ─────────────────────────────────────────────────────────
  "Mobile phone": [
    { key: "dataGb",          label: "Minimum data per month (GB)",  type: "number", placeholder: "e.g. 10" },
    { key: "includesHandset", label: "Include new handset in the deal?", type: "boolean" },
    { key: "contractMonths",  label: "Contract length (months)", type: "select",
      options: [
        { value: "12",      label: "12 months" },
        { value: "24",      label: "24 months" },
        { value: "rolling", label: "Rolling (SIM-only)" },
      ]
    },
    { key: "roamingNeeded",   label: "Regular EU/international roaming needed?", type: "boolean" },
  ],
};

// ─── Field input components ────────────────────────────────────────────────────

function BoolField({
  value,
  onChange,
  onExplicitUnknown,
}: {
  value: boolean | null;
  onChange: (v: boolean | null) => void;
  onExplicitUnknown?: (unknown: boolean) => void;
}) {
  return (
    <Select
      value={value === null ? "__unknown__" : value ? "yes" : "no"}
      onValueChange={(v) => {
        const isUnknown = v === "__unknown__";
        onChange(isUnknown ? null : v === "yes");
        onExplicitUnknown?.(isUnknown);
      }}
    >
      <SelectTrigger><SelectValue /></SelectTrigger>
      <SelectContent>
        <SelectItem value="__unknown__">I don't know</SelectItem>
        <SelectItem value="yes">Yes</SelectItem>
        <SelectItem value="no">No</SelectItem>
      </SelectContent>
    </Select>
  );
}

// ─── Main component ────────────────────────────────────────────────────────────

export function ServiceRequirementsTab({
  serviceId,
  serviceType,
}: {
  serviceId: number;
  serviceType: string;
}) {
  const { toast } = useToast();
  const [localFields, setLocalFields] = useState<Record<string, unknown>>({});
  const [unknownFields, setUnknownFields] = useState<Set<string>>(new Set());
  const [dirty, setDirty] = useState(false);

  const { data, isLoading } = useGetServiceRequirements(serviceId);
  const save = useUpdateServiceRequirements();

  const questions = QUESTIONS[serviceType] ?? [];

  useEffect(() => {
    if (data) {
      setLocalFields((data.fields as Record<string, unknown>) ?? {});
      // unknownFields is now in the generated ServiceRequirements type
      const uf = data.unknownFields ?? [];
      setUnknownFields(new Set(uf));
    }
  }, [data?.updatedAt]);

  function setField(key: string, value: unknown) {
    setDirty(true);
    setLocalFields((f) => ({ ...f, [key]: value }));
  }

  function setExplicitUnknown(key: string, isUnknown: boolean) {
    setUnknownFields((prev) => {
      const next = new Set(prev);
      if (isUnknown) next.add(key);
      else next.delete(key);
      return next;
    });
  }

  function handleSave() {
    save.mutate(
      {
        id: serviceId,
        data: {
          fields: localFields,
          unknownFields: Array.from(unknownFields),
        } as Parameters<typeof save.mutate>[0]["data"],
      },
      {
        onSuccess: () => {
          toast({ title: "Requirements saved" });
          setDirty(false);
        },
        onError: (err) => {
          toast({
            title: "Failed to save",
            description: (err as { data?: { error?: string } }).data?.error ?? "Unknown error",
            variant: "destructive",
          });
        },
      },
    );
  }

  if (isLoading) {
    return (
      <div className="flex items-center gap-2 py-8 text-muted-foreground">
        <Loader2 className="h-4 w-4 animate-spin" /> Loading…
      </div>
    );
  }

  if (questions.length === 0) {
    return (
      <Card>
        <CardContent className="py-8 text-center text-muted-foreground text-sm">
          No service-specific requirements for <strong>{serviceType}</strong> yet.
          General requirements can be entered in the service edit form.
        </CardContent>
      </Card>
    );
  }

  return (
    <div className="space-y-6">
      <Card>
        <CardHeader>
          <CardTitle>Service Requirements</CardTitle>
          <CardDescription>
            Tell the AI what you need from your {serviceType} deal. Leave anything
            you're not sure about blank, or select "I don't know" to acknowledge
            the question.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-5">
          {questions.map((q) => {
            const value = localFields[q.key] ?? null;
            return (
              <div key={q.key}>
                <Label className="text-sm font-medium">{q.label}</Label>
                {q.hint && (
                  <p className="text-xs text-muted-foreground mt-0.5 mb-1">{q.hint}</p>
                )}
                <div className="mt-1">
                  {q.type === "boolean" ? (
                    <BoolField
                      value={value as boolean | null}
                      onChange={(v) => setField(q.key, v)}
                      onExplicitUnknown={(isUnknown) => {
                        setDirty(true);
                        setExplicitUnknown(q.key, isUnknown);
                      }}
                    />
                  ) : q.type === "select" ? (
                    <Select
                      value={(value as string | null) ?? "__unknown__"}
                      onValueChange={(v) => {
                        const isUnknown = v === "__unknown__";
                        setField(q.key, isUnknown ? null : v);
                        setDirty(true);
                        setExplicitUnknown(q.key, isUnknown);
                      }}
                    >
                      <SelectTrigger><SelectValue placeholder="Select…" /></SelectTrigger>
                      <SelectContent>
                        <SelectItem value="__unknown__">I don't know / no preference</SelectItem>
                        {q.options?.map((o) => (
                          <SelectItem key={o.value} value={o.value}>{o.label}</SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  ) : (
                    <Input
                      type="number"
                      placeholder={q.placeholder ?? "Leave blank if unknown"}
                      min={q.min}
                      max={q.max}
                      value={(value as number | null) ?? ""}
                      onChange={(e) =>
                        setField(q.key, e.target.value === "" ? null : Number(e.target.value))
                      }
                    />
                  )}
                </div>
              </div>
            );
          })}
        </CardContent>
      </Card>

      <div className="flex justify-end">
        <Button onClick={handleSave} disabled={save.isPending || !dirty} className="gap-2">
          {save.isPending ? (
            <Loader2 className="h-4 w-4 animate-spin" />
          ) : (
            <Save className="h-4 w-4" />
          )}
          Save Requirements
        </Button>
      </div>
    </div>
  );
}
