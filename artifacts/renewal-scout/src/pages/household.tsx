import { useState, useEffect } from "react";
import { useLocation } from "wouter";
import { useGetHouseholdProfile, useUpdateHouseholdProfile } from "@workspace/api-client-react";
import { AppLayout } from "@/components/layout";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import { useToast } from "@/hooks/use-toast";
import {
  ChevronLeft, ChevronRight, CheckCircle, Home, Zap, Car, Tv, Save, Loader2
} from "lucide-react";

// ─── Step definitions ──────────────────────────────────────────────────────────

const STEPS = [
  { id: "location", label: "Location", icon: Home },
  { id: "household", label: "Household", icon: Home },
  { id: "energy", label: "Energy & EV", icon: Zap },
  { id: "vehicles", label: "Vehicles", icon: Car },
  { id: "bundles", label: "Bundles & Other", icon: Tv },
  { id: "review", label: "Review & Save", icon: CheckCircle },
];

// ─── Types ────────────────────────────────────────────────────────────────────

type VehicleEntry = {
  make: string | null;
  model: string | null;
  year: number | null;
  valuePence: number | null;
  annualMileage: number | null;
  drivingExperience: string | null;
  claimsLast5Years: number | null;
};

const EMPTY_VEHICLE: VehicleEntry = {
  make: null, model: null, year: null, valuePence: null,
  annualMileage: null, drivingExperience: null, claimsLast5Years: null,
};

type ProfileDraft = {
  postcode: string | null;
  propertyType: string | null;
  tenure: string | null;
  bedrooms: number | null;
  yearBuilt: number | null;
  numAdults: number | null;
  numChildren: number | null;
  heatingType: string | null;
  hasEv: boolean | null;
  evChargerType: string | null;
  hasSolar: boolean | null;
  solarExportTariff: string | null;
  annualElectricityKwh: number | null;
  annualGasKwh: number | null;
  numCars: number | null;
  /** Multi-vehicle records — numCars > 0 should have ≥1 entry */
  vehicles: VehicleEntry[];
  // Legacy single-car convenience aliases (vehicles[0]) — kept for backward compat
  carMake: string | null;
  carModel: string | null;
  carYear: number | null;
  carValue: number | null;
  annualMileage: number | null;
  drivingExperience: string | null;
  claimsLast5Years: number | null;
  hasSkyTv: boolean | null;
  hasSkyMobile: boolean | null;
  hasVirginMedia: boolean | null;
  smoker: boolean | null;
  accessibilityNeeds: string | null;
  generalPreferences: string | null;
  /**
   * Field names where the user explicitly selected "I don't know".
   * Used by the completeness check to avoid blocking on acknowledged unknowns.
   */
  unknownFields: string[];
};

const EMPTY: ProfileDraft = {
  postcode: null, propertyType: null, tenure: null, bedrooms: null,
  yearBuilt: null, numAdults: null, numChildren: null,
  heatingType: null, hasEv: null, evChargerType: null,
  hasSolar: null, solarExportTariff: null,
  annualElectricityKwh: null, annualGasKwh: null,
  numCars: null, vehicles: [],
  carMake: null, carModel: null, carYear: null,
  carValue: null, annualMileage: null, drivingExperience: null,
  claimsLast5Years: null,
  hasSkyTv: null, hasSkyMobile: null, hasVirginMedia: null,
  smoker: null, accessibilityNeeds: null, generalPreferences: null,
  unknownFields: [],
};

// ─── Helper components ────────────────────────────────────────────────────────

function FieldLabel({ children, hint }: { children: React.ReactNode; hint?: string }) {
  return (
    <div className="mb-1">
      <Label className="text-sm font-medium">{children}</Label>
      {hint && <p className="text-xs text-muted-foreground mt-0.5">{hint}</p>}
    </div>
  );
}

