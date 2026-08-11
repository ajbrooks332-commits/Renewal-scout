import { z } from "zod";

const OptionalBoolean = z.boolean().nullable().optional();
const OptionalText = z.string().trim().max(500).nullable().optional();
const OptionalNonnegative = z.number().finite().min(0).nullable().optional();
const OptionalNonnegativeInt = z.number().int().min(0).nullable().optional();
const OptionalPositiveInt = z.number().int().min(1).nullable().optional();

const BroadbandRequirements = z
  .object({
    downloadSpeedMbps: OptionalNonnegative,
    uploadSpeedMbps: OptionalNonnegative,
    simultaneousUsers: z.number().int().min(1).max(20).nullable().optional(),
    workFromHome: OptionalBoolean,
    videoCallsFrequent: OptionalBoolean,
    onlineGaming: OptionalBoolean,
    streamingHd: OptionalBoolean,
    landlineRequired: OptionalBoolean,
    fullFibrePreferred: OptionalBoolean,
    maxContractMonths: z.enum(["12", "18", "24", "any"]).nullable().optional(),
    maxMonthlyBudgetGbp: OptionalNonnegative,
    linkedSkyTv: OptionalBoolean,
    skyTvPackage: z
      .enum(["sky_q", "sky_glass", "sky_stream", "sky_basic"])
      .nullable()
      .optional(),
    skyTvSportsRequired: OptionalBoolean,
    skyTvCinemaRequired: OptionalBoolean,
    linkedSkyMobile: OptionalBoolean,
    skyMobileLines: z.number().int().min(1).max(20).nullable().optional(),
    skyMobilePlan: OptionalText,
    linkedVirginMedia: OptionalBoolean,
    bundleDiscountImportant: OptionalBoolean,
    currentBundleDiscountGbp: OptionalNonnegative,
    willingToSplitBundle: OptionalBoolean,
    tvAddon: OptionalBoolean,
    homePhoneAddon: OptionalBoolean,
    // Retained for older saved clients.
    contractLengthMonths: OptionalPositiveInt,
    includesLineRental: OptionalBoolean,
  })
  .strict();

const EnergyRequirements = z
  .object({
    tariffType: z
      .enum(["fixed", "variable", "tracker", "economy7", "any"])
      .nullable()
      .optional(),
    tariffPreference: OptionalText,
    greenPreferred: OptionalBoolean,
    paymentMethod: z
      .enum(["direct_debit", "prepay", "quarterly", "any"])
      .nullable()
      .optional(),
    annualKwh: OptionalNonnegative,
    annualElectricityKwh: OptionalNonnegative,
    annualGasKwh: OptionalNonnegative,
    dayNightSplit: OptionalBoolean,
    dayUsagePercent: z.number().finite().min(0).max(100).nullable().optional(),
    smartMeter: OptionalBoolean,
    smartMeterType: z.enum(["SMETS1", "SMETS2", "none"]).nullable().optional(),
    evOwner: OptionalBoolean,
    evMake: OptionalText,
    evModel: OptionalText,
    evBatteryCapacityKwh: OptionalNonnegative,
    evAnnualMileage: OptionalNonnegativeInt,
    homeChargerKw: OptionalNonnegative,
    overnightChargingStart: z
      .enum(["21:00", "22:00", "23:00", "00:00", "01:00"])
      .nullable()
      .optional(),
    overnightChargingEnd: z
      .enum(["04:00", "05:00", "06:00", "07:00", "08:00"])
      .nullable()
      .optional(),
    shiftToOffPeak: OptionalBoolean,
    solarPanels: OptionalBoolean,
    solarExportTariff: OptionalBoolean,
    homeBattery: OptionalBoolean,
    homeBatteryCapacityKwh: OptionalNonnegative,
  })
  .strict();

const CarInsuranceRequirements = z
  .object({
    coverType: z.enum(["comprehensive", "tpft", "tpo"]).nullable().optional(),
    namedDrivers: z.number().int().min(1).max(10).nullable().optional(),
    parkingLocation: z.enum(["garage", "driveway", "street"]).nullable().optional(),
    modifiedVehicle: OptionalBoolean,
    noClaimsYears: z.number().int().min(0).max(30).nullable().optional(),
    useType: z
      .enum(["social", "social_commute", "commuting", "business"])
      .nullable()
      .optional(),
    voluntaryExcessGbp: OptionalNonnegative,
    addBreakdownCover: OptionalBoolean,
    addLegalExpenses: OptionalBoolean,
    addCourtesy: OptionalBoolean,
    maxAnnualBudgetGbp: OptionalNonnegative,
  })
  .strict();

