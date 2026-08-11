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
 *
 * showWhen: optional condition on a FieldDef that hides a question until a
 * sibling field equals a specific value. Used to progressively disclose
 * detail questions (e.g. Sky TV package details only when linkedSkyTv=true,
 * EV details only when evOwner=true).
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

type FieldType = "number" | "select" | "boolean" | "text";

interface FieldDef {
  key: string;
  label: string;
  hint?: string;
  type: FieldType;
  options?: { value: string; label: string }[];
  min?: number;
  max?: number;
  placeholder?: string;
  /**
   * When present, this question is only shown when `localFields[showWhen.field]`
   * equals `showWhen.value` exactly. Used for progressive disclosure of detail
   * questions (e.g. Sky TV sub-questions, EV detail fields).
   */
  showWhen?: { field: string; value: unknown };
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
    // Sky TV detail questions — shown only when linkedSkyTv = true
    { key: "skyTvPackage",         label: "Current Sky TV package",         type: "select",
      showWhen: { field: "linkedSkyTv", value: true },
      options: [
        { value: "sky_q",      label: "Sky Q" },
        { value: "sky_glass",  label: "Sky Glass" },
        { value: "sky_stream", label: "Sky Stream" },
        { value: "sky_basic",  label: "Sky Basic / Now TV box" },
      ]
    },
    { key: "skyTvSportsRequired",  label: "Must keep Sky Sports?",          type: "boolean",
      showWhen: { field: "linkedSkyTv", value: true },
      hint: "Affects whether bundle providers must include a sports add-on." },
    { key: "skyTvCinemaRequired",  label: "Must keep Sky Cinema?",          type: "boolean",
      showWhen: { field: "linkedSkyTv", value: true } },
    { key: "linkedSkyMobile",      label: "Do you already have Sky Mobile?",  type: "boolean" },
    // Sky Mobile detail — shown only when linkedSkyMobile = true
    { key: "skyMobileLines",       label: "Number of Sky Mobile SIM / phone lines", type: "number",
      showWhen: { field: "linkedSkyMobile", value: true },
      placeholder: "e.g. 2", min: 1 },
    { key: "skyMobilePlan",        label: "Current Sky Mobile plan(s)", type: "text",
      showWhen: { field: "linkedSkyMobile", value: true },
      placeholder: "e.g. 20 GB SIM-only, two lines" },
    { key: "linkedVirginMedia",    label: "Do you already have Virgin Media?", type: "boolean" },
    { key: "bundleDiscountImportant", label: "Is a bundle discount important to you?", type: "boolean" },
    // Bundle discount detail — shown when bundleDiscountImportant = true
    { key: "currentBundleDiscountGbp", label: "Current bundle discount (£/month, if known)", type: "number",
      showWhen: { field: "bundleDiscountImportant", value: true },
      placeholder: "e.g. 10", min: 0 },
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
    // ── EV ownership gate ─────────────────────────────────────────────────────
    { key: "evOwner",           label: "Do you have an electric or plug-in hybrid vehicle (EV/PHEV)?", type: "boolean",
      hint: "Enables EV-specific tariff comparisons (off-peak charging, EV tariffs)." },
    // EV detail questions — only shown when evOwner = true
    { key: "evMake",            label: "EV make (e.g. Tesla, Volkswagen, Nissan)",  type: "text",
      showWhen: { field: "evOwner", value: true },
      placeholder: "e.g. Tesla" },
    { key: "evModel",           label: "EV model (e.g. Model 3, Leaf, e-Golf)",     type: "text",
      showWhen: { field: "evOwner", value: true },
      placeholder: "e.g. Model 3" },
    { key: "evBatteryCapacityKwh", label: "EV battery capacity (kWh)",              type: "number",
      showWhen: { field: "evOwner", value: true },
      placeholder: "e.g. 75", min: 0 },
    { key: "evAnnualMileage",   label: "Estimated annual EV mileage",               type: "number",
      showWhen: { field: "evOwner", value: true },
      placeholder: "e.g. 10000", min: 0 },
    { key: "shiftToOffPeak",    label: "Willing to shift EV charging to off-peak hours?", type: "boolean",
      showWhen: { field: "evOwner", value: true },
      hint: "Off-peak tariffs can significantly reduce EV charging costs." },
    { key: "homeChargerKw",     label: "Home EV charger power (kW)",                type: "number",
      showWhen: { field: "evOwner", value: true },
      placeholder: "e.g. 7", min: 0 },
    { key: "overnightChargingStart", label: "Preferred overnight charging start",   type: "select",
      showWhen: { field: "evOwner", value: true },
      hint: "Used to match you to off-peak tariff windows.",
      options: [
        { value: "21:00", label: "9 pm" }, { value: "22:00", label: "10 pm" },
        { value: "23:00", label: "11 pm" }, { value: "00:00", label: "Midnight" },
        { value: "01:00", label: "1 am" },
      ]
    },
    { key: "overnightChargingEnd", label: "Preferred overnight charging end",       type: "select",
      showWhen: { field: "evOwner", value: true },
      options: [
        { value: "04:00", label: "4 am" }, { value: "05:00", label: "5 am" },
        { value: "06:00", label: "6 am" }, { value: "07:00", label: "7 am" },
        { value: "08:00", label: "8 am" },
      ]
    },
    { key: "dayUsagePercent",   label: "Approximate % of electricity used during the day (6am–11pm)", type: "number",
      showWhen: { field: "evOwner", value: true },
      hint: "Helps assess whether a day/night split tariff would save money.",
      placeholder: "e.g. 70", min: 0, max: 100 },
    // ── Solar / home battery ──────────────────────────────────────────────────
    { key: "solarPanels",       label: "Do you have solar panels?",                 type: "boolean" },
    { key: "solarExportTariff", label: "Do you have a solar export (SEG) tariff?",  type: "boolean",
      hint: "Affects which suppliers are optimal for solar owners." },
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
    { key: "dayNightSplit",     label: "Do you use Economy 7 / day-night tariff?",  type: "boolean" },
    // ── EV ownership gate ─────────────────────────────────────────────────────
    { key: "evOwner",           label: "Do you have an electric or plug-in hybrid vehicle (EV/PHEV)?", type: "boolean",
      hint: "Enables EV-specific tariff comparisons." },
    // EV detail questions — only shown when evOwner = true
    { key: "evMake",            label: "EV make (e.g. Tesla, Volkswagen, Nissan)",  type: "text",
      showWhen: { field: "evOwner", value: true },
      placeholder: "e.g. Tesla" },
    { key: "evModel",           label: "EV model (e.g. Model 3, Leaf, e-Golf)",     type: "text",
      showWhen: { field: "evOwner", value: true },
      placeholder: "e.g. Model 3" },
    { key: "evBatteryCapacityKwh", label: "EV battery capacity (kWh)",              type: "number",
      showWhen: { field: "evOwner", value: true },
      placeholder: "e.g. 75", min: 0 },
    { key: "evAnnualMileage",   label: "Estimated annual EV mileage",               type: "number",
      showWhen: { field: "evOwner", value: true },
      placeholder: "e.g. 10000", min: 0 },
    { key: "shiftToOffPeak",    label: "Willing to shift EV charging to off-peak hours?", type: "boolean",
      showWhen: { field: "evOwner", value: true } },
    { key: "homeChargerKw",     label: "Home EV charger power (kW)",                type: "number",
      showWhen: { field: "evOwner", value: true },
      placeholder: "e.g. 7", min: 0 },
    { key: "overnightChargingStart", label: "Preferred overnight charging start",   type: "select",
      showWhen: { field: "evOwner", value: true },
      options: [
        { value: "21:00", label: "9 pm" }, { value: "22:00", label: "10 pm" },
        { value: "23:00", label: "11 pm" }, { value: "00:00", label: "Midnight" },
        { value: "01:00", label: "1 am" },
      ]
    },
    { key: "overnightChargingEnd", label: "Preferred overnight charging end",       type: "select",
      showWhen: { field: "evOwner", value: true },
      options: [
        { value: "04:00", label: "4 am" }, { value: "05:00", label: "5 am" },
        { value: "06:00", label: "6 am" }, { value: "07:00", label: "7 am" },
        { value: "08:00", label: "8 am" },
      ]
    },
    { key: "dayUsagePercent",   label: "Approximate % of electricity used during the day (6am–11pm)", type: "number",
      showWhen: { field: "evOwner", value: true },
      placeholder: "e.g. 70", min: 0, max: 100 },
    // ── Solar / home battery ──────────────────────────────────────────────────
    { key: "solarPanels",       label: "Do you have solar panels?",                 type: "boolean" },
    { key: "solarExportTariff", label: "Do you have a solar export (SEG) tariff?",  type: "boolean" },
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
    { key: "modifiedVehicle", label: "Has the vehicle been modified?", type: "boolean" },
    { key: "voluntaryExcessGbp", label: "Preferred voluntary excess (£)", type: "number", placeholder: "e.g. 250" },
    { key: "useType", label: "Vehicle use", type: "select",
      options: [
        { value: "social",         label: "Social / domestic / pleasure" },
        { value: "social_commute", label: "Social + commuting" },
        { value: "business",       label: "Business use" },
      ]
    },
    { key: "noClaimsYears",   label: "No-claims bonus (years)", type: "number", placeholder: "e.g. 5", min: 0, max: 30 },
    { key: "addBreakdownCover", label: "Include breakdown cover?", type: "boolean" },
    { key: "addLegalExpenses",  label: "Include legal expenses cover?", type: "boolean" },
    { key: "addCourtesy",       label: "Include courtesy car?", type: "boolean" },
    { key: "maxAnnualBudgetGbp", label: "Maximum annual premium (£)", type: "number", placeholder: "e.g. 600", min: 0 },
  ],

  // ── Home insurance ────────────────────────────────────────────────────────
  "Home insurance": [
    { key: "coverType", label: "Cover type", type: "select",
      options: [
        { value: "buildings_and_contents", label: "Buildings & contents" },
        { value: "buildings",              label: "Buildings only" },
        { value: "contents",               label: "Contents only" },
      ]
    },
    { key: "voluntaryExcessGbp", label: "Preferred voluntary excess (£)", type: "number", placeholder: "e.g. 250" },
    { key: "rebuildValueGbp",     label: "Estimated rebuild value (£)", type: "number", placeholder: "e.g. 250000", min: 0 },
    { key: "addAccidentalDamage",  label: "Include accidental damage cover?", type: "boolean" },
    { key: "addPersonalPossessions", label: "Include personal possessions (away from home)?", type: "boolean" },
    { key: "addLegalExpenses",     label: "Include legal expenses cover?",    type: "boolean" },
    { key: "contentsValueGbp",     label: "Estimated contents value (£)",     type: "number", placeholder: "e.g. 30000", min: 0 },
    { key: "prevClaims",           label: "Home insurance claims in the last 5 years", type: "number", placeholder: "0 if none", min: 0, max: 20 },
    { key: "highValueItems",       label: "Do you need cover for high-value items?", type: "boolean" },
    { key: "floodRisk",            label: "Is the property in a known flood-risk area?", type: "boolean" },
    { key: "maxAnnualBudgetGbp",   label: "Maximum annual premium (£)",       type: "number", placeholder: "e.g. 400", min: 0 },
  ],

  // ── Life insurance ────────────────────────────────────────────────────────
  "Life insurance": [
    { key: "coverType", label: "Policy type", type: "select",
      options: [
        { value: "level_term",     label: "Level term" },
        { value: "decreasing_term",label: "Decreasing term (e.g. mortgage)" },
        { value: "whole_of_life",  label: "Whole of life" },
        { value: "joint",          label: "Joint policy" },
      ]
    },
    { key: "coverAmountGbp",    label: "Required cover amount (£)",   type: "number", placeholder: "e.g. 250000", min: 0 },
    { key: "termYears",         label: "Required term (years)",        type: "number", placeholder: "e.g. 25", min: 1, max: 50 },
    { key: "criticalIllness",   label: "Include critical illness cover?", type: "boolean" },
    { key: "jointPolicy",       label: "Do you require a joint policy?", type: "boolean" },
    { key: "indexLinked",       label: "Should the policy be index-linked?", type: "boolean" },
    { key: "maxAnnualBudgetGbp",label: "Maximum annual premium (£)",  type: "number", placeholder: "e.g. 300", min: 0 },
  ],

  // ── Mobile phone ──────────────────────────────────────────────────────────
  "Mobile phone": [
    { key: "monthlyDataGb",    label: "Monthly data needed (GB)",    type: "number", placeholder: "e.g. 20", min: 0 },
    { key: "unlimitedData",    label: "Need unlimited data?",         type: "boolean" },
    { key: "roamingEu",        label: "Must include EU roaming?",     type: "boolean" },
    { key: "roamingWorld",     label: "Must include worldwide roaming?", type: "boolean" },
    { key: "sim_only",         label: "SIM-only deal (no new handset)?", type: "boolean" },
    { key: "maxContractMonths",label: "Maximum contract length (months)", type: "select",
      options: [
        { value: "1",   label: "1 month (rolling)" },
        { value: "12",  label: "12 months" },
        { value: "24",  label: "24 months" },
        { value: "any", label: "No preference" },
      ]
    },
    { key: "maxMonthlyBudgetGbp", label: "Maximum monthly budget (£)", type: "number", placeholder: "e.g. 20", min: 0 },
  ],

  // ── Credit card ───────────────────────────────────────────────────────────
  "Credit card": [
    { key: "primaryUse", label: "What is the card mainly for?", type: "select",
      options: [
        { value: "purchases",        label: "Everyday purchases / 0% purchases" },
        { value: "balance_transfer", label: "Balance transfer" },
        { value: "travel",           label: "Travel / no foreign transaction fees" },
        { value: "cashback",         label: "Cashback" },
        { value: "rewards",          label: "Points or rewards" },
      ]
    },
    { key: "creditLimitGbp", label: "Preferred credit limit (£, if known)", type: "number", min: 0 },
    { key: "rewardPreference", label: "Reward preference", type: "text", placeholder: "e.g. airline points or cashback" },
    { key: "balanceTransfer", label: "Do you need to transfer an existing balance?", type: "boolean" },
    { key: "balanceTransferAmountGbp", label: "Approximate balance to transfer (£)", type: "number",
      showWhen: { field: "balanceTransfer", value: true }, min: 0 },
    { key: "maxAnnualFeeGbp", label: "Maximum acceptable annual fee (£)", type: "number", min: 0 },
  ],

  // ── Loan ──────────────────────────────────────────────────────────────────
  Loan: [
    { key: "purposeOfLoan", label: "Purpose of the loan", type: "text", placeholder: "e.g. home improvements" },
    { key: "amountGbp", label: "Amount required (£)", type: "number", min: 0 },
    { key: "termMonths", label: "Preferred repayment term (months)", type: "number", min: 1, max: 360 },
    { key: "maxAprPct", label: "Maximum acceptable representative APR (%)", type: "number", min: 0 },
  ],
};