function SelectField({
  value, onChange, options, placeholder = "Select…", allowUnknown = true,
}: {
  value: string | null;
  onChange: (v: string | null) => void;
  options: { value: string; label: string }[];
  placeholder?: string;
  allowUnknown?: boolean;
}) {
  return (
    <Select
      value={value ?? "__unknown__"}
      onValueChange={(v) => onChange(v === "__unknown__" ? null : v)}
    >
      <SelectTrigger>
        <SelectValue placeholder={placeholder} />
      </SelectTrigger>
      <SelectContent>
        {allowUnknown && (
          <SelectItem value="__unknown__">I don't know / prefer not to say</SelectItem>
        )}
        {options.map((o) => (
          <SelectItem key={o.value} value={o.value}>{o.label}</SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}

function YesNoField({
  value, onChange, onExplicitUnknown,
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
      <SelectTrigger>
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        <SelectItem value="__unknown__">I don't know</SelectItem>
        <SelectItem value="yes">Yes</SelectItem>
        <SelectItem value="no">No</SelectItem>
      </SelectContent>
    </Select>
  );
}

function NumberField({
  value, onChange, placeholder, min, max,
}: {
  value: number | null;
  onChange: (v: number | null) => void;
  placeholder?: string;
  min?: number;
  max?: number;
}) {
  return (
    <Input
      type="number"
      placeholder={placeholder ?? "Leave blank if unknown"}
      value={value ?? ""}
      min={min}
      max={max}
      onChange={(e) => {
        const v = e.target.value;
        onChange(v === "" ? null : Number(v));
      }}
    />
  );
}

// ─── Step views ───────────────────────────────────────────────────────────────

function LocationStep({ draft, set }: { draft: ProfileDraft; set: (k: keyof ProfileDraft, v: unknown) => void }) {
  return (
    <div className="space-y-5">
      <div>
        <FieldLabel hint="Used for broadband, energy, and home insurance research">Postcode</FieldLabel>
        <Input
          placeholder="e.g. SW1A 1AA"
          value={draft.postcode ?? ""}
          maxLength={10}
          onChange={(e) => set("postcode", e.target.value.toUpperCase() || null)}
        />
      </div>
      <div>
        <FieldLabel>Property type</FieldLabel>
        <SelectField
          value={draft.propertyType}
          onChange={(v) => set("propertyType", v)}
          options={[
            { value: "detached", label: "Detached house" },
            { value: "semi-detached", label: "Semi-detached house" },
            { value: "terraced", label: "Terraced house" },
            { value: "flat", label: "Flat / apartment" },
            { value: "bungalow", label: "Bungalow" },
            { value: "other", label: "Other" },
          ]}
        />
      </div>
      <div>
        <FieldLabel>Tenure</FieldLabel>
        <SelectField
          value={draft.tenure}
          onChange={(v) => set("tenure", v)}
          options={[
            { value: "owner", label: "Owner-occupier" },
            { value: "tenant", label: "Renting" },
            { value: "other", label: "Other" },
          ]}
        />
      </div>
      <div>
        <FieldLabel>Number of bedrooms</FieldLabel>
        <NumberField value={draft.bedrooms} onChange={(v) => set("bedrooms", v)} min={1} max={20} />
      </div>
      <div>
        <FieldLabel hint="Helps with home insurance rebuild value estimates">Year built (approximate)</FieldLabel>
        <NumberField value={draft.yearBuilt} onChange={(v) => set("yearBuilt", v)} placeholder="e.g. 1960" min={1800} max={2030} />
      </div>
    </div>
  );
}

function HouseholdStep({ draft, set }: { draft: ProfileDraft; set: (k: keyof ProfileDraft, v: unknown) => void }) {
  return (
    <div className="space-y-5">
      <div>
        <FieldLabel hint="Helps estimate broadband and energy usage">Number of adults</FieldLabel>
        <NumberField value={draft.numAdults} onChange={(v) => set("numAdults", v)} min={1} max={20} />
      </div>
      <div>
        <FieldLabel>Number of children</FieldLabel>
        <NumberField value={draft.numChildren} onChange={(v) => set("numChildren", v)} min={0} max={20} placeholder="0 if none" />
      </div>
      <div>
        <FieldLabel hint="Used for energy research">Primary heating type</FieldLabel>
        <SelectField
          value={draft.heatingType}
          onChange={(v) => set("heatingType", v)}
          options={[
            { value: "gas", label: "Gas central heating" },
            { value: "electric", label: "Electric heating" },
            { value: "oil", label: "Oil" },
            { value: "heat_pump", label: "Heat pump" },
            { value: "other", label: "Other" },
          ]}
        />
      </div>
    </div>
  );
}

function EnergyStep({ draft, set }: { draft: ProfileDraft; set: (k: keyof ProfileDraft, v: unknown) => void }) {
  return (
    <div className="space-y-5">
      <div>
        <FieldLabel hint="Check your energy bill for kWh used in the past 12 months">Annual electricity usage (kWh)</FieldLabel>
        <NumberField value={draft.annualElectricityKwh} onChange={(v) => set("annualElectricityKwh", v)} placeholder="e.g. 3100" />
      </div>
      <div>
        <FieldLabel>Annual gas usage (kWh)</FieldLabel>
        <NumberField value={draft.annualGasKwh} onChange={(v) => set("annualGasKwh", v)} placeholder="e.g. 12000" />
      </div>
      <div>
        <FieldLabel>Do you have solar panels?</FieldLabel>
        <YesNoField value={draft.hasSolar} onChange={(v) => set("hasSolar", v)} />
      </div>
      {draft.hasSolar && (
        <div>
          <FieldLabel>Solar export tariff name (if known)</FieldLabel>
          <Input
            value={draft.solarExportTariff ?? ""}
            onChange={(e) => set("solarExportTariff", e.target.value || null)}
            placeholder="e.g. SEG tariff"
          />
        </div>
      )}
      <div>
        <FieldLabel hint="Used for energy tariff research — EV charging can significantly affect the best tariff">Do you have an electric vehicle (EV)?</FieldLabel>
        <YesNoField value={draft.hasEv} onChange={(v) => set("hasEv", v)} />
      </div>
      {draft.hasEv && (
        <div>
          <FieldLabel>Home charger power</FieldLabel>
          <SelectField
            value={draft.evChargerType}
            onChange={(v) => set("evChargerType", v)}
            options={[
              { value: "7kw", label: "7 kW (standard home charger)" },
              { value: "22kw", label: "22 kW (fast home charger)" },
              { value: "none", label: "No home charger" },
            ]}
          />
        </div>
      )}
    </div>
  );
}

const DRIVING_EXPERIENCE_OPTIONS = [
  { value: "new_driver", label: "New driver (< 1 year)" },
  { value: "lt5yrs",     label: "1–4 years" },
  { value: "5_10yrs",    label: "5–9 years" },
  { value: "10plus",     label: "10+ years" },
];

function SingleVehicleForm({
  vehicle,
  onChange,
  label,
}: {
  vehicle: VehicleEntry;
  onChange: (updated: VehicleEntry) => void;
  label?: string;
}) {
  function v<K extends keyof VehicleEntry>(k: K, val: VehicleEntry[K]) {
    onChange({ ...vehicle, [k]: val });
  }
  // Display valuePence as GBP; convert back on input
  const valueGbp = vehicle.valuePence != null ? vehicle.valuePence / 100 : null;

  return (
    <div className="space-y-4 rounded-md border p-4 bg-muted/30">
      {label && <p className="text-sm font-medium text-muted-foreground">{label}</p>}
      <div className="grid grid-cols-2 gap-4">
        <div>
          <FieldLabel>Make</FieldLabel>
          <Input value={vehicle.make ?? ""} onChange={(e) => v("make", e.target.value || null)} placeholder="e.g. Ford" />
        </div>
        <div>
          <FieldLabel>Model</FieldLabel>
          <Input value={vehicle.model ?? ""} onChange={(e) => v("model", e.target.value || null)} placeholder="e.g. Focus" />
        </div>
      </div>
      <div className="grid grid-cols-2 gap-4">
        <div>
          <FieldLabel>Year</FieldLabel>
          <NumberField value={vehicle.year} onChange={(val) => v("year", val)} placeholder="e.g. 2019" min={1950} max={2030} />
        </div>
        <div>
          <FieldLabel>Estimated value (£)</FieldLabel>
          <NumberField value={valueGbp} onChange={(val) => v("valuePence", val != null ? Math.round(val * 100) : null)} placeholder="e.g. 8000" />
        </div>
      </div>
      <div>
        <FieldLabel hint="Used to calculate insurance premiums">Annual mileage</FieldLabel>
        <NumberField value={vehicle.annualMileage} onChange={(val) => v("annualMileage", val)} placeholder="e.g. 8000" />
      </div>
      <div>
        <FieldLabel>Driving experience</FieldLabel>
        <SelectField value={vehicle.drivingExperience} onChange={(val) => v("drivingExperience", val)} options={DRIVING_EXPERIENCE_OPTIONS} />
      </div>
      <div>
        <FieldLabel hint="At-fault claims only">At-fault claims in last 5 years</FieldLabel>
        <NumberField value={vehicle.claimsLast5Years} onChange={(val) => v("claimsLast5Years", val)} min={0} max={20} placeholder="0 if none" />
      </div>
    </div>
  );
}

function VehiclesStep({ draft, set }: { draft: ProfileDraft; set: (k: keyof ProfileDraft, v: unknown) => void }) {
  const numCars = draft.numCars ?? 0;
  const vehicles = draft.vehicles;

  function updateVehicle(index: number, updated: VehicleEntry) {
    const next = [...vehicles];
    next[index] = updated;
    set("vehicles", next);
    // Also sync legacy single-car fields from vehicle[0]
    if (index === 0) {
      set("carMake", updated.make);
      set("carModel", updated.model);
      set("carYear", updated.year);
      set("carValue", updated.valuePence != null ? updated.valuePence / 100 : null);
      set("annualMileage", updated.annualMileage);
      set("drivingExperience", updated.drivingExperience);
      set("claimsLast5Years", updated.claimsLast5Years);
    }
  }

  function addVehicle() {
    set("vehicles", [...vehicles, { ...EMPTY_VEHICLE }]);
  }

  function removeVehicle(index: number) {
    const next = vehicles.filter((_, i) => i !== index);
    set("vehicles", next);
  }

  // When numCars changes, ensure vehicles array has the right length
  function handleNumCarsChange(n: number | null) {
    set("numCars", n);
    if (n == null || n === 0) {
      set("vehicles", []);
      return;
    }
    const current = vehicles.length;
    if (current < n) {
      // Add empty vehicle slots
      const extra: VehicleEntry[] = Array.from({ length: n - current }, () => ({ ...EMPTY_VEHICLE }));
      set("vehicles", [...vehicles, ...extra]);
    }
    // Don't shrink automatically — let user remove manually if they reduce numCars
  }

  return (
    <div className="space-y-5">
      <div>
        <FieldLabel>Number of cars in household</FieldLabel>
        <NumberField value={draft.numCars} onChange={handleNumCarsChange} min={0} max={10} />
      </div>

      {numCars === 1 && (
        <SingleVehicleForm
          vehicle={vehicles[0] ?? EMPTY_VEHICLE}
          onChange={(u) => updateVehicle(0, u)}
        />
      )}

      {numCars > 1 && (
        <div className="space-y-4">
          {Array.from({ length: Math.max(numCars, vehicles.length) }).map((_, i) => (
            <div key={i} className="relative">
              <SingleVehicleForm
                vehicle={vehicles[i] ?? EMPTY_VEHICLE}
                onChange={(u) => updateVehicle(i, u)}
                label={`Vehicle ${i + 1}`}
              />
              {i > 0 && (
                <button
                  type="button"
                  onClick={() => removeVehicle(i)}
                  className="absolute top-3 right-3 text-xs text-destructive hover:underline"
                >
                  Remove
                </button>
              )}
            </div>
          ))}
          {vehicles.length < numCars && (
            <Button variant="outline" size="sm" onClick={addVehicle} type="button">
              + Add vehicle
            </Button>
          )}
        </div>
      )}
    </div>
  );
}

function BundlesStep({ draft, set, setBool }: { draft: ProfileDraft; set: (k: keyof ProfileDraft, v: unknown) => void; setBool: (k: keyof ProfileDraft, v: boolean | null) => void }) {
  return (
    <div className="space-y-5">
      <p className="text-sm text-muted-foreground">
        Bundle information helps the AI identify deals that include Sky or Virgin Media discounts when researching broadband or mobile.
      </p>
      <div>
        <FieldLabel>Do you have a Sky TV subscription?</FieldLabel>
        <YesNoField value={draft.hasSkyTv} onChange={(v) => setBool("hasSkyTv", v)} />
      </div>
      <div>
        <FieldLabel>Do you have a Sky Mobile subscription?</FieldLabel>
        <YesNoField value={draft.hasSkyMobile} onChange={(v) => setBool("hasSkyMobile", v)} />
      </div>
      <div>
        <FieldLabel>Do you have Virgin Media (any product)?</FieldLabel>
        <YesNoField value={draft.hasVirginMedia} onChange={(v) => setBool("hasVirginMedia", v)} />
      </div>
      <div className="border-t pt-5">
        <FieldLabel hint="Used only for life insurance research to find appropriate cover amounts">Are you a smoker?</FieldLabel>
        <YesNoField value={draft.smoker} onChange={(v) => setBool("smoker", v)} />
      </div>
      <div>
        <FieldLabel hint="e.g. step-free access required, large-print communications">Accessibility needs</FieldLabel>
        <Textarea
          value={draft.accessibilityNeeds ?? ""}
          onChange={(e) => set("accessibilityNeeds", e.target.value || null)}
          placeholder="Leave blank if none"
          className="min-h-[80px]"
        />
      </div>
      <div>
        <FieldLabel>General preferences for all services</FieldLabel>
        <Textarea
          value={draft.generalPreferences ?? ""}
          onChange={(e) => set("generalPreferences", e.target.value || null)}
          placeholder="e.g. prefer direct debit, no cashback cards, green energy preferred"
          className="min-h-[80px]"
        />
      </div>
    </div>
  );
}

function ReviewStep({ draft }: { draft: ProfileDraft }) {
  const rows: { label: string; value: unknown }[] = [
    { label: "Postcode", value: draft.postcode },
    { label: "Property type", value: draft.propertyType },
    { label: "Tenure", value: draft.tenure },
    { label: "Bedrooms", value: draft.bedrooms },
    { label: "Year built", value: draft.yearBuilt },
    { label: "Adults", value: draft.numAdults },
    { label: "Children", value: draft.numChildren },
    { label: "Heating", value: draft.heatingType },
    { label: "Annual electricity (kWh)", value: draft.annualElectricityKwh },
    { label: "Annual gas (kWh)", value: draft.annualGasKwh },
    { label: "Solar panels", value: draft.hasSolar === null ? null : draft.hasSolar ? "Yes" : "No" },
    { label: "EV", value: draft.hasEv === null ? null : draft.hasEv ? "Yes" : "No" },
    { label: "EV charger", value: draft.evChargerType },
    { label: "Cars", value: draft.numCars },
    { label: "Car make/model", value: draft.carMake && draft.carModel ? `${draft.carMake} ${draft.carModel} (${draft.carYear ?? "year unknown"})` : null },
    { label: "Annual mileage", value: draft.annualMileage },
    { label: "Claims (5yr)", value: draft.claimsLast5Years },
    { label: "Sky TV", value: draft.hasSkyTv === null ? null : draft.hasSkyTv ? "Yes" : "No" },
    { label: "Sky Mobile", value: draft.hasSkyMobile === null ? null : draft.hasSkyMobile ? "Yes" : "No" },
    { label: "Virgin Media", value: draft.hasVirginMedia === null ? null : draft.hasVirginMedia ? "Yes" : "No" },
    { label: "Smoker", value: draft.smoker === null ? null : draft.smoker ? "Yes" : "No" },
  ];

  const filled = rows.filter((r) => r.value !== null && r.value !== undefined);

  return (
    <div className="space-y-4">
      <p className="text-sm text-muted-foreground">
        Review what you've entered. Blank fields won't be included in research — that's fine, the AI will note when it couldn't personalise.
      </p>
      <div className="divide-y divide-border rounded-md border">
        {filled.length === 0 ? (
          <p className="p-4 text-sm text-muted-foreground">No fields filled in yet.</p>
        ) : (
          filled.map((r) => (
            <div key={r.label} className="flex justify-between items-center p-3 text-sm">
              <span className="text-muted-foreground">{r.label}</span>
              <span className="font-medium">{String(r.value)}</span>
            </div>
          ))
        )}
      </div>
      <p className="text-xs text-muted-foreground">
        Sensitive data (credentials, financial details, driving licence numbers) should never be entered here.
        Click Save Profile to store your answers.
      </p>
    </div>
  );
}

// ─── Main page ────────────────────────────────────────────────────────────────

export default function HouseholdPage() {
  const [_, setLocation] = useLocation();
  const { toast } = useToast();
  const [step, setStep] = useState(0);
  const [draft, setDraft] = useState<ProfileDraft>(EMPTY);
  const [saved, setSaved] = useState(false);

  const { data: profile, isLoading } = useGetHouseholdProfile();
  const update = useUpdateHouseholdProfile();

  // Load existing profile into draft on mount
  useEffect(() => {
    if (!profile) return;

    // Reconstruct VehicleEntry list from API vehicles array (or single-car fields).
    // profile.vehicles is now part of the generated HouseholdProfile type.
    const apiVehicles = profile.vehicles ?? [];

    const vehicles: VehicleEntry[] = apiVehicles.length > 0
      ? apiVehicles.map((v) => ({
          make: v.make ?? null,
          model: v.model ?? null,
          year: v.year ?? null,
          valuePence: v.valuePence ?? null,
          annualMileage: v.annualMileage ?? null,
          drivingExperience: v.drivingExperience ?? null,
          claimsLast5Years: v.claimsLast5Years ?? null,
        }))
      : (profile.carMake
          ? [{
              make: profile.carMake,
              model: profile.carModel ?? null,
              year: profile.carYear ?? null,
              valuePence: profile.carValue != null ? Math.round(profile.carValue * 100) : null,
              annualMileage: profile.annualMileage ?? null,
              drivingExperience: profile.drivingExperience ?? null,
              claimsLast5Years: profile.claimsLast5Years ?? null,
            }]
          : []);

    // profile.unknownFields is now part of the generated HouseholdProfile type.
    const unknownFields: string[] = profile.unknownFields ?? [];

    setDraft({
      postcode: profile.postcode ?? null,
      propertyType: profile.propertyType ?? null,
      tenure: profile.tenure ?? null,
      bedrooms: profile.bedrooms ?? null,
      yearBuilt: profile.yearBuilt ?? null,
      numAdults: profile.numAdults ?? null,
      numChildren: profile.numChildren ?? null,
      heatingType: profile.heatingType ?? null,
      hasEv: profile.hasEv ?? null,
      evChargerType: profile.evChargerType ?? null,
      hasSolar: profile.hasSolar ?? null,
      solarExportTariff: profile.solarExportTariff ?? null,
      annualElectricityKwh: profile.annualElectricityKwh ?? null,
      annualGasKwh: profile.annualGasKwh ?? null,
      numCars: profile.numCars ?? null,
      vehicles,
      carMake: profile.carMake ?? null,
      carModel: profile.carModel ?? null,
      carYear: profile.carYear ?? null,
      carValue: profile.carValue ?? null,
      annualMileage: profile.annualMileage ?? null,
      drivingExperience: profile.drivingExperience ?? null,
      claimsLast5Years: profile.claimsLast5Years ?? null,
      hasSkyTv: profile.hasSkyTv ?? null,
      hasSkyMobile: profile.hasSkyMobile ?? null,
      hasVirginMedia: profile.hasVirginMedia ?? null,
      smoker: profile.smoker ?? null,
      accessibilityNeeds: profile.accessibilityNeeds ?? null,
      generalPreferences: profile.generalPreferences ?? null,
      unknownFields,
    });
  }, [profile?.updatedAt]);

  function set(key: keyof ProfileDraft, value: unknown) {
    setSaved(false);
    setDraft((d) => ({ ...d, [key]: value }));
  }

  /** Mark a boolean field as "explicitly I don't know" (or clear that mark). */
  function setBoolWithUnknown(key: keyof ProfileDraft, value: boolean | null) {
    setDraft((d) => {
      const uf = d.unknownFields;
      const newUf = value === null
        ? [...new Set([...uf, String(key)])]
        : uf.filter((k) => k !== String(key));
      return { ...d, [key]: value, unknownFields: newUf };
    });
    setSaved(false);
  }

  /** Build the API payload from the current draft. */
  function buildPayload() {
    // Filter out vehicle entries where ALL fields are null (empty slots created
    // when numCars is set before vehicle details are filled in).
    const apiVehicles = draft.vehicles
      .filter(
        (v) =>
          v.make != null ||
          v.model != null ||
          v.year != null ||
          v.valuePence != null ||
          v.annualMileage != null ||
          v.drivingExperience != null ||
          v.claimsLast5Years != null,
      )
      .map((v) => ({
        // All vehicle fields are nullable in VehicleInput — partial saves are fine.
        make:              v.make ?? undefined,
        model:             v.model ?? undefined,
        year:              v.year ?? undefined,
        valuePence:        v.valuePence ?? undefined,
        annualMileage:     v.annualMileage ?? undefined,
        drivingExperience: v.drivingExperience ?? undefined,
        claimsLast5Years:  v.claimsLast5Years ?? undefined,
      }));

    // Decide what to send for the vehicles key:
    //  • numCars === 0 → always send [] so the API clears legacy car columns.
    //  • vehicles have data → send the array (API syncs legacy cols from [0]).
    //  • vehicles are empty but numCars > 0 → send undefined; user hasn't filled
    //    in details yet and we don't want to wipe data that might be in the DB.
    const vehiclesPayload: typeof apiVehicles | [] | undefined =
      draft.numCars === 0
        ? []
        : apiVehicles.length > 0
          ? apiVehicles
          : undefined;

    // Exclude legacy scalar car-alias fields (carMake, carModel, carYear,
    // carValue, annualMileage, drivingExperience, claimsLast5Years) from the
    // payload whenever we are sending a vehicles array.  The API route derives
    // those columns from vehicles[0]; if we also send the null scalar aliases
    // they take precedence (they are !== undefined in the patch) and the
    // vehicles[0] sync logic is skipped, leaving stale or null values in the
    // legacy columns even when the vehicles array has data.
    const {
      carMake: _cm,
      carModel: _cmo,
      carYear: _cy,
      carValue: _cv,
      annualMileage: _am,
      drivingExperience: _de,
      claimsLast5Years: _cl,
      vehicles: _v,
      ...rest
    } = draft;

    if (vehiclesPayload !== undefined) {
      // Send vehicles — legacy scalar aliases omitted intentionally so the API
      // can derive them from vehicles[0] without interference.
      return { ...rest, vehicles: vehiclesPayload, unknownFields: draft.unknownFields };
    }

    // No vehicles update — include the legacy scalar aliases so the user can
    // still save car details through the legacy single-car path if needed.
    return {
      ...rest,
      carMake: _cm, carModel: _cmo, carYear: _cy, carValue: _cv,
      annualMileage: _am, drivingExperience: _de, claimsLast5Years: _cl,
      unknownFields: draft.unknownFields,
    };
  }

  function handleSave() {
    update.mutate({ data: buildPayload() as Parameters<typeof update.mutate>[0]["data"] }, {
      onSuccess: () => {
        setSaved(true);
        toast({ title: "Household profile saved" });
      },
      onError: (err) => {
        toast({ title: "Failed to save", description: (err as { data?: { error?: string } }).data?.error ?? "Unknown error", variant: "destructive" });
      },
    });
  }

  function handleSaveLater() {
    update.mutate({ data: buildPayload() as Parameters<typeof update.mutate>[0]["data"] }, {
      onSuccess: () => {
        setSaved(true);
        toast({ title: "Household profile saved" });
        setLocation("/");
      },
      onError: (err) => {
        toast({
          title: "Failed to save",
          description: (err as { data?: { error?: string } }).data?.error ?? "Unknown error",
          variant: "destructive",
        });
        // Navigation is intentionally withheld on failure so the user can retry
      },
    });
  }

  const isLast = step === STEPS.length - 1;

  const stepContent = () => {
    switch (step) {
      case 0: return <LocationStep draft={draft} set={set} />;
      case 1: return <HouseholdStep draft={draft} set={set} />;
      case 2: return <EnergyStep draft={draft} set={set} />;
      case 3: return <VehiclesStep draft={draft} set={set} />;
      case 4: return <BundlesStep draft={draft} set={set} setBool={setBoolWithUnknown} />;
      case 5: return <ReviewStep draft={draft} />;
      default: return null;
    }
  };

  if (isLoading) {
    return (
      <AppLayout>
        <div className="flex items-center justify-center py-12">
          <Loader2 className="h-8 w-8 animate-spin text-muted-foreground" />
        </div>
      </AppLayout>
    );
  }

  const StepIcon = STEPS[step]!.icon;

  return (
    <AppLayout>
      {/* Header */}
      <div className="mb-8">
        <h1 className="text-3xl font-bold tracking-tight">My Household</h1>
        <p className="text-muted-foreground mt-1">
          Tell us about your household so the AI can personalise its research.
          All fields are optional — leave anything you don't know blank.
        </p>
      </div>

      {/* Progress bar */}
      <div className="mb-8">
        <div className="flex items-center justify-between mb-2">
          {STEPS.map((s, i) => (
            <button
              key={s.id}
              onClick={() => setStep(i)}
              className={`flex flex-col items-center gap-1 text-xs font-medium transition-colors ${
                i === step
                  ? "text-primary"
                  : i < step
                  ? "text-primary/70 cursor-pointer hover:text-primary"
                  : "text-muted-foreground cursor-default"
              }`}
            >
              <span
                className={`h-8 w-8 rounded-full flex items-center justify-center text-xs font-bold border-2 transition-colors ${
                  i === step
                    ? "border-primary bg-primary text-primary-foreground"
                    : i < step
                    ? "border-primary bg-primary/20 text-primary"
                    : "border-border bg-background text-muted-foreground"
                }`}
              >
                {i < step ? <CheckCircle className="h-4 w-4" /> : i + 1}
              </span>
              <span className="hidden sm:block">{s.label}</span>
            </button>
          ))}
        </div>
        <div className="h-1.5 bg-muted rounded-full overflow-hidden">
          <div
            className="h-full bg-primary rounded-full transition-all duration-300"
            style={{ width: `${((step + 1) / STEPS.length) * 100}%` }}
          />
        </div>
      </div>

      {/* Step content */}
      <Card className="shadow-sm">
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <StepIcon className="h-5 w-5 text-primary" />
            {STEPS[step]!.label}
          </CardTitle>
          <CardDescription>
            {step < STEPS.length - 1
              ? `Step ${step + 1} of ${STEPS.length - 1} — answers you don't know can be left blank`
              : "Review your answers before saving"}
          </CardDescription>
        </CardHeader>
        <CardContent>{stepContent()}</CardContent>
      </Card>

      {/* Navigation */}
      <div className="mt-6 flex items-center justify-between">
        <div className="flex gap-2">
          {step > 0 && (
            <Button variant="outline" onClick={() => setStep((s) => s - 1)} className="gap-2">
              <ChevronLeft className="h-4 w-4" />
              Back
            </Button>
          )}
          <Button variant="ghost" onClick={handleSaveLater} className="gap-2 text-muted-foreground">
            <Save className="h-4 w-4" />
            Save &amp; exit
          </Button>
        </div>

        <div className="flex gap-2">
          {isLast ? (
            <Button onClick={handleSave} disabled={update.isPending} className="gap-2">
              {update.isPending ? <Loader2 className="h-4 w-4 animate-spin" /> : <Save className="h-4 w-4" />}
              {saved ? "Saved ✓" : "Save Profile"}
            </Button>
          ) : (
            <Button onClick={() => setStep((s) => s + 1)} className="gap-2">
              Continue
              <ChevronRight className="h-4 w-4" />
            </Button>
          )}
        </div>
      </div>
    </AppLayout>
  );
}