const HomeInsuranceRequirements = z
  .object({
    coverType: z
      .enum([
        "buildings_and_contents",
        "buildings",
        "contents",
        "buildings_only",
        "contents_only",
      ])
      .nullable()
      .optional(),
    rebuildValueGbp: OptionalNonnegative,
    contentsValueGbp: OptionalNonnegative,
    voluntaryExcessGbp: OptionalNonnegative,
    prevClaims: OptionalNonnegativeInt,
    highValueItems: OptionalBoolean,
    floodRisk: OptionalBoolean,
    addAccidentalDamage: OptionalBoolean,
    addPersonalPossessions: OptionalBoolean,
    addLegalExpenses: OptionalBoolean,
    maxAnnualBudgetGbp: OptionalNonnegative,
  })
  .strict();

const LifeInsuranceRequirements = z
  .object({
    coverType: z
      .enum(["level_term", "decreasing_term", "whole_of_life", "joint"])
      .nullable()
      .optional(),
    coverAmountGbp: OptionalNonnegative,
    termYears: z.number().int().min(1).max(50).nullable().optional(),
    jointPolicy: OptionalBoolean,
    criticalIllness: OptionalBoolean,
    criticalIllnessCover: OptionalBoolean,
    indexLinked: OptionalBoolean,
    maxAnnualBudgetGbp: OptionalNonnegative,
  })
  .strict();

const CreditCardRequirements = z
  .object({
    primaryUse: z
      .enum(["purchases", "balance_transfer", "travel", "cashback", "rewards"])
      .nullable()
      .optional(),
    creditLimitGbp: OptionalNonnegative,
    rewardPreference: OptionalText,
    balanceTransfer: OptionalBoolean,
    balanceTransferAmountGbp: OptionalNonnegative,
    maxAnnualFeeGbp: OptionalNonnegative,
  })
  .strict();

const LoanRequirements = z
  .object({
    purposeOfLoan: OptionalText,
    amountGbp: OptionalNonnegative,
    termMonths: z.number().int().min(1).max(360).nullable().optional(),
    maxAprPct: OptionalNonnegative,
  })
  .strict();

const MobileRequirements = z
  .object({
    monthlyDataGb: OptionalNonnegative,
    unlimitedData: OptionalBoolean,
    roamingEu: OptionalBoolean,
    roamingWorld: OptionalBoolean,
    sim_only: OptionalBoolean,
    maxContractMonths: z.enum(["1", "12", "24", "any"]).nullable().optional(),
    maxMonthlyBudgetGbp: OptionalNonnegative,
    // Retained for older saved clients.
    dataGb: OptionalNonnegative,
    includesHandset: OptionalBoolean,
    networkPreference: OptionalText,
    contractMonths: OptionalPositiveInt,
    roamingNeeded: OptionalBoolean,
  })
  .strict();

const EmptyRequirements = z.object({}).strict();

export const REQUIREMENT_SCHEMAS_BY_SERVICE_TYPE = {
  Broadband: BroadbandRequirements,
  Electricity: EnergyRequirements,
  "Gas and electricity": EnergyRequirements,
  "Car insurance": CarInsuranceRequirements,
  "Home insurance": HomeInsuranceRequirements,
  "Life insurance": LifeInsuranceRequirements,
  "Credit card": CreditCardRequirements,
  Loan: LoanRequirements,
  "Mobile phone": MobileRequirements,
  Other: EmptyRequirements,
} as const;

export function getRequirementFieldsSchema(serviceType: string): z.ZodObject<any> {
  return (
    REQUIREMENT_SCHEMAS_BY_SERVICE_TYPE[
      serviceType as keyof typeof REQUIREMENT_SCHEMAS_BY_SERVICE_TYPE
    ] ?? EmptyRequirements
  );
}

export function getRequirementFieldNames(serviceType: string): string[] {
  return Object.keys(getRequirementFieldsSchema(serviceType).shape);
}