// ─── Boolean field component ──────────────────────────────────────────────────

function BoolField({
  value,
  onChange,
  onExplicitUnknown,
}: {
  value: boolean | null;
  onChange: (v: boolean | null) => void;
  onExplicitUnknown: (isUnknown: boolean) => void;
}) {
  const isUnknown = value === null;
  return (
    <div className="flex flex-wrap gap-2 items-center">
      <button
        type="button"
        onClick={() => { onChange(true); onExplicitUnknown(false); }}
        className={`px-3 py-1.5 rounded-md text-sm border transition-colors ${
          value === true
            ? "bg-primary text-primary-foreground border-primary"
            : "bg-background text-foreground border-border hover:bg-muted"
        }`}
      >
        Yes
      </button>
      <button
        type="button"
        onClick={() => { onChange(false); onExplicitUnknown(false); }}
        className={`px-3 py-1.5 rounded-md text-sm border transition-colors ${
          value === false
            ? "bg-primary text-primary-foreground border-primary"
            : "bg-background text-foreground border-border hover:bg-muted"
        }`}
      >
        No
      </button>
      <button
        type="button"
        onClick={() => { onChange(null); onExplicitUnknown(true); }}
        className={`px-3 py-1.5 rounded-md text-sm border transition-colors ${
          isUnknown
            ? "bg-muted text-muted-foreground border-border"
            : "bg-background text-muted-foreground border-border hover:bg-muted"
        }`}
      >
        I don't know
      </button>
    </div>
  );
}

// ─── Main component ───────────────────────────────────────────────────────────

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
            // Progressive disclosure: skip questions whose gate condition is not met.
            // The gate checks the current local value (not saved), so flipping the
            // gate field in the UI immediately shows/hides dependant questions.
            if (q.showWhen !== undefined) {
              const gateValue = localFields[q.showWhen.field];
              if (gateValue !== q.showWhen.value) return null;
            }

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
                  ) : q.type === "text" ? (
                    <Input
                      type="text"
                      placeholder={q.placeholder ?? "Leave blank if unknown"}
                      value={(value as string | null) ?? ""}
                      onChange={(e) =>
                        setField(q.key, e.target.value === "" ? null : e.target.value)
                      }
                    />
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
